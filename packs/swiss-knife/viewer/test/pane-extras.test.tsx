// What the annotation layer promises the person once it is seated in a pane: the picture's bar comes up with the
// Box in the hand, Escape puts the pen down to scroll and zoom (and the marks stay), a reloaded picture (a theme
// change) neither takes the pen nor gives it back, a file that did not open offers nothing to draw with, and a
// text offers the one Comment tool.
//
// A picture's notes live where they were made: a popover beside each new mark, a numbered badge once it is closed,
// and ONE slim footer seated at the end of the pane that carries the send. There is no Notes panel for a picture,
// in a narrow View or a wide one; a text keeps its panel.
//
// The REAL `PaneExtras` is mounted (kit hooks, overlay, bar and footer included) in linkedom with the real react-dom
// under `act`, into the DOM the pane builds around it: a pane holding the mode strip and the stage frame that holds
// the picture. linkedom has no layout, so the overlay's box is stubbed; the pointer paths are the kit's own tests'
// (`annotate-gesture.test.ts`) and a real browser's. Marks are placed from the keyboard, the way the overlay
// supports without a pointer.
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import * as react from "react";
import { createElement } from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import type { ViewerKind } from "../src/contract";
import * as realBytes from "../app/view/document-bytes";
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

// A send reads the picture's bytes through the pane's one door and has the kit paint them (a canvas, which linkedom
// does not have). Both answer only while this file runs: a module mock outlives its file (one process runs every test
// file), and a stub left standing would hand the next file's tests `[1, 2, 3]` for a document.
let stubbing = true;
/** Every tab the send asked bytes for, and the failure the next ask is to meet. */
const loads: DocTab[] = [];
let bytesFailure: Error | null = null;
const { loadDocumentBytes: loadForReal } = realBytes;
mock.module(Bun.resolveSync("../app/view/document-bytes", import.meta.dir), () => ({
	...realBytes,
	loadDocumentBytes: async (...args: Parameters<typeof loadForReal>) => {
		if (!stubbing) return loadForReal(...args);
		loads.push(args[1]);
		if (bytesFailure !== null) throw bytesFailure;
		return { bytes: new Uint8Array([1, 2, 3]), truncated: false };
	},
}));
const paintFile = join(kitSource, "paint.ts");
// Dynamic: the specifier is worked out from where the kit resolves to, which only the running file knows.
const realPaint = await import(paintFile);
const { paintMarkup: paintForReal, measureImage: measureForReal } = realPaint;
const painted = {
	frame: { mimeType: "image/png", data: "AAAA", bytes: 3, width: 800, height: 600 },
	crops: [],
	natural: { width: 800, height: 600 },
	scale: 1,
	marksPainted: 1,
	notes: [],
};
mock.module(paintFile, () => ({
	...realPaint,
	paintMarkup: async (...args: unknown[]) => (stubbing ? painted : paintForReal(...args)),
	measureImage: async (...args: unknown[]) => (stubbing ? painted.natural : measureForReal(...args)),
}));

let env: ReactEnv;
let PaneExtras: typeof PaneExtrasComponent;
const restores: (() => void)[] = [];
/** Who has the focus: linkedom has no focus of its own, so the shim below keeps the count. */
let focused: Element | null = null;

/** Put a global (or a property of one) in place for the whole file, remembering how to take it out. */
function install(target: object, name: string, value: unknown): void {
	const previous = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { value, configurable: true, writable: true });
	restores.push(() => (previous ? Object.defineProperty(target, name, previous) : void Reflect.deleteProperty(target, name)));
}

const win = (): Window & typeof globalThis => env.document.defaultView as Window & typeof globalThis;

