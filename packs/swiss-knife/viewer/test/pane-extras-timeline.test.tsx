// What the timeline layer promises a person marking up a recording (the PANE's part: the seating, the keys, the rules
// that come from the pane and not from the kit): one toolbar whose tools depend on whether it is a sound or a video, the
// two tools only a recording has (Moment, Stretch) and when they go off, the keys on the window and whose keys they are,
// a drawing landing on the frame on screen, choosing a note going to where it is, the lane's own gestures making and
// writing notes without the list taking the caret, and the notes outliving the renderer.
//
// The REAL `TimelineMarks` is mounted (kit session, toolbar and list, the transport, the draw layer, the frame clock and
// the key decision included) in linkedom with the real react-dom under `act`, into the DOM the pane builds around it: a
// pane holding the mode strip, and the stage frame that holds the recording's element and the dock under it. Three
// stand-ins on the way in:
//   * the player is a linkedom element carrying the parts of an HTMLMediaElement the pane reads and writes (no browser
//     engine plays here), with the video's `requestVideoFrameCallback` a test drives by hand so the frame clock learns
//     a frame length and which frame is showing;
//   * the kit's two lanes record the props they are drawn with, so a seek, a note or a stretch is sent to the pane the
//     way a lane sends it; the kit's list and drawing overlay record theirs and then draw for real (the list's `focus`
//     and the overlay's `onShape` have no other seam); the real lanes are the kit's own test subjects;
//   * the grabber's thumbnails, which would open a second video and a canvas: never taken, never failing.
// Bun cannot lift a module mock, so the kit mock stays installed for the rest of the run: it sits over the REAL kit module
// (spread under it) and every part it wraps still draws, so a test that loads the kit's React parts after this file finds
// them working.
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { type MarkShape, MAX_TIMELINE_MARKS, type TimelineMark } from "@dimension/mcp-app-kit/annotate";
import type { AnnotationPanelProps, FilmLaneProps, MarkupOverlayProps, WaveLaneProps } from "@dimension/mcp-app-kit/annotate/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import * as react from "react";
import { createElement } from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import type { TimelineMarks as TimelineMarksComponent } from "../app/view/pane-extras-timeline";
import { FrameGrabber, frameStepTarget, insideFrame } from "../app/view/media-frame";
import type { PaneExtrasProps } from "../app/view/pane-shared";
import type { DocTab } from "../app/view/tabs";
import { installReact, type ReactEnv } from "./media-react";

const KIT = "@dimension/mcp-app-kit/annotate/react";

// The kit's tsconfig maps `react` and its JSX runtimes onto their type declarations, which bun cannot load as code, and
// bun applies that map to the kit's sources wherever they are imported from. The map's targets are mocked with the real
// modules (the same instances this file and the pane use, so there is one React): that is what lets the pane import the
// kit here the way the kit's own React tests do from inside the kit.
const kitSource = dirname(Bun.resolveSync(KIT, import.meta.dir));
for (const [id, real] of [
	["react", react],
	["react/jsx-runtime", jsxRuntime],
	["react/jsx-dev-runtime", jsxDevRuntime],
] as const) {
	mock.module(Bun.resolveSync(id, kitSource), () => real);
}

type Kind = "video" | "audio";
const KINDS: Kind[] = ["video", "audio"];

/** How long every recording here says it is. */
const LENGTH = 30;
/** A frame of 25 fps, shown by these frames reaching the screen. */
const FRAME = 0.04;
/** Five frames on screen at 25 fps: enough gaps for the clock to believe the rate; the last one began at 1.96 s. */
const PLAYED = [1.8, 1.84, 1.88, 1.92, 1.96];

let env: ReactEnv;
let TimelineMarks: typeof TimelineMarksComponent;
let FULL_SENTENCE: string;
const restores: (() => void)[] = [];

/** The props each stand-in was last drawn with. */
let film: FilmLaneProps | null = null;
let wave: WaveLaneProps | null = null;
let overlay: MarkupOverlayProps | null = null;
let panel: AnnotationPanelProps | null = null;

/** Put a global (or a property of one) in place for the whole file, remembering how to take it out. */
function install(target: object, name: string, value: unknown): void {
	const previous = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { value, configurable: true, writable: true });
	restores.push(() => (previous ? Object.defineProperty(target, name, previous) : void Reflect.deleteProperty(target, name)));
}

const win = (): Window & typeof globalThis => env.document.defaultView as Window & typeof globalThis;

/** A player: what the pane reads and writes of a recording, and the events it listens to. A video also reports its frames. */
interface Player extends HTMLElement {
	paused: boolean;
	error: MediaError | null;
	currentTime: number;
	tell(type: string): void;
	play(): Promise<void>;
	pause(): void;
	/** A frame reaching the screen: whoever asked to hear of it (the pane's clock) is told its media time. */
	presentFrame?(mediaTime: number): void;
}

let makePlayer: (kind: Kind) => Player;

const NO_RANGES = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;

