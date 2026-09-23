/**
 * Puppeteer engine driver — the `chromium` and `chrome-relay` engines.
 *
 * What lives here: launching / attaching and the ownership rules that go with
 * each, the document identity frames and annotations are pinned to, and one
 * native dispatch per action. Frame storage, cropping and validation live in
 * the runtime.
 *
 * Ownership rules, restated because they are the whole safety story:
 *  - `chromium` owns the Chrome it launched AND the persistent profile
 *    directory behind it. `onClosed` (the profile-lock release) is called only
 *    once that process is CONFIRMED gone — a timed-out or unconfirmed shutdown
 *    keeps the lock, because a lock claiming "free" while a Chrome may still be
 *    writing the user-data dir is how one profile ends up with two Chromes.
 *  - `chrome-relay` owns NOTHING of the human's browser except the one blank
 *    tab it opened (and tabs a task agent opens from it). It never adopts the
 *    tab the human is looking at and never closes the browser — only
 *    disconnects. For the relay the leased resource is the attachment itself,
 *    so a confirmed disconnect IS a confirmed release.
 *
 * Every page script executed here is a fixed compiled function from
 * `page-scripts.ts`. Caller-supplied JavaScript never reaches `evaluate`.
 */
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import type { Browser, CDPSession, ElementHandle, KeyInput, Page, Target } from "puppeteer-core";
import type { BrowserAction, BrowserRegion, Viewport } from "../contracts.js";
import { MAX_FRAME_BYTES } from "../image.js";
import { ActionNotDispatched, fail } from "../store.js";
import { ELEMENTS_IN_REGION_SCRIPT, PAGE_TEXT_SCRIPT, SELECT_ALL_SCRIPT } from "./page-scripts.js";
import type { EngineDriver, EngineOptions, EngineState } from "./types.js";

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
 * A private CDP session on the page's target. `Page.getFrameTree` is the
 * document identity source: the main frame's `loaderId` is fresh for every
 * committed document, including a reload and a same-URL navigation.
 */
async function attachSession(page: Page): Promise<CDPSession> {
	const cdp = await page.createCDPSession();
	await cdp.send("Page.enable");
	return cdp;
}

/**
 * While a cross-process navigation commits, the page's CDP session is briefly
 * detached ("Not attached to an active page", "Target closed" on the swapped
 * renderer). Reads have no effect, so they are retried across that window.
 */
