/**
 * Puppeteer engine driver — the `chromium` and `chrome-relay` engines.
 *
 * This is the real driver behind both Chrome-backed engines, extracted from
 * BrowserRuntime so the runtime keeps exactly one copy of the lifecycle,
 * approval and claim logic and the engines keep none of it.
 *
 * What lives here (and only here):
 *  - launching / attaching, and the ownership rules that go with each,
 *  - the document identity a claim is pinned to,
 *  - read-only target resolution plus the single native dispatch per action.
 *
 * What deliberately does NOT live here: approval, journalling, idempotency,
 * frame storage, cropping, action normalization. The runtime owns those, calls
 * `prepare` once and `dispatch` once, and classifies whatever bubbles out.
 *
 * Ownership rules, restated because they are the whole safety story:
 *  - `chromium` owns the Chrome it launched AND the persistent profile
 *    directory behind it. `onClosed` (the profile-lock release) is called only
 *    once that process is CONFIRMED gone — a timed-out or unconfirmed shutdown
 *    keeps the lock, because a lock claiming "free" while a Chrome may still be
 *    writing the user-data dir is how one profile ends up with two Chromes.
 *  - `chrome-relay` owns NOTHING of the human's browser except the one blank
 *    tab it opened. It never adopts the tab the human is looking at, never
 *    navigates one, and never closes the browser — only its own tab, then it
 *    disconnects. For the relay the leased resource is the attachment itself,
 *    so a confirmed disconnect IS a confirmed release.
 *
 * Every page script executed here is a fixed compiled function from
 * `page-scripts.ts` (or the tiny literal guards below). Caller-supplied
 * JavaScript never reaches `evaluate`, and typed text never reaches argv, a
 * log line or a journal record — it is delivered with `Input.insertText` via
 * `keyboard.sendCharacter`.
 */
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import type { Browser, CDPSession, ElementHandle, KeyInput, Page } from "puppeteer-core";
import type { BrowserAction, BrowserRegion, Viewport } from "../contracts.js";
import { MAX_FRAME_BYTES } from "../image.js";
import { fail } from "../store.js";
import { ELEMENTS_IN_REGION_SCRIPT, PAGE_TEXT_SCRIPT, SELECT_ALL_SCRIPT } from "./page-scripts.js";
import type { EngineDriver, EngineOptions, EngineState, PreparedAction } from "./types.js";

const NAVIGATE_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 15_000;
const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";

/**
 * Launch flags for the profile we own. Beyond the usual first-run noise these
 * switch OFF everything that would phone home from an agent's browser:
 * background networking (component updates, variations/field trials, the
 * safebrowsing list fetch), profile sync, crash upload, domain reliability
 * beacons, link pings and Chrome's bundled default apps / component extensions
 * with background pages. `--metrics-recording-only` keeps UMA local and
 * upload-free. User-installed extensions in this profile are NOT disabled;
 * only Chrome's own default payload is.
 */
const CHROMIUM_ARGS = [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-features=Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions",
	"--disable-background-networking",
	"--disable-component-update",
	"--disable-sync",
	"--disable-domain-reliability",
	"--disable-breakpad",
	"--disable-crash-reporter",
	"--disable-client-side-phishing-detection",
	"--disable-default-apps",
	"--disable-component-extensions-with-background-pages",
	"--metrics-recording-only",
	"--no-pings",
];

export type PuppeteerEngine = "chromium" | "chrome-relay";

/**
 * Build a driver for one of the two Chrome-backed engines.
 *
 * Rejects rather than returning a degraded driver: there is no fallback engine
 * and no half-open browser. On every rejection path the profile lease is either
 * released (nothing is running, or shutdown was confirmed) or deliberately
 * retained with an explanatory error — never released on a guess.
 */
