// What drawing on a video promises: the kit's overlay lies over the picture the video DRAWS (not the bars the box shows
// around it), shows only the drawings that belong to the frame on screen, numbers them by their place among ALL the
// notes, keeps a drawing's note open only while its frame is on screen, and stops the film when the human starts to
// draw - without redrawing the pane for every frame of a playing film.
//
// Rendered for real (linkedom + react-dom under `act`) over a real <video> element whose layout is stubbed (linkedom has
// no layout): the box, the stage offset and the picture's size are numbers the test sets, and a ResizeObserver stand-in
// is fired by hand for the video or its stage. The kit's overlay is a stand-in that records the props it is drawn with
// (it is the kit's own test subject); everything else - the transport's playhead, the frame maths - is the real thing.
// Bun cannot lift a module mock, so the file puts the real kit back when it is done.
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { MarkShape, TimelineMark } from "@dimension/mcp-app-kit/annotate";
import type { MarkupOverlayProps } from "@dimension/mcp-app-kit/annotate/react";
import * as react from "react";
import { createElement, type ReactElement } from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import type * as Draw from "../app/view/media-draw";
import { installReact, type ReactEnv } from "./media-react";

const KIT = "@dimension/mcp-app-kit/annotate/react";

// The kit's tsconfig maps `react` and its JSX runtimes onto their type declarations, which bun cannot load as code, and
// bun applies that map to the kit's sources wherever they are imported from. The map's targets are mocked with the real
// modules (the same instances this file uses, so there is one React): that is what lets the real kit module be read
// here, to stand under the overlay's stand-in.
const kitSource = dirname(Bun.resolveSync(KIT, import.meta.dir));
for (const [id, real] of [
	["react", react],
	["react/jsx-runtime", jsxRuntime],
	["react/jsx-dev-runtime", jsxDevRuntime],
] as const) {
	mock.module(Bun.resolveSync(id, kitSource), () => real);
}

let env: ReactEnv;
let DrawLayer: typeof Draw.DrawLayer;
let realKit: Record<string, unknown>;
const restores: (() => void)[] = [];

/** Put a global in place for the whole file, remembering how to take it out. */
function install(target: object, name: string, value: unknown): void {
	const previous = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { value, configurable: true, writable: true });
	restores.push(() => (previous ? Object.defineProperty(target, name, previous) : void Reflect.deleteProperty(target, name)));
}

const win = (): Window & typeof globalThis => env.document.defaultView as Window & typeof globalThis;

/** Every drawing of the overlay stand-in, oldest first: its length is how many times the layer was drawn. */
const overlays: MarkupOverlayProps[] = [];

function StandInOverlay(props: MarkupOverlayProps): ReactElement {
	overlays.push(props);
	return createElement("div", { "data-stand-in": "overlay" });
}

/** The last props the layer drew the overlay with. */
function overlay(): MarkupOverlayProps {
	const last = overlays.at(-1);
	if (last === undefined) throw new Error("the overlay was never drawn");
	return last;
}

/** The ids of the drawings the overlay was last given. */
const shown = (): number[] => overlay().marks.map(mark => mark.id);

/** A ResizeObserver whose callbacks the test calls by hand, for whatever it was asked to watch. */
class WatchedSizes {
	static readonly all: WatchedSizes[] = [];
	readonly targets = new Set<Element>();
	constructor(readonly callback: () => void) {
		WatchedSizes.all.push(this);
	}
	observe(target: Element): void {
		this.targets.add(target);
	}
	unobserve(target: Element): void {
		this.targets.delete(target);
	}
	disconnect(): void {
		this.targets.clear();
	}
}

/** The browser reports a size change of any of `targets`. */
const resized = (...targets: Element[]): Promise<void> =>
	env.act(async () => {
		for (const observer of WatchedSizes.all) if (targets.some(target => observer.targets.has(target))) observer.callback();
	});

/** Run `run` in an engine that has no ResizeObserver, and put the global back after. */
async function withoutResizeObserver(run: () => Promise<void>): Promise<void> {
	install(globalThis, "ResizeObserver", undefined);
	try {
		await run();
	} finally {
		restores.pop()?.();
	}
}

beforeAll(async () => {
	env = await installReact();
	install(globalThis, "ResizeObserver", WatchedSizes);
	// Dynamic by necessity: the kit binds React when it loads, and react-dom (loaded by `installReact`) decides once, then, whether there is a DOM.
	realKit = { ...(await import(KIT)) };
	mock.module(KIT, () => ({ ...realKit, MarkupOverlay: StandInOverlay }));
	({ DrawLayer } = await import("../app/view/media-draw"));
});
afterEach(async () => {
	await env.cleanup();
	overlays.length = 0;
	WatchedSizes.all.length = 0;
});
afterAll(() => {
	mock.module(KIT, () => realKit);
	while (restores.length > 0) restores.pop()?.();
	env.restore();
});

