/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent that opens a throwaway browser to do real work on the real
 *  web is turned away by the first bot check (a HeadlessChrome User-Agent, `navigator.webdriver`, a 1280x800 page on
 *  an 800x600 "screen", the pack's own file path in a stack trace, a software GPU), while the same Chrome started by
 *  hand is not — or the opposite failure, that the person's View or a saved profile stops being the real, honest
 *  browser (doc 77 §12 decision 2: nothing hides automation where a person signs in).
 *
 *  These tests load a local page that reads the signals public bot-detection checks read
 *  (`bench/sites/detect.mjs`) in a REAL Chrome, and assert what the page observed. Only a throwaway browser (no
 *  profile) is shaped; a saved profile is not. The signals under test are the ones this change controls; others
 *  (audio device, installed fonts, codecs) belong to the host and the binary, and are not asserted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type DetectRow, type DetectServer, createDetectServer } from "../bench/sites/detect.mjs";
import { withoutDriverNames } from "../src/engines/agent-browser";
import type { BrowserRuntime } from "../src/runtime";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, perform, teardown, waitUntil } from "./fixture";

const servers: DetectServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

/** A Chrome with no GPU, as a CI box or a VPS has: the software renderer is what a page would see unmasked. */
const NO_GPU = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/** The signals this change controls, by row id. */
const CONTROLLED = [
	"webdriver", "iframe-webdriver", "worker-webdriver",
	"ua-headless", "ua-data-headless", "worker-ua-headless", "iframe-ua", "ch-ua-header-headless", "worker-matches-page",
	"outer-smaller-than-inner", "viewport-larger-than-screen", "screen-orientation", "screen-default", "window-fits-screen", "outer-window",
	"webgl-renderer", "driver-sourceurl", "navigator-own-properties", "accessor-receiver", "native-source",
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

describe("the driver's script names", () => {
	const named = "(a) => a\n//# sourceURL=pptr:evaluate;fn%20(C%3A%5Cwork%5Cpack%5Cdriver.ts%3A9%3A3)\n";

	test("are taken out of the two commands that evaluate with them, and out of nothing else", () => {
		expect(withoutDriverNames("Runtime.callFunctionOn", { functionDeclaration: named, objectId: "1" })).toEqual({ functionDeclaration: "(a) => a\n", objectId: "1" });
		expect(withoutDriverNames("Runtime.evaluate", { expression: named, awaitPromise: true })).toEqual({ expression: "(a) => a\n", awaitPromise: true });
		// Other commands carry no such name; a page script is not ours to edit.
		const other = { source: named };
		expect(withoutDriverNames("Page.addScriptToEvaluateOnNewDocument", other)).toBe(other);
	});

	test("leave a model's own sourceURL alone: a script it named itself keeps its name in the stack", () => {
		const own = { expression: "run()\n//# sourceURL=my-script.js\n" };
		expect(withoutDriverNames("Runtime.evaluate", own)).toBe(own);
	});
});

describeWithChrome("a throwaway browser against a bot-detection page", () => {
	test("raises none of the automation signals this change controls", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot());
		const { browserId } = await runtime.open({});
		expect(flagged(await look(runtime, server, browserId))).toEqual([]);
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

	test("shows a page no trace of the driver's own scripts or the pack's file path", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot());
		const { browserId } = await runtime.open({});
		const rows = await look(runtime, server, browserId);
		expect(row(rows, "driver-sourceurl")).toMatchObject({ tell: false });
		expect(row(rows, "driver-sourceurl").value).not.toContain("pptr:");
	}, BROWSER_TEST_TIMEOUT_MS);

	test("hides a software renderer behind a GPU a person's Chrome would report, with native-looking functions", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot(), { launchArgs: NO_GPU });
		const { browserId } = await runtime.open({});
		const rows = await look(runtime, server, browserId);
		// The precondition: this Chrome really has no GPU (a worker's canvas is not masked).
		expect(row(rows, "webgl-worker-renderer").value).toMatch(/swiftshader/i);
		expect(flagged(rows)).toEqual([]);
		expect(row(rows, "webgl-renderer").value).not.toMatch(/swiftshader/i);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("browser_read's reader presents the same: no HeadlessChrome, no webdriver, a screen that fits", async () => {
		const server = await detector();
		const runtime = newRuntime(await createRoot(), { allowPrivateReadHosts: ["127.0.0.1"] });
		const result = await runtime.read({ url: server.url, maxChars: 30_000 });
		if (result.status !== "ok") throw new Error(`the reader did not read the page: ${JSON.stringify(result)}`);
		const seen = result.text.split("\n").filter((line) => /^(FLAG|ok)\|/.test(line)).map((line) => ({ flag: line.startsWith("FLAG"), id: line.split("|")[1] ?? "" }));
		expect(seen.length).toBeGreaterThan(20);
		const controlled = ["webdriver", "iframe-webdriver", "ua-headless", "iframe-ua", "outer-smaller-than-inner", "viewport-larger-than-screen", "screen-orientation", "screen-default"];
		expect(seen.filter((entry) => entry.flag && controlled.includes(entry.id)).map((entry) => entry.id)).toEqual([]);
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
	}, BROWSER_TEST_TIMEOUT_MS);
});