export async function createPuppeteerDriver(engine: PuppeteerEngine, options: EngineOptions): Promise<EngineDriver> {
	let released = false;
	/** Idempotent: several confirmations of the same shutdown may race. */
	const release = (): void => {
		if (released) return;
		released = true;
		options.onClosed();
	};

	if (engine === "chrome-relay") return await attachRelay(options, release);
	return await launchChromium(options, release);
}

/**
 * Attach to the human's already-running Chrome and open OUR OWN blank tab.
 *
 * The tab the human is looking at is never adopted, inspected or navigated —
 * `newPage()` is the only tab this driver will ever touch.
 */
async function attachRelay(options: EngineOptions, release: () => void): Promise<EngineDriver> {
	const browserURL = options.relayUrl ?? DEFAULT_RELAY_URL;
	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		try {
			browser = await puppeteer.connect({ browserURL, defaultViewport: null });
		} catch (err) {
			fail(
				"relay_unavailable",
				`could not attach to chrome-relay at ${browserURL}: ${describe(err)}. ` +
					`Start the chrome-relay (the relay app/extension that exposes this endpoint), or point relayUrl at the endpoint it is actually listening on.`,
			);
		}
		page = await browser.newPage();
		const cdp = await attachSession(page);
		await page.setViewport({ ...options.viewport, deviceScaleFactor: 1 });
		return new PuppeteerDriver({
			browser,
			page,
			cdp,
			viewport: options.viewport,
			ownsBrowser: false,
			release,
		});
	} catch (err) {
		// Roll back exactly what we created. Disconnecting ends the lease, which
		// is the only resource the relay engine holds — so the release here is
		// confirmed, not assumed. The human's browser is never closed.
		if (page && !page.isClosed()) await page.close().catch(() => undefined);
		if (browser) await browser.disconnect().catch(() => undefined);
		release();
		throw err;
	}
}

/** Launch Chrome on the persistent profile directory this driver owns. */
async function launchChromium(options: EngineOptions, release: () => void): Promise<EngineDriver> {
	const userDataDir = options.profileDirectory;
	let browser: Browser;
	try {
		mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
		browser = await puppeteer.launch({
			headless: options.headless ?? true,
			userDataDir,
			timeout: LAUNCH_TIMEOUT_MS,
			defaultViewport: null,
			// An explicit binary wins; otherwise the locally installed stable
			// Chrome channel. Nothing is downloaded at runtime.
			...(options.executablePath ? { executablePath: options.executablePath } : { channel: "chrome" as const }),
			args: CHROMIUM_ARGS,
		});
	} catch (err) {
		// Nothing of ours is running: puppeteer kills a partially started Chrome
		// before rejecting, so the profile directory has no live writer.
		release();
		throw err;
	}

	// Process-exit handling goes in the moment the launch succeeds, BEFORE any
	// further setup can fail: a Chrome that dies inside the setup window is a
	// confirmed release, and without this listener that confirmation is lost and
	// the profile stays locked forever.
	browser.process()?.once("exit", release);

	try {
		const page = (await browser.pages())[0] ?? (await browser.newPage());
		const cdp = await attachSession(page);
		await page.setViewport({ ...options.viewport, deviceScaleFactor: 1 });
		return new PuppeteerDriver({ browser, page, cdp, viewport: options.viewport, ownsBrowser: true, release });
	} catch (err) {
		try {
			// `browser.close()` resolves once the process is gone; only then is the
			// profile actually free.
			await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, "failed-launch cleanup");
			release();
		} catch (cleanupError) {
			if (hasExited(browser)) release();
			else {
				fail(
					"launch_cleanup_failed",
					`browser initialization failed (${describe(err)}), and shutdown is unconfirmed (${describe(cleanupError)}). ` +
						`The profile lease for ${userDataDir} is deliberately retained while that process may still be alive.`,
				);
			}
		}
		throw err;
	}
}

/**
 * A private CDP session on the page's target.
 *
 * `Page.getFrameTree` is the driver's document identity source: the main
 * frame's `loaderId` is a fresh value for every committed document, including a
 * reload and a navigation to the same URL, and it is read live from the browser
 * rather than inferred from an event that may still be in flight.
 */