// ── the video ────────────────────────────────────────────────────────────

/** What the stubbed video reports: its box and the box's place in the stage, the picture's own size, the playhead. */
interface Footage {
	videoWidth: number;
	videoHeight: number;
	clientWidth: number;
	clientHeight: number;
	offsetLeft: number;
	offsetTop: number;
	currentTime: number;
	paused: boolean;
}

const NO_RANGES = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;

/** A 2:1 picture in a 4:3 box that sits at the corner of its stage: the picture fills the width, with bars above and below. */
const WIDE_IN_TALL: Footage = { videoWidth: 200, videoHeight: 100, clientWidth: 400, clientHeight: 300, offsetLeft: 0, offsetTop: 0, currentTime: 0, paused: true };

interface Rig {
	readonly stage: HTMLElement;
	readonly video: HTMLVideoElement;
	readonly footage: Footage;
	/** The video says each of `types` (native events). */
	readonly tell: (...types: string[]) => Promise<void>;
	/** The playhead is at `seconds`, and the video says `event` about it. */
	readonly seek: (seconds: number, event?: string) => Promise<void>;
	/** The layer's wrapper in the stage, or `null` while there is none. */
	readonly wrapper: () => HTMLElement | null;
	/** Listeners attached to the video right now. */
	readonly listening: () => number;
}

/** A real <video> in a stage, reporting `over` on top of {@link WIDE_IN_TALL}; with `staged: false` it has no parent. */
function rig(over: Partial<Footage> = {}, staged = true): Rig {
	const stage = env.document.createElement("div");
	const video = env.document.createElement("video") as unknown as HTMLVideoElement;
	const footage: Footage = { ...WIDE_IN_TALL, ...over };
	const report = (name: string, get: () => unknown, set?: (value: number) => void): void => void Object.defineProperty(video, name, { get, set, configurable: true });
	for (const name of ["videoWidth", "videoHeight", "clientWidth", "clientHeight", "offsetLeft", "offsetTop", "paused"] as const) report(name, () => footage[name]);
	report("currentTime", () => footage.currentTime, value => void (footage.currentTime = value));
	for (const [name, value] of Object.entries({ ended: false, playbackRate: 1, volume: 1, muted: false, error: null, duration: 120, seekable: NO_RANGES })) report(name, () => value);

	const attached = new Map<EventListenerOrEventListenerObject, Set<string>>();
	const add = video.addEventListener.bind(video);
	const remove = video.removeEventListener.bind(video);
	video.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
		attached.set(listener, (attached.get(listener) ?? new Set()).add(type));
		add(type, listener, options);
	}) as typeof video.addEventListener;
	video.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
		attached.get(listener)?.delete(type);
		remove(type, listener, options);
	}) as typeof video.removeEventListener;

	if (staged) {
		stage.append(video);
		env.document.body.append(stage);
	}
	const tell = (...types: string[]): Promise<void> =>
		env.act(async () => {
			for (const type of types) video.dispatchEvent(new (win().Event)(type));
		});
	return {
		stage,
		video,
		footage,
		tell,
		seek(seconds, event = "seeked") {
			footage.currentTime = seconds;
			return tell(event);
		},
		wrapper: () => stage.querySelector<HTMLElement>('[data-slot="viewer-video-draw"]'),
		listening: () => [...attached.values()].reduce((total, types) => total + types.size, 0),
	};
}

/** One frame is a tenth of a second: far from the float edges of the frame maths, and a plain number to read a test by. */
const FRAME = 0.1;

function layer(video: HTMLVideoElement, over: Partial<Draw.DrawLayerProps> = {}): ReactElement {
	return createElement(DrawLayer, { video, live: true, marks: [], tool: null, activeId: null, filename: "clip.mp4", frameSeconds: () => FRAME, drawingTime: playhead => playhead, onBegin: () => {}, onShape: () => undefined, openId: null, onOpen: () => {}, onNote: () => {}, onRemove: () => {}, ...over });
}

/** Where the layer sits, as the numbers its wrapper's style gives (px), and the rest of that style. */
function placed(wrapper: HTMLElement | null): { left: number; top: number; width: number; height: number; position: string; pointerEvents: string } {
	if (wrapper === null) throw new Error("the layer is not in the stage");
	const css = new Map((wrapper.getAttribute("style") ?? "").split(";").map(declaration => declaration.split(":").map(part => part.trim()) as [string, string]));
	const px = (name: string): number => Number.parseFloat(css.get(name) ?? "NaN");
	return { left: px("left"), top: px("top"), width: px("width"), height: px("height"), position: css.get("position") ?? "", pointerEvents: css.get("pointer-events") ?? "" };
}

