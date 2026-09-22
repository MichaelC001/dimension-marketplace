/**
 * Browser4 engine driver.
 *
 * Browser4 (platonai/Browser4, Apache-2.0) ships a standalone MCP server that
 * runs *outside* Spring and speaks the standard stdio transport:
 *
 *   java -cp <bundle>/lib/* ai.platon.pulsar.agentic.mcp.server.Browser4MCPServerRunnerKt \
 *        --transport stdio [--headless|--headed]
 *
 * `Browser4MCPServerRunner.kt` creates ONE agentic session at startup
 * (`AgenticContexts.createSession(headless = …)`), wraps its tool manager in
 * `Browser4MCPServer`, and serves it over `StdioServerTransport` until stdin
 * closes. No web application is started, so this driver opens no port of its
 * own: the JVM is spawned per profile, owned here, and torn down here.
 *
 * Isolation is the profile directory itself. `-Dbrowser.profile.path=<dir>`
 * (B4Constants.BROWSER_PROFILE_PATH) is read by
 * `AbstractPulsarSession.createBoundDriver`, which launches Chrome with a
 * `BrowserProfile` rooted at that directory instead of rotating through the
 * SEQUENTIAL profile pool — the Chrome user data dir is `<dir>/PULSAR_CHROME`
 * (`BrowserId.userDataDir` = `contextDir/<browserType.name>`), so everything
 * the profile accumulates stays under the directory this plugin already locks,
 * and survives restarts.
 *
 * WHAT DRIVES THE PAGE
 *
 * The MCP channel is used for the session LIFECYCLE and for exactly one
 * read — the identity of the tab the Browser4 session drives. Every read and
 * every action afterwards runs over this driver's own CDP connection to the
 * Chrome that Browser4 launched, through `createAttachedPageDriver`, which
 * pins the element handle it resolved and re-reads the live loaderId before
 * each native step. The MCP tool path is deliberately NOT used for mutation:
 *
 *  - `RobustRPC.invokeWithRetry` (maxRetry = 2) re-runs the whole operation of
 *    a failed call, and `invokeOnElement` puts the selector lookup *inside*
 *    that retry block, so one approved call could re-resolve a target and
 *    repeat a partially completed effect;
 *  - `tab.click`/`tab.fill` take a SELECTOR, which the executor resolves again
 *    on the backend — approval would be checked against one node and spent on
 *    whatever the selector names at dispatch time.
 *
 * Neither is configurable, so the mutation boundary was moved out of them.
 * A side effect worth naming: typed text never crosses into the JVM at all, so
 * no upstream logger, exception message or `ToolCall.pseudoExpression` can
 * carry it.
 *
 * WHICH BROWSER, WHICH TAB
 *
 * The endpoint is `<profile>/PULSAR_CHROME/DevToolsActivePort` — written by the
 * Chrome that owns that user data dir, inside the directory this driver owns —
 * and it is read only after the stale marker was removed and the profile was
 * proven unheld at startup. The tab is the one whose live identity equals the
 * identity Browser4's own session reported; a zero or ambiguous match is a hard
 * failure. No unrelated browser is attached, and no replacement browser is ever
 * launched: if the owned backend cannot be established, opening fails.
 *
 * The JVM and the jars come from the public runtime bundle that
 * `browser4-cli install` lays down (`{data}/browser4/runtime/<tag>/` with
 * `lib/*.jar` and a bundled JRE at `runtime/bin/java`). Opening a browser
 * never installs, downloads or repairs anything: a missing, too-old or
 * certificate-unsafe bundle is reported with the fact that decides it.
 *
 * Nothing here reaches a model: only `tab.evaluate_value` is ever called, the
 * agent's inference engine is never constructed, and the child gets the MCP
 * SDK's curated environment, so provider keys in this process are not handed to
 * a runtime that could spend them.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import type { BrowserAction, BrowserRegion, Viewport } from "../contracts.js";
import { fail } from "../store.js";
import { createAttachedPageDriver } from "./puppeteer.js";
import type { EngineDriver, EngineOptions, EngineState, PreparedAction } from "./types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Read budget. Mirrors browser4-cli's 30s default tool timeout. */
const READ_TIMEOUT_MS = 30_000;
/**
 * Cold start budget. The runner creates its session — which launches Chrome —
 * *before* it connects the stdio transport, so the MCP `initialize` handshake
 * only answers once the JVM and the browser are both up.
 */
const CONNECT_TIMEOUT_MS = 180_000;
/** How long the owned Chrome gets to publish its DevTools endpoint. */
const ENDPOINT_TIMEOUT_MS = 60_000;
/** How long a stopping child gets before it is taken down by force. */
const PROCESS_EXIT_TIMEOUT_MS = 30_000;
/** Budget for one process-table enumeration or one forced kill. */
const PROCESS_TOOL_TIMEOUT_MS = 20_000;
/** Bytes of child stderr kept for diagnostics. Never logged, never printed. */
const STDERR_KEEP = 4096;
const STDERR_REPORT = 600;

/** `fun main` of Browser4MCPServerRunner.kt — the standalone stdio entry. */
const RUNNER_CLASS = "ai.platon.pulsar.agentic.mcp.server.Browser4MCPServerRunnerKt";
/**
 * First release whose `AbstractPulsarSession.createBoundDriver` honours
 * `browser.profile.path`. Older bundles silently launch a pooled SEQUENTIAL
 * profile instead of ours, which would break profile isolation without any
 * visible error — so an older bundle is rejected rather than used.
 */
