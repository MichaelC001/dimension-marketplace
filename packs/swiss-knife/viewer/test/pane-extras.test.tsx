// What the annotation layer promises the person once it is seated in a pane: the picture's bar comes up with the
// Box in the hand, Escape puts the pen down to scroll and zoom (and the marks stay), a reloaded picture (a theme
// change) neither takes the pen nor gives it back, a file that did not open offers nothing to draw with, and a
// text offers the one Comment tool.
//
// The REAL `PaneExtras` is mounted (kit hooks, overlay, bar and list included) in linkedom with the real react-dom
// under `act`, into the DOM the pane builds around it: a pane holding the mode strip and the stage frame that holds
// the picture. linkedom has no layout, so the overlay's box is stubbed; the pointer paths are the kit's own tests'
// (`annotate-gesture.test.ts`) and a real browser's. Marks are placed from the keyboard, the way the overlay
// supports without a pointer.
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import * as react from "react";
import { createElement } from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import type { ViewerKind } from "../src/contract";
import type { PaneExtras as PaneExtrasComponent } from "../app/view/pane-extras";
import type { PaneExtrasProps } from "../app/view/pane-shared";
import type { DocTab } from "../app/view/tabs";
import { installReact, type ReactEnv } from "./media-react";

// The kit's tsconfig maps `react` and its JSX runtimes onto their type declarations, which bun cannot load as code,
// and bun applies that map to the kit's sources wherever they are imported from. The map's targets are mocked with the
// real modules (the same instances this file and the pane use, so there is one React), which is what lets the pane
// import the kit here the way the kit's own React tests do from inside the kit.
const kitSource = dirname(Bun.resolveSync("@dimension/mcp-app-kit/annotate/react", import.meta.dir));
for (const [id, real] of [
	["react", react],
	["react/jsx-runtime", jsxRuntime],
	["react/jsx-dev-runtime", jsxDevRuntime],
] as const) {
	mock.module(Bun.resolveSync(id, kitSource), () => real);
}

let env: ReactEnv;
let PaneExtras: typeof PaneExtrasComponent;
const restores: (() => void)[] = [];

/** Put a global (or a property of one) in place for the whole file, remembering how to take it out. */
function install(target: object, name: string, value: unknown): void {
	const previous = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { value, configurable: true, writable: true });
	restores.push(() => (previous ? Object.defineProperty(target, name, previous) : void Reflect.deleteProperty(target, name)));
}

const win = (): Window & typeof globalThis => env.document.defaultView as Window & typeof globalThis;

beforeAll(async () => {
	env = await installReact();
	const window = win();
	// `installDom` leaves out the field classes the shortcut hook tests a key's target against, and the width query the
	// pane's list asks.
	install(globalThis, "HTMLInputElement", window.HTMLInputElement);
	install(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
	// No layout in linkedom: the overlay's box is 800 x 600 at the origin.
	install(window.Element.prototype, "getBoundingClientRect", () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }));
	// A narrow View: the list goes under the document, into the pane (the width the artifact column really has).
	install(window, "matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
	// Dynamic by necessity: react-dom decides once, when it loads, whether there is a DOM, and the layer binds the
	// kit's React hooks at load.
	({ PaneExtras } = await import("../app/view/pane-extras"));
});
afterEach(() => env.cleanup());
afterAll(() => {
	while (restores.length > 0) restores.pop()?.();
	env.restore();
});

const app = {
	getHostCapabilities: () => ({ updateModelContext: { text: {}, image: {} } }),
	updateModelContext: async () => ({}),
} as unknown as App;

const tabOf = (kind: ViewerKind): DocTab => ({
	path: `/files/sample.${kind}`,
	filename: `sample.${kind}`,
	key: `/files/sample.${kind}`,
	kind,
	size: 2048,
	mtimeMs: 1,
	revision: 0,
	annotateRequests: 0,
});

const slotOf = (name: string): HTMLElement => {
	const element = env.document.createElement("div");
	element.setAttribute("data-slot", name);
	return element;
};

