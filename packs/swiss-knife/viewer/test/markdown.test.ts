import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import DOMPurify from "dompurify";
import markdown from "../app/view/renderers/markdown";
import { installDom, stage, type TestDom } from "./dom";

// linkedom cannot host DOMPurify, and this file is about what a click does to a link
// that is already in the tree, not about the sanitiser: stand it in for the run.
const realPurify = { isSupported: DOMPurify.isSupported, sanitize: DOMPurify.sanitize };
let dom: TestDom;
beforeAll(() => {
	dom = installDom();
	Object.assign(DOMPurify, { isSupported: true, sanitize: (html: string) => html });
});
afterAll(() => {
	Object.assign(DOMPurify, realPurify);
	dom.restore();
});

const source = new TextEncoder().encode("[web](https://example.test/page) and [local](docs/notes.md)");

describe("markdown link activation", () => {
	async function activate(type: "click" | "auxclick", label: string): Promise<{ event: Event; hosted: string[] }> {
		const hosted: string[] = [];
		const el = stage(dom.document);
		await markdown.mount(el, source, { filename: "notes.md", theme: "dark", openLink: url => hosted.push(url) });
		const link = Array.from(el.querySelectorAll("a")).find(candidate => candidate.textContent === label);
		if (!link) throw new Error(`no link labelled ${label}`);
		const event = new window.Event(type, { bubbles: true, cancelable: true });
		link.dispatchEvent(event);
		return { event, hosted };
	}

	test("a primary click on an http(s) link goes to the host and never navigates the frame", async () => {
		const { event, hosted } = await activate("click", "web");
		expect(hosted).toEqual(["https://example.test/page"]);
		expect(event.defaultPrevented).toBe(true);
	});

	test("a primary click on any other link does nothing", async () => {
		const { event, hosted } = await activate("click", "local");
		expect(hosted).toEqual([]);
		expect(event.defaultPrevented).toBe(true);
	});

	test("a middle click never reaches the browser's default (a popup of the raw href), and opens nothing itself", async () => {
		for (const label of ["web", "local"]) {
			const { event, hosted } = await activate("auxclick", label);
			expect(event.defaultPrevented, label).toBe(true);
			expect(hosted, label).toEqual([]);
		}
	});
});