const rectOf = (at: Rig) => {
	const { left, top, width, height } = placed(at.wrapper());
	return { left, top, width, height };
};

// ── the notes ────────────────────────────────────────────────────────────

const BOX: MarkShape = { kind: "box", from: { x: 0.1, y: 0.1 }, to: { x: 0.4, y: 0.4 } };
const PIN: MarkShape = { kind: "pin", at: { x: 0.5, y: 0.5 } };
const ARROW: MarkShape = { kind: "arrow", from: { x: 0.2, y: 0.8 }, to: { x: 0.6, y: 0.3 } };

/** In time order: two plain notes among three drawings, two of them on one frame. */
const MARKS: readonly TimelineMark[] = [
	{ id: 11, at: 2, note: "tighten the cut" },
	{ id: 12, at: 5, note: "logo too low", shape: BOX },
	{ id: 13, at: 5, note: "", shape: PIN },
	{ id: 14, at: 8, to: 9.5, note: "music swells" },
	{ id: 15, at: 9, note: "cut this", shape: ARROW },
];

describe("where the layer sits: over the picture, not over the bars around it", () => {
	const PLACEMENTS = [
		{
			name: "a wide picture in a taller box (bars above and below), the box a little way into its stage",
			over: { videoWidth: 1920, videoHeight: 1080, clientWidth: 333, clientHeight: 250, offsetLeft: 12, offsetTop: 5 },
			rect: { left: 12, top: 36.3, width: 333, height: 187.3 },
		},
		{
			name: "a tall picture in a wider box (bars at the sides), rounded to tenths of a pixel",
			over: { videoWidth: 1000, videoHeight: 1900, clientWidth: 400, clientHeight: 300, offsetLeft: 3, offsetTop: 4 },
			rect: { left: 124.1, top: 4, width: 157.9, height: 300 },
		},
	];
	for (const { name, over, rect } of PLACEMENTS) {
		test(name, async () => {
			const at = rig(over);
			await env.mount(layer(at.video));

			expect(rectOf(at)).toEqual(rect);
			expect(placed(at.wrapper()).position).toBe("absolute");
			// The video is clicked through to play and pause it; the kit's overlay takes input itself once a tool is armed.
			expect(placed(at.wrapper()).pointerEvents).toBe("none");
			expect(at.wrapper()?.querySelector('[data-stand-in="overlay"]')).not.toBeNull();
		});
	}

	const NO_PICTURE = [
		{
			name: "a video that has not said how big its picture is",
			over: { videoWidth: 0, videoHeight: 0 },
			settle: (footage: Footage) => Object.assign(footage, { videoWidth: 200, videoHeight: 100 }),
			until: "loadedmetadata",
		},
		{
			name: "a box with no room (hidden)",
			over: { clientWidth: 0, clientHeight: 0 },
			settle: (footage: Footage) => Object.assign(footage, { clientWidth: 400, clientHeight: 300 }),
			until: "resize",
		},
	];
	for (const { name, over, settle, until } of NO_PICTURE) {
		test(`draws nothing for ${name}, and appears when it does`, async () => {
			const at = rig(over);
			await env.mount(layer(at.video));

			expect(at.wrapper()).toBeNull();
			expect(overlays).toHaveLength(0);

			settle(at.footage);
			await (until === "resize" ? resized(at.video) : at.tell("loadedmetadata"));

			expect(rectOf(at)).toEqual({ left: 0, top: 50, width: 400, height: 200 });
		});
	}

	test("draws nothing for a video that is in no stage", async () => {
		const at = rig({}, false);
		const mounted = await env.mount(layer(at.video));

		expect(mounted.container.childNodes).toHaveLength(0);
		expect(env.document.querySelector('[data-slot="viewer-video-draw"]')).toBeNull();
		expect(overlays).toHaveLength(0);
	});
});

