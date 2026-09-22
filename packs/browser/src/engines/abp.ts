import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { BrowserAction, BrowserRegion, Viewport } from "../contracts.js";
import { ELEMENTS_IN_REGION_SCRIPT, PAGE_TEXT_SCRIPT } from "./page-scripts.js";
import type { EngineDriver, EngineOptions, EngineState, PreparedAction } from "./types.js";
import { fail } from "../store.js";

/**
 * Driver for ABP — the Agent Browser Protocol browser
 * (github.com/theredsix/agent-browser-protocol, default branch `dev`).
 *
 * ABP is a Chromium fork that embeds an HTTP server in the browser process, so
 * this driver owns one `abp` process per profile and speaks plain JSON to
 * `http://127.0.0.1:<port>/api/v1`. There is no SDK dependency: the wire
 * protocol is stable REST, and the npm wrapper's launcher would fight us for
 * process ownership (it picks its own port and its own throwaway profile).
 *
 * Two properties of the engine shape this driver:
 *
 * 1. The pointer/keyboard surface is COORDINATE-ONLY. There is no selector or
 *    element-handle click. A `selector` action is therefore lowered to a point
 *    by one read-only `execute` call, and that point is the immutable target.
 * 2. Between actions ABP pauses JavaScript and virtual time (execution
 *    control, on unless `--abp-disable-pause`). A coordinate resolved from a
 *    paused document cannot be invalidated by script or animation before the
 *    input is delivered — which is why re-resolving a selector at dispatch
 *    time is both unnecessary and forbidden here.
 *
 * Licensing is two-layered and not contradictory: the npm wrapper is MIT, the
 * native binary is a BSD-3-Clause Chromium derivative (`LICENSE`,
 * `LICENSE.abp`). Redistributing the binary carries the BSD-3 notice
 * obligations; this file ships neither.
 *
 * REFUSED, 2026-09-22. That embedded HTTP server is the reason this engine is
 * not offered: it authenticates nothing. `AbpHttpServer::HandleRequestOnUI`
 * drops every request header before the REST controller sees the body, and the
 * controller parses any body as JSON, so a `text/plain` cross-origin POST from
 * an ordinary web page reaches `POST /api/v1/tabs` -> `CreateTab` -> `Navigate`
 * (and `POST /api/v1/browser/shutdown`) with no id, no token and no readable
 * response needed. A page could therefore drive a browser holding real logins
 * WITHOUT this pack's approval ledger ever being consulted. The reviewed
 * switches (`abp_switches.cc`: port, config, pause, session dir, window, zoom,
 * timing) expose no authentication, no Origin policy and no private transport,
 * and an ephemeral port is obscurity, not authorization. Until upstream can
 * authenticate its control routes, launching this browser at all is the unsafe
 * act, so the driver refuses before anything is spawned.
 */

/** `--user-data-dir`, the private recording dir and the config all live here. */
const ENGINE_SUBDIR = "abp";

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 150;
const STATUS_TIMEOUT_MS = 2_000;
const READ_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
const MUTATION_TIMEOUT_MS = 60_000;
const NAVIGATE_TIMEOUT_MS = 120_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 8_000;
const KILL_GRACE_MS = 5_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Every action endpoint returns before+after screenshots whether or not they
 * were asked for — the native build has no "skip screenshot" switch (the npm
 * wrapper's `screenshot.area: "none"` is not implemented in
 * `abp_action_context.cc`). Reads and mutations therefore ask for the cheapest
 * possible encode, since their images are discarded; only `screenshot()` asks
 * for the real PNG.
 */
const DISCARDED_SCREENSHOT = { format: "jpeg", quality: 1, markup: [] as string[] };

/** Resolves immediately in `AbpController::WaitFor`; documented in `plans/API.md`. */
const WAIT_IMMEDIATE = { type: "immediate" };

/**
 * Refuse to launch. The profile lock is released because nothing was started:
 * no process, no directory, no port.
 */
