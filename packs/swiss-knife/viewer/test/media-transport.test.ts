// The media transport: what plays a recording, and the lane under its buttons (a video's filmstrip, a sound's waveform -
// the kit's `FilmLane` and `WaveLane`), which is where the human also scrubs and, while the marking layer is up, notes.
//
// While a recording plays the playhead is read every animation frame, 60 to 144 times a second; what that may redraw is
// the clock - not the buttons, the volume, the speed or the lane, which paints the playhead into its own DOM from the
// source the transport hands it (when it re-rendered the whole strip, every frame rebuilt every glyph and class name in
// it; when the lane took the position as a prop, every frame rebuilt its waveform, cells and markers).
//
// Rendered for real (linkedom + react-dom under `act`) over a stand-in media element; animation frames are a queue the
// test runs by hand. Two stand-ins on the way in: the IconButton (every one in the strip counts its own renders, which
// is how "the strip was not drawn again" is seen) and the kit's two lanes (each counts its renders, records the props it
// is drawn with, so a seek, a note or a stretch can be sent to the transport the way the lane sends it, and listens to
// the playhead it is given the way the real lane does: writing the value into its own node, drawing nothing). The real
// lanes are the kit's own test subjects. Bun cannot lift a module mock, so both stay installed for the rest of the run:
// the lanes' stand-in sits over the REAL kit module (spread under them), so a test that loads the kit's other React
// parts after this file still finds them; and no other viewer test renders the kit's lanes or the IconButton.
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { type FilmFrame, formatTimecode, type TimelineMark } from "@dimension/mcp-app-kit/annotate";
import type { FilmLaneProps, NoteCloseReason, WaveLaneProps } from "@dimension/mcp-app-kit/annotate/react";
import * as react from "react";
import { createElement, type ReactNode, useEffect, useRef } from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import { UNBOUNDED_SENTENCE } from "../app/view/media-length";
import type * as Transport from "../app/view/media-transport";
import { installReact, type ReactEnv } from "./media-react";

const KIT = "@dimension/mcp-app-kit/annotate/react";

// The kit's tsconfig maps `react` and its JSX runtimes onto their type declarations, which bun cannot load as code, and
// bun applies that map to the kit's sources wherever they are imported from. The map's targets are mocked with the real
// modules (the same instances this file uses, so there is one React): that is what lets the real kit module be read
// here, to stand under the lanes' stand-ins.
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
type LaneProps = FilmLaneProps | WaveLaneProps;

let env: ReactEnv;
let transport: typeof Transport;
/** How many times any button of the strip has been drawn. */
let buttonRenders = 0;
/** How many times either lane has been drawn. */
let laneRenders = 0;
/** The props the film lane was last drawn with. */
let film: FilmLaneProps | null = null;
/** The props the wave lane was last drawn with. */
let wave: WaveLaneProps | null = null;

/** What both lanes' stand-ins are: a slider that writes the playhead's value into its own node, and never draws for it. */
function useStandIn(slot: string, props: LaneProps): ReactNode {
	laneRenders += 1;
	const node = useRef<HTMLDivElement>(null);
	const { playhead } = props;
	useEffect(() => {
		const paint = (): void => node.current?.setAttribute("aria-valuenow", String(playhead.get()));
		paint();
		return playhead.subscribe(paint);
	}, [playhead]);
	return createElement("div", { ref: node, role: "slider", "data-slot": slot, "aria-valuenow": playhead.get() });
}

beforeAll(async () => {
	env = await installReact();
	// Dynamic by necessity: the kit binds React when it loads, and react-dom (loaded by `installReact`) decides once, then, whether there is a DOM.
	const realKit = await import(KIT);
	// The transport binds these modules when it loads, so the stand-ins are installed first (and it is imported after).
	mock.module("@fraym/ui/elements/icon-button", () => ({
		IconButton: ({ children, variant: _variant, toggled: _toggled, asChild: _asChild, ...rest }: Record<string, unknown>) => {
			buttonRenders += 1;
			return createElement("button", rest, children as ReactNode);
		},
	}));
	mock.module(KIT, () => ({
		...realKit,
		FilmLane: (props: FilmLaneProps) => {
			film = props;
			return useStandIn("film-lane", props);
		},
		WaveLane: (props: WaveLaneProps) => {
			wave = props;
			return useStandIn("wave-lane", props);
		},
	}));
	transport = await import("../app/view/media-transport");
});
afterEach(async () => {
	await env.cleanup();
	buttonRenders = 0;
	laneRenders = 0;
	film = null;
	wave = null;
});
afterAll(() => env.restore());

