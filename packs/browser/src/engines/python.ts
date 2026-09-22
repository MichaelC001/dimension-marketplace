import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launch, type Browser } from "puppeteer-core";
import type { BrowserAction, BrowserRegion } from "../contracts.js";
import { ELEMENTS_IN_REGION_SCRIPT, PAGE_TEXT_SCRIPT } from "./page-scripts.js";
import type { EngineDriver, EngineOptions, EngineState, PreparedAction } from "./types.js";

/**
 * Python engines (jev, browser-use) behind one standard MCP stdio worker.
 *
 * The worker is `src/engines/python/dim_browser_bridge`, an ordinary MCP server
 * whose tool list is narrowed on purpose: observe, prepare, dispatch, dispose,
 * shut down. It exposes no JavaScript and no raw CDP tool, so a model can never
 * reach a mutation that did not pass through the host's approval path. The two
 * fixed read-only DOM helpers from `page-scripts.ts` are handed over once, in
 * the initialization config file, never as a tool argument.
 *
 * Ownership differs per engine, and so does the confirmed-shutdown proof:
 *
 * * jev attaches through browser-harness, which has no profile isolation of its
 *   own — it connects to whatever Chrome it can find. This factory therefore
 *   launches a dedicated Chrome on the plugin's own profile directory with
 *   puppeteer-core (lifecycle and CDP endpoint only; every browser operation is
 *   performed by the jev library) and points the harness at it through the
 *   documented `BU_CDP_WS` endpoint plus a per-profile `BU_NAME` daemon. The
 *   user's own Chrome is never touched or discovered.
 * * browser-use launches and owns its Chrome itself, into the same private
 *   profile directory, and confirms the process is gone inside the worker.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// Bounds. Every call has a deadline; nothing here waits forever on a browser.
const CONNECT_TIMEOUT_MS = 60_000;
const OPEN_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
const DISPATCH_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 45_000;
const PROCESS_EXIT_TIMEOUT_MS = 15_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const STDERR_KEEP = 4096;
const STDERR_REPORT = 600;

const CHROME_ARGS = [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-background-networking",
	"--disable-breakpad",
	"--disable-domain-reliability",
	"--disable-sync",
	"--metrics-recording-only",
	"--no-pings",
	"--disable-features=Translate,MediaRouter,OptimizationHints",
];

const CHROME_PATHS: Record<string, string[]> = {
	win32: [
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		`${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
	],
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/microsoft-edge",
	],
};

const exists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

/** The bridge package directory, in both the source tree and the built app. */
const workerDirectory = async (): Promise<string> => {
	for (const candidate of [resolve(HERE, "python"), resolve(HERE, "..", "python")]) {
		if (await exists(join(candidate, "pyproject.toml"))) return candidate;
	}
	throw new Error("browser bridge is not installed: dim_browser_bridge was not found next to the engine");
};

/**
 * Interpreter for the bridge. Only an environment a human prepared on purpose
 * is ever used: an explicit `DIM_BROWSER_PYTHON`, or the package's own `.venv`.
 * Opening a browser never provisions, installs or downloads anything — when no
 * prepared environment exists the driver fails with the exact setup command.
 */
const interpreter = async (workerDir: string): Promise<{ command: string; args: string[] }> => {
	const module = ["-m", "dim_browser_bridge"];
	const explicit = process.env.DIM_BROWSER_PYTHON;
	if (explicit) {
		if (await exists(explicit)) return { command: explicit, args: module };
		throw new Error(`DIM_BROWSER_PYTHON points at ${explicit}, which does not exist`);
	}
	const venv =
		process.platform === "win32" ? join(workerDir, ".venv/Scripts/python.exe") : join(workerDir, ".venv/bin/python");
	if (await exists(venv)) return { command: venv, args: module };
	throw new Error(
		`the Python browser bridge has no prepared environment: ${venv} does not exist. ` +
			`Create it once, by hand: \`uv sync --python 3.12\` in ${workerDir}, where the pins and the ` +
			"lockfile live. Alternatively point DIM_BROWSER_PYTHON at an interpreter that already has " +
			"this package's pinned dependencies. " +
			"Opening a browser never installs dependencies.",
	);
};

