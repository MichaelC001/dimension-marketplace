// The shape the bar above a document promises, so that it can never again be three rows tall on a phone: at 390 px the
// PDF header wrapped to three rows (120 px) and the page under it rendered tiny. The bar is TWO flex items and no more -
// the file (kind, name, size, Copy path) and, only when there are any, the controls (pages, zoom) - so a View too narrow
// for both on one line puts the controls underneath as a whole, and that is two rows at most.
//
// linkedom has no layout, so none of this is a pixel: what is judged is the structure a layout engine is handed (which
// elements are the bar's children, in which order) and the class tokens that ARE the wrap rules here (`flex-wrap`,
// `min-w-0`, `basis-*`). That the 390 px header really is two rows is a real browser's to say. The REAL `Toolbar` is
// mounted, in linkedom with the real react-dom under `act`, as the pane's own tests do.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Toolbar as ToolbarComponent, ToolbarProps } from "../app/view/toolbar";
import { installReact, type ReactEnv } from "./media-react";

let env: ReactEnv;
let Toolbar: typeof ToolbarComponent;
let written: string[] = [];
const original = { clipboard: Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard") };
// linkedom's windows share their timers: what is replaced here has to be put back for every file that runs after.
let realTimers: Pick<typeof window, "setTimeout" | "clearTimeout">;

beforeAll(async () => {
	env = await installReact();
	realTimers = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout };
	// The moment "Path copied" lasts is `use-copied`'s own to test; here no timer fires, so no test waits on the clock.
	Object.assign(window, { setTimeout: () => 0, clearTimeout: () => undefined });
	Object.defineProperty(globalThis.navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text: string) => void written.push(text) },
	});
	// Dynamic by necessity: react-dom (loaded by `installReact`) decides once, when it loads, whether there is a DOM.
	({ Toolbar } = await import("../app/view/toolbar"));
});
afterEach(async () => {
	await env.cleanup();
	written = [];
});
afterAll(() => {
	Object.assign(window, realTimers);
	if (original.clipboard) Object.defineProperty(globalThis.navigator, "clipboard", original.clipboard);
	else delete (globalThis.navigator as unknown as Record<string, unknown>).clipboard;
	env.restore();
});

const NAME = "quarterly-report-final-v3.pdf";
const PATH = "C:\\Users\\Me\\Documents\\reports\\quarterly-report-final-v3.pdf";
// Mid-range on purpose: a page at an end or a zoom at its limit disables a button, and a disabled button is out of the tab order.
const PAGER = { page: 2, count: 12, onGoto: () => undefined };
const ZOOM = { factor: 1, onStep: () => undefined, onReset: () => undefined };

type Over = Partial<Omit<ToolbarProps, "filename" | "path">>;
/** The header of a PDF: every part the bar can have. */
const PDF: Over = { kind: "pdf", size: 2_400_000, pager: PAGER, zoom: ZOOM };

const BAR = '[data-slot="viewer-toolbar"]';
const FILE = '[data-slot="viewer-toolbar-file"]';
const CONTROLS = '[data-slot="viewer-toolbar-controls"]';
const COPY = 'button[aria-label="Copy path"]';
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

function one(root: Element, selector: string): HTMLElement {
	const found = root.querySelector<HTMLElement>(selector);
	if (found === null) throw new Error(`nothing matches ${selector}`);
	return found;
}

async function show(over: Over = {}) {
	const { container } = await env.mount(createElement(Toolbar, { filename: NAME, path: PATH, ...over }));
	return { container, bar: one(container, BAR) };
}

const slots = (parent: Element): (string | null)[] => Array.from(parent.children).map(child => child.getAttribute("data-slot"));
const tokens = (element: Element): string[] => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const groupsIn = (root: Element): (string | null)[] => Array.from(root.querySelectorAll('[role="group"]')).map(group => group.getAttribute("aria-label"));
/** What a control is called to a person using it; the zoom reset's name carries the percent, which is not its identity. */
const nameOf = (control: Element): string => {
	const label = control.getAttribute("aria-label") ?? control.textContent ?? "";
	return label.endsWith("Reset zoom") ? "Reset zoom" : label;
};
const focusable = (bar: Element): Element[] => Array.from(bar.querySelectorAll(FOCUSABLE)).filter(control => !control.hasAttribute("disabled"));
const nameSpan = (bar: HTMLElement): HTMLSpanElement | undefined => Array.from(one(bar, FILE).querySelectorAll("span")).find(span => span.textContent === NAME);