beforeAll(async () => {
	env = await installReact();
	const window = win();
	// The overlay's box is 800 x 600 at the origin: linkedom has no layout.
	install(window.Element.prototype, "getBoundingClientRect", () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }));
	// A narrow View: the list goes under the document, into the pane.
	install(window, "matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
	// The silent second element a picture is taken from cannot open in linkedom, and a picture is not what is under test: a
	// thumbnail that is asked for and never comes leaves the filmstrip as it is while the pane is mounted.
	install(FrameGrabber.prototype, "thumbnail", () => new Promise(() => {}));

	const Base = window.HTMLElement as unknown as new (document: Document, localName: string) => HTMLElement;
	class FakeMediaElement extends Base {
		paused = true;
		ended = false;
		playbackRate = 1;
		volume = 1;
		muted = false;
		error: MediaError | null = null;
		duration = LENGTH;
		seekable = NO_RANGES;
		currentSrc = "blob:fake-recording";
		#time = 0;
		// Like a browser's, assigning a time that is not a number throws.
		get currentTime(): number {
			return this.#time;
		}
		set currentTime(value: number) {
			if (!Number.isFinite(value)) throw new TypeError("The provided double value is non-finite.");
			this.#time = value;
		}
		tell(type: string): void {
			this.dispatchEvent(new window.Event(type));
		}
		play(): Promise<void> {
			if (this.paused) {
				this.paused = false;
				this.tell("play");
			}
			return Promise.resolve();
		}
		pause(): void {
			if (!this.paused) {
				this.paused = true;
				this.tell("pause");
			}
		}
	}
	class FakeVideo extends FakeMediaElement {
		videoWidth = 640;
		videoHeight = 360;
		clientWidth = 640;
		clientHeight = 360;
		offsetLeft = 0;
		offsetTop = 0;
		#frame: ((now: number, metadata: { mediaTime: number }) => void) | null = null;
		requestVideoFrameCallback(callback: (now: number, metadata: { mediaTime: number }) => void): number {
			this.#frame = callback;
			return 1;
		}
		cancelVideoFrameCallback(): void {
			this.#frame = null;
		}
		presentFrame(mediaTime: number): void {
			const callback = this.#frame;
			this.#frame = null;
			callback?.(0, { mediaTime });
		}
	}
	// `instanceof HTMLMediaElement` and `instanceof HTMLVideoElement` is how the pane tells a sound from a video.
	install(globalThis, "HTMLMediaElement", FakeMediaElement);
	install(globalThis, "HTMLVideoElement", FakeVideo);
	makePlayer = kind => {
		const player = (kind === "video" ? new FakeVideo(env.document, "video") : new FakeMediaElement(env.document, "audio")) as unknown as Player;
		player.setAttribute("data-slot", "viewer-media");
		return player;
	};

	// Dynamic by necessity: the kit binds React when it loads, and react-dom (loaded by `installReact`) decides once, then, whether there is a DOM.
	const realKit = await import(KIT);
	// Taken BEFORE the mock goes in: `mock.module` rewrites the exports of a module that is already loaded IN PLACE, so
	// `realKit.MarkupOverlay` read afterwards is the stand-in itself, and a stand-in that draws "the real one" through
	// that name draws itself, forever (a render that never ends and grows by half a gigabyte a second).
	const { MarkupOverlay: RealOverlay, AnnotationPanel: RealPanel } = realKit;
	mock.module(KIT, () => ({
		...realKit,
		FilmLane: (props: FilmLaneProps) => {
			film = props;
			return createElement("div", { "data-slot": "film-lane" });
		},
		WaveLane: (props: WaveLaneProps) => {
			wave = props;
			return createElement("div", { "data-slot": "wave-lane" });
		},
		MarkupOverlay: (props: MarkupOverlayProps) => {
			overlay = props;
			return createElement(RealOverlay, props);
		},
		AnnotationPanel: (props: AnnotationPanelProps) => {
			panel = props;
			return createElement(RealPanel, props);
		},
	}));
	({ TimelineMarks } = await import("../app/view/pane-extras-timeline"));
	({ FULL_SENTENCE } = await import("../app/view/media-transport"));
});
afterEach(async () => {
	await env.cleanup();
	film = null;
	wave = null;
	overlay = null;
	panel = null;
});
afterAll(() => {
	while (restores.length > 0) restores.pop()?.();
	env.restore();
});

const app = {
	getHostCapabilities: () => ({ updateModelContext: { text: {}, image: {} } }),
	updateModelContext: async () => ({}),
	callServerTool: async () => {
		throw new Error("this test has no files to read");
	},
} as unknown as App;

const tabOf = (kind: Kind, over: Partial<DocTab> = {}): DocTab => ({
	path: `/files/take.${kind === "video" ? "mp4" : "wav"}`,
	filename: `take.${kind === "video" ? "mp4" : "wav"}`,
	key: `/files/take.${kind === "video" ? "mp4" : "wav"}`,
	kind,
	size: 2048,
	mtimeMs: 1,
	revision: 0,
	annotateRequests: 0,
	...over,
});

const slotOf = (name: string): HTMLElement => {
	const element = env.document.createElement("div");
	element.setAttribute("data-slot", name);
	return element;
};

/** What a tool of the bar says of itself. */
interface ToolView {
	readonly id: string;
	readonly label: string;
	readonly key: string | null;
	readonly text: string | null;
	readonly disabled: boolean;
	readonly checked: boolean;
}

