import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import docx from "../app/view/renderers/docx";
import { LINK_ATTRIBUTE } from "../app/view/renderers/office/shared";
import { installDom, stage, type TestDom } from "./dom";
import { buildDocx, hyperlink, pageBreak, paragraph } from "./office-fixtures";

let dom: TestDom;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.restore());

const ctx = { filename: "report.docx", theme: "dark" } as const;

/** The document's own tree: docx renders into a shadow root so its styles stay off the pane. */
function documentHost(el: HTMLElement): HTMLElement {
	const host = Array.from(el.querySelectorAll<HTMLElement>("div")).find(candidate => candidate.shadowRoot);
	if (!host?.shadowRoot) throw new Error("the document was not rendered into a shadow root");
	return host;
}

const page = (el: HTMLElement): ShadowRoot => documentHost(el).shadowRoot as ShadowRoot;

/** Everything written on the pages. */
const pagesText = (el: HTMLElement): string =>
	Array.from(page(el).querySelectorAll("section.docx"))
		.map(section => section.textContent ?? "")
		.join("\n");

describe("docx renderer", () => {
	test("draws the document's text on a page, and a single page has no pager", async () => {
		const el = stage(dom.document);
		const mounted = await docx.mount(el, await buildDocx(paragraph("Quarterly plan") + paragraph("Revenue grew")), ctx);
		expect(pagesText(el)).toContain("Quarterly plan");
		expect(pagesText(el)).toContain("Revenue grew");
		expect(mounted.pageCount).toBeUndefined();
		expect(mounted.goto).toBeUndefined();
		expect(mounted.zoom).toBeFunction();
		mounted.destroy();
		expect(el.childNodes).toHaveLength(0);
	});

	test("explicit page breaks become pages the pager can count", async () => {
		const el = stage(dom.document);
		const bytes = await buildDocx(paragraph("one") + pageBreak + paragraph("two") + pageBreak + paragraph("three"));
		const mounted = await docx.mount(el, bytes, ctx);
		expect(mounted.pageCount).toBe(3);
		expect(mounted.goto).toBeFunction();
		mounted.destroy();
	});

	test("a hyperlink in the file cannot navigate the frame or run script", async () => {
		const el = stage(dom.document);
		const bytes = await buildDocx(
			hyperlink("rId7", "safe link") + hyperlink("rId8", "hostile link"),
			{ rId7: "https://example.test/report", rId8: "javascript:alert(1)" },
		);
		await docx.mount(el, bytes, ctx);
		const links = Array.from(page(el).querySelectorAll("a"));
		expect(links).toHaveLength(2);
		for (const link of links) expect(link.hasAttribute("href")).toBe(false);
		const byText = (text: string) => links.find(link => link.textContent === text);
		expect(byText("safe link")?.getAttribute(LINK_ATTRIBUTE)).toBe("https://example.test/report");
		expect(byText("hostile link")?.hasAttribute(LINK_ATTRIBUTE)).toBe(false);
	});

	test("a font name that breaks out of its CSS declaration cannot leave the box the pane put the document in", async () => {
		// docx-preview pastes a font name into its <style> unescaped; this one closes the rule and restyles `:host`.
		const hostile = "x;}:host{position:fixed;inset:0;z-index:9999}";
		const styles = `<w:style w:type="paragraph" w:styleId="Evil"><w:name w:val="Evil"/><w:rPr><w:rFonts w:ascii="${hostile}"/></w:rPr></w:style>`;
		const body = '<w:p><w:pPr><w:pStyle w:val="Evil"/></w:pPr><w:r><w:t>still readable</w:t></w:r></w:p>';
		const el = stage(dom.document);
		await docx.mount(el, await buildDocx(body, {}, styles), ctx);

		const shadow = page(el);
		const stylesheets = Array.from(shadow.querySelectorAll("style"))
			.map(sheet => sheet.textContent ?? "")
			.join("\n");
		expect(stylesheets, "the payload must reach a stylesheet, or this test proves nothing").toContain(hostile);

		// What defends the chrome is the box around the shadow host: set inline, so nothing in the shadow tree's CSS can reach it.
		const guard = documentHost(el).parentElement;
		const inline = guard?.getAttribute("style") ?? "";
		expect(inline).toMatch(/contain:\s*paint/);
		expect(inline).toMatch(/overflow:\s*hidden/);
		expect(inline).toMatch(/isolation:\s*isolate/);
		// And the hostile text never lands anywhere but the shadow tree.
		expect(el.innerHTML).not.toContain("z-index:9999");
	});
});

describe("docx renderer: the annotation layer's text root", () => {
	test("the shadow host that holds the pages is the marked text root", async () => {
		const el = stage(dom.document);
		await docx.mount(el, await buildDocx(paragraph("Quarterly plan")), ctx);
		const roots = el.querySelectorAll('[data-slot="viewer-text-root"]');
		expect(roots).toHaveLength(1);
		expect((roots[0] as HTMLElement).shadowRoot).toBe(page(el));
		expect(pagesText(el)).toContain("Quarterly plan");
	});
});
