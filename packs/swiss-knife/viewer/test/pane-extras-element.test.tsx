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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Wait, in `act`, until the pick frame is there: the kit builds its document a few promise turns after Pick comes up. */
async function pickFrameUp(at: Pane): Promise<void> {
	for (const started = Date.now(); at.pickFrame === null && Date.now() - started < 2000; ) await env.act(async () => sleep(2));
}

/** Let the build that follows Pick coming up run its course, so that a frame that is merely late would be there. */
const quiet = () => env.act(async () => sleep(60));

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