const NO_RANGES = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;
/** What a player that can seek as far as `end` says. */
const rangesEndingAt = (end: number): TimeRanges => ({ length: 1, start: () => 0, end: () => end }) as unknown as TimeRanges;

/** A player: what the transport reads and writes, and the events it listens to. Like a browser's, assigning a time that is not a number throws. */
class FakeMedia extends EventTarget {
	paused = true;
	ended = false;
	playbackRate = 1;
	volume = 1;
	muted = false;
	error: MediaError | null = null;
	duration = 12;
	seekable = NO_RANGES;
	#time = 0;
	get currentTime(): number {
		return this.#time;
	}
	set currentTime(value: number) {
		if (!Number.isFinite(value)) throw new TypeError("The provided double value is non-finite.");
		this.#time = value;
	}
	tell(type: string): void {
		this.dispatchEvent(new Event(type));
	}
	play(): Promise<void> {
		this.paused = false;
		this.tell("play");
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
		this.tell("pause");
	}
}

// The stand-in has the parts of an HTMLMediaElement the transport touches and no others.
const asElement = (media: FakeMedia): HTMLMediaElement => media as unknown as HTMLMediaElement;

interface Over {
	readonly kind?: Kind;
	readonly live?: boolean;
	readonly filename?: string;
	readonly marks?: readonly TimelineMark[];
	readonly activeId?: number | null;
	readonly onSelectMark?: (id: number) => void;
	readonly onNote?: (id: number, note: string) => void;
	readonly waveform?: ArrayLike<number>;
	readonly film?: Transport.TransportFilm;
	readonly marking?: Transport.TransportMarking | null;
	readonly openId?: number | null;
	readonly onClose?: (reason: NoteCloseReason) => void;
	readonly onRemove?: (id: number) => void;
}

function transportOf(media: FakeMedia, over: Over = {}) {
	const { kind = "video", live = true, filename = "clip.mp4", marks = [], activeId = null, onSelectMark = () => {}, onNote = () => {}, openId = null, onClose = () => {}, onRemove = () => {}, marking = null } = over;
	return createElement(transport.MediaTransport, {
		media: asElement(media),
		kind,
		filename,
		live,
		marks,
		activeId,
		onSelectMark,
		onNote,
		openId,
		onClose,
		onRemove,
		marking,
		...(over.waveform === undefined ? {} : { waveform: over.waveform }),
		...(over.film === undefined ? {} : { film: over.film }),
	});
}

/** A marking layer that records what the lane sends it. */
function markingOf(over: { full?: boolean; inPoint?: number | null; hint?: string | null } = {}) {
	const { full = false, inPoint = null, hint = null } = over;
	const spans: [number, number][] = [];
	const comments: number[] = [];
	const marking: Transport.TransportMarking = {
		full,
		inPoint,
		hint,
		onSpan: (from, to) => void spans.push([from, to]),
		onComment: at => void comments.push(at),
	};
	return { marking, spans, comments };
}

/** The pane's side of the notes: every callback leaves its own entry in one log, so one wired to another, dropped, or handed the wrong argument shows in what the log says. */
function noteHost() {
	const log: string[] = [];
	const over = {
		onSelectMark: (id: number) => void log.push(`select ${id}`),
		onNote: (id: number, note: string) => void log.push(`note ${id} ${note}`),
		onClose: (reason: NoteCloseReason) => void log.push(`close ${reason}`),
		onRemove: (id: number) => void log.push(`remove ${id}`),
	};
	return { log, over };
}