/**
 * Everything needed to spawn the worker, resolved before anything is launched.
 */
const launchSpec = async (): Promise<{ workerDir: string; command: string; args: string[] }> => {
	const workerDir = await workerDirectory();
	return { workerDir, ...(await interpreter(workerDir)) };
};

const chromeExecutable = async (explicit?: string): Promise<string> => {
	if (explicit) return explicit;
	const configured = process.env.DIM_BROWSER_CHROME || process.env.CHROME_PATH;
	if (configured && (await exists(configured))) return configured;
	for (const candidate of CHROME_PATHS[process.platform] ?? []) {
		if (candidate && (await exists(candidate))) return candidate;
	}
	throw new Error("no Chromium-family browser was found; set executablePath or DIM_BROWSER_CHROME");
};

// `Promise.withResolvers` is not in this package's ES2022 lib, so the executor
// form is the only typed way to build these two timers.
const withTimeout = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([work, expiry]);
	} finally {
		clearTimeout(timer);
	}
};

/** True once the pid is gone. EPERM means someone else owns it: still alive. */
const waitForExit = async (pid: number | undefined | null, ms: number): Promise<boolean> => {
	if (!pid) return true;
	const deadline = Date.now() + ms;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		}
		if (Date.now() >= deadline) return false;
		await new Promise<void>(done => setTimeout(done, 100));
	}
};

interface ToolResult {
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
}

/** JSON body of a bridge tool result; a tool error becomes a thrown error. */
const readResult = <T>(result: ToolResult, name: string): T => {
	const text = (result.content ?? [])
		.filter(part => part.type === "text" && typeof part.text === "string")
		.map(part => part.text as string)
		.join("");
	if (result.isError) throw new Error(text || `${name} failed`);
	return JSON.parse(text || "{}") as T;
};