async function attachSession(page: Page): Promise<CDPSession> {
	const cdp = await page.createCDPSession();
	await cdp.send("Page.enable");
	return cdp;
}

/** Attach native, non-replaying input to the exact page owned by another
 * backend. The backend retains process ownership and final lock release. */
export async function createAttachedPageDriver(
	browser: Browser,
	page: Page,
	options: Pick<EngineOptions, "viewport" | "onClosed">,
): Promise<EngineDriver> {
	await page.setViewport({ ...options.viewport, deviceScaleFactor: 1 });
	const cdp = await attachSession(page);
	return new PuppeteerDriver({
		browser, page, cdp, viewport: options.viewport,
		ownsBrowser: false, release: options.onClosed,
	});
}

interface DriverParts {
	browser: Browser;
	page: Page;
	cdp: CDPSession;
	viewport: Viewport;
	ownsBrowser: boolean;
	release: () => void;
}

class PuppeteerDriver implements EngineDriver {
	readonly #browser: Browser;
	readonly #page: Page;
	readonly #cdp: CDPSession;
	readonly #viewport: Viewport;
	readonly #ownsBrowser: boolean;
	readonly #release: () => void;
	readonly #onPageClosed: () => void;
	readonly #onDisconnected: () => void;
	#closed = false;
	#closing: Promise<void> | undefined;

