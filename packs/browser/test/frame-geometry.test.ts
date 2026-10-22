import { afterEach, expect, test } from "bun:test";
import puppeteer from "puppeteer-core";
import { pngSize } from "../src/code/kinds/cmux/png";
import type { BrowserRuntime } from "../src/runtime";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, perform, startFixture, teardown } from "./fixture";
import { startDebugChrome, stopDebugChromes } from "./kinds-fixture";

const VIEWPORT = { width: 640, height: 480 };
const SCROLLED_TO = 1000;
const CHAT = "frame-geometry-chat";
const BLOCK_AT_TOP: Colour = { r: 26, g: 230, b: 26 };
const BLOCK_AT_BOTTOM: Colour = { r: 26, g: 230, b: 189 };
const JPEG_TOLERANCE = 40;

interface Colour {
	r: number;
	g: number;
	b: number;
}

interface Decoded {
	width: number;
	height: number;
	top: Colour;
	bottom: Colour;
}

afterEach(async () => {
	await teardown();
	await stopDebugChromes();
}, BROWSER_TEST_TIMEOUT_MS);

async function decode(image: Uint8Array, mime: "image/png" | "image/jpeg"): Promise<Decoded> {
	const chrome = await startDebugChrome();
	const browser = await puppeteer.connect({ browserURL: chrome.cdpUrl, defaultViewport: null });
	try {
		const page = await browser.newPage();
		return await page.evaluate(async (source) => {
			const bitmap = await createImageBitmap(await (await fetch(source)).blob());
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const context = canvas.getContext("2d");
			if (context === null) throw new Error("no 2d context");
			context.drawImage(bitmap, 0, 0);
			const at = (y: number): Colour => {
				const [r, g, b] = context.getImageData(Math.floor(bitmap.width * 0.9), y, 1, 1).data;
				return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
			};
			return { width: bitmap.width, height: bitmap.height, top: at(Math.floor(bitmap.height * 0.02)), bottom: at(Math.floor(bitmap.height * 0.98)) };
		}, `data:${mime};base64,${Buffer.from(image).toString("base64")}`);
	} finally {
		await browser.disconnect();
	}
}

function expectColour(actual: Colour, expected: Colour): void {
	expect(Math.abs(actual.r - expected.r)).toBeLessThan(JPEG_TOLERANCE);
	expect(Math.abs(actual.g - expected.g)).toBeLessThan(JPEG_TOLERANCE);
	expect(Math.abs(actual.b - expected.b)).toBeLessThan(JPEG_TOLERANCE);
}

async function scrolledTallPage(ratio: number): Promise<{ runtime: BrowserRuntime; browserId: string }> {
	const fixture = startFixture();
	const { runtime } = await createRuntime();
	const { browserId } = await runtime.open({ viewport: VIEWPORT }, { caller: "app", session: CHAT });
	await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/tall") });
	await runtime.resize(browserId, VIEWPORT, ratio);
	await runtime.actMany(browserId, [{ kind: "eval", expression: `window.scrollTo(0, ${SCROLLED_TO})` }]);
	return { runtime, browserId };
}

describeWithChrome("a frozen frame of a page this pack owns", () => {
	test.each([{ ratio: 1 }, { ratio: 1.25 }, { ratio: 2 }])(
		"at pixel ratio $ratio is the whole visible viewport at that ratio, taken from where the page is scrolled to",
		async ({ ratio }) => {
			const { runtime, browserId } = await scrolledTallPage(ratio);

			const frame = await runtime.frame(browserId);

			expect(frame.state.viewport).toEqual(VIEWPORT);
			const png = Buffer.from(frame.data, "base64");
			expect(pngSize(png)).toEqual({ width: VIEWPORT.width * ratio, height: VIEWPORT.height * ratio });
			const seen = await decode(png, "image/png");
			expectColour(seen.top, BLOCK_AT_TOP);
			expectColour(seen.bottom, BLOCK_AT_BOTTOM);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("a preview still of a page this pack owns", () => {
	test.each([{ ratio: 1 }, { ratio: 2 }])(
		"at pixel ratio $ratio shows the visible part of a scrolled page from its first row, at the viewport's shape",
		async ({ ratio }) => {
			const { runtime, browserId } = await scrolledTallPage(ratio);

			const still = await runtime.previewStill(CHAT, browserId);

			if (still === undefined) throw new Error("expected a preview still");
			const seen = await decode(Buffer.from(still, "base64"), "image/jpeg");
			expect(seen.width / seen.height).toBeCloseTo(VIEWPORT.width / VIEWPORT.height, 1);
			expectColour(seen.top, BLOCK_AT_TOP);
			expectColour(seen.bottom, BLOCK_AT_BOTTOM);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