describe("keeping up with the video's size", () => {
	const RESIZES = [
		{
			name: "the video's own box changing size",
			change: (footage: Footage) => Object.assign(footage, { clientWidth: 200 }),
			target: (at: Rig) => at.video,
			rect: { left: 0, top: 100, width: 200, height: 100 },
		},
		{
			name: "the stage around it changing size (the box is centred in it, so the picture moves without the box changing)",
			change: (footage: Footage) => Object.assign(footage, { offsetLeft: 100, offsetTop: 30 }),
			target: (at: Rig) => at.stage,
			rect: { left: 100, top: 80, width: 400, height: 200 },
		},
	];
	for (const { name, change, target, rect } of RESIZES) {
		test(`measures again on ${name}`, async () => {
			const at = rig();
			await env.mount(layer(at.video));
			expect(rectOf(at)).toEqual({ left: 0, top: 50, width: 400, height: 200 });

			change(at.footage);
			await resized(target(at));

			expect(rectOf(at)).toEqual(rect);
		});
	}

	test("draws the layer again only when the picture really moved: not for the same size, not for less than a tenth of a pixel", async () => {
		const at = rig();
		await env.mount(layer(at.video));
		const drawn = overlays.length;

		await resized(at.video, at.stage);
		at.footage.clientHeight = 300.04; // the picture's top is 50.02: 50 to a tenth
		await resized(at.video);
		expect(overlays).toHaveLength(drawn);

		at.footage.clientHeight = 300.4;
		await resized(at.video);
		expect(overlays).toHaveLength(drawn + 1);
		expect(rectOf(at).top).toBe(50.2);
	});

	test("follows a different video: its stage, its size, its events", async () => {
		const first = rig();
		const second = rig({ videoWidth: 100, videoHeight: 100, clientWidth: 100, clientHeight: 100, offsetLeft: 7 });
		const mounted = await env.mount(layer(first.video));
		await mounted.render(layer(second.video));

		expect(first.wrapper()).toBeNull();
		expect(rectOf(second)).toEqual({ left: 7, top: 0, width: 100, height: 100 });

		second.footage.clientWidth = 200;
		second.footage.clientHeight = 50;
		await second.tell("loadedmetadata");
		expect(rectOf(second)).toEqual({ left: 82, top: 0, width: 50, height: 50 });
	});

	test("measures from the video's own events in an engine without a ResizeObserver", () =>
		withoutResizeObserver(async () => {
			const at = rig({ videoWidth: 0, videoHeight: 0 });
			await env.mount(layer(at.video));
			expect(at.wrapper()).toBeNull();

			Object.assign(at.footage, { videoWidth: 200, videoHeight: 100 });
			await at.tell("loadedmetadata");

			expect(rectOf(at)).toEqual({ left: 0, top: 50, width: 400, height: 200 });
		}));

	// A capture or a joined recording changes the picture's size mid-stream with the box unmoved: no size the observer
	// watches changes, so the video's own `resize` event is all that says the picture is now another shape.
	const ENGINES = [
		{ name: "an engine with a ResizeObserver", run: (body: () => Promise<void>) => body() },
		{ name: "an engine without one", run: withoutResizeObserver },
	];
	for (const { name, run } of ENGINES) {
		test(`follows the picture changing shape mid-stream inside an unmoved box, on the video's resize event, in ${name}`, () =>
			run(async () => {
				const at = rig({ videoWidth: 1920, videoHeight: 1080, clientWidth: 320, clientHeight: 240, offsetLeft: 10, offsetTop: 4 });
				await env.mount(layer(at.video));
				expect(rectOf(at)).toEqual({ left: 10, top: 34, width: 320, height: 180 }); // bars above and below

				Object.assign(at.footage, { videoWidth: 1080, videoHeight: 1920 });
				await env.act(async () => {});
				expect(rectOf(at)).toEqual({ left: 10, top: 34, width: 320, height: 180 }); // nothing says it yet

				await at.tell("resize");
				expect(rectOf(at)).toEqual({ left: 102.5, top: 4, width: 135, height: 240 }); // bars at the sides

				Object.assign(at.footage, { videoWidth: 1920, videoHeight: 1080 });
				await at.tell("resize");
				expect(rectOf(at)).toEqual({ left: 10, top: 34, width: 320, height: 180 });
			}));
	}

	test("leaves nothing attached to the video, or watching it, once the layer is gone", async () => {
		const at = rig();
		const before = at.listening();
		const mounted = await env.mount(layer(at.video));
		expect(at.listening()).toBeGreaterThan(before);
		expect([...WatchedSizes.all].some(observer => observer.targets.has(at.video))).toBe(true);

		await mounted.unmount();

		expect(at.listening()).toBe(before);
		expect(WatchedSizes.all.filter(observer => observer.targets.size > 0)).toHaveLength(0);
	});

	for (const { name, run } of ENGINES) {
		test(`a video that says resize or loadedmetadata once the layer is gone is not measured, in ${name}`, () =>
			run(async () => {
				const at = rig();
				let measured = 0; // the layer measures by reading the picture's size: a read is a measurement
				Object.defineProperty(at.video, "videoWidth", {
					get: () => {
						measured += 1;
						return at.footage.videoWidth;
					},
					configurable: true,
				});
				const mounted = await env.mount(layer(at.video));
				const onMount = measured;
				expect(onMount).toBeGreaterThan(0);
				await at.tell("resize");
				await at.tell("loadedmetadata");
				expect(measured).toBe(onMount + 2);

				await mounted.unmount();
				const gone = measured;
				await at.tell("resize", "loadedmetadata");

				expect(measured).toBe(gone);
			}));
	}
});

