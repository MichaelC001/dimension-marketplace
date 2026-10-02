/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent that opens a throwaway browser to do real work on the real
 *  web is turned away by the first bot check (a HeadlessChrome User-Agent, `navigator.webdriver`, a 1280x800 page on
 *  an 800x600 "screen", CDP Runtime left on, the driver's own reads showing in a hook on the page's APIs, a software
 *  GPU), while the same Chrome started by hand is not — or the opposite failure, that the person's View or a saved profile stops being the real, honest
 *  browser (doc 77 §12 decision 2: nothing hides automation where a person signs in).
 *
 *  These tests load a local page that reads the signals public bot-detection checks read
 *  (`bench/sites/detect.mjs`) in a REAL Chrome, and assert what the page observed. Only a throwaway browser (no
 *  profile) is shaped; a saved profile is not. The signals under test are the ones this change controls; others
 *  (audio device, installed fonts, codecs) belong to the host and the binary, and are not asserted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import stockPuppeteer from "puppeteer-core";
import { type DetectRow, type DetectServer, createDetectServer } from "../bench/sites/detect.mjs";
import { agentPuppeteer } from "../src/engines/agent-puppeteer";
import { resolveBrowser, viewLaunchOptions } from "../src/engines/launch";
import type { BrowserRuntime } from "../src/runtime";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, describeWithChrome, newRuntime, perform, teardown, waitUntil } from "./fixture";

const servers: DetectServer[] = [];
const popupSites: Array<{ stop(force?: boolean): unknown }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop();
	for (const site of popupSites.splice(0)) await site.stop(true);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

/** A Chrome with no GPU, as a CI box or a VPS has: the software renderer is what a page would see unmasked. */
const NO_GPU = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/** The signals this change controls, by row id. */
const CONTROLLED = [
	"webdriver", "iframe-webdriver", "worker-webdriver",
	"ua-headless", "ua-data-headless", "worker-ua-headless", "iframe-ua", "ch-ua-header-headless", "worker-matches-page",
	"outer-smaller-than-inner", "viewport-larger-than-screen", "screen-orientation", "screen-default", "window-fits-screen", "outer-window",
	"webgl-renderer", "webgl-precision", "webgl-worker-renderer", "iframe-webgl-renderer", "navigator-own-properties", "accessor-receiver", "native-source", "native-source-cross-realm",
	"cdp-runtime-enabled", "worker-runtime-enabled", "driver-main-world",
];

async function detector(): Promise<DetectServer> {
	const server = await createDetectServer();
	servers.push(server);
	return server;
}

const flagged = (rows: readonly DetectRow[]): string[] => rows.filter((row) => row.tell && CONTROLLED.includes(row.id)).map((row) => row.id);
const row = (rows: readonly DetectRow[], id: string): DetectRow => {
	const found = rows.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`the page reported no ${id} row; it reported ${rows.map((r) => r.id).join(", ")}`);
	return found;
};

/** Load the detection page in `browserId` and answer what it saw, including the row that needs the driver to have acted first. */
async function look(runtime: BrowserRuntime, server: DetectServer, browserId: string): Promise<DetectRow[]> {
	server.reset();
	await perform(runtime, browserId, { kind: "navigate", url: server.url });
	const rows = await waitUntil("the page's rows", () => server.rows(), (posted) => posted !== null);
	// The driver acts on the page (a snapshot runs its own scripts in it); the page then reports what its hooks saw.
	await runtime.snapshot(browserId);
	const after = server.lates();
	await waitUntil("the page's late row to be reported after the driver acted", () => server.lates(), (count) => count >= after + 2);
	const late = server.late();
	return [...(rows ?? []), ...(late ? [late] : [])];
}

/** The page's rows when a site opens it in a new tab (a link with target=_blank): the tab is created, shaped and released by the browser, not by a later call of ours. */
async function lookInNewTab(runtime: BrowserRuntime, server: DetectServer, browserId: string): Promise<DetectRow[]> {
	server.reset();
	await perform(runtime, browserId, { kind: "navigate", url: server.openerUrl });
	await perform(runtime, browserId, { kind: "click", selector: "#go" });
	const rows = await waitUntil("the new tab's rows", () => server.rows(), (posted) => posted !== null);
	return rows ?? [];
}

