// `fixtures/deck.pptx` is four text slides (title, bullets, a table, closing) made by
// pptxgenjs 4.0.1:
//   const p = new PptxGenJS(); p.layout = "LAYOUT_16x9";
//   p.addSlide().addText("Chat Roadmap", {...}); ... p.writeFile({ fileName: "deck.pptx" });
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import pptx from "../app/view/renderers/pptx";
import { installDom, stage, type TestDom } from "./dom";

let dom: TestDom;
let deck: Uint8Array;
beforeAll(async () => {
	dom = installDom();
	deck = new Uint8Array(await readFile(new URL("./fixtures/deck.pptx", import.meta.url)));
});
afterAll(() => dom.restore());

const ctx = { filename: "deck.pptx", theme: "dark" } as const;

describe("pptx renderer", () => {
	test("the pager counts the slides the file holds, not some other number", async () => {
		const slidesInFile = Object.keys((await JSZip.loadAsync(deck)).files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
		expect(slidesInFile).toBe(4);

		const el = stage(dom.document);
		const mounted = await pptx.mount(el, deck, ctx);
		expect(mounted.pageCount).toBe(slidesInFile);
		expect(mounted.goto).toBeFunction();
		expect(mounted.zoom).toBeFunction();
		mounted.destroy();
		expect(el.childNodes).toHaveLength(0);
	});

	test("a deck with no slides says so instead of drawing a blank page", async () => {
		const zip = await JSZip.loadAsync(deck);
		const presentation = await zip.file("ppt/presentation.xml")?.async("string");
		zip.file("ppt/presentation.xml", (presentation ?? "").replace(/<p:sldIdLst>.*<\/p:sldIdLst>/s, "<p:sldIdLst/>"));
		zip.remove("ppt/slides");
		const el = stage(dom.document);
		await pptx.mount(el, await zip.generateAsync({ type: "uint8array" }), ctx);
		expect(el.querySelector("[role=alert]")?.textContent).toMatch(/no slides/i);
	});
});

describe("pptx shape links", () => {
	const HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

	/** The deck with its first shape made clickable: a link to `target`, outside the file. */
	async function deckLinkingTo(target: string): Promise<Uint8Array> {
		const zip = await JSZip.loadAsync(deck);
		const slide = (await zip.file("ppt/slides/slide1.xml")?.async("string")) ?? "";
		const rels = (await zip.file("ppt/slides/_rels/slide1.xml.rels")?.async("string")) ?? "";
		zip.file("ppt/slides/slide1.xml", slide.replace('<p:cNvPr id="2" name="Text 0"></p:cNvPr>', '<p:cNvPr id="2" name="Text 0"><a:hlinkClick r:id="rIdLink"/></p:cNvPr>'));
		zip.file(
			"ppt/slides/_rels/slide1.xml.rels",
			rels.replace("</Relationships>", `<Relationship Id="rIdLink" Type="${HYPERLINK}" Target="${target}" TargetMode="External"/></Relationships>`),
		);
		return zip.generateAsync({ type: "uint8array" });
	}

	/** Click the shape that links to `target`; report what reached the host and what tried to open a window. */
	async function clickLink(target: string): Promise<{ hosted: string[]; popups: unknown[][]; found: boolean }> {
		const hosted: string[] = [];
		const popups: unknown[][] = [];
		const previous = Object.getOwnPropertyDescriptor(window, "open");
		Object.defineProperty(window, "open", { value: (...args: unknown[]) => popups.push(args), configurable: true, writable: true });
		try {
			const el = stage(dom.document);
			const mounted = await pptx.mount(el, await deckLinkingTo(target), { ...ctx, openLink: url => hosted.push(url) });
			const shape = Array.from(el.querySelectorAll<HTMLElement>("[title]")).find(candidate => candidate.title === target);
			shape?.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
			mounted.destroy();
			return { hosted, popups, found: shape !== undefined };
		} finally {
			if (previous) Object.defineProperty(window, "open", previous);
			else Reflect.deleteProperty(window, "open");
		}
	}

	test("an http(s) link on a shape goes to the host and never opens a window of its own", async () => {
		const clicked = await clickLink("https://example.test/roadmap");
		expect(clicked.found, "the fixture's shape must carry the link").toBe(true);
		expect(clicked.hosted).toEqual(["https://example.test/roadmap"]);
		expect(clicked.popups).toEqual([]);
	});

	test("a mailto: link on a shape is dropped, not handed to a window", async () => {
		const clicked = await clickLink("mailto:someone@example.test");
		expect(clicked.found, "the library draws a clickable shape for mailto:").toBe(true);
		expect(clicked.hosted).toEqual([]);
		expect(clicked.popups).toEqual([]);
	});
});

describe("pptx renderer: the annotation layer's text root", () => {
	test("the slide host is the marked text root and the slide on screen says which slide it is", async () => {
		const el = stage(dom.document);
		await pptx.mount(el, deck, ctx);
		const roots = el.querySelectorAll('[data-slot="viewer-text-root"]');
		expect(roots).toHaveLength(1);
		const numbered = Array.from(roots[0].querySelectorAll<HTMLElement>("[data-page-number]")).map(slide => slide.dataset.pageNumber);
		expect(numbered).toContain("1");
	});
});