/** The props the lane of this kind was last drawn with. */
function laneOf(kind: Kind): LaneProps {
	const props = kind === "video" ? film : wave;
	if (props === null) throw new Error(`no ${kind} lane was drawn`);
	return props;
}

function waveLane(): WaveLaneProps {
	if (wave === null) throw new Error("no wave lane was drawn");
	return wave;
}

function filmLane(): FilmLaneProps {
	if (film === null) throw new Error("no film lane was drawn");
	return film;
}

const slider = (container: HTMLElement) => container.querySelector('[role="slider"]');
const heard = (container: HTMLElement) => Number(slider(container)?.getAttribute("aria-valuenow"));
/** The elapsed time the clock prints (the part before the total). */
const clock = (container: HTMLElement) => container.querySelector('[data-slot="viewer-time"]')?.firstElementChild?.textContent;
const hintOf = (container: HTMLElement) => container.querySelector('[data-slot="viewer-transport-hint"]');
const buttonNamed = (container: HTMLElement, name: RegExp): Element | null =>
	Array.from(container.querySelectorAll("button")).find(button => name.test(button.getAttribute("aria-label") ?? "")) ?? null;

const win = (): Window & typeof globalThis => env.document.defaultView as Window & typeof globalThis;

function click(element: Element | null): Promise<void> {
	if (element === null) throw new Error("nothing to click");
	return env.act(async () => void element.dispatchEvent(new (win().Event)("click", { bubbles: true, cancelable: true })));
}

async function startPlaying(media: FakeMedia): Promise<void> {
	await env.act(async () => void media.play());
}

describe("the lane under the buttons", () => {
	test.each(KINDS)("a %s transport mounts exactly its own lane and no second scrubber", async kind => {
		const { container } = await env.mount(transportOf(new FakeMedia(), { kind }));
		const slot = (name: string) => container.querySelectorAll(`[data-slot="${name}"]`).length;
		expect({ film: slot("film-lane"), wave: slot("wave-lane") }).toEqual(kind === "video" ? { film: 1, wave: 0 } : { film: 0, wave: 1 });
		// Whatever else could be scrubbed with would be a second slider.
		expect(container.querySelectorAll('[role="slider"]')).toHaveLength(1);
	});

	test.each(KINDS)("the %s lane is given the notes, the active one, the way to select one, and the filename for its name", async kind => {
		const first: TimelineMark[] = [
			{ id: 1, at: 2, note: "" },
			{ id: 2, at: 5, to: 7, note: "x" },
		];
		const selected: number[] = [];
		const { render } = await env.mount(transportOf(new FakeMedia(), { kind, filename: "take two.mp4", marks: first, activeId: 2, onSelectMark: id => void selected.push(id) }));
		expect(laneOf(kind).marks).toBe(first);
		expect(laneOf(kind).activeId).toBe(2);
		expect(laneOf(kind).label).toBe("Position in take two.mp4");
		laneOf(kind).onSelectMark(1);
		expect(selected).toEqual([1]);
		// The marks change as the human makes them: the lane is not left with the ones it was first drawn with.
		const second: TimelineMark[] = [...first, { id: 3, at: 9, note: "" }];
		await render(transportOf(new FakeMedia(), { kind, filename: "take two.mp4", marks: second, activeId: null }));
		expect(laneOf(kind).marks).toBe(second);
		expect(laneOf(kind).activeId).toBeNull();
	});

	describe.each(KINDS)("the %s lane's length", kind => {
		test.each([
			["the length the player reports", 12, null, 12],
			["a recording that does not say how long it is: as far as it can be played so far, never an endless length", Number.POSITIVE_INFINITY, 40, 40],
			["a recording not loaded yet: no length at all, which the lane takes as off", Number.NaN, null, 0],
		] as const)("is %s", async (_what, said, seekableTo, expected) => {
			const media = new FakeMedia();
			media.duration = said;
			if (seekableTo !== null) media.seekable = rangesEndingAt(seekableTo);
			await env.mount(transportOf(media, { kind }));
			expect(laneOf(kind).duration).toBe(expected);
		});
	});

	test.each(KINDS)("the %s lane's length, and how far a seek may go, follow the player as it learns the length", async kind => {
		const media = new FakeMedia();
		media.duration = Number.NaN;
		await env.mount(transportOf(media, { kind }));
		expect(laneOf(kind).duration).toBe(0);
		media.duration = 30;
		await env.act(async () => media.tell("durationchange"));
		expect(laneOf(kind).duration).toBe(30);
		await env.act(async () => laneOf(kind).onSeek(20));
		expect(media.currentTime).toBe(20);
		await env.act(async () => laneOf(kind).onSeek(99));
		expect(media.currentTime).toBe(30);
	});
});

