// What the page-picking layer promises once it is seated in a pane: Pick is in the hand from the first frame the page
// can be read (a PICK frame stands over the reading frame, in the stage), unless the page is larger than
// `PICK_FRAME_LIMIT`, which starts with Pick put down, says so in the strip, and waits until the person asks; pressing
// Pick toggles it, and Escape puts it down; a page that is put down has no second copy of itself running.
//
// The REAL `PaneExtras` is mounted (kit hooks, picker and bar included) in linkedom with the real react-dom under
// `act`, into the DOM the pane builds around it, exactly as `pane-extras.test.tsx` does for the picture: a pane holding
// the mode strip and the stage frame, which holds the reading frame (an iframe with a `srcdoc`, as the renderer draws
// it). linkedom runs no frame, so what is observed is what the kit puts in the stage: the pick frame, an iframe
// sandboxed `allow-scripts` and nothing else, and the bar's Pick radio. The messages the page would send back are the
// kit's own tests' and a real browser's.
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import * as react from "react";
import { createElement } from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import * as reactDom from "react-dom";
import { PICK_FRAME_LIMIT } from "../app/view/document-bytes";
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
	["react-dom", reactDom],
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
	// `installDom` leaves out the field classes the shortcut hook tests a key's target against, the frame class the
	// pane tests its reading frame against, and the width query the pane's list asks.
	install(globalThis, "HTMLInputElement", window.HTMLInputElement);
	install(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
	install(globalThis, "HTMLIFrameElement", window.HTMLIFrameElement);
	// No layout in linkedom: every box is 800 x 600 at the origin.
	install(window.Element.prototype, "getBoundingClientRect", () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }));
	const frameWindows = new WeakMap<object, { postMessage(data: unknown): void }>();
	install(window.HTMLIFrameElement.prototype, "contentWindow", undefined);
	Object.defineProperty(window.HTMLIFrameElement.prototype, "contentWindow", {
		configurable: true,
		get(this: HTMLIFrameElement) {
			let value = frameWindows.get(this);
			if (value === undefined) {
				value = { postMessage() {} };
				frameWindows.set(this, value);
			}
			return value;
		},
	});
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

const tabOf = (size: number): DocTab => ({
	path: "/files/sample.html",
	filename: "sample.html",
	key: "/files/sample.html",
	kind: "html",
	size,
	mtimeMs: 1,
	revision: 0,
	annotateRequests: 0,
});

/** What the reading frame holds, and a piece of it the pick frame's copy must carry. */
const NEEDLE = '<p id="needle">hello</p>';
const PAGE = `<!doctype html><title>sample</title>${NEEDLE}`;

const LARGE_HINT = "Large page: press Pick to choose elements";

const slotOf = (name: string): HTMLElement => {
	const element = env.document.createElement("div");
	element.setAttribute("data-slot", name);
	return element;
};

/** The DOM the pane builds around the layer, and the ways a person looks at what the layer put in it. */
interface Pane {
	readonly frame: HTMLElement;
	/** The frame the kit stood over the reading frame (sandboxed `allow-scripts`), or null while there is none. */
	readonly pickFrame: HTMLElement | null;
	/** The document the pick frame was given, or null while there is no pick frame. */
	readonly pickPage: string | null;
	/** Pick's radio on the bar. */
	readonly pick: HTMLElement | null;
	/** Whether Pick is the checked radio. */
	readonly picking: boolean;
	/** Whether the bar says that a large page waits for Pick. */
	readonly hint: boolean;
	/** Whether Whole page is switched off. */
	readonly wholePageOff: boolean;
}