function refuse(options: EngineOptions): never {
	options.onClosed();
	fail(
		"abp_unauthenticated_control_port",
		"The ABP browser is not available: it exposes an unauthenticated local control port, so any web page it visits could drive it " +
			"(open tabs, navigate, shut it down) without this pack's approval. Upstream offers no authentication, origin check or private " +
			"transport for those routes, so a browser holding your logins is not started. Use the chromium, chrome-relay, jev or browser-use engine.",
	);
}

/**
 * Characters that ABP's key table names rather than spells. Everything else in
 * the contract's key space — single letters, digits, and the named keys — is
 * matched case-insensitively by `GetKeyInfo`, so it is passed through as-is.
 * Without this mapping a symbol key falls into ABP's "unknown key, using
 * as-is" branch, which produces a keydown with virtual key 0 and inserts
 * nothing.
 */
const KEY_NAMES: Record<string, string> = {
	" ": "Space",
	",": "Comma",
	".": "Period",
	"/": "Slash",
	"\\": "Backslash",
	";": "Semicolon",
	"'": "Quote",
	"[": "BracketLeft",
	"]": "BracketRight",
	"-": "Minus",
	"=": "Equal",
	"`": "Backquote",
};

/** Why a selector could not become a clickable point, in the caller's words. */
const LOCATE_FAILURES: Record<string, string> = {
	invalid_selector: "is not a valid CSS selector",
	not_found: "matched no element",
	not_visible: "matched an element with no layout box",
	outside_viewport: "matched an element outside the viewport; scroll it into view first",
	obscured: "matched an element covered by another element at its centre point",
};

/**
 * Chromium switches that keep an owned profile off the network when the page
 * did not ask: no crash upload, no component/variations fetch, no sync, no
 * hyperlink auditing, no domain reliability beacons, no bundled extensions or
 * default apps. `CalculateNativeWinOcclusion` is disabled because an occluded
 * window stops producing compositor frames on Windows, and every ABP
 * screenshot is a view snapshot of that window.
 */
const HARDENING_ARGS = [
	"--no-first-run",
	"--no-default-browser-check",
	"--no-pings",
	"--disable-background-networking",
	"--disable-breakpad",
	"--disable-client-side-phishing-detection",
	"--disable-component-update",
	"--disable-default-apps",
	"--disable-domain-reliability",
	"--disable-extensions",
	"--disable-sync",
	"--use-mock-keychain",
	"--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CalculateNativeWinOcclusion",
];

/** Relative path of the browser binary inside the npm package's `browsers/`. */
const PLATFORM_EXECUTABLE: Record<string, string> = {
	win32: "abp-chrome/abp.exe",
	linux: "abp-chrome/abp",
	darwin: "ABP.app/Contents/MacOS/ABP",
};

/**
 * ABP is its own Chromium build, not a Chrome install: a stock `chrome.exe`
 * has none of the `--abp-*` switches and would never open the API port. The
 * binary is therefore resolved from an ABP-specific source only, and never
 * from the host's generic Chrome executable setting.
 */
const ABP_EXECUTABLE_ENV = "DIMENSION_BROWSER_ABP_EXECUTABLE";

const INSTALL_HINT =
	`Set ${ABP_EXECUTABLE_ENV} (or upstream's ABP_BROWSER_PATH) to an installed \`abp\` binary, or install the browser with ` +
	"`npm i agent-browser-protocol@0.1.11`, whose postinstall downloads the matching native build. " +
	"The ABP engine cannot run on a stock Chrome/Chromium executable.";

class AbpError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "AbpError";
		this.status = status;
		this.code = code;
	}
}

interface ActionEnvelope<T = unknown> {
	action_id?: string;
	tab_id?: string;
	tab_changed?: boolean;
	original_tab_id?: string;
	result?: T;
	events?: { type?: string }[];
	screenshot_after?: { data?: string; width?: number; height?: number; format?: string };
}

interface TabSummary {
	id: string;
	url?: string;
	title?: string;
	active?: boolean;
}

/** What one read of the live document tells us. Produced by `PROBE_SCRIPT`. */
interface DocumentProbe {
	url: string;
	title: string;
	/** `performance.timeOrigin`, unique per document: a reload mints a new one. */
	origin: number;
	viewport: Viewport;
}