/** The DOM the pane builds around the layer, and the ways a person looks at what the layer put in it. */
function rig(kind: Kind) {
	const pane = slotOf("viewer-pane");
	const strip = slotOf("viewer-mode-strip");
	const frame = slotOf("viewer-stage-frame");
	const stage = env.document.createElement("div");
	const dock = slotOf("viewer-media-dock");
	let player = makePlayer(kind);
	stage.append(player);
	frame.append(stage, dock);
	pane.append(strip, frame);
	env.document.body.append(pane);

	let props: PaneExtrasProps;
	let handle: Awaited<ReturnType<ReactEnv["mount"]>>;
	const element = () => createElement(TimelineMarks, props);

	const tools = (): ToolView[] =>
		Array.from(strip.querySelectorAll<HTMLElement>("button[data-tool]")).map(button => ({
			id: button.getAttribute("data-tool") ?? "",
			label: button.getAttribute("aria-label") ?? "",
			key: button.getAttribute("aria-keyshortcuts"),
			text: button.querySelector(".dam-tool-text")?.textContent ?? null,
			disabled: button.hasAttribute("disabled"),
			checked: button.getAttribute("aria-checked") === "true",
		}));
	const rows = (): HTMLElement[] => Array.from(pane.querySelectorAll<HTMLElement>('[data-slot="annotate-panel"] li'));

	return {
		pane,
		strip,
		dock,
		/** The element the renderer drew. */
		get media(): Player {
			return player;
		},
		async mount(over: Partial<PaneExtrasProps> = {}, tab: Partial<DocTab> = {}): Promise<void> {
			props = { app, tab: tabOf(kind, tab), active: true, ready: true, frame, mode: "timeline", ...over };
			handle = await env.mount(element());
		},
		/** The pane is given new props (a tab's own fields are merged over the tab it has). */
		async update(over: Partial<PaneExtrasProps> = {}, tab: Partial<DocTab> = {}): Promise<void> {
			props = { ...props, ...over, tab: { ...props.tab, ...tab } };
			await handle.render(element());
		},
		/** The renderer mounting again (a theme change): the element it drew is gone and a fresh one stands in its place. */
		replaceMedia(): Player {
			player.remove();
			player = makePlayer(kind);
			stage.append(player);
			return player;
		},
		/** The player fails partway through a recording. */
		async fail(): Promise<void> {
			player.error = { code: 3, message: "The recording could not be decoded." } as MediaError;
			await env.act(async () => player.tell("error"));
		},
		/** Frames reaching the screen, one after another. */
		async present(...times: number[]): Promise<void> {
			const present = player.presentFrame?.bind(player);
			if (present === undefined) throw new Error("only a video shows frames");
			await env.act(async () => {
				for (const time of times) present(time);
			});
		},
		async play(): Promise<void> {
			await env.act(async () => void player.play());
		},
		/** The overlay finishing a shape. */
		async draw(shape: MarkShape, aspect = 16 / 9): Promise<void> {
			const target = overlay;
			if (target === null) throw new Error("no drawing overlay was drawn");
			await env.act(async () => target.onShape(shape, aspect));
		},
		/** A mark made at `seconds` with the key. */
		async mark(seconds: number): Promise<void> {
			player.currentTime = seconds;
			await press("m");
		},
		/** The bar. */
		get bar(): HTMLElement | null {
			return strip.querySelector<HTMLElement>('[role="toolbar"][aria-label="Annotation tools"]');
		},
		get tools(): ToolView[] {
			return tools();
		},
		/** The tool ids of each group of the bar, in order. */
		get layout(): string[][] {
			return Array.from(strip.querySelectorAll('[data-slot="annotation-tool-group"]')).map(group =>
				Array.from(group.querySelectorAll<HTMLElement>("button[data-tool]")).map(button => button.getAttribute("data-tool") ?? ""),
			);
		},
		view(id: string): ToolView {
			const found = tools().find(tool => tool.id === id);
			if (found === undefined) throw new Error(`the bar has no ${id} tool`);
			return found;
		},
		tool: (id: string): HTMLElement | null => strip.querySelector<HTMLElement>(`[data-tool="${id}"]`),
		/** The drawing tool in hand, or `null`. */
		get armed(): string | null {
			return strip.querySelector('[role="radiogroup"] [aria-checked="true"]')?.getAttribute("data-tool") ?? null;
		},
		/** The line at the far end of the bar. */
		get hint(): string {
			return strip.querySelector('[data-slot="annotation-toolbar-hint"]')?.textContent ?? "";
		},
		/** The line of help the transport shows for the last thing that could not be done. */
		get said(): string {
			return dock.querySelector('[data-slot="viewer-transport-hint"]')?.textContent ?? "";
		},
		get list(): HTMLElement | null {
			return pane.querySelector<HTMLElement>('[data-slot="annotate-panel"]');
		},
		get rows(): HTMLElement[] {
			return rows();
		},
		/** What each row says it is: its time, and for a drawing the tool that made it. */
		get headings(): string[] {
			return rows().map(row => row.querySelector("code")?.textContent ?? "");
		},
		get notes(): string[] {
			return rows().map(row => row.querySelector("textarea")?.value ?? "");
		},
		/** The 1-based places of the rows that are active. */
		get active(): number[] {
			return rows().flatMap((row, index) => (row.hasAttribute("data-active") ? [index + 1] : []));
		},
		/** The notes the lane was handed, in time order. */
		get marks(): readonly TimelineMark[] {
			const lane = kind === "video" ? film : wave;
			if (lane === null) throw new Error("no lane was drawn");
			return lane.marks;
		},
	};
}

type Rig = ReturnType<typeof rig>;

interface Keys {
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	/** The system repeating a key that is held down; the key's first press has it `false`. */
	repeat?: boolean;
}

/** A key pressed on `target` (the page, unless a field is named): it bubbles to the window the pane listens on. */
async function press(key: string, init: Keys = {}, target: EventTarget = env.document.body): Promise<Event> {
	const event = Object.assign(new (win().Event)("keydown", { bubbles: true, cancelable: true }), { key, ...init });
	await env.act(async () => void target.dispatchEvent(event));
	return event;
}

/** A key held down: pressed once, then repeated `repeats` more times, `between(n)` running before the nth repeat. */
async function hold(key: string, repeats: number, between: (n: number) => void = () => {}): Promise<void> {
	await press(key, { repeat: false });
	for (let n = 0; n < repeats; n += 1) {
		between(n);
		await press(key, { repeat: true });
	}
}