	constructor(parts: DriverParts) {
		this.#browser = parts.browser;
		this.#page = parts.page;
		this.#cdp = parts.cdp;
		this.#viewport = parts.viewport;
		this.#ownsBrowser = parts.ownsBrowser;
		this.#release = parts.release;
		this.#onPageClosed = (): void => {
			// Our tab going away ends the session. For a browser we own that means
			// shutting it down; the lease still waits for the process to exit.
			void this.close().catch(() => undefined);
		};
		this.#onDisconnected = (): void => {
			if (this.#ownsBrowser) {
				// A dropped transport is NOT proof the process died, so this goes
				// through the normal confirmed shutdown rather than releasing.
				if (!this.#closed) void this.close().catch((err) => console.error("Owned browser cleanup failed:", err));
				return;
			}
			// Relay: the attachment IS the leased resource, and it is now provably
			// gone. Nothing of the human's browser was ever ours to close.
			this.#closed = true;
			this.#release();
		};
		parts.page.on("close", this.#onPageClosed);
		parts.browser.on("disconnected", this.#onDisconnected);
	}

	// -----------------------------------------------------------------------
	// Reads
	// -----------------------------------------------------------------------

	async state(): Promise<EngineState> {
		if (this.#closed || this.#page.isClosed()) fail("browser_closed", "The browser is closed.");
		const documentId = await this.#documentId();
		const url = this.#page.url();
		// Read browser-maintained metadata, not document JavaScript: the latter
		// loses its execution context during an ordinary in-flight navigation.
		const history = await this.#read(() => this.#cdp.send("Page.getNavigationHistory"));
		const current = history.entries[history.currentIndex];
		if (!current) fail("no_document", "The browser did not report a current navigation entry.");
		const title = current.title;
		return { url, title, documentId, viewport: this.#viewport };
	}

	/**
	 * One read-only CDP call, retried once. While a cross-document navigation
	 * commits, the session's target is briefly not an active page and the send
	 * rejects; a read has no effect, so re-reading is safe and a transient
	 * protocol error must not fail a state read or void a human's approval.
	 */
	async #read<T>(send: () => Promise<T>): Promise<T> {
		try {
			return await send();
		} catch (error) {
			if (this.#closed || this.#page.isClosed()) fail("browser_closed", "The browser closed during inspection.");
			try {
				return await send();
			} catch {
				throw error;
			}
		}
	}


	async screenshot(): Promise<Uint8Array> {
		const shot = await this.#page.screenshot({ type: "png", captureBeyondViewport: false });
		if (shot.length > MAX_FRAME_BYTES) {
			fail("frame_too_large", `screenshot is ${shot.length} bytes, above the ${MAX_FRAME_BYTES} byte limit`);
		}
		return shot;
	}

	async snapshot(limit: number): Promise<string> {
		return await this.#page.evaluate(PAGE_TEXT_SCRIPT, limit);
	}

	async elements(region: BrowserRegion, limit: number): Promise<string> {
		return await this.#page.evaluate(ELEMENTS_IN_REGION_SCRIPT, region, limit);
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	/**
	 * Resolve everything the action needs, read-only, and hand back the single
	 * dispatch that performs it.
	 *
	 * Nothing here navigates, focuses, scrolls or types. The element a selector
	 * names is resolved ONCE, and the returned dispatch uses that exact handle —
	 * never a second query — so the target identity the human approved is the
	 * target that gets clicked or typed into. `documentId` is the document the
	 * approval is pinned to, and every native step re-reads the live loaderId
	 * before touching the page.
	 */
	async prepare(action: BrowserAction, documentId: string): Promise<PreparedAction> {
		await this.#assertDocument(documentId);
		switch (action.kind) {
			case "navigate": {
				const url = requireField(action.url, "navigate.url");
				return {
					dispatch: async () => {
						await this.#assertDocument(documentId);
						await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
					},
				};
			}
			case "click": {
				if (action.selector === undefined) {
					const x = requireNumber(action.x, "click.x");
					const y = requireNumber(action.y, "click.y");
					return {
						dispatch: async () => {
							await this.#assertDocument(documentId);
							await this.#page.mouse.click(x, y);
						},
					};
				}
				const handle = await this.#resolve(action.selector);
				return {
					dispatch: async () => {
						await this.#assertDocument(documentId);
						await handle.click();
					},
					dispose: () => handle.dispose(),
				};
			}
			case "type": {
				const handle = await this.#resolve(requireField(action.selector, "type.selector"));
				const text = requireField(action.text, "type.text", true);
				return {
					dispose: () => handle.dispose(),
					dispatch: async () => {
						// Typing is the one multi-step native sequence, so the document
						// is re-checked between EVERY step: a navigation landing halfway
						// through must not deliver the rest of the text into whatever
						// document replaced the approved one.
						await this.#assertDocument(documentId);
						await handle.focus();
						await this.#assertDocument(documentId);
						const selected = await handle.evaluate(SELECT_ALL_SCRIPT);
						await this.#assertDocument(documentId);
						if (!selected) {
							const modifier = process.platform === "darwin" ? "Meta" : "Control";
							await this.#page.keyboard.down(modifier);
							try {
								await this.#assertDocument(documentId);
								await this.#page.keyboard.press("KeyA");
							} finally {
								await this.#page.keyboard.up(modifier);
							}
							await this.#assertDocument(documentId);
						}
						// Replace the selection in ONE native input operation: no
						// transient empty value, and no per-character typing that could
						// straddle two documents. The text is inserted as data and never
						// appears in argv or any log.
						if (text.length > 0) await this.#page.keyboard.sendCharacter(text);
						else await this.#page.keyboard.press("Backspace");
					},
				};
			}
			case "press": {
				const key = requireField(action.key, "press.key") as KeyInput;
				return {
					dispatch: async () => {
						await this.#assertDocument(documentId);
						await this.#page.keyboard.press(key);
					},
				};
			}
			case "scroll": {
				const deltaX = action.deltaX ?? 0;
				const deltaY = action.deltaY ?? 0;
				return {
					dispatch: async () => {
						await this.#assertDocument(documentId);
						await this.#page.mouse.wheel({ deltaX, deltaY });
					},
				};
			}
			default:
				fail("bad_action", `unsupported action kind ${JSON.stringify((action as BrowserAction).kind)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Shutdown
	// -----------------------------------------------------------------------

	/**
	 * Stop everything this driver owns, bounded, and release the profile lease
	 * only on a CONFIRMED stop.
	 *
	 * Owned browser: await `browser.close()` (resolves once the process is gone)
	 * and only then release. A timeout with a still-living process keeps the
	 * lease and says so. Relay: close our own tab, disconnect, release.
	 *
	 * Idempotent while it succeeds; a failed close is not memoized, so a caller
	 * may try again.
	 */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		const attempt = this.#shutdown();
		this.#closing = attempt.catch((err: unknown) => {
			this.#closing = undefined;
			throw err;
		});
		return this.#closing;
	}

	async #shutdown(): Promise<void> {
		this.#closed = true;
		// Detach first: closing the browser fires `close`/`disconnected`, and a
		// re-entrant teardown from our own listeners helps nobody. The child
		// process `exit` listener deliberately stays — it is a release
		// confirmation, and releasing is idempotent.
		this.#page.off("close", this.#onPageClosed);
		this.#browser.off("disconnected", this.#onDisconnected);
		await this.#cdp.detach().catch(() => undefined);

		if (!this.#ownsBrowser) {
			if (!this.#page.isClosed()) await this.#page.close().catch(() => undefined);
			await this.#browser.disconnect().catch(() => undefined);
			this.#release();
			return;
		}
		try {
			await withTimeout(this.#browser.close(), CLOSE_TIMEOUT_MS, "browser.close");
		} catch (err) {
			// A confirmed-dead process is still a confirmed release, however ugly
			// the close path was.
			if (hasExited(this.#browser)) {
				this.#release();
				return;
			}
			fail(
				"close_failed",
				`the browser did not shut down (${describe(err)}); its profile lease is deliberately NOT released while that process may still be alive`,
			);
		}
		this.#release();
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	/** Live document identity, read from the browser, never from a cache. */
	async #documentId(): Promise<string> {
		const { frameTree } = await this.#read(() => this.#cdp.send("Page.getFrameTree"));
		const loaderId = frameTree.frame.loaderId;
		if (typeof loaderId !== "string" || loaderId.length === 0) {
			fail("no_document", "the tab did not report a document identity; it may be closing");
		}
		return loaderId;
	}

	/**
	 * The guard that stands between an approval and a native effect. One live
	 * read, no retry, no repair: a mismatch means the approved document is gone
	 * and the action must not happen at all.
	 */
	async #assertDocument(expected: string): Promise<void> {
		if (this.#closed || this.#page.isClosed()) fail("browser_closed", "the browser closed before dispatch");
		const current = await this.#documentId();
		if (current !== expected) {
			fail("stale_document", `the page changed document: this action was prepared for ${expected}, the tab now holds ${current}`);
		}
	}

	/** Element resolution is read-only, so a miss here is a certain non-event. */
	async #resolve(selector: string): Promise<ElementHandle<Element>> {
		const handle = await this.#page.waitForSelector(selector, { timeout: ACTION_TIMEOUT_MS }).catch(() => null);
		if (!handle) fail("no_element", `selector ${JSON.stringify(selector)} did not resolve to an element`);
		return handle;
	}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * The runtime normalizes and validates every action before it is ever stored,
 * so these only assert the shape the prepared dispatch closes over — they do
 * not re-validate ranges, protocols or lengths, and they never substitute a
 * default for something the caller omitted.
 */
function requireField(value: unknown, name: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		fail("bad_action", `${name} is missing from the prepared action`);
	}
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail("bad_action", `${name} is missing from the prepared action`);
	}
	return value;
}

/** True only when the child process is provably gone. */
function hasExited(browser: Browser): boolean {
	const proc = browser.process();
	return proc !== null && (proc.exitCode !== null || proc.signalCode !== null);
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Bound a shutdown that would otherwise hang the caller forever. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