const MIN_BUNDLE_VERSION = "4.14.0-rc.6";
/**
 * Newest `pulsar-browser` core (the module that launches Chrome and owns the
 * browser-level CDP session) that is PROVEN to run without HTTPS certificate
 * verification, with no supported way to switch it back on:
 *
 *  - `ChromeDefaults.IGNORE_CERTIFICATE_ERRORS = true` is the default of
 *    `ChromeOptions.ignoreCertificateErrors`, which `@ChromeParameter` maps to
 *    `--ignore-certificate-errors`. `BrowserSettings.createChromeOptions` never
 *    clears it, the only capability the launcher passes in is `proxy`
 *    (`AbstractBrowserFactory.launch`), and `ChromeOptions.toList` drops any
 *    raw `browser.launch.chrome.args` argument whose key already has an
 *    effective programmatic value — so the flag cannot be overridden from
 *    configuration;
 *  - `NetworkManager.ignoreHTTPSErrors` is a hard-coded `true` (its own
 *    comment reads "TODO: is it a launch parameter?") and makes every driver
 *    send `Security.setIgnoreCertificateErrors(true)` on the backend's CDP
 *    session in `NetworkManager.enable`.
 *
 * A DevTools session cannot repair either one: `SecurityHandler` keeps the
 * override mode per session, so this driver's own connection cannot revoke the
 * backend's, and the command-line flag is applied to the network context below
 * DevTools entirely.
 */
const LAST_TLS_UNSAFE_CORE = "4.11.16";

/**
 * `BrowserId.userDataDir` = `contextDir/<browserType.name>`, and the profile
 * this driver passes to Browser4 is that context dir.
 */
const CHROME_DATA_DIR = "PULSAR_CHROME";
/** Chrome's own endpoint marker inside the user data dir. */
const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
/**
 * `BrowserFileSystem.prepareUserDataDir` copies the SHARED prototype user data
 * dir (`AppPaths.CHROME_DATA_DIR_PROTOTYPE`) into a fresh profile whenever the
 * prototype has a `Default` directory and the target does not — and the copy
 * filter keeps `Default/Preferences`, `Extensions`, `Network` and the profile
 * sqlite databases, i.e. another context's logins. It returns early when the
 * target `Default` exists, so an empty owned one is created before first
 * launch. An existing profile already has it; creating it is a no-op there.
 */
const CHROME_DEFAULT_PROFILE_DIR = "Default";

// ---------------------------------------------------------------------------
// Page scripts
//
// Compiled functions only. Nothing here is ever assembled from model output:
// the driver serializes a fixed function, exactly like the Puppeteer path's
// `page.evaluate(fn)`.
// ---------------------------------------------------------------------------

interface TabIdentity {
	href: string;
	/**
	 * `performance.timeOrigin` is set when a Document is created and is never
	 * mutated, so it identifies one document of one tab: two tabs showing the
	 * same URL have different origins, down to microseconds.
	 */
	origin: number;
}

/**
 * Read one document's identity. Strictly read-only — nothing is stamped on the
 * page, so running it over the backend's MCP channel leaves no trace there and
 * the same values can be read back over CDP.
 */
const IDENTITY_SCRIPT = (): string =>
	JSON.stringify({ href: document.location.href, origin: performance.timeOrigin });

function parseIdentity(text: string, what: string): TabIdentity {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return fail("browser4_bad_response", `${what} returned malformed JSON: ${describe(error)}`);
	}
	const value = parsed as Partial<TabIdentity> | null;
	if (typeof value?.href !== "string" || typeof value.origin !== "number" || !Number.isFinite(value.origin)) {
		return fail("browser4_bad_response", `${what} returned no usable document identity.`);
	}
	return { href: value.href, origin: value.origin };
}

// ---------------------------------------------------------------------------
// Runtime bundle
// ---------------------------------------------------------------------------

interface InstalledRuntime {
	installDir: string;
	libDir: string;
	javaPath: string;
	/** Version of the Browser4 agentic artifacts in `lib`, e.g. `4.14.0-rc.6`. */
	version: string;
	/** Version of the `pulsar-browser` core that launches and drives Chrome. */
	coreVersion: string;
}

function runtimeDataDir(): string {
	const override = process.env.BROWSER4_RUNTIME_DIR?.trim();
	if (override) return resolve(override);
	if (platform() === "win32") {
		const appData = process.env.APPDATA?.trim();
		if (appData) return join(appData, "browser4");
		return join(homedir(), "AppData", "Roaming", "browser4");
	}
	if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "browser4");
	const xdg = process.env.XDG_DATA_HOME?.trim();
	return join(xdg || join(homedir(), ".local", "share"), "browser4");
}

/** `<artifact>-<version>.jar` → `<version>`, or undefined when absent. */
function jarVersion(jars: string[], artifact: string): string | undefined {
	const prefix = `${artifact}-`;
	const jar = jars.find((name) => name.startsWith(prefix) && /^[0-9]/.test(name.slice(prefix.length)));
	if (jar === undefined) return undefined;
	const version = jar.slice(prefix.length, -".jar".length);
	return version.length > 0 ? version : undefined;
}