function click(element: Element | null): Promise<void> {
	if (element === null) throw new Error("nothing to click");
	return env.act(async () => void element.dispatchEvent(new (win().Event)("click", { bubbles: true, cancelable: true })));
}

/** Every note the most one message carries but the last, one a second from the start. */
async function nearlyFull(at: Rig): Promise<void> {
	for (let second = 0; second < MAX_TIMELINE_MARKS - 1; second += 1) await at.mark(second);
}

const BOX: MarkShape = { kind: "box", from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } };

describe("the one toolbar", () => {
	test.each([
		{ kind: "audio" as const, layout: [["moment", "stretch"]] },
		{
			kind: "video" as const,
			layout: [
				["moment", "stretch"],
				["pin", "box", "ellipse", "arrow", "pen"],
				["undo", "redo", "clear"],
			],
		},
	])("a $kind's bar has exactly its own groups, in the strip, once", async ({ kind, layout }) => {
		const at = rig(kind);
		await at.mount();

		expect(at.strip.querySelectorAll('[role="toolbar"]').length).toBe(1);
		expect(at.bar).not.toBeNull();
		expect(at.layout).toEqual(layout.map(group => [...group]));
		expect(at.view("moment")).toMatchObject({ label: "Moment", key: "M", disabled: false });
		expect(at.view("stretch")).toMatchObject({ label: "Stretch", key: "I", text: null, disabled: false });
	});

	test.each(KINDS)("a %s whose layer is down has its transport, no bar, no list, and keys that make nothing", async kind => {
		const at = rig(kind);
		await at.mount({ mode: null });
		await press("m");

		expect(at.bar).toBeNull();
		expect(at.list).toBeNull();
		expect(at.dock.querySelector('[data-slot="viewer-transport"]')).not.toBeNull();
		// The lane is handed nothing to mark with.
		if (kind === "video") expect(film?.onSpan).toBeUndefined();
		else expect(wave?.onComment).toBeUndefined();

		// The layer comes up: the bar, and the key that was pressed while it was down made no note.
		await at.update({ mode: "timeline" });
		expect(at.bar).not.toBeNull();
		expect(at.rows).toHaveLength(0);
	});
});

describe("Moment and Stretch", () => {
	test("a stretch is begun on the tool, says where it began, can be taken back, and is ended on the same tool", async () => {
		const at = rig("audio");
		await at.mount();
		at.media.currentTime = 2.5;
		await click(at.tool("stretch"));

		expect(at.view("stretch")).toMatchObject({ label: "End stretch", key: "O", text: "from 0:02.5" });
		expect(at.view("cancel-stretch").label).toBe("Cancel stretch");
		expect(at.layout).toEqual([["moment", "stretch", "cancel-stretch"]]);
		expect(at.rows).toHaveLength(0);

		await click(at.tool("cancel-stretch"));
		expect(at.view("stretch")).toMatchObject({ label: "Stretch", key: "I", text: null });
		expect(at.layout).toEqual([["moment", "stretch"]]);
		expect(at.rows).toHaveLength(0);

		await click(at.tool("stretch"));
		at.media.currentTime = 6;
		await click(at.tool("stretch"));
		expect(at.headings).toEqual(["0:02.5-0:06.0"]);
		expect(at.view("stretch")).toMatchObject({ label: "Stretch", text: null });
	});

	test("a stretch ended where it began is not made: it says so and stays half set", async () => {
		const at = rig("audio");
		await at.mount();
		at.media.currentTime = 2.5;
		await click(at.tool("stretch"));
		at.media.currentTime = 2.55;
		await click(at.tool("stretch"));

		expect(at.rows).toHaveLength(0);
		expect(at.view("stretch").label).toBe("End stretch");
		expect(at.said).not.toBe("");

		at.media.currentTime = 3.5;
		await click(at.tool("stretch"));
		expect(at.headings).toEqual(["0:02.5-0:03.5"]);
	});

	test("with every note used the tools that make notes are off and the bar says why; taking one back turns them on", async () => {
		const at = rig("video");
		await at.mount();
		await nearlyFull(at);

		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS - 1);
		expect(at.view("moment").disabled).toBe(false);
		expect(at.view("stretch").disabled).toBe(false);
		expect(at.hint).not.toBe(FULL_SENTENCE);

		await at.mark(MAX_TIMELINE_MARKS - 1);
		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS);
		expect(at.view("moment").disabled).toBe(true);
		expect(at.view("stretch").disabled).toBe(true);
		expect(at.hint).toBe(FULL_SENTENCE);

		// One more press is refused, and the transport says why.
		await at.mark(28);
		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS);
		expect(at.said).toBe(FULL_SENTENCE);

		await click(at.tool("undo"));
		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS - 1);
		expect(at.view("moment").disabled).toBe(false);
		expect(at.view("stretch").disabled).toBe(false);
		expect(at.hint).not.toBe(FULL_SENTENCE);
	});

	test("a recording that failed keeps the notes it has, makes no more, and puts the pen down for good", async () => {
		const at = rig("video");
		await at.mount();
		await at.mark(4);
		await press("3");
		expect(at.armed).toBe("ellipse");

		await at.fail();
		expect(at.view("moment").disabled).toBe(true);
		expect(at.view("stretch").disabled).toBe(true);
		expect(at.armed).toBeNull();
		expect(at.headings).toEqual(["0:04.0"]);
		expect(film?.onSpan).toBeUndefined();

		// The keys that make notes, and the ways to pick the pen up again, do nothing.
		await at.mark(9);
		await press("i");
		await press("2");
		await click(at.tool("box"));
		await at.update({}, { annotateRequests: 1 });
		expect(at.headings).toEqual(["0:04.0"]);
		expect(at.view("stretch").label).toBe("Stretch");
		expect(at.armed).toBeNull();
	});

	test("a recording that failed with nothing marked offers no list", async () => {
		const at = rig("audio");
		await at.mount();
		expect(at.list).not.toBeNull();

		await at.fail();
		expect(at.list).toBeNull();
		expect(wave?.onComment).toBeUndefined();
	});
});