const win = (): Window & typeof globalThis => env.document.defaultView as Window & typeof globalThis;

function click(element: Element): Promise<void> {
	return env.act(async () => void element.dispatchEvent(new (win().Event)("click", { bubbles: true, cancelable: true })));
}

describe("the bar is two flex items and no more", () => {
	test.each<[string, Over, boolean]>([
		["only a name and a path (a file that did not open)", {}, false],
		["a kind and a size (a sound)", { kind: "audio", size: 3_400_000 }, false],
		["a kind, a size and a pager", { kind: "docx", size: 48_000, pager: PAGER }, true],
		["a kind, a size and a zoom", { kind: "image", size: 912_000, zoom: ZOOM }, true],
		["a kind, a size, a pager and a zoom (a PDF)", PDF, true],
		["a large text file of which only the head was read, with a zoom", { kind: "text", size: 52_000_000, shownBytes: 1_000_000, zoom: ZOOM }, true],
	])("%s: the file, then the controls only if there are any", async (_what, over, hasControls) => {
		const { bar } = await show(over);
		// Not a count: a third child of any kind (pager and zoom as their own items, Copy path on the bar) is a third row to wrap onto.
		expect(slots(bar)).toEqual(hasControls ? ["viewer-toolbar-file", "viewer-toolbar-controls"] : ["viewer-toolbar-file"]);
	});

	test.each<[string, Over, string[]]>([
		["a sound has no pages and no zoom: no controls group, so no empty row", { kind: "audio", size: 3_400_000 }, []],
		["a file that did not open has nothing to page or zoom: no controls group", {}, []],
		["pages alone: the Pages group, and no Zoom group", { kind: "docx", size: 48_000, pager: PAGER }, ["Pages"]],
		["zoom alone: the Zoom group, and no Pages group", { kind: "image", size: 912_000, zoom: ZOOM }, ["Zoom"]],
		["pages and zoom: Pages first, then Zoom", PDF, ["Pages", "Zoom"]],
	])("%s", async (_what, over, expected) => {
		const { bar } = await show(over);
		const controls = bar.querySelector(CONTROLS);
		expect(controls !== null).toBe(expected.length > 0);
		// Every group is the controls group's: none is a bar item (or the file's) of its own.
		expect(groupsIn(bar)).toEqual(expected);
		if (controls !== null) expect(groupsIn(controls)).toEqual(expected);
	});
});

describe("Copy path", () => {
	test("is the last thing in the file group, the only one in the bar, and copies the path (not the name), saying so", async () => {
		const { bar } = await show(PDF);
		const file = one(bar, FILE);
		const copies = bar.querySelectorAll(COPY);
		expect(copies).toHaveLength(1);
		const copy = one(bar, COPY);
		expect(file.lastElementChild).toBe(copy);
		expect(one(bar, CONTROLS).contains(copy)).toBe(false);
		expect(copy.getAttribute("title")).toBe("Copy path");

		await click(copy);

		expect(written).toEqual([PATH]);
		const copied = one(bar, 'button[aria-label="Path copied"]');
		expect(copied).toBe(copy);
		expect(copied.getAttribute("title")).toBe("Path copied");
		expect(bar.querySelectorAll(COPY)).toHaveLength(0);
	});
});