describe("a video's film", () => {
	test("the lane is given the thumbnails and the cells from the film, and its width is reported to the film's owner", async () => {
		const frames: FilmFrame[] = [
			{ at: 0, src: "a" },
			{ at: 6, src: "b" },
		];
		const widths: number[] = [];
		const { render } = await env.mount(transportOf(new FakeMedia(), { film: { frames, failed: false, slots: 5, onSlots: count => void widths.push(count) } }));
		expect(filmLane().frames).toBe(frames);
		expect(filmLane().slots).toBe(5);
		filmLane().onSlots?.(4);
		expect(widths).toEqual([4]);
		// More thumbnails arrive, and the lane's width changed: the lane is drawn with the film as it is now.
		const more: FilmFrame[] = [...frames, { at: 9, src: "c" }];
		await render(transportOf(new FakeMedia(), { film: { frames: more, failed: false, slots: 3, onSlots: count => void widths.push(count) } }));
		expect(filmLane().frames).toBe(more);
		expect(filmLane().slots).toBe(3);
	});

	test("before any film exists the lane is still one it can draw: a list of thumbnails (none yet), at least one cell, and nobody to tell its width to", async () => {
		await env.mount(transportOf(new FakeMedia()));
		expect(filmLane().frames).toEqual([]);
		expect(filmLane().slots).toBeGreaterThanOrEqual(1);
		expect(filmLane().onSlots).toBeUndefined();
	});

	test("the lane is told no more thumbnails are coming (its empty cells stop waiting) only while the film says so", async () => {
		const coming: Transport.TransportFilm = { frames: [], failed: false, slots: 4, onSlots: () => {} };
		// A lane that is not told is the same as one told false: it waits.
		const { render } = await env.mount(transportOf(new FakeMedia(), { film: coming }));
		expect(filmLane().failed ?? false).toBe(false);
		// The video would not give its thumbnails: the lane that was waiting is drawn again, calm.
		await render(transportOf(new FakeMedia(), { film: { ...coming, failed: true } }));
		expect(filmLane().failed ?? false).toBe(true);
		// A video that has no film yet does not inherit the failure.
		await render(transportOf(new FakeMedia()));
		expect(filmLane().failed ?? false).toBe(false);
	});
});

describe("a sound's waveform and notes", () => {
	test("the lane draws the waveform it is given, or a plain track (null) when there is none", async () => {
		const peaks = Float32Array.of(0.1, 0.9, 0.4);
		const { render } = await env.mount(transportOf(new FakeMedia(), { kind: "audio", waveform: peaks }));
		expect(waveLane().peaks).toBe(peaks);
		await render(transportOf(new FakeMedia(), { kind: "audio" }));
		expect(waveLane().peaks).toBeNull();
	});

	test.each([
		["a sound's lane is", "audio", true],
		["a video's lane is never", "video", false],
	] as const)("%s given the marking layer's way to comment at a time (the pane adds the mark and opens its note)", async (_who, kind, offered) => {
		const marked = markingOf();
		await env.mount(transportOf(new FakeMedia(), { kind, marking: marked.marking }));
		// A video's notes come from its drawings and stretches; the film lane takes no such prop.
		const comment = Reflect.get(laneOf(kind), "onComment") as ((at: number) => void) | undefined;
		expect(comment !== undefined).toBe(offered);
		comment?.(3.5);
		expect(marked.comments).toEqual(offered ? [3.5] : []);
	});

	test("a sound with no marking layer has no way to add or stretch a note, nor a keyboard in-point to draw", async () => {
		await env.mount(transportOf(new FakeMedia(), { kind: "audio" }));
		expect(waveLane().onComment).toBeUndefined();
		expect(waveLane().onSpan).toBeUndefined();
		expect(waveLane().inPoint).toBeUndefined();
	});
});