function pane(): Pane {
	const element = slotOf("viewer-pane");
	const strip = slotOf("viewer-mode-strip");
	const frame = slotOf("viewer-stage-frame");
	const reading = env.document.createElement("iframe");
	reading.setAttribute("data-slot", "viewer-html-frame");
	// The renderer's frame runs nothing, for anyone.
	reading.setAttribute("sandbox", "");
	reading.setAttribute("srcdoc", PAGE);
	frame.append(reading);
	element.append(strip, frame);
	env.document.body.append(element);
	const pick = () => strip.querySelector<HTMLElement>('[data-tool="pick"]');
	const pickFrame = () => frame.querySelector<HTMLElement>('iframe[sandbox="allow-scripts"]');
	return {
		frame,
		get pickFrame() {
			return pickFrame();
		},
		get pickPage() {
			// linkedom keeps the attribute's name in the case React wrote it (`srcDoc`); a browser's is `srcdoc`.
			const given = Array.from(pickFrame()?.attributes ?? []).find(attribute => attribute.name.toLowerCase() === "srcdoc");
			return given?.value ?? null;
		},
		get pick() {
			return pick();
		},
		get picking() {
			return pick()?.getAttribute("aria-checked") === "true";
		},
		get hint() {
			return strip.textContent?.includes(LARGE_HINT) ?? false;
		},
		get wholePageOff() {
			return strip.querySelector('[data-tool="whole-page"]')?.hasAttribute("disabled") ?? false;
		},
	};
}

const mountAt = (at: Pane, size: number) =>
	env.mount(createElement(PaneExtras, { app, tab: tabOf(size), active: true, ready: true, frame: at.frame, mode: "elements" } satisfies PaneExtrasProps));

function click(element: Element | null): Promise<void> {
	if (element === null) throw new Error("nothing to click");
	return env.act(async () => void element.dispatchEvent(new (win().Event)("click", { bubbles: true, cancelable: true })));
}

