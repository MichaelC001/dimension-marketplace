// The READING frame a page is drawn in (docs/design/88 section 2): `sandbox=""`, unchanged for every reader.
// Picking adds a second frame; it never loosens this one. This file is the guard that no token is ever added to
// it, and that the page's markup stays in the frame and never enters the View's own tree.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import html from "../app/view/renderers/html";
import { installDom, stage, type TestDom } from "./dom";

let dom: TestDom;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.restore());

const ctx = { filename: "landing.html", theme: "dark" as const };
const hostile = [
	"<!doctype html><title>x</title>",
	"<script>parent.postMessage('owned','*')</script>",
	'<img src="https://tracker.example/p.gif" onerror="parent.steal()">',
	'<form action="https://evil.example"><input name="parentElement"></form>',
	'<a href="javascript:alert(1)">click</a>',
	'<meta http-equiv="refresh" content="0;url=https://evil.example">',
].join("");

async function mount(source = hostile) {
	const el = stage(dom.document);
	const handle = await html.mount(el, new TextEncoder().encode(source), ctx);
	const frame = el.querySelector("iframe") as HTMLIFrameElement;
	return { el, handle, frame };
}

describe("the sandbox", () => {
	test("is the empty token list: the reading frame runs nothing, shares no origin, and can do nothing, for every reader", async () => {
		const { frame } = await mount();
		expect(frame.hasAttribute("sandbox")).toBe(true);
		expect(frame.getAttribute("sandbox")).toBe("");
	});

	test("never grows a token for the picker's sake: Pick mode adds a frame beside this one, it does not loosen it", async () => {
		const { frame } = await mount();
		const attribute = frame.getAttribute("sandbox") ?? "";
		for (const token of ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation", "allow-modals", "allow-downloads"]) {
			expect(attribute, token).not.toContain(token);
		}
	});
});

describe("the frame", () => {
	test("is named for the picker to find: `viewer-html-frame`, an iframe", async () => {
		const { frame } = await mount();
		expect(frame.tagName.toLowerCase()).toBe("iframe");
		expect(frame.dataset.slot).toBe("viewer-html-frame");
	});

	test("carries the page by `srcdoc`, byte for byte, so it inherits the View's CSP", async () => {
		const { frame } = await mount();
		expect(frame.srcdoc).toBe(hostile);
		expect(frame.hasAttribute("src")).toBe(false);
	});

	test("keeps a page's markup inside the frame: nothing from it is put in the View's own tree", async () => {
		const { el } = await mount();
		expect(el.children).toHaveLength(1);
		expect(el.querySelectorAll("script, img, form, input, a, meta")).toHaveLength(0);
	});

	test("sends no referrer and is titled by its file", async () => {
		const { frame } = await mount();
		expect(frame.referrerPolicy).toBe("no-referrer");
		expect(frame.title).toBe("landing.html");
	});

	test("decodes the file as UTF-8", async () => {
		const { frame } = await mount("<p>naïve — 日本語</p>");
		expect(frame.srcdoc).toBe("<p>naïve — 日本語</p>");
	});
});

describe("zoom and destroy", () => {
	test("zooming scales the page and grows the frame by the inverse, so it still fills the pane", async () => {
		const { handle, frame } = await mount();
		handle.zoom?.(2);
		expect([frame.style.transform, frame.style.width, frame.style.height]).toEqual(["scale(2)", "50%", "50%"]);
		handle.zoom?.(0.5);
		expect([frame.style.transform, frame.style.width, frame.style.height]).toEqual(["scale(0.5)", "200%", "200%"]);
		handle.zoom?.(1);
		expect([frame.style.transform, frame.style.width, frame.style.height]).toEqual(["", "", ""]);
	});

	test("destroy takes the frame away", async () => {
		const { el, handle } = await mount();
		handle.destroy();
		expect(el.children).toHaveLength(0);
	});
});