describe("which drawings are on screen", () => {
	test("only the drawings whose frame the playhead is in, as {id, shape, note} and in the order given; plain notes never", async () => {
		const at = rig();
		await env.mount(layer(at.video, { marks: MARKS }));

		const walk: [number, number[]][] = [
			[0, []],
			[2, []], // a plain note's moment: it is not a drawing
			[5.02, [12, 13]], // both on the one frame
			[5.5, []], // past the frame
			[4.5, []], // before it
			[9.03, [15]],
			[8.5, []], // the plain span's time
			[5.02, [12, 13]], // and back
		];
		for (const [seconds, ids] of walk) {
			await at.seek(seconds);
			expect({ seconds, ids: shown() }).toEqual({ seconds, ids });
		}

		await at.seek(5.02);
		expect(overlay().marks).toEqual([
			{ id: 12, shape: BOX, note: "logo too low" },
			{ id: 13, shape: PIN, note: "" },
		]);
	});

	for (const event of ["timeupdate", "seeked"]) {
		test(`follows the playhead when the video says ${event}`, async () => {
			const at = rig();
			await env.mount(layer(at.video, { marks: MARKS }));
			expect(shown()).toEqual([]);

			await at.seek(5.02, event);
			expect(shown()).toEqual([12, 13]);

			await at.seek(7, event);
			expect(shown()).toEqual([]);
		});
	}

	test("asks how long a frame is each time it matters, not once", async () => {
		const at = rig();
		let frame = FRAME;
		await env.mount(layer(at.video, { marks: MARKS, frameSeconds: () => frame }));

		await at.seek(5.5);
		expect(shown()).toEqual([]);

		frame = 1; // a slow film: the frame the drawing was made on lasts a second
		await at.seek(5.6);
		expect(shown()).toEqual([12, 13]);

		frame = FRAME;
		await at.seek(5.7);
		expect(shown()).toEqual([]);
	});

	test("follows the notes: an edit, a new drawing on the frame on screen, a drawing taken away", async () => {
		const at = rig();
		const mounted = await env.mount(layer(at.video, { marks: MARKS }));
		await at.seek(5.02);
		expect(shown()).toEqual([12, 13]);

		const edited = MARKS.map(mark => (mark.id === 12 ? { ...mark, note: "logo lower still", shape: ARROW } : mark));
		await mounted.render(layer(at.video, { marks: edited })); // the same two drawings on screen, one of them rewritten
		expect(overlay().marks).toEqual([
			{ id: 12, shape: ARROW, note: "logo lower still" },
			{ id: 13, shape: PIN, note: "" },
		]);

		const ARROW_ON_FRAME: TimelineMark = { id: 16, at: 5, note: "new", shape: ARROW };
		await mounted.render(layer(at.video, { marks: [...edited.slice(0, 3), ARROW_ON_FRAME, ...edited.slice(3)] }));
		expect(overlay().marks).toEqual([
			{ id: 12, shape: ARROW, note: "logo lower still" },
			{ id: 13, shape: PIN, note: "" },
			{ id: 16, shape: ARROW, note: "new" },
		]);

		await mounted.render(layer(at.video, { marks: MARKS.filter(mark => mark.id !== 13) }));
		expect(shown()).toEqual([12]);
	});

	test("follows a playing video's frames, but only while the pane is on screen", async () => {
		const at = rig();
		const mounted = await env.mount(layer(at.video, { marks: MARKS }));
		expect(env.pendingFrames()).toBe(0); // paused: nothing to follow

		at.footage.paused = false;
		await at.tell("play");
		expect(env.pendingFrames()).toBeGreaterThan(0);

		at.footage.currentTime = 5.02; // no event: only a frame is how the layer finds out
		await env.runFrames();
		expect(shown()).toEqual([12, 13]);
		const drawn = overlays.length;

		at.footage.currentTime = 5.06; // the same frame still: playing does not draw the layer again
		await env.runFrames();
		expect(overlays).toHaveLength(drawn);

		await mounted.render(layer(at.video, { marks: MARKS, live: false }));
		expect(env.pendingFrames()).toBe(0);
		at.footage.currentTime = 9.03;
		await env.runFrames();
		expect(shown()).toEqual([12, 13]); // a hidden pane costs no frames, so it does not move
	});

	test("is drawn again when what the playhead shows changes, and not for each frame within it", async () => {
		const at = rig();
		await env.mount(layer(at.video, { marks: MARKS }));

		let drawn = overlays.length;
		for (const seconds of [0.2, 0.4, 1.5]) await at.seek(seconds, "timeupdate"); // no note passed, no drawing on screen
		expect(overlays).toHaveLength(drawn);

		await at.seek(2.05, "timeupdate"); // the plain note at 2 is passed: one draw, for the number a shape drawn here would wear
		expect(overlays).toHaveLength(++drawn);
		await at.seek(2.5, "timeupdate"); // the frame of a plain note ends: it was never a drawing, so nothing changes
		expect(overlays).toHaveLength(drawn);

		await at.seek(5.02, "timeupdate"); // two drawings arrive: one draw
		expect(overlays).toHaveLength(++drawn);

		for (const seconds of [5.04, 5.06, 5.09]) await at.seek(seconds, "timeupdate"); // the same two, still
		expect(overlays).toHaveLength(drawn);

		await at.seek(5.5, "timeupdate"); // they leave: one draw
		expect(overlays).toHaveLength(++drawn);

		for (const seconds of [5.6, 6.5, 7.9]) await at.seek(seconds, "timeupdate"); // between the drawings, no note passed
		expect(overlays).toHaveLength(drawn);

		await at.seek(8.5, "timeupdate"); // the note at 8 is passed with nothing on screen: one draw, for the number
		expect(overlays).toHaveLength(++drawn);
	});
});