describe("the keys on the window", () => {
	test("M marks the moment under the playhead in either case, and near a note it names that note instead of stacking another", async () => {
		const at = rig("audio");
		await at.mount();
		await at.mark(1);
		await at.mark(5);
		expect(at.headings).toEqual(["0:01.0", "0:05.0"]);

		await at.mark(5.1);
		expect(at.headings).toEqual(["0:01.0", "0:05.0"]);
		expect(at.said).toBe("Note 2 is already here.");

		at.media.currentTime = 9;
		await press("M");
		expect(at.headings).toEqual(["0:01.0", "0:05.0", "0:09.0"]);
	});

	test("I then O make a stretch from the first time to the second; O with no start explains and makes nothing", async () => {
		const at = rig("audio");
		await at.mount();
		at.media.currentTime = 7;
		await press("o");
		expect(at.rows).toHaveLength(0);
		expect(at.view("stretch").label).toBe("Stretch");
		expect(at.said).toMatch(/\bI\b.*\bO\b/);

		at.media.currentTime = 1;
		await press("i");
		expect(at.view("stretch")).toMatchObject({ label: "End stretch", text: "from 0:01.0" });
		at.media.currentTime = 4;
		await press("o");
		expect(at.headings).toEqual(["0:01.0-0:04.0"]);
		expect(at.view("stretch")).toMatchObject({ label: "Stretch", text: null });
	});

	test("Escape takes a half-set stretch back first and only then puts the drawing tool down, leaving the notes", async () => {
		const at = rig("video");
		await at.mount();
		await at.mark(2);
		await press("2");
		expect(at.armed).toBe("box");
		at.media.currentTime = 3;
		await press("i");
		expect(at.view("stretch").label).toBe("End stretch");

		await press("Escape");
		expect(at.view("stretch").label).toBe("Stretch");
		expect(at.armed).toBe("box");

		await press("Escape");
		expect(at.armed).toBeNull();
		expect(at.headings).toEqual(["0:02.0"]);

		await press("Escape");
		expect(at.headings).toEqual(["0:02.0"]);
	});

	test.each([
		["1", "pin"],
		["2", "box"],
		["3", "ellipse"],
		["4", "arrow"],
		["5", "pen"],
	])("on a video the %s key puts the %s in hand, and the drawing layer takes it", async (key, tool) => {
		const at = rig("video");
		await at.mount();
		expect(at.armed).toBeNull();
		expect(overlay?.tool).toBeNull();

		await press(key);
		expect(at.armed).toBe(tool);
		expect<string | null | undefined>(overlay?.tool).toBe(tool);
	});

	test("a video starts with nothing in hand, and the card's Annotate action picks up the Box each time it is asked", async () => {
		const at = rig("video");
		await at.mount();
		expect(at.armed).toBeNull();
		expect(overlay?.tool).toBeNull();

		await at.update({}, { annotateRequests: 1 });
		expect(at.armed).toBe("box");
		expect(overlay?.tool).toBe("box");

		await press("Escape");
		expect(at.armed).toBeNull();
		await at.update({}, { annotateRequests: 2 });
		expect(at.armed).toBe("box");
	});

	test("Ctrl+Z takes the last note of a video back, Ctrl+Shift+Z and Cmd+Z bring it and take it again, and the bar's tools follow", async () => {
		const at = rig("video");
		await at.mount();
		expect(at.view("undo").disabled).toBe(true);
		await at.mark(1);
		await at.mark(3);
		expect(at.headings).toEqual(["0:01.0", "0:03.0"]);
		expect(at.view("undo").disabled).toBe(false);
		expect(at.view("redo").disabled).toBe(true);

		await press("z", { ctrlKey: true });
		expect(at.headings).toEqual(["0:01.0"]);
		expect(at.view("redo").disabled).toBe(false);

		await press("Z", { ctrlKey: true, shiftKey: true });
		expect(at.headings).toEqual(["0:01.0", "0:03.0"]);
		expect(at.view("redo").disabled).toBe(true);

		await press("z", { metaKey: true });
		expect(at.headings).toEqual(["0:01.0"]);
		await click(at.tool("redo"));
		expect(at.headings).toEqual(["0:01.0", "0:03.0"]);
		await click(at.tool("clear"));
		expect(at.rows).toHaveLength(0);
		expect(at.view("clear").disabled).toBe(true);
	});

	test("keys typed in a note, pressed with Alt, or already answered are not the recording's", async () => {
		const at = rig("video");
		await at.mount();
		await at.mark(2);
		// The list has a note to type in; the keys are pressed at a field of the test's own, outside React's roots: React's input
		// polyfill, which linkedom's lack of `oninput` selects, cannot take a key at a field it rendered. The pane only asks
		// whose key it is (a text field's), and the window sees the same event either way.
		expect(at.list?.querySelector("textarea")).not.toBeNull();
		const note = env.document.createElement("textarea");
		env.document.body.append(note);
		at.media.currentTime = 8;

		await press("m", {}, note);
		await press("i", {}, note);
		await press("2", {}, note);
		await press("m", { altKey: true });
		expect(at.headings).toEqual(["0:02.0"]);
		expect(at.armed).toBeNull();
		expect(at.view("stretch").label).toBe("Stretch");

		// Something nearer the key (the scrubber's own arrows, the drawing surface's) answered it first.
		const answered = (event: Event): void => event.preventDefault();
		env.document.body.addEventListener("keydown", answered);
		await press("m");
		env.document.body.removeEventListener("keydown", answered);
		expect(at.headings).toEqual(["0:02.0"]);

		// The same key, unanswered, is ours: the keys above were refused, not dead.
		await press("m");
		expect(at.headings).toEqual(["0:02.0", "0:08.0"]);
	});

	test("only the tab on screen plays and listens: leaving pauses it, its keys go quiet, coming back does not resume it", async () => {
		const at = rig("video");
		await at.mount();
		await press(" ");
		expect(at.media.paused).toBe(false);

		await at.update({ active: false });
		expect(at.media.paused).toBe(true);
		await press(" ");
		await at.mark(3);
		expect(at.media.paused).toBe(true);
		expect(at.rows).toHaveLength(0);

		await at.update({ active: true });
		expect(at.media.paused).toBe(true);
		await at.mark(3);
		expect(at.rows).toHaveLength(1);
	});

	test("the frame keys step one frame from the frame on screen, not from a playhead that has crept past it, and stop the film", async () => {
		const at = rig("video");
		await at.mount();
		await at.present(...PLAYED);
		at.media.currentTime = 2.015;
		await at.play();

		await press(".");
		expect(at.media.paused).toBe(true);
		expect(at.media.currentTime).toBeCloseTo(frameStepTarget(1.96, FRAME, 1), 6);

		await press(",");
		expect(at.media.currentTime).toBeCloseTo(frameStepTarget(1.96, FRAME, -1), 6);
	});
});