/**
 * Read one install directory of the layout `browser4-cli install` lays down:
 * `lib/*.jar` plus the bundled JRE at `runtime/bin/java`.
 *
 * Versions are taken from the jar filenames — `browser4-agentic-<version>.jar`
 * carries the MCP runner, `pulsar-browser-<version>.jar` carries the launcher
 * and the browser-level CDP session — rather than from the directory name,
 * which a `BROWSER4_RUNTIME_DIR` override may have chosen freely. An install
 * missing either jar is not a usable bundle.
 */
function readInstall(dir: string): InstalledRuntime | undefined {
	const libDir = join(dir, "lib");
	const javaPath = join(dir, "runtime", "bin", platform() === "win32" ? "java.exe" : "java");
	try {
		if (!statSync(javaPath).isFile()) return undefined;
	} catch {
		return undefined;
	}
	let jars: string[];
	try {
		jars = readdirSync(libDir).filter((name) => name.endsWith(".jar"));
	} catch {
		return undefined;
	}
	const version = jarVersion(jars, "browser4-agentic");
	const coreVersion = jarVersion(jars, "pulsar-browser");
	if (version === undefined || coreVersion === undefined) return undefined;
	return { coreVersion, installDir: dir, javaPath, libDir, version };
}

/**
 * Locate the runtime bundle: `{runtimeDataDir}/runtime/{current.tag}/`, or the
 * newest complete `v*` install when `current.tag` is missing, exactly as the
 * CLI's own repair path does. Nothing is ever downloaded or installed here:
 * opening a browser must not reach the network.
 */
function findRuntime(): InstalledRuntime {
	const versionsDir = join(runtimeDataDir(), "runtime");
	const tagFile = join(versionsDir, "current.tag");
	if (existsSync(tagFile)) {
		let tag = "";
		try {
			tag = readFileSync(tagFile, "utf8").trim();
		} catch {
			tag = "";
		}
		if (tag) {
			const install = readInstall(join(versionsDir, tag));
			if (install) return install;
		}
	}
	let candidates: string[] = [];
	try {
		candidates = readdirSync(versionsDir).filter((name) => name.startsWith("v"));
	} catch {
		candidates = [];
	}
	const complete = candidates
		.map((name) => readInstall(join(versionsDir, name)))
		.filter((install): install is InstalledRuntime => install !== undefined)
		.sort((a, b) => compareVersions(basename(b.installDir).replace(/^v/, ""), basename(a.installDir).replace(/^v/, "")));
	if (complete.length > 0) return complete[0] as InstalledRuntime;
	return fail(
		"browser4_not_installed",
		`No Browser4 runtime bundle under ${versionsDir}. Install one with \`browser4-cli install\`, or unpack the ` +
			`official browser4-bundle-runtime archive of ${MIN_BUNDLE_VERSION} (or newer) there, or point ` +
			"BROWSER4_RUNTIME_DIR at an existing bundle. Opening a browser never installs anything.",
	);
}

/**
 * Refuse a bundle whose browser core cannot verify HTTPS certificates.
 *
 * This is a fail-closed gate, not a repair: nothing this driver can pass to the
 * child removes `--ignore-certificate-errors` or the backend's
 * `Security.setIgnoreCertificateErrors(true)` (see [LAST_TLS_UNSAFE_CORE]).
 * Opening a persistent, authenticated profile in a browser that accepts any
 * certificate is the one thing this engine must not do quietly.
 */
function assertCertificateVerification(runtime: InstalledRuntime): void {
	if (compareVersions(runtime.coreVersion, LAST_TLS_UNSAFE_CORE) > 0) return;
	fail(
		"browser4_tls_verification_disabled",
		`The Browser4 bundle at ${runtime.installDir} ships pulsar-browser ${runtime.coreVersion}, which launches ` +
			"Chrome with --ignore-certificate-errors (ChromeDefaults.IGNORE_CERTIFICATE_ERRORS = true, mapped by " +
			"ChromeOptions.@ChromeParameter, and unreachable from configuration because ChromeOptions.toList ignores " +
			"raw browser.launch.chrome.args for keys the program already set) AND sends " +
			"Security.setIgnoreCertificateErrors(true) from NetworkManager.enable, whose ignoreHTTPSErrors field is a " +
			"hard-coded true. HTTPS would not be verified for this persistent profile, and no supported setting turns " +
			`it back on, so the browser is not opened. Install a bundle whose pulsar-browser core is newer than ` +
			`${LAST_TLS_UNSAFE_CORE} and makes certificate verification the default (or configurable).`,
	);
}

/**
 * Order two Browser4 versions (`4.14.0`, `4.14.0-rc.6`).
 *
 * Numeric components compare left to right; a prerelease sorts BELOW the
 * matching release, and two prereleases compare by their number.
 */
function compareVersions(a: string, b: string): number {
	const parse = (version: string): { parts: number[]; pre: number } => {
		const [core = "", pre = ""] = version.split("-", 2);
		const parts = core.split(".").map((part) => {
			const value = Number.parseInt(part, 10);
			return Number.isFinite(value) ? value : 0;
		});
		if (pre === "") return { parts, pre: Number.POSITIVE_INFINITY };
		const rank = Number.parseInt(pre.replace(/^[^0-9]*/, ""), 10);
		return { parts, pre: Number.isFinite(rank) ? rank : 0 };
	};
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
		const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
		if (diff !== 0) return diff;
	}
	if (left.pre === right.pre) return 0;
	return left.pre < right.pre ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Child logging
// ---------------------------------------------------------------------------