describe("the numbers on the drawings", () => {
	test("a drawing wears its place among ALL the notes, plain ones included, not among those on screen", async () => {
		const at = rig();
		const mounted = await env.mount(layer(at.video, { marks: MARKS }));

		await at.seek(5.02);
		expect([12, 13].map(overlay().ordinalOf as (id: number) => number)).toEqual([2, 3]);
		await at.seek(9.03);
		expect(overlay().ordinalOf?.(15)).toBe(5);

		// A note before them shifts every number after it.
		const earlier: TimelineMark = { id: 10, at: 1, note: "intro" };
		await mounted.render(layer(at.video, { marks: [earlier, ...MARKS] }));
		expect(overlay().ordinalOf?.(15)).toBe(6);
	});

	const DRAFTS = [
		{ name: "before everything", seconds: 0, draft: 1 },
		{ name: "after a plain note", seconds: 3, draft: 2 },
		{ name: "exactly at a note's time: after it, as a note made there would sort", seconds: 5, draft: 4 },
		{ name: "past the last note", seconds: 9.5, draft: 6 },
	];
	for (const { name, seconds, draft } of DRAFTS) {
		test(`a shape being drawn ${name} wears the number it will have: ${draft}`, async () => {
			const at = rig({ currentTime: seconds });
			await env.mount(layer(at.video, { marks: MARKS }));

			expect(overlay().draftOrdinal).toBe(draft);
		});
	}

	test("…and the number follows the playhead as drawings come and go", async () => {
		const at = rig();
		await env.mount(layer(at.video, { marks: MARKS }));

		await at.seek(5.02);
		expect(overlay().draftOrdinal).toBe(4);
		await at.seek(9.03);
		expect(overlay().draftOrdinal).toBe(6);
		await at.seek(0.5);
		expect(overlay().draftOrdinal).toBe(1);
	});

	test("…and also when the playhead passes a plain note where no drawing comes or goes", async () => {
		const at = rig();
		await env.mount(layer(at.video, { marks: MARKS }));
		expect(overlay().draftOrdinal).toBe(1);

		await at.seek(3); // past the note at 2: nothing on screen before, nothing after
		expect(overlay().draftOrdinal).toBe(2);
		await at.seek(9.5); // past the span at 8 and the drawing at 9, in no frame of any
		expect(overlay().draftOrdinal).toBe(6);
	});

	// A shape drawn now is stamped with the start of the frame on screen - the pane decides it (`drawingTime`) - and
	// takes its place among the notes by that stamp, counted in whole milliseconds like every stored time, a tie
	// sorting the new note after. The playhead is at 3.0345 throughout.
	const STAMPS = [
		{ name: "a frame that began 1.5 ms before a moment at the playhead: the shape sorts before it", noteAt: 3.0345, stamp: () => 3.033, draft: 1 },
		{ name: "the playhead itself as the stamp: after the moment at the playhead", noteAt: 3.0345, stamp: (playhead: number) => playhead, draft: 2 },
		{ name: "a stamp that rounds up into the note's millisecond (3.0326 for a note at 3.033): after it", noteAt: 3.033, stamp: () => 3.0326, draft: 2 },
		{ name: "a stamp that rounds down into the note's millisecond (3.0334 for a note at 3.033): after it", noteAt: 3.033, stamp: () => 3.0334, draft: 2 },
		{ name: "a note one millisecond after the stamp (3.0324 for a note at 3.033): not before it", noteAt: 3.033, stamp: () => 3.0324, draft: 1 },
	];
	for (const { name, noteAt, stamp, draft } of STAMPS) {
		test(`a shape being drawn is numbered by its stamp, not the playhead: ${name}: ${draft}`, async () => {
			const at = rig({ currentTime: 3.0345 });
			await env.mount(layer(at.video, { marks: [{ id: 1, at: noteAt, note: "" }], drawingTime: stamp }));

			expect(overlay().draftOrdinal).toBe(draft);
		});
	}

	test("…and the stamp is asked for each playhead: the frame the playhead is in decides, not the playhead", async () => {
		const at = rig();
		const frameStart = (playhead: number): number => Math.floor(playhead * 10) / 10;
		await env.mount(layer(at.video, { marks: [{ id: 1, at: 5.05, note: "" }], drawingTime: frameStart }));

		const walk: [number, number][] = [
			[5.07, 1], // the frame began at 5.0, before the note at 5.05, though the playhead is past it
			[5.12, 2], // the next frame began at 5.1
			[5.07, 1], // and back
		];
		for (const [seconds, draft] of walk) {
			await at.seek(seconds);
			expect({ seconds, draft: overlay().draftOrdinal }).toEqual({ seconds, draft });
		}
	});
});

