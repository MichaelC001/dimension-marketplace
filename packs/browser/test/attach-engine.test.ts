/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell that attaches to the person's own Chrome damages it. The attach engine is the one place the pack
 *  touches a browser it does not own on the person's behalf: it must adopt the page the person is on (that is the point), leave that page exactly as it
 *  was (no resize, no raising, never closed), open nothing in their browser unasked, and on close let go without ending their Chrome or any page of it. The
 *  only thing it may end is an application the pack started itself, and only when asked (`kill`). A regression shows as a tab that vanishes, a window that
 *  changes size, or an application the person started that is gone after a cell is done. Each test attaches to a real headless Chrome started here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { pngSize } from "../src/code/kinds/cmux/png";
import { KIND_TIMINGS } from "../src/code/kinds/cdp";
import { establishKind } from "../src/code/kinds/establish";
import type { ProcessScanner } from "../src/code/kinds/spawned";
import { readImageDimensions } from "../src/code/worker/image-size";
import type { AttachTarget } from "../src/engines/attach";
import { createEngineDriver } from "../src/engines";
import type { EngineDriver, LiveFrame } from "../src/engines/types";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, describeWithChrome, failureCode, waitUntil } from "./fixture";
import { alive, gone, killTree, type PageServer, startDebugChrome, startPageServer, stopDebugChromes } from "./kinds-fixture";

const drivers: EngineDriver[] = [];
afterEach(async () => {
	for (const driver of drivers.splice(0)) await driver.close().catch(() => undefined);
	await stopDebugChromes();
}, BROWSER_TEST_TIMEOUT_MS);

interface PageEntry {
	id: string;
	url: string;
	title: string;
	type: string;
}

async function pagesOf(cdpUrl: string): Promise<PageEntry[]> {
	return ((await (await fetch(`${cdpUrl}/json/list`)).json()) as PageEntry[]).filter((entry) => entry.type === "page");
}

/** The person's Chrome with two tabs on known pages, and a driver attached to it as a cell's `connected` kind would be. */
async function attachedToPersonsChrome(viewport = { width: 640, height: 480 }): Promise<{ driver: EngineDriver; chromeUrl: string; pid: number; pages: PageServer; released: () => number }> {
	const pages = await startPageServer();
	const chrome = await startDebugChrome();
	// The person has two tabs open: the one Chrome started with, and one they opened by hand.
	const opener = await puppeteer.connect({ browserURL: chrome.cdpUrl, defaultViewport: null });
	const first = (await opener.pages())[0]!;
	await first.goto(pages.url("/one"));
	const second = await opener.newPage();
	await second.goto(pages.url("/two"));
	await opener.disconnect();
	const established = await establishKind({ kind: "connected", cdpUrl: chrome.cdpUrl }, { timings: KIND_TIMINGS });
	if (!("attach" in established)) throw new Error("expected an attach target");
	let released = 0;
	const driver = await createEngineDriver("chrome-relay", {
		profileDirectory: join(tmpdir(), "unused-by-attach"),
		viewport,
		attach: established.attach,
		onClosed: () => void (released += 1),
	});
	drivers.push(driver);
	return { driver, chromeUrl: chrome.cdpUrl, pid: chrome.pid, pages, released: () => released };
}