/** The width query the pane's list asks: a narrow View (the width the artifact column really has), or a wide one. */
function viewIs(wide: boolean): void {
	Object.defineProperty(win(), "matchMedia", {
		value: (query: string) => ({ matches: wide, media: query, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
		writable: true,
	});
}

beforeAll(async () => {
	env = await installReact();
	const window = win();
	// `installDom` leaves out the field classes the shortcut hook tests a key's target against.
	install(globalThis, "HTMLInputElement", window.HTMLInputElement);
	install(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
	// No layout in linkedom: the overlay's box is 800 x 600 at the origin.
	install(window.Element.prototype, "getBoundingClientRect", () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }));
	// A narrow View: a text's list goes under the document, into the pane.
	viewIs(false);
	restores.push(() => Reflect.deleteProperty(window, "matchMedia"));
	// No focus in linkedom either. The shim does what a browser does with it: the element takes the focus, the one that
	// had it hears `focusout` (naming who is next), the new one `focusin`. A note opens by taking the focus, and one
	// that loses it to another field closes.
	install(window.Element.prototype, "focus", function focus(this: Element) {
		const previous = focused;
		if (previous === this) return;
		focused = this;
		const fire = (target: Element | null, type: string, related: Element | null) =>
			void target?.dispatchEvent(Object.assign(new window.Event(type, { bubbles: true }), { relatedTarget: related }));
		fire(previous, "focusout", this);
		fire(this, "focusin", previous);
	});
	// linkedom reports no `oninput`, so react-dom (which decides once, when it loads) watches a field's value with the
	// old IE hooks. The hooks are asked for at `focusin` and `focusout`; nothing here needs them to do anything.
	install(window.Element.prototype, "attachEvent", () => {});
	install(window.Element.prototype, "detachEvent", () => {});
	// Dynamic by necessity: react-dom decides once, when it loads, whether there is a DOM, and the layer binds the
	// kit's React hooks at load.
	({ PaneExtras } = await import("../app/view/pane-extras"));
});
afterEach(async () => {
	await env.cleanup();
	viewIs(false);
	focused = null;
	loads.length = 0;
	staged.length = 0;
	bytesFailure = null;
});
afterAll(() => {
	stubbing = false;
	while (restores.length > 0) restores.pop()?.();
	env.restore();
});

/** What the host was handed to stage on the next message. */
interface StagedContext {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}
const staged: StagedContext[] = [];
const app = {
	getHostCapabilities: () => ({ updateModelContext: { text: {}, image: {} } }),
	updateModelContext: async (context: StagedContext) => {
		staged.push(context);
		return {};
	},
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
	/**
	 * The Notes panel of a text (its list and its send), wherever the View seats it: under the document in the pane, or
	 * beside it in a wide View, where it is the layer's own element and not the pane's child.
	 */
	readonly panel: HTMLElement | null;
	/** The slim send row a picture seats at the end of the pane. */
	readonly footer: HTMLElement | null;
	/** The numbered badge buttons over the marks, in the order they are read. */
	readonly badges: HTMLButtonElement[];
	/** What each badge is named. */
	readonly badgeNames: (string | null)[];
	/** The popover beside the mark being noted, in the picture. */
	readonly popover: HTMLElement | null;
	/** The field in that popover. */
	readonly field: HTMLTextAreaElement | null;
	/** The footer's "Anything else for the agent?" field. */
	readonly message: HTMLTextAreaElement | null;
	/** The footer's send. */
	readonly send: HTMLButtonElement | null;
	/** What the send says: the ask, the count, or that it is staged. */
	readonly sendLabel: string;
	/** The line the footer says about the send. */
	readonly status: string;
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
	const footer = () => element.querySelector<HTMLElement>('[data-slot="annotation-footer"]');
	const badges = () => Array.from(picture.querySelectorAll<HTMLButtonElement>('button[data-slot="mark-badge"]'));
	const popover = () => picture.querySelector<HTMLElement>('[data-slot="note-popover"]');
	const send = () => footer()?.querySelector<HTMLButtonElement>("button") ?? null;
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
		get panel() {
			return env.document.querySelector<HTMLElement>('[data-slot="annotate-panel"]');
		},
		get footer() {
			return footer();
		},
		get badges() {
			return badges();
		},
		get badgeNames() {
			return badges().map(badge => badge.getAttribute("aria-label"));
		},
		get popover() {
			return popover();
		},
		get field() {
			return popover()?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
		},
		get message() {
			return footer()?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
		},
		get send() {
			return send();
		},
		get sendLabel() {
			return send()?.querySelector(".dam-send-face:not(.dam-send-sizer)")?.textContent ?? "";
		},
		get status() {
			return footer()?.querySelector('[role="status"]')?.textContent ?? "";
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

interface KeyInit {
	shiftKey?: boolean;
	ctrlKey?: boolean;
}

const keyEvent = (key: string, init: KeyInit = {}) =>
	Object.assign(new (win().Event)("keydown", { bubbles: true, cancelable: true }), { key, ...init });

function press(target: EventTarget, key: string, init: KeyInit = {}): Promise<void> {
	const event = keyEvent(key, init);
	return env.act(async () => void target.dispatchEvent(event));
}

function click(element: Element | null): Promise<void> {
	if (element === null) throw new Error("nothing to click");
	return env.act(async () => void element.dispatchEvent(new (win().Event)("click", { bubbles: true, cancelable: true })));
}

/** The field of the note that is open; a test that asks for it expects one. */
function noteField(at: Pane): HTMLTextAreaElement {
	if (at.field === null) throw new Error("no note is open");
	return at.field;
}

/**
 * A key typed at a field the person is in: the caret goes in first, as it does before any key reaches a field. (Not
 * only manners: react-dom, here, watches a field's value from the field that has the focus, and a key at one that has
 * not been given it is a crash in React's own change plugin, not in the layer.)
 */
async function pressIn(field: HTMLTextAreaElement, key: string, init: KeyInit = {}): Promise<void> {
	await env.act(async () => void field.focus());
	await press(field, key, init);
}

/** The value a field holds, set the way the browser does it: past the tracker React keeps, so React sees a change. */
function setValue(field: HTMLTextAreaElement, text: string): void {
	let owner: object | null = Object.getPrototypeOf(field);
	while (owner !== null && Object.getOwnPropertyDescriptor(owner, "value") === undefined) owner = Object.getPrototypeOf(owner);
	const setter = owner === null ? undefined : Object.getOwnPropertyDescriptor(owner, "value")?.set;
	if (setter === undefined) throw new Error("a field with no value to set");
	setter.call(field, text);
}

/**
 * Words typed into a field, replacing what it held. A browser says it twice: `input`, and the key. react-dom hears
 * the first (a DOM that has `oninput`) or the second (linkedom's, which does not); both are sent, so the field reads
 * the same either way.
 */
async function type(field: HTMLTextAreaElement, text: string): Promise<void> {
	await env.act(async () => void field.focus());
	await env.act(async () => {
		setValue(field, text);
		field.dispatchEvent(new (win().Event)("input", { bubbles: true }));
		field.dispatchEvent(keyEvent(text.slice(-1)));
	});
}

/** Let a send run to its end: it is a chain of settled promises, so every turn of `act` carries it a step further. */
async function until(done: () => boolean): Promise<void> {
	for (let turn = 0; turn < 50 && !done(); turn += 1) await env.act(async () => {});
	if (!done()) throw new Error("the send never came to an end");
}

/**
 * A shape from the keyboard, in whatever tool is armed: Enter for the first point, the arrows, Enter again. The new
 * mark's note opens beside it and its field takes the focus; the keys after this are still pressed at the drawing
 * surface itself.
 */
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
		expect(at.badges).toHaveLength(1);
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
		expect(at.badges).toHaveLength(1);
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
		expect(at.badges).toHaveLength(1);
		expect(at.tools).toEqual(["pin", "box", "ellipse", "arrow", "pen"]);

		// Pressing it once more picks the pen up again, and it draws.
		await click(at.tool("box"));
		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
		expect(pointerEvents(at.overlay)).toBe("auto");
		await drawShape(at);
		expect(at.drawn).toBe(2);
		expect(at.badges).toHaveLength(2);
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
		test(`keeps ${row.held} when the picture is re-mounted, and the marks and the footer follow it`, async () => {
			const at = pane();
			const view = await mountAt(at);
			await drawShape(at);
			await row.before();
			const footer = at.footer;
			expect(footer).not.toBeNull();

			await view.render(layer(at, { ready: false }));
			at.remount();
			await view.render(layer(at, { ready: true }));

			expect(at.checked).toEqual(row.checked);
			expect(at.overlay?.getAttribute("data-tool")).toBe(row.tool);
			expect(pointerEvents(at.overlay)).toBe(row.pointer);
			// The overlay is in the picture that is on screen now, not the one the renderer threw away.
			expect(at.drawn).toBe(1);
			expect(at.badges).toHaveLength(1);
			// The footer is the pane's, not the picture's: the renderer starting over leaves the very same row, still
			// counting the mark.
			expect(at.footer === footer).toBe(true);
			expect(at.sendLabel).toBe("Request edits · 1");
		});
	}
});