/** The DOM the pane builds around the layer, and the ways a person looks at what the layer put in it. */
interface Pane {
	readonly frame: HTMLElement;
	readonly strip: HTMLElement;
	readonly element: HTMLElement;
	/** The renderer mounting again (a theme change): the picture it drew is gone and a fresh one stands in its place. */
	remount(): void;
	readonly picture: HTMLElement;
	readonly bar: HTMLElement | null;
	/** The tool ids that are checked. */
	readonly checked: (string | null)[];
	/** The tool ids the bar offers. */
	readonly tools: (string | null)[];
	tool(id: string): HTMLElement | null;
	readonly overlay: SVGElement | null;
	readonly list: HTMLElement | null;
	readonly rows: Element[];
	/** How many marks the picture shows. */
	readonly drawn: number;
}

function pane(): Pane {
	const element = slotOf("viewer-pane");
	const strip = slotOf("viewer-mode-strip");
	const frame = slotOf("viewer-stage-frame");
	let picture = slotOf("viewer-picture");
	frame.append(picture);
	element.append(strip, frame);
	env.document.body.append(element);
	const radios = () => Array.from(strip.querySelectorAll<HTMLElement>('[role="radio"]'));
	return {
		frame,
		strip,
		element,
		remount() {
			picture.remove();
			picture = slotOf("viewer-picture");
			frame.append(picture);
		},
		get picture() {
			return picture;
		},
		get bar() {
			return strip.querySelector<HTMLElement>('[role="toolbar"][aria-label="Annotation tools"]');
		},
		/** The tools that are checked, by id. */
		get checked() {
			return radios().filter(radio => radio.getAttribute("aria-checked") === "true").map(radio => radio.getAttribute("data-tool"));
		},
		get tools() {
			return radios().map(radio => radio.getAttribute("data-tool"));
		},
		tool: (id: string) => strip.querySelector<HTMLElement>(`[data-tool="${id}"]`),
		get overlay() {
			return picture.querySelector<SVGElement>("svg[data-markup-overlay]");
		},
		get list() {
			return element.querySelector<HTMLElement>('[data-slot="annotate-panel"]');
		},
		get rows() {
			return Array.from(element.querySelectorAll("li"));
		},
		/** How many marks the picture shows. */
		get drawn() {
			return picture.querySelectorAll("[data-mark]").length;
		},
	};
}

/** What a re-mount of the picture must leave: the tool before it, and the bar and overlay after it. */
interface Reload {
	readonly held: string;
	readonly before: () => Promise<void>;
	readonly checked: string[];
	readonly tool: string;
	readonly pointer: string;
}

const layer = (at: Pane, over: Partial<PaneExtrasProps> = {}, kind: ViewerKind = "image") =>
	createElement(PaneExtras, { app, tab: tabOf(kind), active: true, ready: true, frame: at.frame, mode: "marks", ...over });

const mountAt = (at: Pane, over: Partial<PaneExtrasProps> = {}, kind: ViewerKind = "image") => env.mount(layer(at, over, kind));

function press(target: EventTarget, key: string, init: { shiftKey?: boolean } = {}): Promise<void> {
	const event = Object.assign(new (win().Event)("keydown", { bubbles: true, cancelable: true }), { key, ...init });
	return env.act(async () => void target.dispatchEvent(event));
}

function click(element: Element | null): Promise<void> {
	if (element === null) throw new Error("nothing to click");
	return env.act(async () => void element.dispatchEvent(new (win().Event)("click", { bubbles: true, cancelable: true })));
}

/** A shape from the keyboard, in whatever tool is armed: Enter for the first point, the arrows, Enter again. */
async function drawShape(at: Pane): Promise<void> {
	const overlay = at.overlay;
	if (overlay === null) throw new Error("no overlay to draw on");
	await press(overlay, "Enter");
	for (let step = 0; step < 4; step += 1) await press(overlay, "ArrowRight", { shiftKey: true });
	await press(overlay, "Enter");
}

const pointerEvents = (overlay: Element | null): string => /pointer-events:\s*(\w+)/.exec(overlay?.getAttribute("style") ?? "")?.[1] ?? "unset";