/**
 * Reads the live document's identity, title, url and true viewport in one
 * evaluation. `performance.timeOrigin` is the document identity: it is minted
 * when the document is created, so a reload or a same-URL navigation changes
 * it, while a same-document (fragment/pushState) navigation — which really is
 * the same document — does not.
 */
const PROBE_SCRIPT = (): string =>
	JSON.stringify({
		url: document.location.href,
		title: document.title,
		origin: performance.timeOrigin,
		width: Math.round(window.innerWidth),
		height: Math.round(window.innerHeight),
	});

/**
 * Lowers a CSS selector to a viewport point, read-only. Returns the reason it
 * could not rather than throwing, so the caller reports a precise failure
 * instead of a script exception. `origin` rides along so the point and the
 * document it was measured in are observed atomically.
 *
 * Nothing about the element's content is returned — only geometry — so a
 * password field's value cannot leak through the resolve path.
 */
const LOCATE_SCRIPT = (selector: string): string => {
	let el: Element | null;
	try {
		el = document.querySelector(selector);
	} catch {
		return JSON.stringify({ ok: false, reason: "invalid_selector", origin: performance.timeOrigin });
	}
	if (!el) return JSON.stringify({ ok: false, reason: "not_found", origin: performance.timeOrigin });
	const rect = el.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) {
		return JSON.stringify({ ok: false, reason: "not_visible", origin: performance.timeOrigin });
	}
	const x = rect.left + rect.width / 2;
	const y = rect.top + rect.height / 2;
	const width = window.innerWidth;
	const height = window.innerHeight;
	if (x < 0 || y < 0 || x >= width || y >= height) {
		// ABP input is viewport-relative; scrolling it into view would be a
		// mutation, which target resolution is not allowed to perform.
		return JSON.stringify({ ok: false, reason: "outside_viewport", origin: performance.timeOrigin });
	}
	// A coordinate click lands on whatever paints on top. If that is not the
	// element or something in its own subtree chain, the click would hit an
	// overlay instead, which is exactly the wrong thing to do silently.
	const top = document.elementFromPoint(x, y);
	const hits = top !== null && (top === el || el.contains(top) || top.contains(el));
	if (!hits) return JSON.stringify({ ok: false, reason: "obscured", origin: performance.timeOrigin });
	return JSON.stringify({ ok: true, x: Math.round(x), y: Math.round(y), origin: performance.timeOrigin });
};

/**
 * Serialize a compiled helper into a self-invoking expression for
 * `Runtime.evaluate`. Arguments are JSON literals, never concatenated source,
 * and the function bodies are the fixed compiled helpers in this package — no
 * caller-supplied JavaScript ever reaches the page.
 */
function callScript(fn: (...args: never[]) => string, ...args: unknown[]): string {
	return `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(",")})`;
}

/**
 * The ABP-specific sources win over the shared `executablePath`, which on this
 * runtime names the host's Chrome install and would be a wrong answer here.
 * The explicit option is still honored when nothing ABP-specific is
 * configured, so a direct factory test can point at a build of its own.
 */
function resolveExecutable(explicit: string | undefined): string {
	const configured = process.env[ABP_EXECUTABLE_ENV] ?? process.env.ABP_BROWSER_PATH ?? explicit;
	if (configured) return configured;
	const relative = PLATFORM_EXECUTABLE[process.platform];
	if (!relative) throw new Error(`The ABP engine has no published build for ${process.platform}. ${INSTALL_HINT}`);
	try {
		const manifest = createRequire(import.meta.url).resolve("agent-browser-protocol/package.json");
		return join(dirname(manifest), "browsers", relative);
	} catch {
		throw new Error(`The ABP browser binary could not be located. ${INSTALL_HINT}`);
	}
}

/**
 * Take a loopback port from the OS and hand it straight to the browser. ABP
 * binds `--abp-port` at startup; a port that was free a moment ago is the same
 * guarantee the upstream launcher gives itself.
 */
function reservePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (address === null || typeof address === "string") {
			server.close();
			reject(new Error("Could not reserve a loopback port for the ABP browser"));
			return;
		}
		const { port } = address;
		server.close(error => (error ? reject(error) : resolve(port)));
	});
	return promise;
}

/** `{"error":"…"}` from the router, `{"error":"CODE","message":"…"}` from an action. */
function describeFailure(status: number, body: string): AbpError {
	try {
		const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
		const code = typeof parsed.error === "string" ? parsed.error : undefined;
		const message = typeof parsed.message === "string" ? parsed.message : undefined;
		if (code && message) return new AbpError(`ABP ${code}: ${message}`, status, code);
		if (code) return new AbpError(`ABP request failed (${status}): ${code}`, status, code);
	} catch {
		// Not JSON — fall through to the raw body.
	}
	return new AbpError(`ABP request failed (${status}): ${body.slice(0, 200)}`, status);
}

export async function createAbpDriver(options: EngineOptions): Promise<EngineDriver> {
	refuse(options);
	// eslint-disable-next-line no-unreachable -- retained below: the transport is
	// complete and correct; only the upstream authorization gap blocks it.
	const home = join(options.profileDirectory, ENGINE_SUBDIR);
	const userDataDir = join(home, "user-data");
	// ABP's session directory is its action journal — a SQLite row per action
	// whose `params` column is the raw payload, including typed text. It is
	// created regardless (the network database is opened from it at startup),
	// so it is kept private AND the journal itself is switched off below.
	const sessionDir = join(home, "session");
	const configPath = join(home, "abp-config.json");

	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		options.onClosed();
	};

	let executable: string;
	let port: number;
	try {
		executable = resolveExecutable(options.executablePath);
		await mkdir(userDataDir, { recursive: true, mode: 0o700 });
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		// `history.enabled:false` is the recording kill switch: AbpHistoryController
		// captures it at construction and every RecordAction/RecordEvent returns
		// early when it is false, so no action parameters — no typed text, no
		// before/after frames — are ever written to disk.
		await writeFile(
			configPath,
			JSON.stringify({
				history: {
					enabled: false,
					database_path: join(sessionDir, "history.db"),
					screenshots: { enabled: false, directory: join(sessionDir, "screenshots") },
				},
			}),
			{ mode: 0o600 },
		);
		port = await reservePort();
	} catch (error) {
		// Nothing was launched, so the profile is not held by anyone.
		release();
		throw error;
	}

	const args = [
		`--abp-port=${port}`,
		`--abp-config=${configPath}`,
		`--abp-session-dir=${sessionDir}`,
		`--abp-window-size=${options.viewport.width},${options.viewport.height}`,
		`--user-data-dir=${userDataDir}`,
		...HARDENING_ARGS,
	];
	// Undefined keeps ABP's supported headed default. `--headless=new` is wired
	// through, but upstream lists "Full headless support" as not yet
	// implemented, so an explicit request is honored and nothing more is claimed.
	if (options.headless === true) args.push("--headless=new");

	let child: ChildProcess;
	try {
		child = spawn(executable, args, { stdio: "ignore", windowsHide: true, detached: false });
	} catch (error) {
		release();
		throw error;
	}

	let exited = false;
	const exitWatchers = new Set<() => void>();
	const markExited = (): void => {
		if (exited) return;
		exited = true;
		for (const watcher of exitWatchers) watcher();
		exitWatchers.clear();
		// The owned process is confirmed gone, so the profile is free.
		release();
	};
	child.once("exit", markExited);
	// `error` can also mean a failed kill/send on a LIVE child. Only a spawn
	// failure with no PID proves that no process ever acquired the profile.
	child.on("error", () => {
		if (child.pid === undefined) markExited();
	});

	const waitForExit = async (timeoutMs: number): Promise<boolean> => {
		if (exited) return true;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => {
			exitWatchers.delete(watcher);
			resolve(false);
		}, timeoutMs);
		const watcher = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		exitWatchers.add(watcher);
		return await promise;
	};

	const base = `http://127.0.0.1:${port}/api/v1`;

	async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
		let response: Response;
		try {
			response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		} catch (error) {
			if (exited) throw new AbpError("The ABP browser process is no longer running", 0);
			throw error;
		}
		const body = await response.text();
		if (!response.ok) throw describeFailure(response.status, body);
		return (body.length === 0 ? {} : JSON.parse(body)) as T;
	}

	async function post<T>(path: string, payload: unknown, timeoutMs: number): Promise<T> {
		return await request<T>(
			path,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
			timeoutMs,
		);
	}

	/** Stop the owned process, bounded. Resolves true only on a confirmed exit. */
	const stop = async (): Promise<boolean> => {
		if (exited) return true;
		try {
			await post("/browser/shutdown", { timeout_ms: SHUTDOWN_REQUEST_TIMEOUT_MS }, SHUTDOWN_REQUEST_TIMEOUT_MS);
		} catch {
			// The browser may already be dying, or its HTTP server may never have
			// come up. Either way the escalation below is the answer.
		}
		if (await waitForExit(SHUTDOWN_GRACE_MS)) return true;
		child.kill();
		if (await waitForExit(KILL_GRACE_MS)) return true;
		child.kill("SIGKILL");
		return await waitForExit(KILL_GRACE_MS);
	};

	const deadline = Date.now() + READY_TIMEOUT_MS;
	let ready = false;
	while (Date.now() < deadline && !exited) {
		try {
			const status = await request<{ data?: { ready?: boolean } }>("/browser/status", {}, STATUS_TIMEOUT_MS);
			if (status.data?.ready === true) {
				ready = true;
				break;
			}
		} catch {
			// Not listening yet.
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, READY_POLL_INTERVAL_MS);
		await promise;
	}
	if (!ready) {
		const cause = new Error(
			exited
				? `The ABP browser at ${executable} exited before becoming ready (code ${child.exitCode ?? "unknown"})`
				: `The ABP browser at ${executable} was not ready within ${READY_TIMEOUT_MS}ms`,
		);
		// A process we could not confirm dead may still hold the profile, so the
		// lock is deliberately NOT released in that case.
		await stop();
		throw cause;
	}

	let tabId: string;
	try {
		const tabs = await request<TabSummary[]>("/tabs", {}, READ_TIMEOUT_MS);
		const existing = tabs.find(tab => tab.active) ?? tabs[0];
		tabId = existing ? existing.id : (await post<{ id: string }>("/tabs", {}, READ_TIMEOUT_MS)).id;
	} catch (error) {
		await stop();
		throw error;
	}

	const tabPath = `/tabs/${encodeURIComponent(tabId)}`;

	/**
	 * One `execute` round trip. ABP runs it through the full action lifecycle
	 * (resume → evaluate → settle → pause), so the page is left frozen again
	 * when it returns — which is what makes a resolved coordinate stay valid.
	 */
	async function evaluate(script: string, timeoutMs: number): Promise<string> {
		const envelope = await post<ActionEnvelope<{ type?: string; value?: unknown }>>(
			`${tabPath}/execute`,
			{ script, wait_until: WAIT_IMMEDIATE, screenshot: DISCARDED_SCREENSHOT },
			timeoutMs,
		);
		const result = envelope.result;
		if (!result || result.type !== "string" || typeof result.value !== "string") {
			throw new AbpError(`ABP returned a ${result?.type ?? "missing"} value where a string was expected`, 0);
		}
		return result.value;
	}

	async function probe(): Promise<DocumentProbe> {
		const raw = await evaluate(callScript(PROBE_SCRIPT), READ_TIMEOUT_MS);
		const parsed = JSON.parse(raw) as { url: string; title: string; origin: number; width: number; height: number };
		return {
			url: parsed.url,
			title: parsed.title,
			origin: parsed.origin,
			// The measured box, not the requested one: `--abp-window-size` sizes the
			// window, so the content box is whatever is left after browser chrome,
			// and the screenshot is scaled to exactly this.
			viewport: { width: parsed.width, height: parsed.height },
		};
	}

	/** Read the document and refuse to go on if it is not the approved one. */
	async function requireDocument(documentId: string): Promise<DocumentProbe> {
		const current = await probe();
		if (`${tabId}|${current.origin}` !== documentId) {
			throw new AbpError(
				`The page changed since this action was prepared (expected document ${documentId}, found ${tabId}|${current.origin})`,
				409,
				"STALE_DOCUMENT",
			);
		}
		return current;
	}

	async function locate(selector: string, documentId: string): Promise<{ x: number; y: number }> {
		const raw = await evaluate(callScript(LOCATE_SCRIPT, selector), READ_TIMEOUT_MS);
		const parsed = JSON.parse(raw) as { ok: boolean; reason?: string; x?: number; y?: number; origin: number };
		// The element and the document were observed in the same evaluation, so a
		// navigation between the approval and the measurement cannot slip through.
		if (`${tabId}|${parsed.origin}` !== documentId) {
			throw new AbpError(
				`The page changed while resolving ${JSON.stringify(selector)} (expected document ${documentId})`,
				409,
				"STALE_DOCUMENT",
			);
		}
		if (!parsed.ok || parsed.x === undefined || parsed.y === undefined) {
			const reason = parsed.reason ?? "unresolved";
			throw new AbpError(
				`${JSON.stringify(selector)} ${LOCATE_FAILURES[reason] ?? `could not be resolved (${reason})`}`,
				404,
				"SELECTOR_NOT_FOUND",
			);
		}
		return { x: parsed.x, y: parsed.y };
	}

	/** One native action call. Every one of these is a real browser mutation. */
	async function act<T>(path: string, payload: Record<string, unknown>, timeoutMs: number): Promise<ActionEnvelope<T>> {
		return await post<ActionEnvelope<T>>(`${tabPath}/${path}`, { ...payload, screenshot: DISCARDED_SCREENSHOT }, timeoutMs);
	}

	return {
		async state(): Promise<EngineState> {
			const current = await probe();
			return {
				url: current.url,
				title: current.title,
				documentId: `${tabId}|${current.origin}`,
				viewport: current.viewport,
			};
		},

		async screenshot(): Promise<Uint8Array> {
			const envelope = await post<ActionEnvelope>(
				`${tabPath}/screenshot`,
				// No markup overlays: the frame must be what a person would see.
				{ wait_until: WAIT_IMMEDIATE, screenshot: { format: "png", markup: [] } },
				SCREENSHOT_TIMEOUT_MS,
			);
			const captured = envelope.screenshot_after;
			if (!captured?.data) throw new AbpError("ABP returned no screenshot data", 0);
			if (captured.format !== undefined && captured.format !== "png") {
				throw new AbpError(`ABP encoded the screenshot as ${captured.format} instead of png`, 0);
			}
			const bytes = Buffer.from(captured.data, "base64");
			if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
				throw new AbpError(
					`The ${captured.width ?? "?"}x${captured.height ?? "?"} screenshot is ${bytes.byteLength} bytes, over the ${MAX_SCREENSHOT_BYTES} byte limit`,
					0,
				);
			}
			return bytes;
		},

		async snapshot(limit: number): Promise<string> {
			return await evaluate(callScript(PAGE_TEXT_SCRIPT, limit), READ_TIMEOUT_MS);
		},

		async elements(region: BrowserRegion, limit: number): Promise<string> {
			return await evaluate(callScript(ELEMENTS_IN_REGION_SCRIPT, region, limit), READ_TIMEOUT_MS);
		},

		async prepare(action: BrowserAction, documentId: string): Promise<PreparedAction> {
			switch (action.kind) {
				case "navigate": {
					if (typeof action.url !== "string") throw new AbpError("navigate needs a url", 400, "INVALID_ARGUMENT");
					// Refuse anything that would turn a navigation into script
					// execution or a local file read, independently of the caller.
					const target = new URL(action.url);
					if (target.protocol !== "http:" && target.protocol !== "https:") {
						throw new AbpError(`ABP navigation refuses the ${target.protocol} scheme`, 400, "INVALID_ARGUMENT");
					}
					const url = target.toString();
					await requireDocument(documentId);
					return {
						dispatch: async () => {
							await requireDocument(documentId);
							await act("navigate", { url }, NAVIGATE_TIMEOUT_MS);
						},
					};
				}
				case "click": {
					// The point is resolved once, here, and never re-derived from the
					// selector: a selector re-read against a different document would
					// silently retarget an approved click.
					let point: { x: number; y: number };
					if (typeof action.selector === "string") {
						point = await locate(action.selector, documentId);
					} else {
						if (typeof action.x !== "number" || typeof action.y !== "number") {
							throw new AbpError("click needs a selector or x/y coordinates", 400, "INVALID_ARGUMENT");
						}
						point = { x: action.x, y: action.y };
						await requireDocument(documentId);
					}
					return {
						dispatch: async () => {
							await requireDocument(documentId);
							await act("click", { x: point.x, y: point.y, button: "left", click_count: 1 }, MUTATION_TIMEOUT_MS);
						},
					};
				}
				case "type": {
					if (typeof action.selector !== "string" || typeof action.text !== "string") {
						throw new AbpError("type needs a selector and text", 400, "INVALID_ARGUMENT");
					}
					const text = action.text;
					const point = await locate(action.selector, documentId);
					return {
						dispatch: async () => {
							await requireDocument(documentId);
							// ABP's `/type` only appends, so replacing a field is
							// clear_text (click, select all, backspace) followed by the
							// typing. Empty text is therefore a pure clear.
							const cleared = await act("clear_text", { x: point.x, y: point.y }, MUTATION_TIMEOUT_MS);
							if (text.length === 0) return;
							if (cleared.tab_changed === true || (cleared.events ?? []).some(event => event.type === "navigation")) {
								// The field is gone; typing now would put the text into
								// whatever replaced it.
								throw new AbpError(
									"The page navigated while the field was being cleared; the text was not typed",
									409,
									"STALE_DOCUMENT",
								);
							}
							await act("type", { text }, MUTATION_TIMEOUT_MS);
						},
					};
				}
				case "press": {
					if (typeof action.key !== "string") throw new AbpError("press needs a key", 400, "INVALID_ARGUMENT");
					const key = KEY_NAMES[action.key] ?? action.key;
					await requireDocument(documentId);
					return {
						dispatch: async () => {
							await requireDocument(documentId);
							await act("keyboard/press", { key, modifiers: [] }, MUTATION_TIMEOUT_MS);
						},
					};
				}
				case "scroll": {
					const deltaX = action.deltaX ?? 0;
					const deltaY = action.deltaY ?? 0;
					if (deltaX === 0 && deltaY === 0) {
						throw new AbpError("scroll needs a non-zero deltaX or deltaY", 400, "INVALID_ARGUMENT");
					}
					const prepared = await requireDocument(documentId);
					return {
						dispatch: async () => {
							const current = await requireDocument(documentId);
							// ABP scrolls the element under a wheel anchor, so the anchor
							// decides whether the page or an inner scroller moves. The
							// viewport centre is the closest honest equivalent of a
							// page-level wheel. Deltas keep the contract's sign
							// convention: ABP also treats positive as down/right.
							const viewport = current.viewport.width > 0 ? current.viewport : prepared.viewport;
							const scrolls: { delta_px: number; direction: "x" | "y" }[] = [];
							if (deltaY !== 0) scrolls.push({ delta_px: deltaY, direction: "y" });
							if (deltaX !== 0) scrolls.push({ delta_px: deltaX, direction: "x" });
							await act(
								"scroll",
								{ x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2), scrolls },
								MUTATION_TIMEOUT_MS,
							);
						},
					};
				}
				default:
					throw new AbpError(`Unsupported action kind ${JSON.stringify((action as BrowserAction).kind)}`, 400);
			}
		},

		async close(): Promise<void> {
			if (await stop()) return;
			throw new Error(
				`The ABP browser process ${child.pid ?? "?"} did not exit; the ${options.profileDirectory} profile stays locked`,
			);
		},
	};
}