/**
 * The logback configuration the JVM is started with, pointed at by the
 * standard `logback.configurationFile` property. It has no appender at all:
 * the child writes no log line anywhere.
 *
 * The shipped `logback.xml` cannot be used, and neither can a file appender of
 * our own, because three logger calls carry tool payloads:
 *
 *  1. the shipped root logger writes INFO to a `ConsoleAppender` — i.e. to
 *     `System.out`, which under `--transport stdio` is the JSON-RPC stream;
 *  2. `ToolInvocationLogger` records every call as `tool.call start … args=[…]`;
 *  3. a FAILED call is logged twice at WARN with the call's own arguments —
 *     `AbstractToolExecutor` logs `Error executing expression: {pseudo}`, and
 *     `Browser4MCPServer.errorResult` logs the message it builds from
 *     `TcException.expression`. Both render `ToolCall.pseudoExpression`.
 *
 * Since input is delivered natively over this driver's own CDP connection,
 * nothing the human types can reach those loggers at all; the only call this
 * driver makes is the read-only identity probe. The configuration stays
 * because stdout is the transport, and an INFO line on it is a protocol error.
 *
 * Diagnostics do not depend on this: a failed tool returns its message in
 * band, and whatever the JVM writes to stderr (crashes, startup failures) is
 * kept in memory by the driver and quoted in the error it raises.
 */
function loggingConfig(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by the Dimension browser plugin. Edits are overwritten. -->
<configuration>
    <statusListener class="ch.qos.logback.core.status.NopStatusListener" />

    <!--
      No appender is declared on purpose. stdout is the MCP transport, and every
      file the shipped configuration would write can carry tool arguments: the
      tool-call log, and the two WARN lines a failed call produces.
    -->
    <root level="OFF"/>

    <!-- Named so an OFF root is not the only thing standing between a tool
         argument and the disk. -->
    <logger name="ai.platon.pulsar.agentic.tools.ToolInvocationLogger" level="OFF"/>
    <logger name="ai.platon.pulsar.agentic.tools.builtin.AbstractToolExecutor" level="OFF"/>
    <logger name="ai.platon.pulsar.agentic.mcp.server.Browser4MCPServer" level="OFF"/>
</configuration>
`;
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	try {
		return await Promise.race([work, promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** True once the pid is gone. EPERM means someone else owns it: still alive. */
async function waitForExit(pid: number | undefined, ms: number): Promise<boolean> {
	if (pid === undefined) return true;
	const deadline = Date.now() + ms;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		}
		if (Date.now() >= deadline) return false;
		await sleep(100);
	}
}

/** Run a helper binary and collect stdout; `undefined` when it is unusable. */
async function capture(command: string, args: string[]): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	let settled = false;
	let out = "";
	const finish = (value: string | undefined): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(value);
	};
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		finish(undefined);
	}, PROCESS_TOOL_TIMEOUT_MS);
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString("utf8");
	});
	child.on("error", () => finish(undefined));
	child.on("close", (code) => finish(code === 0 ? out : undefined));
	return await promise;
}

/**
 * Terminate a process and everything it spawned.
 *
 * The JVM owns Chrome, so a bare kill would orphan the browser — and an
 * orphaned Chrome keeps the profile directory open, which is exactly the state
 * the profile lock exists to prevent. On Windows `taskkill /T` walks the whole
 * tree; on POSIX the direct pid is signalled and the profile sweep decides,
 * because the child is not a process-group leader and `kill(-pid)` would then
 * address a group this driver does not own.
 */
async function killTree(pid: number | undefined): Promise<void> {
	if (pid === undefined) return;
	if (platform() === "win32") {
		await capture("taskkill", ["/PID", String(pid), "/T", "/F"]);
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone; the pid check is what decides.
	}
}

/** One process that holds the profile, with the command line that proves it. */
interface ProfileHolder {
	pid: number;
	commandLine: string;
}

/** Windows compares case-insensitively, and both spellings of a path match. */
function normalizeCommandLine(text: string): string {
	return (platform() === "win32" ? text.toLowerCase() : text).replace(/\\/g, "/");
}

/**
 * Pids of the processes that can hold [directory] open, identified by the
 * launch options this driver is responsible for:
 *
 *  - the JVM, which carries `-Dbrowser.profile.path=<directory>`;
 *  - the Chrome it launched (and Chrome's children that repeat the option),
 *    which carry `--user-data-dir=<directory>/PULSAR_CHROME`.
 *
 * The match is on those option tokens, never on the bare path: an editor, a
 * log viewer or a shell that merely names the directory is not a profile
 * holder, and this list authorizes a forced kill.
 *
 * `undefined` means the process table could not be read at all.
 */
async function profileHolders(directory: string): Promise<ProfileHolder[] | undefined> {
	const needles = [
		normalizeCommandLine(`-Dbrowser.profile.path=${directory}`),
		normalizeCommandLine(`--user-data-dir=${join(directory, CHROME_DATA_DIR)}`),
	];
	const self = process.pid;
	const holders: ProfileHolder[] = [];
	const holds = (commandLine: string): boolean => {
		const line = normalizeCommandLine(commandLine);
		return needles.some((needle) => line.includes(needle));
	};

	if (platform() === "win32") {
		const json = await capture("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-NoLogo",
			"-Command",
			"Get-CimInstance Win32_Process | Where-Object CommandLine | " +
				"Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
		]);
		if (json === undefined) return undefined;
		type Row = { ProcessId?: number; CommandLine?: string };
		let rows: Row[];
		try {
			const parsed = JSON.parse(json) as Row | Row[];
			// A single process would come back as a bare object, not a list.
			rows = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			return undefined;
		}
		for (const row of rows) {
			const pid = row?.ProcessId;
			const line = row?.CommandLine;
			if (typeof pid !== "number" || pid === self || typeof line !== "string") continue;
			if (holds(line)) holders.push({ commandLine: line, pid });
		}
		return holders;
	}

	const table = await capture("ps", ["-A", "-o", "pid=,args="]);
	if (table === undefined) return undefined;
	for (const line of table.split("\n")) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (match === null) continue;
		const pid = Number.parseInt(match[1] as string, 10);
		const commandLine = match[2] as string;
		if (!Number.isFinite(pid) || pid === self) continue;
		if (holds(commandLine)) holders.push({ commandLine, pid });
	}
	return holders;
}

/**
 * Make sure nothing is left holding [directory], and report whether that is
 * confirmed.
 *
 * A leftover exists whenever the JVM was killed before it finished closing its
 * browser — which the MCP SDK's transport does on its own, two seconds after
 * it closes stdin — so this sweep is the difference between "we stopped
 * asking" and "the profile is free".
 *
 * An unreadable process table is NOT a pass: a child exit proves nothing about
 * a Chrome the child may have orphaned, so the caller keeps the profile locked
 * and may try again.
 */
async function releaseProfile(directory: string): Promise<boolean> {
	const holders = await profileHolders(directory);
	if (holders === undefined) return false;
	if (holders.length === 0) return true;
	for (const holder of holders) await killTree(holder.pid);
	for (const holder of holders) await waitForExit(holder.pid, PROCESS_EXIT_TIMEOUT_MS);
	const left = await profileHolders(directory);
	return left !== undefined && left.length === 0;
}

// ---------------------------------------------------------------------------
// Owned endpoint
// ---------------------------------------------------------------------------

/**
 * The DevTools endpoint of the Chrome that owns [userDataDir].
 *
 * Chrome writes `DevToolsActivePort` (port, then the browser websocket path)
 * into its own user data directory once its listener is up, and the stale copy
 * of a previous run was removed before launch, so the file that appears here
 * belongs to the browser this driver just had launched. Nothing else is
 * consulted: a port discovered by scanning, or a `/json` listing from a
 * browser that merely answers on localhost, would not prove ownership.
 */
async function readOwnedEndpoint(userDataDir: string): Promise<string> {
	const marker = join(userDataDir, DEVTOOLS_PORT_FILE);
	const deadline = Date.now() + ENDPOINT_TIMEOUT_MS;
	for (;;) {
		let text: string | undefined;
		try {
			text = await readFile(marker, "utf8");
		} catch {
			text = undefined;
		}
		if (text !== undefined) {
			const [portLine = "", pathLine = ""] = text.split("\n");
			const port = Number.parseInt(portLine.trim(), 10);
			const wsPath = pathLine.trim();
			if (Number.isFinite(port) && port > 0 && wsPath.startsWith("/devtools/")) {
				return `ws://127.0.0.1:${port}${wsPath}`;
			}
		}
		if (Date.now() >= deadline) {
			return fail(
				"browser4_endpoint_unavailable",
				`The Browser4 browser did not publish a usable ${DEVTOOLS_PORT_FILE} in ${userDataDir} within ` +
					`${ENDPOINT_TIMEOUT_MS}ms, so the tab it drives cannot be identified. No other browser is attached.`,
			);
		}
		await sleep(100);
	}
}