const READ_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

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
	/** The tab this driver opened; its closing ends the session. */
	readonly #home: Page;
	/** The tab being shown and driven: `#home`, or the tab a task agent opened. */
	#page: Page;
	#cdp: CDPSession;
	readonly #viewport: Viewport;
	readonly #ownsBrowser: boolean;
	readonly #release: () => void;
	readonly #onHomeClosed: () => void;
	readonly #onDisconnected: () => void;
	#closed = false;
	#closing: Promise<void> | undefined;

	constructor(parts: DriverParts) {
		this.#browser = parts.browser;
		this.#home = parts.page;
		this.#page = parts.page;
		this.#cdp = parts.cdp;
		this.#viewport = parts.viewport;
		this.#ownsBrowser = parts.ownsBrowser;
		this.#release = parts.release;
		this.#onHomeClosed = (): void => {
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
		parts.page.on("close", this.#onHomeClosed);
		parts.browser.on("disconnected", this.#onDisconnected);
	}

	// -----------------------------------------------------------------------
	// Reads
	// -----------------------------------------------------------------------

	async state(): Promise<EngineState> {
		const documentId = await this.#documentId();
		const history = await this.#read(() => this.#cdp.send("Page.getNavigationHistory"));
		const current = history.entries[history.currentIndex];
		if (!current) fail("no_document", "The browser did not report a current navigation entry.");
		// Browser-maintained metadata, not document JavaScript: the latter loses
		// its execution context during an ordinary in-flight navigation.
		return { url: current.url, title: current.title, documentId, viewport: this.#viewport };
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
	 * One native dispatch, never retried. Everything that can fail without
	 * touching the page (validation, element resolution) throws
	 * ActionNotDispatched before the first input event.
	 */
	async perform(action: BrowserAction): Promise<void> {
		this.#assertOpen();
		const page = this.#page;
		switch (action.kind) {
			case "navigate": {
				await page.goto(requireField(action.url, "navigate.url"), { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS });
				return;
			}
			case "click": {
				if (action.selector === undefined) {
					await page.mouse.click(requireNumber(action.x, "click.x"), requireNumber(action.y, "click.y"));
					return;
				}
				const handle = await this.#resolve(action.selector);
				try {
					await handle.click();
				} finally {
					await handle.dispose().catch(() => undefined);
				}
				return;
			}
			case "type": {
				const text = requireField(action.text, "type.text", true);
				const handle = await this.#resolve(requireField(action.selector, "type.selector"));
				try {
					await handle.focus();
					if (!(await handle.evaluate(SELECT_ALL_SCRIPT))) {
						const modifier = process.platform === "darwin" ? "Meta" : "Control";
						await page.keyboard.down(modifier);
						try {
							await page.keyboard.press("KeyA");
						} finally {
							await page.keyboard.up(modifier);
						}
					}
					// Replace the selection in ONE native input operation: no transient
					// empty value, and the text never appears in argv or a log.
					if (text.length > 0) await page.keyboard.sendCharacter(text);
					else await page.keyboard.press("Backspace");
				} finally {
					await handle.dispose().catch(() => undefined);
				}
				return;
			}
			case "select": {
				const wanted = requireField(action.value, "select.value", true);
				const handle = await this.#resolve(requireField(action.selector, "select.selector"));
				try {
					const value = await handle.evaluate((el, wanted) => {
						if (!(el instanceof HTMLSelectElement)) return null;
						const option = Array.from(el.options).find((o) => o.value === wanted || o.text.trim() === wanted);
						return option ? option.value : null;
					}, wanted);
					if (value === null) {
						throw new ActionNotDispatched("no_option", `${JSON.stringify(action.selector)} is not a <select> with an option ${JSON.stringify(wanted)}`);
					}
					await handle.select(value);
				} finally {
					await handle.dispose().catch(() => undefined);
				}
				return;
			}
			case "press":
				await page.keyboard.press(requireField(action.key, "press.key") as KeyInput);
				return;
			case "scroll":
				await page.mouse.wheel({ deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0 });
				return;
			default:
				throw new ActionNotDispatched("bad_action", `unsupported action kind ${JSON.stringify((action as BrowserAction).kind)}`);
		}
	}

	cdpEndpoint(): string {
		return this.#browser.wsEndpoint();
	}

	/**
	 * A task agent drives the same Chrome over CDP and may open its own tab
	 * (jev does). The newest page it opens becomes the page this driver shows,
	 * so the human watches the agent work. A followed tab that closes hands the
	 * view back to the home tab.
	 */
	followNewPages(): () => void {
		const onCreated = (target: Target): void => {
			if (target.type() !== "page") return;
			void (async () => {
				const page = await target.page();
				if (!page || this.#closed || page.isClosed()) return;
				await page.setViewport({ ...this.#viewport, deviceScaleFactor: 1 }).catch(() => undefined);
				const cdp = await attachSession(page).catch(() => undefined);
				if (!cdp || this.#closed || page.isClosed()) return;
				const previous = this.#cdp;
				this.#page = page;
				this.#cdp = cdp;
				if (previous !== cdp) await previous.detach().catch(() => undefined);
				page.once("close", () => {
					if (this.#page !== page || this.#closed || this.#home.isClosed()) return;
					void attachSession(this.#home).then((home) => {
						if (this.#page !== page) return void home.detach().catch(() => undefined);
						this.#page = this.#home;
						this.#cdp = home;
					}, () => undefined);
				});
			})().catch(() => undefined);
		};
		this.#browser.on("targetcreated", onCreated);
		return () => this.#browser.off("targetcreated", onCreated);
	}

	// -----------------------------------------------------------------------
	// Shutdown
	// -----------------------------------------------------------------------

	/**
	 * Stop everything this driver owns, bounded, and release the profile lease
	 * only on a CONFIRMED stop. Owned browser: await `browser.close()` (resolves
	 * once the process is gone). Relay: close our own tab, disconnect, release.
	 * A failed close is not memoized, so a caller may try again.
	 */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closing = this.#shutdown().finally(() => {
			this.#closing = undefined;
		});
		return this.#closing;
	}

	async #shutdown(): Promise<void> {
		this.#closed = true;
		this.#home.off("close", this.#onHomeClosed);
		this.#browser.off("disconnected", this.#onDisconnected);
		await this.#cdp.detach().catch(() => undefined);

		if (!this.#ownsBrowser) {
			if (!this.#home.isClosed()) await this.#home.close().catch(() => undefined);
			await this.#browser.disconnect().catch(() => undefined);
			this.#release();
			return;
		}
		try {
			await withTimeout(this.#browser.close(), CLOSE_TIMEOUT_MS, "browser.close");
		} catch (err) {
			// A confirmed-dead process is still a confirmed release.
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

	#assertOpen(): void {
		if (this.#closed || this.#page.isClosed()) fail("browser_closed", "The browser is closed.");
	}

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
	 * One read-only CDP call, retried with backoff across a navigation's
	 * detach window. Reads have no effect, so re-reading is safe; the last
	 * error is rethrown once the window is exhausted.
	 */
	async #read<T>(send: () => Promise<T>): Promise<T> {
		for (const delay of READ_RETRY_DELAYS_MS) {
			this.#assertOpen();
			try {
				return await send();
			} catch {
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		this.#assertOpen();
		return await send();
	}

	/** Element resolution is read-only, so a miss here is a certain non-event. */
	async #resolve(selector: string): Promise<ElementHandle<Element>> {
		const handle = await this.#page.waitForSelector(selector, { timeout: ACTION_TIMEOUT_MS }).catch(() => null);
		if (!handle) throw new ActionNotDispatched("no_element", `selector ${JSON.stringify(selector)} did not resolve to an element`);
		return handle;
	}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireField(value: unknown, name: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new ActionNotDispatched("bad_action", `${name} is required`);
	}
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ActionNotDispatched("bad_action", `${name} is required`);
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