describeWithChrome("a throwaway browser against a bot-detection page", () => {
	test("raises none of the automation signals this change controls", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot());
		const { browserId } = await runtime.open({});
		expect(flagged(await look(runtime, server, browserId))).toEqual([]);
		// A cross-origin iframe is a process, a CDP session and a document start of its own.
		const frame = await waitUntil("the cross-origin frame's report", () => server.frame(), (reported) => reported !== null);
		expect(frame).toMatchObject({ webdriver: false, headless: false, runtime: false });
	}, BROWSER_TEST_TIMEOUT_MS);

	test("shows a new tab a site opens the same shaped browser from its first line", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot(), { launchArgs: NO_GPU });
		const { browserId } = await runtime.open({});
		const rows = await lookInNewTab(runtime, server, browserId);
		expect(flagged(rows)).toEqual([]);
		expect(row(rows, "webgl-renderer").value).not.toMatch(/swiftshader/i);
		expect(row(rows, "screen-default")).toMatchObject({ tell: false });
	}, BROWSER_TEST_TIMEOUT_MS);

	test("keeps its screen, window and orientation consistent after a resize and in a new tab", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot());
		const { browserId } = await runtime.open({});
		await perform(runtime, browserId, { kind: "resize", width: 1000, height: 700 });
		const resized = await look(runtime, server, browserId);
		expect(flagged(resized)).toEqual([]);
		expect(JSON.parse(row(resized, "outer-smaller-than-inner").value).slice(2)).toEqual([1000, 700]);

		await runtime.tab(browserId, { op: "new" });
		const second = await look(runtime, server, browserId);
		expect(flagged(second)).toEqual([]);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("shows a page no trace of the driver: its reads never reach a hook on the page's own APIs, and Runtime is off", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot());
		const { browserId } = await runtime.open({});
		const rows = await look(runtime, server, browserId);
		expect(row(rows, "driver-main-world")).toMatchObject({ tell: false });
		expect(row(rows, "cdp-runtime-enabled")).toMatchObject({ tell: false });
		expect(row(rows, "worker-runtime-enabled")).toMatchObject({ tell: false });
		// Whatever the page's hooks recorded names no script of the driver's.
		expect(row(rows, "driver-main-world").value).not.toMatch(/pptr:|puppeteer/i);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("hides a software renderer behind a GPU a person's Chrome would report, with native-looking functions", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot(), { launchArgs: NO_GPU });
		const { browserId } = await runtime.open({});
		const rows = await look(runtime, server, browserId);
		expect(flagged(rows)).toEqual([]);
		expect(row(rows, "webgl-renderer").value).not.toMatch(/swiftshader/i);
		// A worker's OffscreenCanvas and a cross-origin frame name the same GPU the page does.
		expect(row(rows, "webgl-worker-renderer").value).not.toMatch(/swiftshader/i);
		const frame = await waitUntil("the cross-origin frame's report", () => server.frame(), (reported) => reported !== null);
		expect(frame?.gpu?.join(" ")).not.toMatch(/swiftshader/i);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("browser_read's reader presents the same: no HeadlessChrome, no webdriver, a screen that fits", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot(), { allowPrivateReadHosts: ["127.0.0.1"] });
		const result = await runtime.read({ url: server.url, maxChars: 30_000 });
		if (result.status !== "ok") throw new Error(`the reader did not read the page: ${JSON.stringify(result)}`);
		const seen = result.text.split("\n").filter((line) => /^(FLAG|ok)\|/.test(line)).map((line) => ({ flag: line.startsWith("FLAG"), id: line.split("|")[1] ?? "" }));
		expect(seen.length).toBeGreaterThan(20);
		const controlled = ["webdriver", "iframe-webdriver", "ua-headless", "iframe-ua", "outer-smaller-than-inner", "viewport-larger-than-screen", "screen-orientation", "screen-default", "cdp-runtime-enabled"];
		expect(seen.filter((entry) => entry.flag && controlled.includes(entry.id)).map((entry) => entry.id)).toEqual([]);
		// Runtime is off, and the read script itself ran in the utility world: the page's hook on its APIs heard nothing from outside the page.
		expect(result.text).toMatch(/^RUNTIME\|off$/m);
		expect(server.hooked()).toEqual([]);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("browser_read's reader hides a software renderer too", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot(), { allowPrivateReadHosts: ["127.0.0.1"], launchArgs: NO_GPU });
		const result = await runtime.read({ url: server.url, maxChars: 30_000 });
		if (result.status !== "ok") throw new Error(`the reader did not read the page: ${JSON.stringify(result)}`);
		expect(result.text).toMatch(/^ok\|webgl-renderer\|/m);
		expect(result.text).not.toMatch(/^ok\|webgl-renderer\|.*swiftshader/im);
	}, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("a saved profile's browser (the View) stays the real browser", () => {
	test("is honest about automation and shows the host's own GPU, unlike a throwaway", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot(), { launchArgs: NO_GPU });
		const { browserId } = await runtime.open({ profile: "person" });
		const rows = await look(runtime, server, browserId);
		// No automation-hiding switch: a person signing in to Google must not be disguised (doc 77 §12 decision 2).
		expect(row(rows, "webdriver")).toMatchObject({ tell: true, value: "true" });
		expect(row(rows, "iframe-webdriver").tell).toBe(true);
		// No fingerprint change: the software renderer is what the page sees.
		expect(row(rows, "webgl-renderer")).toMatchObject({ tell: true });
		expect(row(rows, "webgl-renderer").value).toMatch(/swiftshader/i);
		// Stock puppeteer turns Runtime on in every page and every worker; the page's probe must see it, or its "false" for a throwaway means nothing.
		expect(row(rows, "cdp-runtime-enabled")).toMatchObject({ tell: true });
		expect(row(rows, "worker-runtime-enabled")).toMatchObject({ tell: true });
		// Stock reads in the page's own world: a hook on the page's APIs hears them.
		expect(row(rows, "driver-main-world")).toMatchObject({ tell: true });
		// No screen or window fitting: headless Chrome's own 800x600 screen under the page.
		expect(row(rows, "screen-default")).toMatchObject({ tell: true });
		expect(row(rows, "viewport-larger-than-screen")).toMatchObject({ tell: true });
	}, BROWSER_TEST_TIMEOUT_MS);
});