describe("reading order is tab order", () => {
	test.each<[string, Over, string[]]>([
		["a PDF", PDF, ["Copy path", "Previous page", "Next page", "Zoom out", "Reset zoom", "Zoom in"]],
		["pages alone", { kind: "docx", size: 48_000, pager: PAGER }, ["Copy path", "Previous page", "Next page"]],
		["zoom alone", { kind: "image", size: 912_000, zoom: ZOOM }, ["Copy path", "Zoom out", "Reset zoom", "Zoom in"]],
		["neither", { kind: "audio", size: 3_400_000 }, ["Copy path"]],
	])("%s: the controls take focus in the order they are read", async (_what, over, order) => {
		const { bar } = await show(over);
		expect(focusable(bar).map(nameOf)).toEqual(order);
	});

	test("nothing is moved off its place in the DOM by CSS `order` or a positive tabindex, which would split the two orders", async () => {
		const { bar } = await show(PDF);
		const everything = Array.from(bar.querySelectorAll("*"));
		// The query reaches the whole bar, so the absence below is not an empty search.
		expect(everything.length).toBeGreaterThan(focusable(bar).length);
		expect(everything.flatMap(tokens).filter(token => /(^|:)-?order-/.test(token))).toEqual([]);
		expect(everything.filter(element => Number(element.getAttribute("tabindex")) > 0)).toEqual([]);
	});
});

describe("the wrap rules", () => {
	test.each<[string, (bar: HTMLElement) => Element | undefined, RegExp[]]>([
		["the bar wraps, so a View too narrow for the file and the controls on one line puts the controls underneath", bar => bar, [/^flex$/, /^flex-wrap$/]],
		["the file group is the one that gives: it can shrink to nothing (min-w-0), takes the free width (flex-1) and starts from a basis", bar => one(bar, FILE), [/^min-w-0$/, /^flex-1$/, /^basis-/]],
		["the name truncates: it may be narrower than its text (min-w-0)", bar => nameSpan(bar), [/^min-w-0$/, /^truncate$/]],
		["the controls group wraps within the bar (flex-wrap, max-w-full) rather than overflowing it", bar => one(bar, CONTROLS), [/^flex-wrap$/, /^max-w-full$/]],
	])("%s", async (_what, find, required) => {
		const { bar } = await show(PDF);
		const element = find(bar);
		if (element === undefined) throw new Error("the element is not in the bar");
		const missing = required.filter(rule => !tokens(element).some(token => rule.test(token))).map(String);
		expect(missing).toEqual([]);
	});

	test.each<[string, Over, string]>([
		["a size of megabytes (a PDF)", PDF, `${PATH} · 2.3 MB`],
		["a size under a kilobyte", { kind: "text", size: 900 }, `${PATH} · 900 B`],
		["no size (a file that did not open)", {}, PATH],
	])("the name's title is the path, and the size after it when one is known: %s", async (_what, over, title) => {
		const { bar } = await show(over);
		expect(nameSpan(bar)?.getAttribute("title")).toBe(title);
	});

	test("the size is only in the name's title: it is not drawn beside the name", async () => {
		const { bar } = await show(PDF);
		expect(bar.textContent).not.toMatch(/\d\s*(B|KB|MB|GB|TB)\b/);
	});

	test("says in visible text how much of a large text file was read, and says nothing when all of it was", async () => {
		const whole = await show({ kind: "text", size: 52_000_000 });
		expect(one(whole.bar, FILE).textContent).not.toContain("showing the first");
		const head = await show({ kind: "text", size: 52_000_000, shownBytes: 1_048_576 });
		expect(one(head.bar, FILE).textContent).toContain("showing the first 1.0 MB");
	});
});

describe("touch targets", () => {
	test("every icon button in the bar is 28 px (size-7), over the 24 px floor, and none is made smaller", async () => {
		const { bar } = await show(PDF);
		// By tag, not by the IconButton's own `data-slot`: other files in the process replace that module with a plain <button>, so what the
		// bar owns (its tags, labels and `size-N` class) is what is judged. The zoom's percent is a text button, not an icon button.
		const buttons = Array.from(bar.querySelectorAll("button")).filter(button => !(button.getAttribute("aria-label") ?? "").endsWith("Reset zoom"));
		// The query reaches every icon button the bar has, so the loop below is not over nothing.
		expect(buttons.map(nameOf)).toEqual(["Copy path", "Previous page", "Next page", "Zoom out", "Zoom in"]);
		for (const button of buttons) {
			expect(
				tokens(button).filter(token => /^size-\d/.test(token)),
				nameOf(button),
			).toEqual(["size-7"]);
		}
	});
});