describe("drawing stops the film", () => {
	const press = (target: Element, type: "pointerdown" | "keydown"): Promise<void> => {
		const event = Object.assign(new (win().Event)(type, { bubbles: true, cancelable: true }), type === "keydown" ? { key: "ArrowRight" } : {});
		return env.act(async () => void target.dispatchEvent(event));
	};
	/** The kit's overlay, which a hand lands on. */
	const surface = (at: Rig): Element => {
		const element = at.wrapper()?.querySelector('[data-stand-in="overlay"]');
		if (element === null || element === undefined) throw new Error("no overlay to press");
		return element;
	};

	test("with a tool armed, each press and each key on the overlay begins the drawing - once", async () => {
		const at = rig();
		let begun = 0;
		await env.mount(layer(at.video, { tool: "box", onBegin: () => void (begun += 1) }));

		await press(surface(at), "pointerdown");
		expect(begun).toBe(1);
		await press(surface(at), "keydown");
		expect(begun).toBe(2);
		await press(surface(at), "pointerdown");
		expect(begun).toBe(3);
	});

	test("with no tool in hand it does not: a click on the picture still just plays and pauses", async () => {
		const at = rig();
		let begun = 0;
		const mounted = await env.mount(layer(at.video, { tool: null, onBegin: () => void (begun += 1) }));

		await press(surface(at), "pointerdown");
		await press(surface(at), "keydown");
		expect(begun).toBe(0);

		await mounted.render(layer(at.video, { tool: "pin", onBegin: () => void (begun += 1) }));
		await press(surface(at), "pointerdown");
		expect(begun).toBe(1);

		await mounted.render(layer(at.video, { tool: null, onBegin: () => void (begun += 1) }));
		await press(surface(at), "keydown");
		expect(begun).toBe(1);
	});
});

describe("what the layer hands the kit's overlay", () => {
	test("the tool, the highlighted note, the label, and the way back out for a finished shape", async () => {
		const at = rig();
		const finished: [MarkShape, number][] = [];
		const onShape = (shape: MarkShape, aspect: number): undefined => void finished.push([shape, aspect]);
		const mounted = await env.mount(layer(at.video, { tool: "arrow", activeId: 13, filename: "take 2.mp4", onShape }));

		expect(overlay()).toMatchObject({ tool: "arrow", activeId: 13, label: "Draw on take 2.mp4" });
		overlay().onShape(BOX, 16 / 9);
		expect(finished).toEqual([[BOX, 16 / 9]]);

		await mounted.render(layer(at.video, { tool: null, activeId: null, filename: "take 3.mp4", onShape }));
		expect(overlay()).toMatchObject({ tool: null, activeId: null, label: "Draw on take 3.mp4" });
	});

	test("a finished shape is answered with the id of the note the pane made of it (the overlay opens that note), or with nothing when none was made", async () => {
		const at = rig();
		const finished: [MarkShape, number][] = [];
		const answers = [42, undefined];
		const onShape = (shape: MarkShape, aspect: number): number | undefined => {
			finished.push([shape, aspect]);
			return answers[finished.length - 1];
		};
		await env.mount(layer(at.video, { tool: "box", onShape }));

		expect(overlay().onShape(BOX, 2)).toBe(42);
		expect(overlay().onShape(PIN, 1)).toBeUndefined();
		expect(finished).toEqual([[BOX, 2], [PIN, 1]]);
	});

	test("what the overlay says about a note reaches the pane under its own name: opening and closing, each typed word, the trash", async () => {
		const at = rig();
		const told: unknown[][] = [];
		await env.mount(
			layer(at.video, {
				onOpen: id => void told.push(["open", id]),
				onNote: (id, note) => void told.push(["note", id, note]),
				onRemove: id => void told.push(["remove", id]),
			}),
		);

		overlay().onOpenChange?.(13);
		overlay().onOpenChange?.(null);
		overlay().onNote?.(12, "logo lower");
		overlay().onRemove?.(15);

		expect(told).toEqual([["open", 13], ["open", null], ["note", 12, "logo lower"], ["remove", 15]]);
	});
});