describe("the marking layer on a lane", () => {
	test.each(KINDS)("the %s lane's stretches and keyboard in-point are the marking layer's while it is up, and go when it does", async kind => {
		const media = new FakeMedia();
		const { render } = await env.mount(transportOf(media, { kind }));
		expect(laneOf(kind).onSpan).toBeUndefined();
		expect(laneOf(kind).inPoint ?? null).toBeNull();

		const marked = markingOf({ inPoint: 3.5 });
		await render(transportOf(media, { kind, marking: marked.marking }));
		laneOf(kind).onSpan?.(2, 5);
		expect(marked.spans).toEqual([[2, 5]]);
		expect(laneOf(kind).inPoint).toBe(3.5);

		await render(transportOf(media, { kind, marking: markingOf({ inPoint: null }).marking }));
		expect(laneOf(kind).inPoint).toBeNull();

		await render(transportOf(media, { kind }));
		expect(laneOf(kind).onSpan).toBeUndefined();
		expect(laneOf(kind).inPoint ?? null).toBeNull();
	});
});

describe.each(KINDS)("the %s lane's notes", kind => {
	test.each([
		["up", true],
		["down (a player that failed): the notes it already has can still be opened, edited and taken out, only none can be made", false],
	] as const)("with the marking layer %s, each note callback the lane calls reaches the pane's own, with the lane's id, words or reason", async (_state, up) => {
		const host = noteHost();
		await env.mount(transportOf(new FakeMedia(), { kind, marks: [{ id: 4, at: 2, note: "" }], openId: 4, marking: up ? markingOf().marking : null, ...host.over }));
		const lane = laneOf(kind);
		lane.onSelectMark(3);
		lane.onNote(4, "the drums come in late");
		lane.onClose("save");
		lane.onClose("cancel");
		lane.onClose("outside");
		lane.onRemove(5);
		expect(host.log).toEqual(["select 3", "note 4 the drums come in late", "close save", "close cancel", "close outside", "remove 5"]);
	});

	test("the note open on the lane is the pane's open one - not the selected one - and follows it as it opens, moves to another and closes", async () => {
		const media = new FakeMedia();
		const marks: TimelineMark[] = [
			{ id: 1, at: 2, note: "a" },
			{ id: 2, at: 5, note: "b" },
		];
		const { render } = await env.mount(transportOf(media, { kind, marks, activeId: 1, openId: 2 }));
		expect(laneOf(kind).openId).toBe(2);
		await render(transportOf(media, { kind, marks, activeId: 1, openId: 1 }));
		expect(laneOf(kind).openId).toBe(1);
		await render(transportOf(media, { kind, marks, activeId: 1, openId: null }));
		expect(laneOf(kind).openId).toBeNull();
	});
});

