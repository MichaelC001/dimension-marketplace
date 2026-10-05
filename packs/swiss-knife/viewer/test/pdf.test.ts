import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { installDom, stage, type TestDom } from "./dom";

// pdf.js itself is stubbed: what is under test is what the renderer does with the
// page count a document CLAIMS. `/Count` is written by whoever made the file.
const CLAIMED_PAGES = 2_000_000_000;
/** Past this many DOM nodes the renderer is not bounded, whatever its own cap says. */
const ABSURD_NODE_COUNT = 20_000;

const page = {
	getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
	render: () => ({ promise: new Promise<void>(() => undefined), cancel: () => undefined }),
	streamTextContent: () => undefined,
};
const stubbedDocument = { numPages: CLAIMED_PAGES, getPage: async () => page };

mock.module("pdfjs-dist", () => ({
	getDocument: () => ({ promise: Promise.resolve(stubbedDocument), destroy: async () => undefined }),
	PDFWorker: { create: () => ({ destroy: () => undefined }) },
	TextLayer: class {
		render = async () => undefined;
		cancel = () => undefined;
	},
}));
mock.module("pdfjs-dist/build/pdf.worker.min.mjs?raw", () => ({ default: "self.onmessage = null;" }));

let dom: TestDom;
const realWorker = globalThis.Worker;
beforeAll(() => {
	dom = installDom();
	globalThis.Worker = class {
		terminate = () => undefined;
	} as unknown as typeof Worker;
});
afterAll(() => {
	globalThis.Worker = realWorker;
	dom.restore();
});

describe("pdf renderer with a document that claims billions of pages", () => {
	test("builds a bounded number of page slots, says so, and keeps the pager inside them", async () => {
		// Static import is not possible: the stubs above must be registered before the renderer's imports resolve.
		const { default: pdf, MAX_PAGE_SLOTS } = await import("../app/view/renderers/pdf");

		// A regression would try to build two billion nodes: stop it at the first slot past any sane bound.
		const create = dom.document.createElement.bind(dom.document);
		let created = 0;
		Object.defineProperty(dom.document, "createElement", {
			configurable: true,
			value: (...args: Parameters<Document["createElement"]>) => {
				if (++created > ABSURD_NODE_COUNT) throw new Error("the renderer is building page slots without a bound");
				return create(...args);
			},
		});
		// linkedom has no layout: give each slot the offset a stack of 100 px pages would have, and record where the pane is told to scroll.
		const scrolled: number[] = [];
		const proto = Object.getPrototypeOf(dom.document.createElement("div")) as HTMLElement;
		Object.defineProperties(proto, {
			offsetTop: { configurable: true, get: function (this: HTMLElement) { return Number(this.dataset.index) * 100; } },
			scrollTo: { configurable: true, value: (options: ScrollToOptions) => scrolled.push(options.top ?? Number.NaN) },
		});

		try {
			const el = stage(dom.document);
			const mounted = await pdf.mount(el, new Uint8Array([37, 80, 68, 70]), { filename: "huge.pdf", theme: "dark" });

			expect(el.querySelectorAll(".vw-pdf-page")).toHaveLength(MAX_PAGE_SLOTS);
			expect(el.querySelector(".vw-pdf-note")?.textContent).toBe("Showing the first 2,000 of 2,000,000,000 pages.");
			expect(mounted.pageCount).toBe(MAX_PAGE_SLOTS);

			mounted.goto?.(CLAIMED_PAGES);
			expect(scrolled.at(-1)).toBe((MAX_PAGE_SLOTS - 1) * 100 - 16); // the last slot that exists, not one of two billion
			mounted.destroy();
		} finally {
			Reflect.deleteProperty(dom.document, "createElement");
			Reflect.deleteProperty(proto, "offsetTop");
			Reflect.deleteProperty(proto, "scrollTo");
		}
	});
});