describeWithChrome("the attach engine on the person's Chrome", () => {
	test(
		"it adopts a page that is already there, opens none, and leaves the page exactly as it was: its size, its pixel ratio, how it is rendered",
		async () => {
			const before = await startDebugChrome();
			const read = async (): Promise<number[]> => {
				const probe = await puppeteer.connect({ browserURL: before.cdpUrl, defaultViewport: null });
				try {
					return (await (await probe.pages())[0]!.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])) as number[];
				} finally {
					await probe.disconnect();
				}
			};
			const metricsBefore = await read();
			const established = await establishKind({ kind: "connected", cdpUrl: before.cdpUrl });
			if (!("attach" in established)) throw new Error("expected an attach target");
			const pageCount = (await pagesOf(before.cdpUrl)).length;
			// The pack's own tabs get 640 x 480 here (and, where an agent drives them, whatever shaping that applies to them): the person's page is none of those.
			// This is also the test that must keep passing when #155's agent shaping is merged: it applies to the pack's own tabs, never to an adopted page (see the PR body of #164).
			const driver = await createEngineDriver("chrome-relay", { profileDirectory: join(tmpdir(), "unused-by-attach"), viewport: { width: 640, height: 480 }, attach: established.attach, onClosed: () => undefined });
			drivers.push(driver);

			expect((await pagesOf(before.cdpUrl)).length).toBe(pageCount);
			const state = await driver.state();
			expect(state.tabs).toHaveLength(1);
			expect(await read()).toEqual(metricsBefore);
			expect(metricsBefore.slice(0, 2)).not.toEqual([640, 480]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page is picked by what is on it, and one that is not there is refused with the pages listed",
		async () => {
			const { driver, pages } = await attachedToPersonsChrome();
			const ref = await driver.adoptTab({ match: "Page two" });
			expect(ref).toMatchObject({ url: pages.url("/two"), title: "Page two", active: true });
			expect(ref.targetId.length).toBeGreaterThan(8);
			expect((await driver.state()).url).toBe(pages.url("/two"));

			const other = await driver.adoptTab({ match: pages.url("/one") });
			expect(other.url).toBe(pages.url("/one"));
			expect(other.tabId).not.toBe(ref.tabId);
			// The same page again is the same tab, not a second adoption.
			expect((await driver.adoptTab({ match: "Page two" })).tabId).toBe(ref.tabId);
			expect((await driver.state()).tabs).toHaveLength(2);

			const refusal = await driver.adoptTab({ match: "no such page" }).then(
				() => "adopted",
				(error: Error) => error.message,
			);
			expect(refusal).toContain('No page target matched "no such page". Available pages:');
			expect(refusal).toContain(pages.url("/one"));
			expect(refusal).toContain(pages.url("/two"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"letting go closes nothing of the person's: every page stays open and their Chrome keeps running, and the lease is released once",
		async () => {
			const { driver, chromeUrl, pid, pages, released } = await attachedToPersonsChrome();
			await driver.adoptTab({ match: "Page one" });
			await driver.adoptTab({ match: "Page two" });
			const open = (await pagesOf(chromeUrl)).map((entry) => entry.url).sort();
			expect(open).toEqual([pages.url("/one"), pages.url("/two")].sort());

			await driver.close();
			expect(released()).toBe(1);
			expect(alive(pid)).toBe(true);
			expect((await pagesOf(chromeUrl)).map((entry) => entry.url).sort()).toEqual(open);
			await pages.stop();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"closing an adopted tab releases it and leaves the page open in the person's browser",
		async () => {
			const { driver, chromeUrl, pages } = await attachedToPersonsChrome();
			const one = await driver.adoptTab({ match: "Page one" });
			const two = await driver.adoptTab({ match: "Page two" });
			await driver.closeTab(two.tabId);
			expect((await pagesOf(chromeUrl)).map((entry) => entry.url).sort()).toEqual([pages.url("/one"), pages.url("/two")].sort());
			// The other adopted page is the active one now; nothing was opened in the person's browser to take the closed one's place.
			const state = await driver.state();
			expect(state.tabs.map((tab) => tab.id)).toEqual([one.tabId]);
			expect(state.url).toBe(pages.url("/one"));
			// Letting go of the last one leaves no tab, and says so rather than failing on a detached session.
			await driver.closeTab(one.tabId);
			expect(await failureCode(() => driver.state())).toBe("no_tab");
			expect((await pagesOf(chromeUrl)).length).toBe(2);
			await pages.stop();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"fitting the browser to a size resizes none of the person's pages: the window is theirs, whoever asks",
		async () => {
			const { driver, chromeUrl } = await attachedToPersonsChrome();
			await driver.adoptTab({ match: "Page one" });
			await driver.adoptTab({ match: "Page two" });
			const read = async (): Promise<number[][]> => {
				const probe = await puppeteer.connect({ browserURL: chromeUrl, defaultViewport: null });
				try {
					return await Promise.all((await probe.pages()).map(async (page) => (await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])) as number[]));
				} finally {
					await probe.disconnect();
				}
			};
			const before = await read();
			await driver.resize({ width: 500, height: 400 }, 2);
			expect(await read()).toEqual(before);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test("an attach target belongs to the attach engine alone, and a launched browser has nothing to adopt", async () => {
		const target = { kind: "connected" as const, cdpUrl: "http://127.0.0.1:1", label: "connected http://127.0.0.1:1" };
		expect(await failureCode(() => createEngineDriver("chromium", { profileDirectory: tmpdir(), viewport: { width: 640, height: 480 }, attach: target, onClosed: () => undefined }))).toBe("bad_engine");
	});

	test("connecting to an endpoint that is not a browser says which kind failed, and releases the lease it never held", async () => {
		let released = 0;
		const target = { kind: "connected" as const, cdpUrl: "http://127.0.0.1:1", label: "connected http://127.0.0.1:1" };
		expect(await failureCode(() => createEngineDriver("chrome-relay", { profileDirectory: tmpdir(), viewport: { width: 640, height: 480 }, attach: target, onClosed: () => void (released += 1) }))).toBe("attach_failed");
		expect(released).toBe(1);
	});
});

interface PageGeometry {
	width: number;
	height: number;
	ratio: number;
}

async function withPageAt<T>(chromeUrl: string, url: string, use: (page: Page) => Promise<T>): Promise<T> {
	const probe = await puppeteer.connect({ browserURL: chromeUrl, defaultViewport: null });
	try {
		const page = (await probe.pages()).find((candidate) => candidate.url() === url);
		if (page === undefined) throw new Error(`the person's Chrome has no page at ${url}`);
		return await use(page);
	} finally {
		await probe.disconnect();
	}
}

async function geometryOf(chromeUrl: string, url: string): Promise<PageGeometry> {
	return await withPageAt(chromeUrl, url, async (page) => {
		const [width, height, ratio] = (await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])) as [number, number, number];
		return { width, height, ratio };
	});
}

async function resizeWindowOf(chromeUrl: string, url: string, size: { width: number; height: number }): Promise<void> {
	await withPageAt(chromeUrl, url, async (page) => {
		const cdp = await page.createCDPSession();
		const { windowId } = await cdp.send("Browser.getWindowForTarget");
		await cdp.send("Browser.setWindowBounds", { windowId, bounds: { ...size, windowState: "normal" } });
	});
}

const LARGER_THAN_ANY_HEADLESS_WINDOW = { width: 2600, height: 1800 };
const STALLED_RENDERER_BUDGET_MS = 500;
const PICTURE_SIZE_TOLERANCE_PX = 2;
const SIZE_READERS = 8;

interface HeldPageServer {
	readonly url: (path: string) => string;
	readonly requested: Promise<void>;
	readonly stop: () => Promise<void>;
}

async function startHeldPageServer(): Promise<HeldPageServer> {
	const requested = Promise.withResolvers<void>();
	const server = createServer(() => requested.resolve());
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	return {
		url: (path) => `http://127.0.0.1:${port}${path}`,
		requested: requested.promise,
		stop: async () => {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

describeWithChrome("a page adopted from the person's Chrome is described as it is, not as this driver was configured", () => {
	async function adoptedForegroundPage(): Promise<{ driver: EngineDriver; chromeUrl: string; pageUrl: string; real: PageGeometry }> {
		const { driver, chromeUrl, pages } = await attachedToPersonsChrome(LARGER_THAN_ANY_HEADLESS_WINDOW);
		await driver.adoptTab({ match: "Page two" });
		const pageUrl = pages.url("/two");
		const real = await geometryOf(chromeUrl, pageUrl);
		expect(real.width).toBeLessThan(LARGER_THAN_ANY_HEADLESS_WINDOW.width);
		expect(real.height).toBeLessThan(LARGER_THAN_ANY_HEADLESS_WINDOW.height);
		return { driver, chromeUrl, pageUrl, real };
	}

	async function pictureOf(driver: EngineDriver): Promise<{ width: number; height: number } | undefined> {
		return pngSize(Buffer.from(await driver.screenshot()));
	}

	test(
		"state reports the page's own innerWidth x innerHeight and the frozen picture is that size at the page's pixel ratio",
		async () => {
			const { driver, real } = await adoptedForegroundPage();

			expect((await driver.state()).viewport).toEqual({ width: real.width, height: real.height });
			expect(await pictureOf(driver)).toEqual({ width: Math.round(real.width * real.ratio), height: Math.round(real.height * real.ratio) });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a cell fitting the driver to another size and ratio changes neither: the page is the person's, and so is the description of it",
		async () => {
			const { driver, real } = await adoptedForegroundPage();

			await driver.resize({ width: 500, height: 400 }, 2);

			expect((await driver.state()).viewport).toEqual({ width: real.width, height: real.height });
			expect(await pictureOf(driver)).toEqual({ width: Math.round(real.width * real.ratio), height: Math.round(real.height * real.ratio) });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"state follows the person resizing their window",
		async () => {
			const { driver, chromeUrl, pageUrl } = await adoptedForegroundPage();

			await resizeWindowOf(chromeUrl, pageUrl, { width: 720, height: 520 });
			const resized = await geometryOf(chromeUrl, pageUrl);

			expect((await driver.state()).viewport).toEqual({ width: resized.width, height: resized.height });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the live picture is tagged with the page's own size from its first frame, and the tag follows the person resizing their window",
		async () => {
			const { driver, chromeUrl, pageUrl, real } = await adoptedForegroundPage();
			const frames: LiveFrame[] = [];
			const stop = driver.watchFrames((frame) => frames.push(frame));
			try {
				await waitUntil("the first picture", async () => frames.length, (count) => count >= 1);
				expect(frames[0]?.viewport).toEqual({ width: real.width, height: real.height });

				await resizeWindowOf(chromeUrl, pageUrl, { width: 720, height: 520 });
				const resized = await geometryOf(chromeUrl, pageUrl);
				expect(resized.width).not.toBe(real.width);

				await waitUntil("a picture tagged with the resized window", async () => frames.at(-1)?.viewport, (viewport) => viewport?.width === resized.width && viewport.height === resized.height);
			} finally {
				stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"while the person's page is loading a slow site, state answers at once with the last measured size of their window instead of waiting on the stalled renderer",
		async () => {
			const held = await startHeldPageServer();
			try {
				const { driver, chromeUrl, pageUrl, real } = await adoptedForegroundPage();
				expect((await driver.state()).viewport).toEqual({ width: real.width, height: real.height });

				await withPageAt(chromeUrl, pageUrl, async (page) => {
					await page.evaluate((href) => window.location.assign(href), held.url("/slow"));
					await held.requested;

					const asked = performance.now();
					const state = await driver.state();
					const waited = performance.now() - asked;

					expect(state.loading).toBe(true);
					expect(state.viewport).toEqual({ width: real.width, height: real.height });
					expect(waited).toBeLessThan(STALLED_RENDERER_BUDGET_MS);
				});
			} finally {
				await held.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"readers asking at once share one measurement of the person's window: its renderer is asked the size once, not once per reader",
		async () => {
			const { driver, chromeUrl, pageUrl } = await adoptedForegroundPage();
			await withPageAt(chromeUrl, pageUrl, async (page) => {
				await page.evaluate(() => {
					const read = Object.getOwnPropertyDescriptor(window, "innerWidth")?.get;
					if (read === undefined) throw new Error("innerWidth is not readable through an accessor here");
					let reads = 0;
					Object.defineProperty(window, "innerWidth", { configurable: true, get: () => ((reads += 1), read.call(window)) });
					Object.defineProperty(window, "sizeReads", { get: () => reads });
				});

				await Promise.all(Array.from({ length: SIZE_READERS }, () => driver.state()));

				const reads = await page.evaluate(() => Reflect.get(window, "sizeReads"));
				expect(reads).toBeGreaterThanOrEqual(1);
				expect(reads).toBeLessThan(SIZE_READERS);
			});
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a window the person grows past the size the live picture began at is cast at its new size from then on, not downscaled to the old one",
		async () => {
			const { driver, chromeUrl, pageUrl, real } = await adoptedForegroundPage();
			const frames: LiveFrame[] = [];
			const stop = driver.watchFrames((frame) => frames.push(frame));
			try {
				await waitUntil("the first picture", async () => frames.length, (count) => count >= 1);

				await resizeWindowOf(chromeUrl, pageUrl, { width: 1400, height: 1000 });
				const grown = await geometryOf(chromeUrl, pageUrl);
				expect(grown.width).toBeGreaterThan(real.width);
				expect(grown.height).toBeGreaterThan(real.height);

				const expected = { width: Math.round(grown.width * grown.ratio), height: Math.round(grown.height * grown.ratio) };
				await waitUntil(
					"a picture at the grown window's size",
					async () => readImageDimensions(frames.at(-1)!.jpeg),
					(size) => size !== undefined && Math.abs(size.width - expected.width) <= PICTURE_SIZE_TOLERANCE_PX && Math.abs(size.height - expected.height) <= PICTURE_SIZE_TOLERANCE_PX,
					10_000,
				);
			} finally {
				stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

/** What a machine with the application not running looks like: no other Chrome on it (a test's, a person's) is taken for the application, so an open starts its own. */
const NOTHING_RUNNING: ProcessScanner = { running: async () => ({ processes: [], unreadable: false }) };

describeWithChrome("an application the pack spawned", () => {
	/** A headless Chrome as the application, started by the kinds module with a profile of its own; the pid is ended in `finally`. */
	async function spawnApplication(): Promise<{ attach: AttachTarget; pid: number; userDataDir: string }> {
		if (chromePath === undefined) throw new Error("no Chrome");
		const userDataDir = await mkdtemp(join(tmpdir(), "dimension-attach-spawned-"));
		const established = await establishKind({ kind: "spawned", path: chromePath, args: ["--headless=new", `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"] }, { scanner: NOTHING_RUNNING });
		if (!("attach" in established) || established.attach.pid === undefined) throw new Error("expected an attach target with a pid");
		return { attach: established.attach, pid: established.attach.pid, userDataDir };
	}
	const driverOn = (attach: AttachTarget): Promise<EngineDriver> => createEngineDriver("chrome-relay", { profileDirectory: tmpdir(), viewport: { width: 640, height: 480 }, attach, onClosed: () => undefined });

	test(
		"closing the driver leaves it running, a hard stop of the attachment still leaves it running, and only a kill that asks for the application ends it",
		async () => {
			const { attach, pid, userDataDir } = await spawnApplication();
			try {
				const first = await driverOn(attach);
				await first.close();
				expect(alive(pid)).toBe(true);

				// A close that hung is answered by a hard stop (the runtime's fallback): the driver lets go at once, and the application the cell opened is not its to end.
				const second = await driverOn(attach);
				await second.kill();
				expect(alive(pid)).toBe(true);

				const third = await driverOn(attach);
				await third.kill({ application: true });
				expect(await gone(pid)).toBe(true);
			} finally {
				await killTree(pid);
				await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