function escape(): Promise<void> {
	const event = Object.assign(new (win().Event)("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
	return env.act(async () => void win().dispatchEvent(event));
}

async function typeNote(field: HTMLTextAreaElement, text: string): Promise<void> {
	const fire = (type: string): Promise<void> =>
		env.act(async () => void field.dispatchEvent(new (win().Event)(type, { bubbles: true, cancelable: true })));
	Object.assign(field, { attachEvent() {}, detachEvent() {} });
	await fire("focusin");
	Object.getOwnPropertyDescriptor(win().HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
	await fire("input");
	await fire("keyup");
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Wait, in `act`, until the pick frame is there: the kit builds its document a few promise turns after Pick comes up. */
async function pickFrameUp(at: Pane): Promise<void> {
	for (const started = Date.now(); at.pickFrame === null && Date.now() - started < 2000; ) await env.act(async () => sleep(2));
}

/** Let the build that follows Pick coming up run its course, so that a frame that is merely late would be there. */
const quiet = () => env.act(async () => sleep(60));

/** Deliver a real picker-protocol message from this frame, not a call directly into the session. */
async function pageSays(frame: HTMLElement, data: Record<string, unknown>): Promise<void> {
	const event = Object.assign(new (win().Event)("message"), {
		data,
		source: (frame as HTMLIFrameElement).contentWindow,
		origin: "null",
	});
	await env.act(async () => void win().dispatchEvent(event));
}

function channelOf(at: Pane): string {
	const matches = [...(at.pickPage ?? "").matchAll(/\)\("([0-9a-f]{32})"\);/g)];
	const channel = matches[matches.length - 1]?.[1];
	if (channel === undefined) throw new Error("picker channel unavailable");
	return channel;
}

async function pickedPage(at: Pane): Promise<{ frame: HTMLElement; channel: string }> {
	await pickFrameUp(at);
	const frame = at.pickFrame;
	if (frame === null) throw new Error("picker frame unavailable");
	const channel = channelOf(at);
	await pageSays(frame, { c: channel, t: "ready", vw: 800, vh: 600 });
	return { frame, channel };
}

const noteTarget = {
	selector: "#needle",
	matches: 1,
	tag: "p",
	text: "hello",
	attrs: [],
	style: { color: "rgb(0, 0, 0)", background: "rgba(0, 0, 0, 0)", fontSize: "16px", fontWeight: "400" },
	box: { x: 30, y: 40, width: 100, height: 20 },
};

describe("HTML picks as notes in place", () => {
	test("opens the picked element beside the page, keeps its badge after an outside press, and reopens from that badge", async () => {
		const at = pane();
		await mountAt(at, 4096);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();

		const popover = at.frame.querySelector('[data-slot="note-popover"]');
		expect(popover?.querySelector('[data-slot="note-popover-heading"]')?.textContent).toBe("#needle");
		expect(popover?.querySelector('[data-slot="note-popover-actions"]')?.textContent).toContain("Wider");
		expect(at.frame.querySelector('[data-slot="viewer-html-pick-frame"] [data-slot="note-popover"]')).toBeNull();
		const footer = env.document.querySelector('[data-slot="annotation-footer"]');
		expect(footer?.querySelector("button")?.textContent).toContain("Request edits · 1");
		expect(env.document.querySelector('[data-slot="annotation-panel"]')).toBeNull();

		await env.act(async () => {
			env.document.body.dispatchEvent(new (win().Event)("pointerdown", { bubbles: true, cancelable: true }));
		});
		expect(at.frame.querySelector('[data-slot="note-popover"]')).toBeNull();
		const badge = at.frame.querySelector('[data-slot="element-note-badge"]');
		expect(badge?.getAttribute("aria-label")?.toLowerCase()).toContain("no note");
		await env.act(async () => void badge?.dispatchEvent(new (win().Event)("mouseover", { bubbles: true })));
		expect(at.frame.querySelector('[data-slot="note-card-heading"]')?.textContent).toBe("#needle");
		await click(badge);
		expect(at.frame.querySelector('[data-slot="note-popover"] textarea')?.getAttribute("aria-label")).toBe("Note 1");
		await click(at.frame.querySelector('[data-slot="note-popover-delete"]'));
		await env.runFrames();
		expect(at.frame.querySelector('[data-slot="element-note-badge"]')).toBeNull();
		expect(env.document.querySelector('[data-slot="annotation-footer"] button')?.hasAttribute("disabled")).toBe(true);
	});

	test("a page reporting unavailable leaves the reading frame and no pick editor", async () => {
		const at = pane();
		await mountAt(at, 4096);
		await pickFrameUp(at);
		const frame = at.pickFrame;
		if (frame === null) throw new Error("picker frame unavailable");
		await pageSays(frame, { c: channelOf(at), t: "unavailable" });
		await env.runFrames();

		expect(at.pickFrame).toBeNull();
		expect(at.frame.querySelector('[data-slot="viewer-html-frame"]')).not.toBeNull();
		expect(at.frame.querySelector('[data-slot="note-popover"]')).toBeNull();
		expect(env.document.querySelector('[data-slot="viewer-mode-strip"]')?.textContent).toContain("Can't pick from this page");
	});

	test("Escape while typing in the opened note does not put Pick down", async () => {
		const at = pane();
		await mountAt(at, 4096);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();
		expect(at.frame.querySelector('[data-slot="note-popover"] textarea')).not.toBeNull();
		const input = env.document.createElement("textarea");
		env.document.body.append(input);
		await env.act(async () => {
			const event = Object.assign(new (win().Event)("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
			input.dispatchEvent(event);
		});
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();
	});

	test("notes remain navigable after Escape closes the editor and then puts Pick down", async () => {
		const at = pane();
		await mountAt(at, 4096);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();
		await escape();
		await escape();
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();

		const navigation = at.frame.querySelector('[data-slot="element-note-navigation"][aria-label="Notes on this page"]');
		const item = navigation?.querySelector('[data-slot="element-note-navigation-item"]');
		expect(item?.textContent).toContain("#needle");
		await click(item ?? null);
		expect(at.picking).toBe(false);
		expect(at.frame.querySelector('[data-slot="note-popover-heading"]')?.textContent).toBe("#needle");
		await click(at.frame.querySelector('[data-slot="note-popover-delete"]'));
		expect(navigation?.querySelector('[data-slot="element-note-navigation-item"]')).toBeNull();
	});

	test("a large page keeps its notes readable and editable without rebuilding the pick frame", async () => {
		const at = pane();
		await mountAt(at, PICK_FRAME_LIMIT + 1);
		await click(at.pick);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();
		await escape();
		await escape();
		expect(at.pickFrame).toBeNull();
		await click(at.frame.querySelector('[data-slot="element-note-navigation-item"]'));
		const input = at.frame.querySelector<HTMLTextAreaElement>('[data-slot="note-popover"] textarea');
		expect(input?.getAttribute("aria-label")).toBe("Note 1");
		if (input === null) throw new Error("note editor unavailable");
		await typeNote(input, "Keep this paragraph");
		expect(at.frame.querySelector('[data-slot="element-note-navigation-item"]')?.textContent).toContain("Keep this paragraph");
		expect(at.pickFrame).toBeNull();
		await escape();
		expect(at.frame.querySelector('[data-slot="element-note-navigation-item"]')?.textContent).toContain("#needle");
		await click(at.frame.querySelector('[data-slot="element-note-navigation-item"]'));
		expect(at.frame.querySelector<HTMLTextAreaElement>('[data-slot="note-popover"] textarea')?.value).toBe("Keep this paragraph");
		expect(at.pickFrame).toBeNull();
	});

	test("an off-layer page retains note navigation and editing without activating the picker", async () => {
		const at = pane();
		const mounted = await mountAt(at, 4096);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await env.runFrames();
		await mounted.render(createElement(PaneExtras, {
			app, tab: tabOf(4096), active: true, ready: true, frame: at.frame, mode: "comments",
		} satisfies PaneExtrasProps));
		expect(at.pickFrame).toBeNull();
		await click(at.frame.querySelector('[data-slot="element-note-navigation-item"]'));
		expect(at.frame.querySelector('[data-slot="element-note-navigation-item"]')?.textContent).toContain("#needle");
		expect(at.frame.querySelector('[data-slot="note-popover-heading"]')?.textContent).toBe("#needle");
		expect(at.pickFrame).toBeNull();
	});
});

describe("Pick on a page, once its layer is up", () => {
	const armedAtStart = [
		{ name: "a small page", size: 4096 },
		{ name: "a page of exactly the limit", size: PICK_FRAME_LIMIT },
	];
	for (const row of armedAtStart) {
		test(`is in the hand from the first frame on ${row.name}, with the pick frame over it`, async () => {
			const at = pane();
			await mountAt(at, row.size);
			await pickFrameUp(at);

			expect(at.picking).toBe(true);
			expect(at.hint).toBe(false);
			expect(at.pickFrame).not.toBeNull();
			// The same page as the reading frame holds, not another one.
			expect(at.pickPage).toContain(NEEDLE);
		});
	}

	test("waits to be asked on a page over the limit: the bar says so, and no second copy of the page is built", async () => {
		const at = pane();
		await mountAt(at, PICK_FRAME_LIMIT + 1);
		await quiet();

		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();
		expect(at.hint).toBe(true);
		expect(at.wholePageOff).toBe(true);
		expect(at.frame.querySelector('[data-slot="note-popover"]')).toBeNull();
	});

	test("is picked up and put down by Pick on a page over the limit, the pick frame with it", async () => {
		const at = pane();
		await mountAt(at, PICK_FRAME_LIMIT + 1);
		await quiet();
		expect(at.pickFrame).toBeNull();

		await click(at.pick);
		await pickFrameUp(at);
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();
		expect(at.hint).toBe(false);
		expect(at.wholePageOff).toBe(false);

		await click(at.pick);
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();
		expect(at.hint).toBe(true);
		expect(at.wholePageOff).toBe(true);
		// A frame that was still being built when Pick went down must not turn up afterwards.
		await quiet();
		expect(at.pickFrame).toBeNull();

		await click(at.pick);
		await pickFrameUp(at);
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();
	});

	test("is put down by Pick pressed again on a small page, and comes back when pressed once more", async () => {
		const at = pane();
		await mountAt(at, 4096);
		await pickFrameUp(at);
		expect(at.picking).toBe(true);

		await click(at.pick);
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();
		// The page is not large: nothing waits for Pick, so the bar has no such thing to say.
		expect(at.hint).toBe(false);
		expect(at.wholePageOff).toBe(true);
		await quiet();
		expect(at.pickFrame).toBeNull();

		await click(at.pick);
		await pickFrameUp(at);
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();
		expect(at.wholePageOff).toBe(false);
	});

	const putDownByEscape = [
		{ name: "a small page, armed from the start", size: 4096, armBy: false },
		{ name: "a page over the limit, once Pick is pressed", size: PICK_FRAME_LIMIT + 1, armBy: true },
	];
	for (const row of putDownByEscape) {
		test(`is put down by Escape on ${row.name}`, async () => {
			const at = pane();
			await mountAt(at, row.size);
			if (row.armBy) await click(at.pick);
			await pickFrameUp(at);
			expect(at.picking).toBe(true);

			await escape();

			expect(at.picking).toBe(false);
			expect(at.pickFrame).toBeNull();
			await quiet();
			expect(at.pickFrame).toBeNull();
		});
	}
});