describe("what the strip offers", () => {
	test.each([
		["a video transport without", "video", false],
		["a video transport with", "video", true],
		["an audio transport without", "audio", false],
		["an audio transport with", "audio", true],
	] as const)("%s the marking layer has no button for a mark, a moment or a stretch: those are the pane toolbar's", async (_what, kind, marked) => {
		const { container } = await env.mount(transportOf(new FakeMedia(), { kind, marking: marked ? markingOf({ hint: "a line" }).marking : null }));
		const names = Array.from(container.querySelectorAll("button")).map(button => `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`);
		// The strip is not empty (it still plays), and nothing in it makes a note.
		expect(names.some(name => /^Play/.test(name))).toBe(true);
		expect(names.filter(name => /mark|moment|stretch/i.test(name))).toEqual([]);
	});

	test("the play button plays a paused recording and pauses a playing one, and says which it will do", async () => {
		const media = new FakeMedia();
		const { container } = await env.mount(transportOf(media));
		await click(buttonNamed(container, /^Play$/));
		expect(media.paused).toBe(false);
		expect(buttonNamed(container, /^Pause$/)).not.toBeNull();
		await click(buttonNamed(container, /^Pause$/));
		expect(media.paused).toBe(true);
		expect(buttonNamed(container, /^Play$/)).not.toBeNull();
	});

	test.each([
		[1, 1.25],
		[0.5, 0.75],
		[2, 0.5],
	])("the speed button steps %f to %f, and comes round to the slowest after the fastest", async (from, to) => {
		const media = new FakeMedia();
		media.playbackRate = from;
		const { container } = await env.mount(transportOf(media));
		await click(buttonNamed(container, /^Speed/));
		expect(media.playbackRate).toBe(to);
	});

	test.each([
		["a sound that is playing is muted", 1, false, { muted: true, volume: 1 }],
		["a muted one is unmuted at the volume it had", 1, true, { muted: false, volume: 1 }],
		["one at volume 0 is already silent: pressing is hearing it again, at half volume", 0, false, { muted: false, volume: 0.5 }],
	] as const)("the mute button: %s", async (_what, volume, muted, after) => {
		const media = new FakeMedia();
		media.volume = volume;
		media.muted = muted;
		const { container } = await env.mount(transportOf(media));
		await click(buttonNamed(container, /^(Un)?[Mm]ute$/));
		expect({ muted: media.muted, volume: media.volume }).toEqual(after);
	});

	test.each([
		["a recording that says its length: elapsed over the total", {}, null, `${formatTimecode(0)} / ${formatTimecode(12)}`, null],
		["one that does not say how long it is: the elapsed time alone, and no sentence while nobody is marking", { unbounded: true }, null, formatTimecode(0), null],
		["...and one sentence about it while they are", { unbounded: true }, markingOf().marking, formatTimecode(0), UNBOUNDED_SENTENCE],
		["a recording that says its length: no sentence even while marking", {}, markingOf().marking, `${formatTimecode(0)} / ${formatTimecode(12)}`, null],
	] as const)("the clock of %s", async (_what, how, marking, text, sentence) => {
		const media = new FakeMedia();
		if ("unbounded" in how) {
			media.duration = Number.POSITIVE_INFINITY;
			media.seekable = rangesEndingAt(40);
		}
		const { container } = await env.mount(transportOf(media, { marking }));
		expect(container.querySelector('[data-slot="viewer-time"]')?.textContent).toBe(text);
		expect(container.querySelector('[data-slot="viewer-transport-note"]')?.textContent ?? null).toBe(sentence);
	});
});

describe("the hint over the picture", () => {
	test("is not there at all while the marking layer is down", async () => {
		const { container } = await env.mount(transportOf(new FakeMedia()));
		expect(hintOf(container)).toBeNull();
	});

	test.each([
		["with nothing to say: in the tree for a screen reader, drawn nowhere", false, null, false],
		["with a line of help: floats over the picture's foot", false, "Pick a time first.", true],
		["with the all-notes-used sentence while there are still notes to make: floats, it is not the toolbar's to say", false, "SENTENCE", true],
		["with the all-notes-used sentence while they are all used: stays in the toolbar, here only for a screen reader", true, "SENTENCE", false],
		["with another line of help while they are all used: floats", true, "Pick a time first.", true],
		["with nothing to say while they are all used: drawn nowhere", true, null, false],
	] as const)("%s", async (_what, full, said, floats) => {
		// The constant is the transport's own: what the pane toolbar says in its place.
		const hint = said === "SENTENCE" ? transport.FULL_SENTENCE : said;
		const { container } = await env.mount(transportOf(new FakeMedia(), { marking: markingOf({ full, hint }).marking }));
		const node = hintOf(container);
		expect(node?.getAttribute("role")).toBe("status");
		expect(node?.classList.contains("sr-only")).toBe(!floats);
		expect(node?.textContent).toBe(hint ?? "");
	});
});