describe("the note open on a drawing", () => {
	/** A pane that records every time the layer asks it to close the open note, and the layer drawn with the notes on the recording. */
	const pane = (video: HTMLVideoElement) => {
		const asked: (number | null)[] = [];
		const onOpen = (id: number | null): void => void asked.push(id);
		return { asked, show: (over: Partial<Draw.DrawLayerProps> = {}): ReactElement => layer(video, { marks: MARKS, onOpen, ...over }) };
	};

	test("the overlay is given the open note only while its drawing is among those on screen", async () => {
		const at = rig({ currentTime: 5.02 });
		const { show } = pane(at.video);
		const mounted = await env.mount(show({ openId: 12 }));
		expect(overlay().openId).toBe(12); // the very first draw: no frame without it

		await at.seek(5.5);
		expect(overlay().openId).toBeNull();
		await at.seek(5.02);
		expect(overlay().openId).toBe(12);

		await mounted.render(show({ openId: 13 })); // the other drawing of the frame
		expect(overlay().openId).toBe(13);
		await mounted.render(show({ openId: 15 })); // a drawing that is on another frame, while drawings are on screen
		expect(overlay().openId).toBeNull();
	});

	const WAITING = [
		{ name: "it was open when the layer came", from: 15 },
		{ name: "it is opened later, while the film is elsewhere", from: null },
	];
	for (const { name, from } of WAITING) {
		test(`a note on a frame that has not been on screen yet waits for it: not closed on the way, and it appears when the playhead lands there - ${name}`, async () => {
			const at = rig();
			const { asked, show } = pane(at.video);
			const mounted = await env.mount(show({ openId: from }));
			if (from === null) await mounted.render(show({ openId: 15 }));
			expect(overlay().openId).toBeNull();
			expect(asked).toEqual([]);

			await at.seek(5.02); // other drawings are on screen, not that one
			expect(overlay().openId).toBeNull();
			await at.seek(7);
			expect(asked).toEqual([]);

			await at.seek(9.03);
			expect(overlay().openId).toBe(15);
			expect(asked).toEqual([]);
		});
	}

	test("closes the note, once, when the playhead leaves the frame it was shown on - however the film moves or the pane draws after", async () => {
		const at = rig({ currentTime: 5.02 });
		const { asked, show } = pane(at.video);
		const mounted = await env.mount(show({ openId: 12 }));
		await at.seek(5.05); // still its frame
		expect(asked).toEqual([]);

		await at.seek(5.5);
		expect(asked).toEqual([null]);

		await at.seek(7); // the pane has not answered: it stays asked for once
		await at.seek(1);
		await mounted.render(show({ openId: 12, onOpen: id => void asked.push(id) })); // drawn again, with a new callback
		expect(asked).toEqual([null]);
	});

	const COMINGS = [
		{ name: "no note is open", openId: null },
		{ name: "the note that is open is on another frame that has not been on screen", openId: 15 },
	];
	for (const { name, openId } of COMINGS) {
		test(`drawings coming and going close nothing when ${name}`, async () => {
			const at = rig();
			const { asked, show } = pane(at.video);
			await env.mount(show({ openId }));

			for (const seconds of [5.02, 5.5, 4.5, 5.02, 7, 2, 5.02]) await at.seek(seconds);

			expect(asked).toEqual([]);
		});
	}

	test("choosing another drawing's note does not close it for the other drawing's frame: it is closed only after it has been shown", async () => {
		const at = rig({ currentTime: 5.02 });
		const { asked, show } = pane(at.video);
		const mounted = await env.mount(show({ openId: 12 })); // shown

		await mounted.render(show({ openId: 15 })); // chosen from the strip: the pane has yet to seek to it
		expect(overlay().openId).toBeNull();
		expect(asked).toEqual([]);

		await at.seek(9.03);
		expect(overlay().openId).toBe(15);
		expect(asked).toEqual([]);

		await at.seek(9.5);
		expect(asked).toEqual([null]);
	});

	test("a note closed and opened again for a drawing that is off screen waits for its frame like a first one", async () => {
		const at = rig({ currentTime: 5.02 });
		const { asked, show } = pane(at.video);
		const mounted = await env.mount(show({ openId: 12 })); // shown

		await mounted.render(show({ openId: null })); // the human closed it
		await at.seek(7);
		await mounted.render(show({ openId: 12 })); // chosen again from the strip: the pane has yet to seek back
		expect(overlay().openId).toBeNull();
		expect(asked).toEqual([]);

		await at.seek(5.02);
		expect(overlay().openId).toBe(12);
		expect(asked).toEqual([]);
	});
});