describe("a key held down", () => {
	test.each([
		{ name: "the playhead still", step: 0 },
		{ name: "the playhead moving on half a second between repeats", step: 0.5 },
	])("a held M adds one moment and nags about nothing, with $name", async ({ step }) => {
		const at = rig("audio");
		await at.mount();
		at.media.currentTime = 1;
		await hold("m", 4, n => {
			at.media.currentTime = 1 + step * (n + 1);
		});
		expect(at.headings).toEqual(["0:01.0"]);
		// A repeat that was let through would say the note is already here, or stack another a half second on.
		expect(at.said).toBe("");

		// The repeats were refused, the key is not dead: pressed anew it marks where the playhead is.
		at.media.currentTime = 9;
		await press("m");
		expect(at.headings).toEqual(["0:01.0", "0:09.0"]);
	});

	test("a held I sets where the stretch starts once: its repeats do not carry the start along with the playhead", async () => {
		const at = rig("audio");
		await at.mount();
		at.media.currentTime = 1;
		await hold("i", 3, n => {
			at.media.currentTime = 2 + n;
		});
		expect(at.view("stretch")).toMatchObject({ label: "End stretch", text: "from 0:01.0" });

		at.media.currentTime = 6;
		await press("o");
		expect(at.headings).toEqual(["0:01.0-0:06.0"]);
	});

	test("a held O ends a stretch once and then keeps quiet: no second stretch, no help about pressing I first", async () => {
		const at = rig("audio");
		await at.mount();
		at.media.currentTime = 1;
		await press("i");

		// A repeat whose first press went to a text field is not an O: it does not end the stretch just begun.
		at.media.currentTime = 6;
		await press("o", { repeat: true });
		expect(at.rows).toHaveLength(0);
		expect(at.view("stretch").label).toBe("End stretch");

		await hold("o", 3, n => {
			at.media.currentTime = 7 + n;
		});
		expect(at.headings).toEqual(["0:01.0-0:06.0"]);
		expect(at.view("stretch").label).toBe("Stretch");
		expect(at.said).toBe("");
	});

	test("a held number key puts its tool in hand once: its repeats do not pick the pen up again after Esc put it down", async () => {
		const at = rig("video");
		await at.mount();
		await hold("2", 3);
		expect(at.armed).toBe("box");
		expect(overlay?.tool).toBe("box");

		await press("Escape");
		expect(at.armed).toBeNull();
		await press("2", { repeat: true });
		expect(at.armed).toBeNull();
		expect(overlay?.tool).toBeNull();

		await press("2");
		expect(at.armed).toBe("box");
	});

	test("a held frame key steps a frame on every repeat, each from the frame the last step put on screen", async () => {
		const at = rig("video");
		await at.mount();
		await at.present(...PLAYED);

		await press(".", { repeat: false });
		const reached = [at.media.currentTime];
		// The player shows the frame each step landed in before the next repeat arrives.
		for (const shown of [2, 2.04, 2.08]) {
			await at.present(shown);
			await press(".", { repeat: true });
			reached.push(at.media.currentTime);
		}
		const expected = [1.96, 2, 2.04, 2.08].map(shown => frameStepTarget(shown, FRAME, 1));
		expect(reached).toHaveLength(expected.length);
		for (const [index, time] of reached.entries()) expect(time).toBeCloseTo(expected[index] as number, 6);
	});
});