describe("a picture's notes, where they were made", () => {
	for (const [view, wide] of [
		["narrow", false],
		["wide", true],
	] as const) {
		test(`has no Notes panel in a ${view} View: no column, no sheet, no list, no heading, before a mark and after it`, async () => {
			viewIs(wide);
			const at = pane();
			await mountAt(at);
			const nothingBut = (marks: number) => {
				expect(at.panel === null).toBe(true);
				expect(env.document.querySelectorAll("li").length).toBe(0);
				const headings = Array.from(env.document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")).map(heading => heading.textContent);
				expect(headings).not.toContain("Notes");
				expect(at.badges).toHaveLength(marks);
			};

			nothingBut(0);
			await drawShape(at);
			nothingBut(1);
			await drawShape(at);
			nothingBut(2);
		});
	}

	test("seats ONE footer at the end of the pane, not in the strip or the frame, from the moment the layer is up", async () => {
		const at = pane();
		await mountAt(at);

		// No mark yet, and the way to send is already there.
		const footers = env.document.querySelectorAll('[data-slot="annotation-footer"]');
		expect(footers.length).toBe(1);
		const footer = at.footer;
		expect(footer?.parentElement === at.element).toBe(true);
		expect(at.element.lastElementChild === footer).toBe(true);
		expect(at.strip.contains(footer)).toBe(false);
		expect(at.frame.contains(footer)).toBe(false);
		expect(at.message?.getAttribute("placeholder")).toBe("Anything else for the agent?");
		expect(at.sendLabel).toBe("Request edits");
		expect(at.send?.hasAttribute("disabled")).toBe(true);
	});

	test("counts the marks on its button and enables it, and the very same footer stays seated as notes are added", async () => {
		const at = pane();
		await mountAt(at);
		const footer = at.footer;

		await drawShape(at);
		expect(at.sendLabel).toBe("Request edits · 1");
		expect(at.send?.hasAttribute("disabled")).toBe(false);
		expect(at.footer === footer).toBe(true);

		await drawShape(at);
		expect(at.sendLabel).toBe("Request edits · 2");
		expect(at.send?.hasAttribute("disabled")).toBe(false);
		// Adding a note does not rebuild the row (a rebuilt one would lose the message a person was typing in it).
		expect(at.footer === footer).toBe(true);
		expect(env.document.querySelectorAll('[data-slot="annotation-footer"]').length).toBe(1);
		expect(at.element.lastElementChild === footer).toBe(true);
	});

	test("keeps the bar's hint in the strip: how to draw while a tool is in the hand, how to start while none is", async () => {
		const at = pane();
		await mountAt(at);
		const hint = () => at.strip.querySelector('[data-slot="annotation-toolbar-hint"]')?.textContent ?? "";

		expect(hint()).toContain("Drag to draw");
		await press(win(), "Escape");
		expect(hint()).toBe("Pick a tool to draw");
		await click(at.tool("ellipse"));
		expect(hint()).toContain("Drag to draw");
	});

	test("opens a note beside a new mark, its field named for the mark and holding the focus", async () => {
		const at = pane();
		await mountAt(at);
		expect(at.popover === null).toBe(true);

		await drawShape(at);

		expect(at.popover).not.toBeNull();
		expect(at.picture.contains(at.popover)).toBe(true);
		expect(at.field?.getAttribute("aria-label")).toBe("Note 1");
		// The person can type at once: the field has the focus.
		expect(focused === at.field).toBe(true);
		expect(at.badgeNames).toEqual(["Note 1: no note"]);
	});

	test("saves a typed note with Enter: the note closes and ONE badge is left, named for it", async () => {
		const at = pane();
		await mountAt(at);
		await drawShape(at);
		const field = noteField(at);

		await type(field, "make it red");
		await pressIn(field, "Enter");

		expect(at.popover === null).toBe(true);
		expect(at.badgeNames).toEqual(["Note 1: make it red"]);
		expect(at.drawn).toBe(1);
	});

	test("closes a note with Escape but keeps the mark and what was typed, and the pen stays in the hand", async () => {
		const at = pane();
		await mountAt(at);
		await drawShape(at);
		const field = noteField(at);
		await type(field, "keep me");

		await pressIn(field, "Escape");

		expect(at.popover === null).toBe(true);
		expect(at.badgeNames).toEqual(["Note 1: keep me"]);
		expect(at.drawn).toBe(1);
		// That Escape was the note's: it did not also put the pen down.
		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
		expect(pointerEvents(at.overlay)).toBe("auto");
		// Control: the same key at the picture itself IS the pen going down, so the quiet above was the note's doing.
		await press(at.overlay as SVGElement, "Escape");
		expect(at.checked).toEqual([]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");
	});

	test("takes a number typed into a note as a letter, not as a tool", async () => {
		const at = pane();
		await mountAt(at);
		await drawShape(at);

		await pressIn(noteField(at), "3");

		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
		expect(at.popover).not.toBeNull();
		// Control: the same key at the picture itself picks the Circle, so the field is what kept it.
		await press(at.overlay as SVGElement, "3");
		expect(at.checked).toEqual(["ellipse"]);
	});

	test("deletes the mark with the note's trash: the badge goes and the footer counts it out", async () => {
		const at = pane();
		await mountAt(at);
		await drawShape(at);
		await drawShape(at);
		expect(at.sendLabel).toBe("Request edits · 2");
		const footer = at.footer;

		// The second mark's note is the one open.
		await click(at.popover?.querySelector('[data-slot="note-popover-delete"]') ?? null);

		expect(at.popover === null).toBe(true);
		expect(at.drawn).toBe(1);
		expect(at.badgeNames).toEqual(["Note 1: no note"]);
		expect(at.sendLabel).toBe("Request edits · 1");

		await click(at.badges[0] ?? null);
		await click(at.popover?.querySelector('[data-slot="note-popover-delete"]') ?? null);
		expect(at.drawn).toBe(0);
		expect(at.badges).toHaveLength(0);
		expect(at.sendLabel).toBe("Request edits");
		expect(at.send?.hasAttribute("disabled")).toBe(true);
		expect(at.footer === footer).toBe(true);
	});

	test("types in the footer's message field as a person, not as a tool: a number there is a letter", async () => {
		const at = pane();
		await mountAt(at);

		await pressIn(at.message as HTMLTextAreaElement, "3");

		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
		// Control: at the picture the same key picks the Circle.
		await press(at.overlay as SVGElement, "3");
		expect(at.checked).toEqual(["ellipse"]);
	});

	test("stages the notes and the message of the picture on Request edits, and says it is staged", async () => {
		const at = pane();
		await mountAt(at);
		await drawShape(at);
		await type(noteField(at), "make it brighter");
		await type(at.message as HTMLTextAreaElement, "keep the sky");
		expect(staged).toHaveLength(0);

		await click(at.send);
		await until(() => at.sendLabel !== "Request edits · 1");

		expect(staged).toHaveLength(1);
		const text = staged[0]?.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("make it brighter");
		expect(text).toContain("keep the sky");
		// The bytes are this tab's own file, asked for once.
		expect(loads.map(tab => tab.path)).toEqual(["/files/sample.image"]);
		expect(at.sendLabel).toBe("Added · press Enter in the chat");
		expect(at.send?.hasAttribute("disabled")).toBe(true);
	});

	test("says in the footer when the picture could not be read, stages nothing and keeps the marks", async () => {
		bytesFailure = new Error("The file could not be read.");
		const at = pane();
		await mountAt(at);
		await drawShape(at);
		await type(noteField(at), "make it brighter");

		await click(at.send);
		await until(() => at.status !== "");

		expect(at.status).toContain("The file could not be read.");
		expect(staged).toHaveLength(0);
		// Nothing was lost, and it can be asked again.
		expect(at.badgeNames).toEqual(["Note 1: make it brighter"]);
		expect(at.sendLabel).toBe("Request edits · 1");
		expect(at.send?.hasAttribute("disabled")).toBe(false);
	});

	test("keeps a tab that is not showing out of the keys: undo, the tool keys and Escape are the one on screen's", async () => {
		const hidden = pane();
		const showing = pane();
		const view = await mountAt(hidden);
		await drawShape(hidden);
		await type(noteField(hidden), "left behind");
		// The person goes to another tab: this one stays mounted, hidden.
		await view.render(layer(hidden, { active: false }));
		await mountAt(showing);
		await drawShape(showing);
		expect(showing.badges).toHaveLength(1);

		await press(win(), "3");
		expect(showing.checked).toEqual(["ellipse"]);
		expect(hidden.checked).toEqual(["box"]);

		await press(win(), "z", { ctrlKey: true });
		expect(showing.badges).toHaveLength(0);
		expect(hidden.badgeNames).toEqual(["Note 1: left behind"]);

		await press(win(), "Escape");
		expect(showing.checked).toEqual([]);
		expect(hidden.checked).toEqual(["box"]);
		expect(hidden.sendLabel).toBe("Request edits · 1");
	});
});

describe("a file that did not open", () => {
	test("offers no bar, no footer and no pen, and the number keys arm nothing", async () => {
		const at = pane();
		const view = await mountAt(at, { mode: null });

		expect(at.bar === null).toBe(true);
		expect(at.panel === null).toBe(true);
		expect(at.footer === null).toBe(true);
		expect(at.strip.children.length).toBe(0);
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");
		expect(pointerEvents(at.overlay)).toBe("none");
		await press(win(), "3");
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");

		// The file opens on a second try: the layer comes up with the Box in the hand.
		await view.render(layer(at, { mode: "marks" }));
		expect(at.bar).not.toBeNull();
		expect(at.footer).not.toBeNull();
		expect(at.checked).toEqual(["box"]);
		expect(at.overlay?.getAttribute("data-tool")).toBe("box");
	});

	test("takes the layer down with the marks left in place, and brings both back", async () => {
		const at = pane();
		const view = await mountAt(at);
		await press(win(), "3");
		await drawShape(at);

		await view.render(layer(at, { mode: null }));
		expect(at.bar === null).toBe(true);
		expect(at.footer === null).toBe(true);
		expect(at.panel === null).toBe(true);
		expect(at.overlay?.getAttribute("data-tool")).toBe("none");
		expect(at.drawn).toBe(1);

		// Back up, the marks are the person's still, and the pen is the Box again, not the Circle of before.
		await view.render(layer(at, { mode: "marks" }));
		expect(at.badges).toHaveLength(1);
		expect(at.sendLabel).toBe("Request edits · 1");
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
		expect(at.panel?.querySelector("h2")?.textContent).toBe("Notes");

		// Pressing it asks for a comment; with nothing selected that is not a way of putting the tool down.
		await click(at.tool("comment"));
		expect(at.checked).toEqual(["comment"]);
		expect(at.panel?.querySelectorAll("li").length).toBe(0);
	});

	test("keeps its Notes panel under the document in a narrow View and beside it in a wide one", async () => {
		const narrow = pane();
		await mountAt(narrow, { mode: "comments" }, "markdown");
		expect(narrow.element.contains(narrow.panel)).toBe(true);
		expect(narrow.panel?.getAttribute("data-placement")).toBe("bottom");
		await env.cleanup();

		viewIs(true);
		const wide = pane();
		await mountAt(wide, { mode: "comments" }, "markdown");
		expect(wide.panel?.getAttribute("data-placement")).toBe("side");
		expect(wide.panel?.querySelector("h2")?.textContent).toBe("Notes");
	});

	test("offers neither bar nor list when the file did not open", async () => {
		const at = pane();
		await mountAt(at, { mode: null }, "markdown");

		expect(at.bar === null).toBe(true);
		expect(at.panel === null).toBe(true);
	});
});