/**
 * The one page whose live identity is the identity Browser4 reported for the
 * tab its session drives.
 *
 * Candidates are read-only probed, and anything but exactly one match is a
 * hard failure: attaching "the first page" of a browser that has more than one
 * would hand approved input to a tab nobody checked.
 */
async function bindOwnedPage(browser: Browser, expected: TabIdentity): Promise<Page> {
	const matches: Page[] = [];
	for (const candidate of await browser.pages()) {
		if (candidate.isClosed()) continue;
		let text: string;
		try {
			text = await candidate.evaluate(IDENTITY_SCRIPT);
		} catch {
			// A page that cannot be evaluated (closing, or a privileged target)
			// is not the session's tab.
			continue;
		}
		const seen = parseIdentity(text, "The candidate tab probe");
		if (seen.href === expected.href && seen.origin === expected.origin) matches.push(candidate);
	}
	if (matches.length !== 1) {
		return fail(
			"browser4_target_ambiguous",
			`${matches.length} tabs of the Browser4 browser match the document its session reported ` +
				`(${expected.href}); exactly one is required to bind native input to the approved target.`,
		);
	}
	return matches[0] as Page;
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

interface ToolResult {
	isError?: boolean;
	content?: Array<{ type?: string; text?: string }>;
}

/**
 * Strip the argument values Browser4 echoes back in a failure message.
 *
 * A failed call is reported as `"<tool> failed: <cause message or
 * TcException.expression>"`, and that expression is `ToolCall.pseudoExpression`
 * — `tab.evaluate_value(expression="…")` with each value shortened to twenty
 * characters. The message this driver raises travels on to the caller and into
 * whatever it records, so the quoted values are replaced here; the tool name,
 * the stable error code and the prose all survive.
 */
function redactValues(text: string): string {
	return text.replace(/="[^"]*"/g, '="…"');
}

function requireString(value: unknown, code: string, message: string): string {
	if (typeof value !== "string" || value.length === 0) fail(code, message);
	return value;
}

function requireFiniteNumber(value: unknown, code: string, message: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(code, message);
	return value;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Create a Browser4-backed engine driver for one private, persistent profile.
 */
export async function createBrowser4Driver(options: EngineOptions): Promise<EngineDriver> {
	const profileDirectory = resolve(
		requireString(options.profileDirectory, "bad_profile_directory", "profileDirectory must be a non-empty path"),
	);
	const viewport: Viewport = {
		height: requireFiniteNumber(options.viewport?.height, "bad_viewport", "viewport.height must be a number"),
		width: requireFiniteNumber(options.viewport?.width, "bad_viewport", "viewport.width must be a number"),
	};

	let releasedLock = false;
	/**
	 * Hand the profile lock back. Called exactly once, and ONLY when everything
	 * this driver owns is confirmed stopped — an unconfirmed shutdown keeps the
	 * lock so the profile is never reopened underneath a live Chrome.
	 */
	const releaseLock = (): void => {
		if (releasedLock) return;
		releasedLock = true;
		options.onClosed();
	};

	// Nothing has been launched yet, so every rejection below hands the lock
	// straight back.
	if (options.relayUrl?.trim()) {
		releaseLock();
		fail(
			"browser4_relay_unsupported",
			"Browser4 runs as this plugin's own stdio MCP server on a private profile; it has no endpoint to attach " +
				"to. Use the chrome-relay engine to drive a browser somebody else owns.",
		);
	}

	const userDataDir = join(profileDirectory, CHROME_DATA_DIR);
	const browser4Dir = join(profileDirectory, "browser4");
	const loggingPath = join(browser4Dir, "logging.xml");

	let runtime: InstalledRuntime;
	try {
		runtime = findRuntime();
		if (compareVersions(runtime.version, MIN_BUNDLE_VERSION) < 0) {
			fail(
				"browser4_runtime_too_old",
				`The Browser4 bundle at ${runtime.installDir} is ${runtime.version}; ${MIN_BUNDLE_VERSION} or newer is ` +
					"required, because only those honour `browser.profile.path` and would otherwise silently open a " +
					"shared pooled profile instead of this one.",
			);
		}
		assertCertificateVerification(runtime);
		// Nothing of ours may be running on this profile yet: a leftover Chrome
		// would publish the endpoint this driver is about to trust, and the
		// launch would bind to a browser nobody here started.
		const running = await profileHolders(profileDirectory);
		if (running === undefined) {
			fail(
				"browser4_process_table_unreadable",
				"The process table could not be read, so it cannot be established that no browser is already running " +
					`on ${profileDirectory}. Opening is refused rather than attaching to an unidentified browser.`,
			);
		}
		if (running.length > 0) {
			fail(
				"browser4_profile_busy",
				`${running.length} process(es) still hold ${profileDirectory} (pids ${running
					.map((holder) => holder.pid)
					.join(", ")}). A previous Browser4 session did not finish shutting down; retry once it has.`,
			);
		}
	} catch (error) {
		releaseLock();
		throw error;
	}

	let client: Client | undefined;
	let transport: StdioClientTransport | undefined;
	let cdpBrowser: Browser | undefined;
	/**
	 * True from the moment a child could exist. The transport drops its process
	 * handle (and with it `transport.pid`) as soon as the child closes, so a
	 * child that died during startup leaves no pid behind — the profile sweep
	 * keys off this flag, never off a pid, or a Chrome orphaned by a JVM that
	 * never finished starting would be reported as "nothing left running".
	 */
	let spawned = false;
	let jvmPid: number | undefined;
	let stderr = "";
	const stderrDetail = (): string => {
		// Redacted like a tool error: an uncaught JVM failure can print a message
		// that quotes the call it came from.
		const detail = redactValues(stderr.trim().slice(-STDERR_REPORT));
		return detail ? ` (browser4: ${detail})` : "";
	};

	/**
	 * Stop everything this driver owns and report whether every stop is
	 * confirmed.
	 *
	 * Closing the client ends the child's stdin, which is what the runner waits
	 * for: it returns from its stdio session and `AgenticContexts.shutdown()`
	 * closes the context and its browsers. A child that does not go away on its
	 * own is taken down with its whole tree, and the profile is swept either
	 * way, because an orphaned Chrome would still hold this directory.
	 */
	const teardown = async (): Promise<boolean> => {
		jvmPid ??= transport?.pid ?? undefined;
		if (cdpBrowser) {
			const connection = cdpBrowser;
			cdpBrowser = undefined;
			// Only this driver's own attachment. The browser belongs to the JVM,
			// which stops it below; disconnecting never closes it.
			await connection.disconnect().catch(() => undefined);
		}
		if (client || transport) {
			const stop = client ? client.close() : (transport as StdioClientTransport).close();
			client = undefined;
			transport = undefined;
			try {
				await withTimeout(stop, PROCESS_EXIT_TIMEOUT_MS, "browser4 server close");
			} catch {
				// The pid check below is what decides, not the close call.
			}
		}
		let jvmGone = await waitForExit(jvmPid, PROCESS_EXIT_TIMEOUT_MS);
		if (!jvmGone) {
			await killTree(jvmPid);
			jvmGone = await waitForExit(jvmPid, PROCESS_EXIT_TIMEOUT_MS);
		}
		// Nothing was ever spawned, so nothing of ours can be holding the
		// profile and there is nothing to sweep for.
		if (!spawned) return jvmGone;
		const profileFree = await releaseProfile(profileDirectory);
		return jvmGone && profileFree;
	};

	/** One MCP tool call. Never retried: this driver re-requests nothing. */
	const invoke = async (tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> => {
		const connected = client;
		if (connected === undefined) fail("browser_closed", "The Browser4 session is closed.");
		let result: ToolResult;
		try {
			result = (await connected.callTool(
				// `cache` is a transport control argument: the server consumes it
				// and never forwards it to an executor. Bypassing the shared result
				// cache is what makes this read a real read.
				{ arguments: { ...args, cache: false }, name: tool },
				undefined,
				{ timeout: timeoutMs },
			)) as unknown as ToolResult;
		} catch (error) {
			return fail("browser4_unreachable", `Browser4 tool ${tool} failed: ${describe(error)}${stderrDetail()}`);
		}
		const text = (result.content ?? [])
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("");
		// A failed tool answers `isError` with `ERROR: [CODE] message` as its
		// text, and that message can quote the call's own arguments back at us.
		if (result.isError === true) {
			fail("browser4_tool_error", `Browser4 tool ${tool} failed: ${redactValues(text) || "no detail"}`);
		}
		return text;
	};

	try {
		await mkdir(browser4Dir, { recursive: true });
		await writeFile(loggingPath, loggingConfig(), "utf8");
		// An empty owned `Default` stops `BrowserFileSystem.prepareUserDataDir`
		// from seeding this profile with the shared prototype's cookies,
		// extensions and logins. Existing profiles already have one; this
		// creates nothing and removes nothing there.
		await mkdir(join(userDataDir, CHROME_DEFAULT_PROFILE_DIR), { recursive: true });
		// A transient marker of a previous run, which upstream itself classes as
		// transient. It is removed so the endpoint read below cannot return the
		// address of a browser that is no longer there — no process holds this
		// profile, which was just established.
		await rm(join(userDataDir, DEVTOOLS_PORT_FILE), { force: true });

		const jvmOptions = [
			// stdout is the JSON-RPC stream: no log line and no stray `println`
			// may ever reach it. Both switches are the product's own.
			`-Dlogback.configurationFile=${loggingPath.replace(/\\/g, "/")}`,
			"-Dlogging.printlnPro.enabled=false",
			// The Pulsar SDK derives its app data root from `app.name`; the CLI
			// daemon launches with the same value so config, WebDB and caches land
			// in the user's normal ~/.browser4 rather than ~/.pulsar.
			"-Dapp.name=browser4",
			// THE isolation switch: B4Constants.BROWSER_PROFILE_PATH, read by
			// AbstractPulsarSession.createBoundDriver, which launches Chrome on a
			// BrowserProfile rooted here instead of a pooled SEQUENTIAL profile.
			`-Dbrowser.profile.path=${profileDirectory.replace(/\\/g, "/")}`,
			// The standard MCP server rejects a call that violates its published
			// spec, and the built-in specs are generated from the WebDriver
			// interface, so they disagree with what the executors actually read.
			// The executors do their own argument validation, which is the one
			// this driver is written against.
			"-Dmcp.validateArgs=false",
		];
		if (options.headless === false) {
			// `--headed` leaves the session without an explicit display mode, and
			// the shipped configuration defaults to HEADLESS; the system property
			// outranks it, so state the intent where it is actually read.
			jvmOptions.push("-Dbrowser.display.mode=GUI");
		}
		if (options.executablePath) {
			jvmOptions.push(`-Dchrome.path=${options.executablePath.replace(/\\/g, "/")}`);
		}
		const appDataDir = process.env.BROWSER4_APP_DATA_DIR?.trim();
		if (appDataDir) jvmOptions.push(`-Dapp.data.dir=${resolve(appDataDir).replace(/\\/g, "/")}`);

		const args = [
			...jvmOptions,
			// The wildcard classpath keeps the command line far below the Windows
			// 32k limit that an enumerated ~250-jar classpath would blow past.
			"-cp",
			join(runtime.libDir, "*"),
			RUNNER_CLASS,
			"--transport",
			"stdio",
			...(options.headless === undefined ? [] : [options.headless ? "--headless" : "--headed"]),
		];

		spawned = true;
		const started = new StdioClientTransport({
			args,
			command: runtime.javaPath,
			// A curated inherit list, not the whole environment: this child hosts
			// an agentic runtime and has no business seeing this process's model
			// provider keys.
			env: getDefaultEnvironment(),
			// Anything the JVM writes relative to its working directory lands
			// inside the profile rather than in the shared runtime install.
			cwd: browser4Dir,
			stderr: "pipe",
		});
		transport = started;
		// The only diagnostics channel the child has: logging is off, so a broken
		// bundle or a failed Chrome launch would otherwise be invisible. Kept in
		// memory, quoted in errors, never printed and never written to disk.
		started.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEEP);
		});
		client = new Client({ name: "dimension-browser", version: "0.1.0" }, { capabilities: {} });
		const connecting = client.connect(started);
		// `connect` spawns the child, and the transport forgets the process the
		// moment it closes — so the pid is taken while the handshake is still in
		// flight, not after it, or a child that died during startup would leave
		// nothing to wait for and nothing to kill.
		let handshakeSettled = false;
		const watch = (async () => {
			while (jvmPid === undefined && !handshakeSettled) {
				jvmPid = started.pid ?? undefined;
				if (jvmPid === undefined) await sleep(20);
			}
		})();
		try {
			await withTimeout(connecting, CONNECT_TIMEOUT_MS, "browser4 server start");
		} finally {
			handshakeSettled = true;
			jvmPid ??= started.pid ?? undefined;
		}
		await watch;
	} catch (error) {
		const confirmed = await teardown();
		const reason = `${describe(error)}${stderrDetail()}`;
		if (confirmed) {
			releaseLock();
			fail("browser4_start_failed", `The Browser4 MCP server failed to start: ${reason}`);
		}
		fail("browser4_start_leaked", `The Browser4 MCP server failed to start and could not be cleaned up: ${reason}`);
	}

	let attached: EngineDriver;
	try {
		// The one and only tool call: which document is the session's tab on?
		// It also materializes that tab, since the executor binds a driver on
		// first use. Read-only — it stamps nothing on the page, and the
		// `(<fn source>)()` form is what `evaluate_value` evaluates page-side.
		const identity = parseIdentity(
			await invoke(
				"evaluate_value",
				{ expression: `(${IDENTITY_SCRIPT.toString()})()` },
				READ_TIMEOUT_MS,
			),
			"The Browser4 tab probe",
		);

		// The browser is running now, so the command line that launched it can be
		// read instead of assumed.
		const holders = await profileHolders(profileDirectory);
		if (holders === undefined) {
			fail(
				"browser4_process_table_unreadable",
				"The process table could not be read, so the browser Browser4 launched cannot be identified or " +
					"checked. Opening is refused rather than attaching to an unverified browser.",
			);
		}
		const browserHolders = holders.filter((holder) =>
			normalizeCommandLine(holder.commandLine).includes(
				normalizeCommandLine(`--user-data-dir=${userDataDir}`),
			),
		);
		if (browserHolders.length === 0) {
			fail(
				"browser4_no_owned_browser",
				`No running browser carries --user-data-dir=${userDataDir}, so the tab the session reported cannot be ` +
					"matched to a browser this driver owns.",
			);
		}
		// The bundle gate above rejects a core whose default disables HTTPS
		// verification; this is the same boundary checked against the process
		// that actually exists, so a newer core that still emits the flag cannot
		// pass silently.
		const insecure = browserHolders.filter((holder) =>
			/--ignore-certificate-errors(?![a-z-])/.test(normalizeCommandLine(holder.commandLine)),
		);
		if (insecure.length > 0) {
			fail(
				"browser4_tls_verification_disabled",
				`The browser Browser4 launched for ${profileDirectory} runs with --ignore-certificate-errors (pid ` +
					`${insecure.map((holder) => holder.pid).join(", ")}), so HTTPS is not verified for this persistent ` +
					"profile. The session is shut down instead of used.",
			);
		}

		const endpoint = await readOwnedEndpoint(userDataDir);
		cdpBrowser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
		const page = await bindOwnedPage(cdpBrowser, identity);
		// Native, non-replaying input on the EXACT page Browser4 drives. The
		// backend keeps process ownership, so this attachment releases nothing:
		// the profile lock is handed back by `close()` below, and only once the
		// whole backend is confirmed stopped.
		attached = await createAttachedPageDriver(cdpBrowser, page, {
			onClosed: () => undefined,
			viewport,
		});
	} catch (error) {
		const confirmed = await teardown();
		if (confirmed) {
			releaseLock();
			throw error;
		}
		fail(
			"browser4_start_leaked",
			`The Browser4 session could not be initialized or cleaned up: ${describe(error)}${stderrDetail()}`,
		);
	}

	let closed = false;
	let closing: Promise<boolean> | undefined;

	/**
	 * Detach this driver's input channel, then stop the backend that owns the
	 * browser, and report whether every stop is confirmed.
	 */
	const shutdown = async (): Promise<boolean> => {
		// Never lets a detach failure decide the profile's fate; `teardown` does.
		await attached.close().catch(() => undefined);
		return await teardown();
	};

	return {
		async close(): Promise<void> {
			if (closed) return;
			// Cleared however it settles: a cached rejection would replay the same
			// stale failure forever instead of re-attempting the shutdown the
			// retained profile lock depends on.
			closing ??= shutdown().finally(() => { closing = undefined; });
			const confirmed = await closing;
			if (!confirmed) {
				// The lock stays held and this driver stays usable for another
				// attempt: a surviving JVM may still own a Chrome that holds the
				// profile directory open.
				fail(
					"browser4_shutdown_unconfirmed",
					"The Browser4 shutdown could not be confirmed; the profile stays locked. Close again to retry.",
				);
			}
			closed = true;
			releaseLock();
		},

		async elements(region: BrowserRegion, limit: number): Promise<string> {
			return await attached.elements(region, limit);
		},

		async prepare(action: BrowserAction, documentId: string): Promise<PreparedAction> {
			return await attached.prepare(action, documentId);
		},

		async screenshot(): Promise<Uint8Array> {
			return await attached.screenshot();
		},

		async snapshot(limit: number): Promise<string> {
			return await attached.snapshot(limit);
		},

		async state(): Promise<EngineState> {
			return await attached.state();
		},
	};
}