describe("drawing on the frame", () => {
	test("a finished shape stops the film and lands on the frame on screen, whose length the clock measured, not on the playhead beside it", async () => {
		const at = rig("video");
		await at.mount();
		await at.present(...PLAYED);
		// 0.055 s past the frame's start: inside a measured frame and a half (0.06), outside a default one (0.05).
		at.media.currentTime = 2.015;
		await at.play();

		await at.draw(BOX);
		expect(at.media.paused).toBe(true);
		expect(at.headings).toEqual(["0:01.9 · box"]);
	});

	test("a shape drawn once a seek has landed far from the frame last reported goes on the playhead", async () => {
		const at = rig("video");
		await at.mount();
		await at.present(...PLAYED);
		at.media.currentTime = 12.34;

		await at.draw(BOX);
		expect(at.headings).toEqual(["0:12.3 · box"]);
	});

	/** The browser telling the layer a seek landed: the layer reads the element's time only when told (no engine seeks here). */
	const landed = (at: Rig): Promise<void> => env.act(async () => at.media.tell("seeked"));

	test("a shape just drawn stays visible: the film is put inside the frame it was stamped on, so the layer still shows it once the seek lands", async () => {
		const at = rig("video");
		await at.mount();
		await at.present(...PLAYED);
		// 0.055 s past the frame's start: the shape is stamped at 1.96, and a paused playhead at 2.015 is outside that frame.
		at.media.currentTime = 2.015;
		await at.play();

		await at.draw(BOX);
		await landed(at);
		const drawing = at.marks.find(mark => mark.shape !== undefined);
		expect(drawing?.at).toBeCloseTo(1.96, 6);
		expect(at.media.paused).toBe(true);
		expect(at.media.currentTime).toBeCloseTo(insideFrame(1.96, FRAME), 6);
		expect(overlay?.marks.map(mark => mark.id)).toEqual([drawing?.id] as number[]);
	});

	test("a shape just drawn stays visible without a seek when the playhead is already inside its frame", async () => {
		const at = rig("video");
		await at.mount();
		await at.present(...PLAYED);
		at.media.currentTime = 1.97;
		await at.play();

		await at.draw(BOX);
		await landed(at);
		const drawing = at.marks.find(mark => mark.shape !== undefined);
		expect(drawing?.at).toBeCloseTo(1.96, 6);
		expect(at.media.currentTime).toBe(1.97);
		expect(overlay?.marks.map(mark => mark.id)).toEqual([drawing?.id] as number[]);
	});

	test("a shape just drawn stays visible only if it was kept: a refused drawing (a speck) does not move the playhead", async () => {
		const at = rig("video");
		await at.mount();
		await at.present(...PLAYED);
		at.media.currentTime = 2.015;
		await at.play();

		await at.draw({ kind: "box", from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 } });
		expect(at.rows).toHaveLength(0);
		expect(at.media.paused).toBe(true);
		expect(at.media.currentTime).toBe(2.015);
	});

	test.each([
		// The box is stamped at 3.033, the start of the frame on screen; the playhead has crept 1.5 ms into the frame.
		{ name: "a moment a hair into the frame sorts after the box", moment: 3.0345, draft: 1, committed: ["0:03.0 · box", "0:03.0"] },
		{ name: "a moment long before it sorts before the box", moment: 1, draft: 2, committed: ["0:01.0", "0:03.0 · box"] },
		{ name: "a moment made on that very frame sorts before the box made after it", moment: 3.033, draft: 2, committed: ["0:03.0", "0:03.0 · box"] },
	])("the number on a shape being drawn is the one it gets once drawn: $name", async ({ moment, draft, committed }) => {
		const at = rig("video");
		await at.mount();
		await at.present(2.913, 2.953, 2.993, 3.033);
		await at.mark(moment);
		at.media.currentTime = 3.0345;
		await landed(at);
		expect(overlay?.draftOrdinal).toBe(draft);

		await at.draw(BOX);
		expect(at.headings).toEqual([...committed]);
		expect(at.headings.findIndex(heading => heading.endsWith("· box")) + 1).toBe(draft);
	});

	test.each([
		{ tool: "pin", shape: { kind: "pin", at: { x: 0.4, y: 0.4 } } as MarkShape, word: "pin" },
		{ tool: "box", shape: BOX, word: "box" },
		{ tool: "ellipse", shape: { kind: "ellipse", from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } } as MarkShape, word: "circle" },
		{ tool: "arrow", shape: { kind: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } } as MarkShape, word: "arrow" },
		{
			tool: "pen",
			shape: {
				kind: "pen",
				points: [
					{ x: 0.1, y: 0.1 },
					{ x: 0.3, y: 0.4 },
					{ x: 0.5, y: 0.2 },
				],
			} as MarkShape,
			word: "draw",
		},
	])("the list calls a drawing made with the $tool tool a $word", async ({ shape, word }) => {
		const at = rig("video");
		await at.mount();

		await at.draw(shape);
		expect(at.headings).toEqual([`0:00.0 · ${word}`]);
	});

	test("a drawing past the last note is refused and says why, but a speck of a drawing is refused without claiming the notes are used", async () => {
		const at = rig("video");
		await at.mount();
		await at.draw({ kind: "box", from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 } });
		expect(at.rows).toHaveLength(0);
		expect(at.said).toBe("");

		await nearlyFull(at);
		await at.mark(MAX_TIMELINE_MARKS - 1);
		expect(at.said).toBe("");
		await at.draw(BOX);
		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS);
		expect(at.said).toBe(FULL_SENTENCE);
	});
});