describe("a picture, once its layer is up", () => {
	test("has the Box in the hand and its bar in the strip, so a drag draws at once", async () => {
		const at = pane();
		await mountAt(at);

		expect(at.bar).not.toBeNull();
		expect(at.strip.contains(at.bar)).toBe(true);
		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
		expect(pointerEvents(at.overlay)).toBe("auto");
		// Armed for real, not just labelled: the first thing the person does with the picture is a mark.
		await drawShape(at);
		expect(at.drawn).toBe(1);
		expect(at.rows).toHaveLength(1);
	});

	test("titles the list Notes, and it holds a row for each mark", async () => {
		const at = pane();
		await mountAt(at);

		expect(at.list?.querySelector("h2")?.textContent).toBe("Notes");
		expect(at.rows).toHaveLength(0);
		await drawShape(at);
		expect(at.rows).toHaveLength(1);
		await drawShape(at);
		expect(at.rows).toHaveLength(2);
	});

	test("takes Escape as putting the pen down to scroll, zoom and read, and keeps the marks", async () => {
		const at = pane();
		await mountAt(at);
		await drawShape(at);

		await press(win(), "Escape");

		expect(at.checked).toEqual([]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");
		expect(pointerEvents(at.overlay)).toBe("none");
		expect(at.drawn).toBe(1);
		expect(at.rows).toHaveLength(1);
		// The bar is still there: the pen is the person's to pick up again.
		expect(at.tools).toEqual(["pin", "box", "ellipse", "arrow", "pen"]);
		await click(at.tool("box"));
		expect(at.checked).toEqual(["box"]);
		expect(pointerEvents(at.overlay)).toBe("auto");
	});

	test("takes a second press on the tool in the hand as putting the pen down, and keeps the marks", async () => {
		const at = pane();
		await mountAt(at);
		await drawShape(at);

		await click(at.tool("box"));

		expect(at.checked).toEqual([]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");
		expect(pointerEvents(at.overlay)).toBe("none");
		expect(at.drawn).toBe(1);
		expect(at.rows).toHaveLength(1);
		expect(at.tools).toEqual(["pin", "box", "ellipse", "arrow", "pen"]);

		// Pressing it once more picks the pen up again, and it draws.
		await click(at.tool("box"));
		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
		expect(pointerEvents(at.overlay)).toBe("auto");
		await drawShape(at);
		expect(at.drawn).toBe(2);
		expect(at.rows).toHaveLength(2);
	});

	test("takes a press on another tool as swapping to it, and only the press on the one in the hand as putting it down", async () => {
		const at = pane();
		await mountAt(at);

		await click(at.tool("ellipse"));
		expect(at.checked).toEqual(["ellipse"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("ellipse");

		await click(at.tool("box"));
		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
		expect(pointerEvents(at.overlay)).toBe("auto");

		await click(at.tool("ellipse"));
		expect(at.checked).toEqual(["ellipse"]);
		await click(at.tool("ellipse"));
		expect(at.checked).toEqual([]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");
		expect(pointerEvents(at.overlay)).toBe("none");
	});

	test("picks a tool by its number key or its button, and a number typed into a note is a letter", async () => {
		const at = pane();
		await mountAt(at);

		await press(win(), "3");
		expect(at.checked).toEqual(["ellipse"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("ellipse");

		await click(at.tool("pen"));
		expect(at.checked).toEqual(["pen"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("pen");

		// A key typed into a field is a letter, not a tool. (The field is the test's own, outside React's roots: React's
		// input polyfill, which linkedom's lack of `oninput` selects, cannot take a key at a field it rendered.)
		await click(at.tool("box"));
		const field = env.document.createElement("textarea");
		env.document.body.append(field);
		await press(field, "3");
		expect(at.checked).toEqual(["box"]);
	});

	test("ignores the tool keys while its tab is not the one showing", async () => {
		const showing = pane();
		const hidden = pane();
		await mountAt(showing);
		await mountAt(hidden, { active: false });

		await press(win(), "3");
		expect(showing.checked).toEqual(["ellipse"]);
		expect(hidden.checked).toEqual(["box"]);

		await press(win(), "Escape");
		expect(showing.checked).toEqual([]);
		expect(hidden.checked).toEqual(["box"]);
	});

	test("leaves the wheel to the scroller, armed or not", async () => {
		const at = pane();
		await mountAt(at);
		const wheel = async (ctrlKey: boolean) => {
			const event = Object.assign(new (win().Event)("wheel", { bubbles: true, cancelable: true }), { deltaY: 120, ctrlKey });
			await env.act(async () => void at.overlay?.dispatchEvent(event));
			return event.defaultPrevented;
		};

		expect(pointerEvents(at.overlay)).toBe("auto");
		expect(await wheel(false)).toBe(false);
		expect(await wheel(true)).toBe(false);
	});

	// A theme change re-mounts the renderer: `ready` goes down and up again on a NEW picture element. The layer must
	// not read that as the person's choice either way.
	const reloads: readonly Reload[] = [
		{ held: "a pen put down with Escape", before: () => press(win(), "Escape"), checked: [], tool: "none", pointer: "none" },
		{ held: "a Circle picked with 3", before: () => press(win(), "3"), checked: ["ellipse"], tool: "ellipse", pointer: "auto" },
	];
	for (const row of reloads) {
		test(`keeps ${row.held} when the picture is re-mounted, and the marks follow it`, async () => {
			const at = pane();
			const view = await mountAt(at);
			await drawShape(at);
			await row.before();

			await view.render(layer(at, { ready: false }));
			at.remount();
			await view.render(layer(at, { ready: true }));

			expect(at.checked).toEqual(row.checked);
			expect(at.overlay?.getAttribute("data-tool")).toBe(row.tool);
			expect(pointerEvents(at.overlay)).toBe(row.pointer);
			// The overlay is in the picture that is on screen now, not the one the renderer threw away.
			expect(at.drawn).toBe(1);
			expect(at.rows).toHaveLength(1);
		});
	}
});

describe("a file that did not open", () => {
	test("offers no bar, no list and no pen, and the number keys arm nothing", async () => {
		const at = pane();
		const view = await mountAt(at, { mode: null });

		expect(at.bar).toBeNull();
		expect(at.list).toBeNull();
		expect(at.strip.children).toHaveLength(0);
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");
		expect(pointerEvents(at.overlay)).toBe("none");
		await press(win(), "3");
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");

		// The file opens on a second try: the layer comes up with the Box in the hand.
		await view.render(layer(at, { mode: "marks" }));
		expect(at.bar).not.toBeNull();
		expect(at.list).not.toBeNull();
		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
	});

	test("takes the layer down with the marks left in place, and brings both back", async () => {
		const at = pane();
		const view = await mountAt(at);
		await press(win(), "3");
		await drawShape(at);

		await view.render(layer(at, { mode: null }));
		expect(at.bar).toBeNull();
		expect(at.list).toBeNull();
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");
		expect(at.drawn).toBe(1);

		// Back up, the marks are the person's still, and the pen is the Box again, not the Circle of before.
		await view.render(layer(at, { mode: "marks" }));
		expect(at.rows).toHaveLength(1);
		expect(at.checked).toEqual(["box"]);
	});
});

describe("a text", () => {
	test("has one tool, Comment, always the armed one, with its shortcut and a hint on how to use it", async () => {
		const at = pane();
		await mountAt(at, { mode: "comments" }, "markdown");

		expect(at.strip.contains(at.bar)).toBe(true);
		expect(at.tools).toEqual(["comment"]);
		expect(at.checked).toEqual(["comment"]);
		expect(at.tool("comment")?.getAttribute("title")).toContain("Ctrl+Alt+M");
		expect(at.bar?.querySelector('[data-slot="annotation-toolbar-hint"]')?.textContent).toContain("Ctrl+Alt+M");
		expect(at.list?.querySelector("h2")?.textContent).toBe("Notes");

		// Pressing it asks for a comment; with nothing selected that is not a way of putting the tool down.
		await click(at.tool("comment"));
		expect(at.checked).toEqual(["comment"]);
		expect(at.rows).toHaveLength(0);
	});

	test("offers neither bar nor list when the file did not open", async () => {
		const at = pane();
		await mountAt(at, { mode: null }, "markdown");

		expect(at.bar).toBeNull();
		expect(at.list).toBeNull();
	});
});