export async function createPythonDriver(
	engine: "jev" | "browser-use",
	options: EngineOptions,
): Promise<EngineDriver> {
	// A missing bridge or an unprepared Python environment fails before anything
	// is launched, so the profile lock is released on a confirmed no-op launch.
	const { workerDir, command, args } = await launchSpec().catch((error: Error) => {
		options.onClosed();
		throw new Error(`${engine} engine failed to start: ${error.message}`);
	});
	const userDataDir = join(options.profileDirectory, "chrome");
	const harnessHome = join(options.profileDirectory, "harness");
	const configPath = join(options.profileDirectory, "bridge", `config-${randomUUID()}.json`);

	let chrome: Browser | undefined;
	let chromeProcess: ReturnType<Browser["process"]> | undefined;
	let transport: StdioClientTransport | undefined;
	let client: Client | undefined;
	let workerPid: number | undefined;
	let bridgeAsked = false;
	let bridgeStopped = false;
	let stderr = "";

	/**
	 * Stop everything this driver owns and report whether every stop is
	 * confirmed. An unconfirmed stop keeps the caller's profile lock, and each
	 * step remembers its own outcome so a retry only re-checks what is unclear.
	 */
	const teardown = async (): Promise<boolean> => {
		workerPid ??= transport?.pid ?? undefined;
		if (client && !bridgeStopped) {
			bridgeAsked = true;
			try {
				const report = (await client.callTool({ name: "shutdown", arguments: {} }, undefined, {
					timeout: SHUTDOWN_TIMEOUT_MS,
				})) as unknown as ToolResult;
				bridgeStopped = readResult<{ ok?: boolean }>(report, "shutdown").ok === true;
			} catch {
				bridgeStopped = false;
			}
		} else if (!bridgeAsked && !client) {
			// The worker never connected, so it owns nothing to release.
			bridgeStopped = true;
		}
		if (client || transport) {
			const stop = client ? client.close() : (transport as StdioClientTransport).close();
			client = undefined;
			transport = undefined;
			try {
				await withTimeout(stop, PROCESS_EXIT_TIMEOUT_MS, "bridge worker close");
			} catch {
				// The pid check below is what decides, not the close call.
			}
		}
		const workerGone = await waitForExit(workerPid, PROCESS_EXIT_TIMEOUT_MS);
		if (chrome) {
			chromeProcess = chrome.process() ?? undefined;
			try {
				await withTimeout(chrome.close(), PROCESS_EXIT_TIMEOUT_MS, "chrome close");
			} catch {
				chromeProcess?.kill("SIGKILL");
			}
			chrome = undefined;
		}
		const chromeGone = chromeProcess ? await waitForExit(chromeProcess.pid, PROCESS_EXIT_TIMEOUT_MS) : true;
		const confirmed = bridgeStopped && workerGone && chromeGone;
		await rm(configPath, { force: true }).catch(() => {});
		return confirmed;
	};

	try {
		await mkdir(dirname(configPath), { recursive: true });
		await mkdir(userDataDir, { recursive: true });

		let cdpEndpoint: string | undefined;
		if (engine === "jev") {
			// browser-harness has no launch path that isolates a profile, so the
			// dedicated automation Chrome is launched here and handed over as an
			// explicit endpoint. puppeteer-core is used for nothing else.
			chrome = await withTimeout(
				launch({
					executablePath: await chromeExecutable(options.executablePath),
					userDataDir,
					headless: options.headless ?? true,
					defaultViewport: null,
					dumpio: false,
					args: CHROME_ARGS,
				}),
				CONNECT_TIMEOUT_MS,
				"chrome launch",
			);
			cdpEndpoint = chrome.wsEndpoint();
		}

		await writeFile(
			configPath,
			JSON.stringify({
				engine,
				viewport: options.viewport,
				headless: options.headless ?? null,
				executablePath: options.executablePath ?? null,
				userDataDir,
				profileName: "Default",
				// Strictly below the caller's deadline, so the worker always
				// finishes its own cleanup before this side gives up on it.
				openTimeout: (OPEN_TIMEOUT_MS - SHUTDOWN_TIMEOUT_MS) / 1000,
				callTimeout: READ_TIMEOUT_MS / 1000,
				// The only scripts the worker will ever evaluate, fixed at
				// initialization and identical to the ones the other engines run.
				scripts: {
					pageText: PAGE_TEXT_SCRIPT.toString(),
					elementsInRegion: ELEMENTS_IN_REGION_SCRIPT.toString(),
				},
			}),
			"utf8",
		);

		const environment: Record<string, string> = {
			// A curated inherit list, not the whole environment: this worker
			// drives a browser and has no business seeing unrelated API keys.
			...getDefaultEnvironment(),
			DIM_BROWSER_BRIDGE_CONFIG: configPath,
			PYTHONPATH: workerDir,
			PYTHONUNBUFFERED: "1",
			PYTHONDONTWRITEBYTECODE: "1",
			// One harness daemon per profile, with its own private state dirs, so
			// two profiles never share a socket, a tab or a browser.
			BU_NAME: `dim-${createHash("sha1").update(options.profileDirectory).digest("hex").slice(0, 12)}`,
			BH_HOME: harnessHome,
			BH_CONFIG_DIR: join(harnessHome, "config"),
			BH_RUNTIME_DIR: join(harnessHome, "runtime"),
			BH_TMP_DIR: join(harnessHome, "tmp"),
			BH_AGENT_WORKSPACE: join(harnessHome, "workspace"),
			BH_UPDATE_CHECK: "0",
			BH_OPEN_LIVE_URL: "0",
			// No telemetry, no cloud sync, no bundled extension downloads.
			ANONYMIZED_TELEMETRY: "false",
			BROWSER_USE_CLOUD_SYNC: "false",
			BROWSER_USE_DISABLE_EXTENSIONS: "1",
			BROWSER_USE_CONFIG_DIR: join(options.profileDirectory, "browseruse"),
			BROWSER_USE_LOGGING_LEVEL: "error",
			CDP_LOGGING_LEVEL: "ERROR",
		};
		if (cdpEndpoint) environment.BU_CDP_WS = cdpEndpoint;

		transport = new StdioClientTransport({ command, args, env: environment, cwd: workerDir, stderr: "pipe" });
		// Startup diagnostics only: a missing interpreter or an unsynced
		// environment is otherwise invisible. Never printed, never logged.
		transport.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEEP);
		});
		client = new Client({ name: "dimension-browser", version: "0.1.0" }, { capabilities: {} });
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "bridge worker start");
		workerPid = transport.pid ?? undefined;
		// A tool failure arrives as an error result, not as a rejection.
		const opened = (await client.callTool({ name: "open", arguments: {} }, undefined, {
			timeout: OPEN_TIMEOUT_MS,
		})) as unknown as ToolResult;
		readResult(opened, "open");
	} catch (error) {
		const released = await teardown();
		const detail = stderr.trim().slice(-STDERR_REPORT);
		const reason = `${(error as Error).message}${detail ? ` (bridge: ${detail})` : ""}`;
		if (released) {
			// Nothing this driver launched is still running, so the profile is free.
			options.onClosed();
			throw new Error(`${engine} engine failed to start: ${reason}`);
		}
		throw new Error(`${engine} engine failed to start and could not be cleaned up: ${reason}`);
	}

	const connected = client;
	const call = async <T>(name: string, args: Record<string, unknown>, timeout: number): Promise<T> => {
		const result = (await connected.callTool({ name, arguments: args }, undefined, {
			timeout,
		})) as unknown as ToolResult;
		return readResult<T>(result, name);
	};

	let closed = false;
	let closing: Promise<boolean> | undefined;

	return {
		async state(): Promise<EngineState> {
			return await call<EngineState>("state", {}, READ_TIMEOUT_MS);
		},
		async screenshot(): Promise<Uint8Array> {
			const { data } = await call<{ data: string }>("screenshot", {}, SCREENSHOT_TIMEOUT_MS);
			const bytes = Buffer.from(data, "base64");
			if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error("screenshot exceeds the frame size limit");
			return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		},
		async snapshot(limit: number): Promise<string> {
			const { text } = await call<{ text: string }>("snapshot", { limit }, READ_TIMEOUT_MS);
			return text;
		},
		async elements(region: BrowserRegion, limit: number): Promise<string> {
			const { text } = await call<{ text: string }>("elements", { region, limit }, READ_TIMEOUT_MS);
			return text;
		},
		async prepare(action: BrowserAction, documentId: string): Promise<PreparedAction> {
			const { token } = await call<{ token: string }>("prepare", { action, documentId }, READ_TIMEOUT_MS);
			let spent = false;
			return {
				async dispatch(): Promise<void> {
					if (spent) throw new Error("prepared action was already dispatched");
					spent = true;
					// The worker pops the token before touching the page, so a
					// failure here can never be retried into a second mutation.
					await call("dispatch", { token }, DISPATCH_TIMEOUT_MS);
				},
				async dispose(): Promise<void> {
					if (spent) return;
					spent = true;
					await call("dispose", { token }, READ_TIMEOUT_MS).catch(() => {});
				},
			};
		},
		async close(): Promise<void> {
			if (closed) return;
			// Cleared however it settles: a cached rejection would make every later
			// close replay it instead of retrying the shutdown.
			closing ??= teardown().finally(() => { closing = undefined; });
			const confirmed = await closing;
			if (!confirmed) {
				throw new Error(`${engine} engine shutdown could not be confirmed; the profile stays locked`);
			}
			closed = true;
			options.onClosed();
		},
	};
}