/** A site whose /opens page opens a popup the moment it loads, with no click: Chrome's popup blocker answers `null` when it is on. The page reports what it got. */
function startPopupSite(): { url: string; reported: string[] } {
	const reported: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname, searchParams } = new URL(request.url);
			const html = (body: string) => new Response(`<!doctype html><meta charset="utf-8">${body}`, { headers: { "content-type": "text/html" } });
			if (pathname === "/opens") return html('<title>opens</title><body></body><script>const w = window.open("/popup"); const got = w ? "window" : "null"; document.body.textContent = "OPENED:" + got; fetch("/report?opened=" + got);</script>');
			if (pathname === "/report") {
				reported.push(searchParams.get("opened") ?? "");
				return new Response("ok");
			}
			return html("<title>popup</title>popup");
		},
	});
	popupSites.push(server);
	return { url: `http://127.0.0.1:${server.port}/opens`, reported };
}

describeWithChrome("Chrome's popup blocker", () => {
	test("stays on in a throwaway browser and in the reader, and is off in a saved profile's browser as puppeteer leaves it", async () => {
		const site = startPopupSite();
		const runtime = newRuntime(await createRoot(), { allowPrivateReadHosts: ["127.0.0.1"] });

		// A throwaway: a page that opens a window on its own gets nothing (the stock default would let it, and no person's Chrome does).
		const { browserId } = await runtime.open({});
		await perform(runtime, browserId, { kind: "navigate", url: site.url });
		await waitUntil("the throwaway page to report", () => site.reported.length, (count) => count >= 1);
		expect(site.reported).toEqual(["null"]);

		// The reader, which has launch arguments of its own.
		site.reported.length = 0;
		const read = await runtime.read({ url: site.url, maxChars: 2_000 });
		if (read.status !== "ok") throw new Error(`the reader did not read the page: ${JSON.stringify(read)}`);
		expect(read.text).toContain("OPENED:null");
		expect(site.reported).toEqual(["null"]);

		// Control: the same page in a saved profile's browser (stock launch arguments) does get its window, so "null" above is the blocker and not the page.
		site.reported.length = 0;
		const saved = await runtime.open({ profile: "person" });
		await perform(runtime, saved.browserId, { kind: "navigate", url: site.url });
		await waitUntil("the saved profile's page to report", () => site.reported.length, (count) => count >= 1);
		expect(site.reported).toEqual(["window"]);
	}, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("the command line Chrome is started with", () => {
	const disabledFeatures = (argv: readonly string[]): string[] => argv.filter((arg) => arg.startsWith("--disable-features=")).flatMap((arg) => arg.slice("--disable-features=".length).split(",")).filter(Boolean);

	/** The arguments a Chrome was spawned with, launched as the pack launches a headless browser (`viewLaunchOptions`), by `driver`. */
	async function spawnedWith(driver: typeof stockPuppeteer, agent: boolean): Promise<string[]> {
		const userDataDir = mkdtempSync(join(tmpdir(), "agent-launch-argv-"));
		const browser = await driver.launch(viewLaunchOptions({ browser: await resolveBrowser(chromePath), userDataDir, headless: true, args: [], agent, timeout: 60_000 }));
		try {
			return browser.process()?.spawnargs ?? [];
		} finally {
			await browser.close();
			rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	}

	test("for a throwaway agent browser carries none of puppeteer's automation switches and the one that turns navigator.webdriver off, which the View's does not", async () => {
		const saved = await spawnedWith(stockPuppeteer, false);
		// Control: what puppeteer starts Chrome with when only --enable-automation is dropped (the View and a saved profile).
		expect(saved).toEqual(expect.arrayContaining(["--disable-popup-blocking", "--disable-ipc-flooding-protection", "--allow-pre-commit-input"]));
		expect(disabledFeatures(saved)).toContain("AcceptCHFrame");
		expect(saved).not.toContain("--disable-blink-features=AutomationControlled");

		const agent = await spawnedWith(await agentPuppeteer(), true);
		for (const dropped of ["--enable-automation", "--disable-popup-blocking", "--disable-ipc-flooding-protection", "--allow-pre-commit-input"]) expect(agent).not.toContain(dropped);
		expect(agent).toContain("--disable-blink-features=AutomationControlled");
		// The patched launcher adds none of puppeteer's own list of disabled features: the only ones are the caller's (none here).
		expect(disabledFeatures(agent)).toEqual([]);
	}, BROWSER_TEST_TIMEOUT_MS);
});