describe("choosing a note", () => {
	/** A video with one drawing on the frame that began at 1.96 s and one plain note at 5 s, the film playing at 20 s. */
	async function drawnAndNoted(): Promise<{ at: Rig; drawing: TimelineMark; plain: TimelineMark }> {
		const at = rig("video");
		await at.mount();
		await at.present(...PLAYED);
		at.media.currentTime = 1.96;
		await at.draw(BOX);
		await at.mark(5);
		at.media.currentTime = 20;
		await at.play();
		const drawing = at.marks.find(mark => mark.shape !== undefined);
		const plain = at.marks.find(mark => mark.shape === undefined);
		if (drawing === undefined || plain === undefined) throw new Error("the notes were not made");
		return { at, drawing, plain };
	}

	/** Choose the note the way a person does: on the lane's marker, or on its row's Go to. */
	const ways: [string, (at: Rig, mark: TimelineMark) => Promise<void>][] = [
		["its marker on the lane", (at, mark) => env.act(async () => film?.onSelectMark(mark.id))],
		["its row's Go to", (at, mark) => click(at.rows[at.marks.indexOf(mark)]?.querySelector("button.dam-tl-go") ?? null)],
	];

	test.each(ways)("%s seeks a plain note to its time and leaves the film playing", async (_name, choose) => {
		const { at, plain } = await drawnAndNoted();
		await choose(at, plain);

		expect(at.media.currentTime).toBe(5);
		expect(at.media.paused).toBe(false);
	});

	test.each(ways)("%s stops the film on a drawing's frame, a tenth of a frame inside it", async (_name, choose) => {
		const { at, drawing } = await drawnAndNoted();
		await choose(at, drawing);

		expect(at.media.paused).toBe(true);
		expect(at.media.currentTime).toBeCloseTo(insideFrame(1.96, FRAME), 6);
	});

	test("choosing a note on the lane makes its row the active one", async () => {
		const { at, plain, drawing } = await drawnAndNoted();
		expect(at.active).toEqual([]);

		await env.act(async () => film?.onSelectMark(plain.id));
		expect(at.active).toEqual([at.marks.indexOf(plain) + 1]);

		await env.act(async () => film?.onSelectMark(drawing.id));
		expect(at.active).toEqual([at.marks.indexOf(drawing) + 1]);
	});
});

describe("the lanes' own gestures", () => {
	test("a note made on a sound's lane is the lane's to type in: the list does not take the caret, the note is active, and the lane is given its id", async () => {
		const at = rig("audio");
		await at.mount();
		let made: number | null | undefined;
		await env.act(async () => {
			made = wave?.onComment?.(3);
		});

		expect(made).toBe(at.marks[0]?.id);
		expect(typeof made).toBe("number");
		expect(at.headings).toEqual(["0:03.0"]);
		expect(at.active).toEqual([1]);
		expect(panel?.focus).toBeNull();

		// The same list does take the caret for a note made with the key: the check above is not a list that never focuses.
		await at.mark(8);
		expect(panel?.focus?.id).toBe(at.marks[1]?.id);
	});

	test("a sound's lane that cannot make a note answers null and says why", async () => {
		const at = rig("audio");
		await at.mount();
		for (let second = 0; second < MAX_TIMELINE_MARKS; second += 1) {
			let made: number | null | undefined;
			await env.act(async () => {
				made = wave?.onComment?.(second);
			});
			expect(made).not.toBeNull();
		}
		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS);
		expect(at.said).toBe("");

		let refused: number | null | undefined;
		await env.act(async () => {
			refused = wave?.onComment?.(28);
		});
		expect(refused).toBeNull();
		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS);
		expect(at.said).toBe(FULL_SENTENCE);
	});

	test("what a sound's lane writes into a note reaches the list, and the lane's cancel takes the note away", async () => {
		const at = rig("audio");
		await at.mount();
		let id: number | null | undefined;
		await env.act(async () => {
			id = wave?.onComment?.(2);
		});
		if (typeof id !== "number") throw new Error("the lane made no note");
		const made = id;

		await env.act(async () => wave?.onNote?.(made, "cut the cough"));
		expect(at.notes).toEqual(["cut the cough"]);

		await env.act(async () => wave?.onRemove?.(made));
		expect(at.rows).toHaveLength(0);
	});

	test("a stretch dragged on a video's film is made, and with every note used it says why instead", async () => {
		const at = rig("video");
		await at.mount();
		await env.act(async () => film?.onSpan?.(1, 4));
		expect(at.headings).toEqual(["0:01.0-0:04.0"]);

		await at.mark(10);
		// Half a second apart, so none is within a quarter second of another (that would focus the one there instead of making a note).
		for (let index = 0; index < MAX_TIMELINE_MARKS - 2; index += 1) await at.mark(11 + index * 0.5);
		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS);
		expect(at.said).toBe("");

		await env.act(async () => film?.onSpan?.(27, 29));
		expect(at.rows).toHaveLength(MAX_TIMELINE_MARKS);
		expect(at.said).toBe(FULL_SENTENCE);
	});
});

describe("notes and their recording", () => {
	test("notes outlive the renderer: when it draws a new element the keys read that one, and the old one is let go", async () => {
		const at = rig("video");
		await at.mount();
		await at.mark(4);
		const first = at.media;

		await at.update({ ready: false });
		const second = at.replaceMedia();
		await at.update({ ready: true });
		expect(at.headings).toEqual(["0:04.0"]);
		expect(at.dock.querySelector('[data-slot="viewer-transport"]')).not.toBeNull();

		first.currentTime = 20;
		second.currentTime = 9;
		await press("m");
		expect(at.headings).toEqual(["0:04.0", "0:09.0"]);
	});

	test.each([
		{ name: "the same file rewritten", tab: { mtimeMs: 2 } },
		{ name: "another file", tab: { path: "/files/other.wav", filename: "other.wav", key: "/files/other.wav" } },
	])("$name starts clean: no note and no half-set stretch from the old recording", async ({ tab }) => {
		const at = rig("audio");
		await at.mount();
		await at.mark(1);
		await press("i");
		expect(at.view("stretch").label).toBe("End stretch");
		expect(at.rows).toHaveLength(1);

		await at.update({}, tab);
		expect(at.view("stretch")).toMatchObject({ label: "Stretch", text: null });
		expect(at.rows).toHaveLength(0);
	});
});