describe.each(KINDS)("the %s transport's playhead", kind => {
	test("a frame of playback moves the lane and the clock, and draws nothing else again - not the buttons, and not the lane", async () => {
		const media = new FakeMedia();
		const { container } = await env.mount(transportOf(media, { kind }));
		await startPlaying(media);
		const buttons = buttonRenders;
		const lanes = laneRenders;
		expect(buttons).toBeGreaterThan(0);
		expect(lanes).toBeGreaterThan(0);
		for (let frame = 1; frame <= 90; frame += 1) {
			media.currentTime = frame / 60;
			await env.runFrames();
		}
		expect(heard(container)).toBeCloseTo(1.5, 6);
		expect(laneOf(kind).playhead.get()).toBeCloseTo(1.5, 6);
		expect(clock(container)).toBe("0:01.5");
		expect(buttonRenders).toBe(buttons);
		expect(laneRenders).toBe(lanes);
	});

	test("the lane listens to the one playhead the clock reads, not a position to draw", async () => {
		const media = new FakeMedia();
		media.currentTime = 4;
		const { container } = await env.mount(transportOf(media, { kind }));
		expect(laneOf(kind).playhead.get()).toBe(4);
		media.currentTime = 6.5;
		await env.act(async () => media.tell("seeked"));
		expect(laneOf(kind).playhead.get()).toBe(6.5);
		expect(clock(container)).toBe("0:06.5");
	});

	test("is not needed to keep the playhead right while paused: the element's own events do", async () => {
		const media = new FakeMedia();
		const { container } = await env.mount(transportOf(media, { kind }));
		media.currentTime = 3;
		await env.act(async () => media.tell("seeking"));
		expect(heard(container)).toBe(3);
		expect(clock(container)).toBe("0:03.0");
		media.currentTime = 4.5;
		await env.act(async () => media.tell("seeked"));
		expect(heard(container)).toBe(4.5);
	});

	test("follows a different element from where it is (the renderer re-mounted)", async () => {
		const first = new FakeMedia();
		const second = new FakeMedia();
		second.currentTime = 5;
		const { container, render } = await env.mount(transportOf(first, { kind }));
		await render(transportOf(second, { kind }));
		expect(heard(container)).toBe(5);
	});
});

describe("the playhead's frames", () => {
	test("are asked for only while the recording plays and is on screen", async () => {
		const media = new FakeMedia();
		const { render } = await env.mount(transportOf(media));
		expect(env.pendingFrames()).toBe(0);
		await startPlaying(media);
		expect(env.pendingFrames()).toBe(1);
		await render(transportOf(media, { live: false }));
		expect(env.pendingFrames()).toBe(0);
		await render(transportOf(media, { live: true }));
		expect(env.pendingFrames()).toBe(1);
		await env.act(async () => media.pause());
		expect(env.pendingFrames()).toBe(0);
	});
});

describe.each(KINDS)("a seek from the %s lane", kind => {
	test("puts the playhead where the human pointed at once, before the player has finished seeking", async () => {
		const media = new FakeMedia();
		const { container } = await env.mount(transportOf(media, { kind }));
		await env.act(async () => laneOf(kind).onSeek(7));
		expect(media.currentTime).toBe(7);
		expect(heard(container)).toBe(7);
		expect(clock(container)).toBe("0:07.0");
	});

	test.each([
		["past the end is the end", 500, 12],
		["before the start is the start", -5, 0],
		["a time that is not a number is the start: assigned to the player it would throw", Number.NaN, 0],
	] as const)("%s", async (_what, asked, landed) => {
		const media = new FakeMedia();
		media.currentTime = 9;
		const { container } = await env.mount(transportOf(media, { kind }));
		await env.act(async () => laneOf(kind).onSeek(asked));
		expect(media.currentTime).toBe(landed);
		expect(heard(container)).toBe(landed);
	});
});

describe("the playhead", () => {
	test("tells its watchers when it moves, and not when it is put where it already is", () => {
		const playhead = transport.createPlayhead(2);
		let told = 0;
		const stop = playhead.subscribe(() => {
			told += 1;
		});
		playhead.set(2);
		expect(told).toBe(0);
		playhead.set(2.5);
		expect(told).toBe(1);
		expect(playhead.get()).toBe(2.5);
		stop();
		playhead.set(9);
		expect(told).toBe(1);
		expect(playhead.get()).toBe(9);
	});
});
