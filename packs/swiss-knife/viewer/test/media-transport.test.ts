// The transport's playhead. While a recording plays the playhead is read every animation frame, 60 to 144 times a
// second; what that may redraw is the clock - not the buttons, the volume, the speed or the scrubber, which paints the
// playhead into its own DOM from the source the transport hands it (when it re-rendered the whole strip, every frame
// rebuilt every glyph and class name in it; when the scrubber took the position as a prop, every frame rebuilt its
// waveform and markers).
//
// Rendered for real (linkedom + react-dom under `act`) over a stand-in media element; animation frames are a queue the
// test runs by hand. Two stand-ins on the way in: the IconButton (every one in the strip counts its own renders, which
// is how "the strip was not drawn again" is seen) and the kit's scrubber (it counts its renders, records the props it
// is drawn with, so a seek can be sent to the transport the way the bar sends it, and listens to the playhead it is
// given the way the real bar does: writing the value into its own node, drawing nothing). The real bar is the kit's
// own test subject; the kit's React sources also need its tsconfig's react paths, which bun cannot follow.
// Bun cannot lift a module mock, so both stay installed for the rest of the run: no other viewer test renders the
// kit's bar or the IconButton.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { TimelineBarProps } from "@dimension/mcp-app-kit/annotate/react";
import { createElement, type ReactNode, useEffect, useRef } from "react";
import type * as Transport from "../app/view/media-transport";
import { installReact, type ReactEnv } from "./media-react";

let env: ReactEnv;
let transport: typeof Transport;
/** How many times any button of the strip has been drawn. */
let buttonRenders = 0;
/** How many times the scrubber has been drawn. */
let barRenders = 0;
/** The props the scrubber was last drawn with. */
let bar: TimelineBarProps | null = null;

beforeAll(async () => {
	env = await installReact();
	// The transport binds both modules when it loads, so the stand-ins are installed first (and it is imported after).
	mock.module("@fraym/ui/elements/icon-button", () => ({
		IconButton: ({ children, variant: _variant, toggled: _toggled, asChild: _asChild, ...rest }: Record<string, unknown>) => {
			buttonRenders += 1;
			return createElement("button", rest, children as ReactNode);
		},
	}));
	mock.module("@dimension/mcp-app-kit/annotate/react", () => ({
		TimelineBar: (props: TimelineBarProps) => {
			bar = props;
			barRenders += 1;
			const node = useRef<HTMLDivElement>(null);
			const { playhead } = props;
			useEffect(() => {
				if (playhead === undefined) return;
				const paint = (): void => node.current?.setAttribute("aria-valuenow", String(playhead.get()));
				paint();
				return playhead.subscribe(paint);
			}, [playhead]);
			return createElement("div", { ref: node, role: "slider", "aria-valuenow": playhead === undefined ? props.position : playhead.get() });
		},
	}));
	transport = await import("../app/view/media-transport");
});
afterEach(async () => {
	await env.cleanup();
	buttonRenders = 0;
	barRenders = 0;
	bar = null;
});
afterAll(() => env.restore());

const NO_RANGES = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;

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
	buffered = NO_RANGES;
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

function transportOf(media: FakeMedia, over: { live?: boolean } = {}) {
	return createElement(transport.MediaTransport, {
		media: asElement(media),
		kind: "video",
		filename: "clip.mp4",
		live: over.live ?? true,
		marks: [],
		activeId: null,
		onSelectMark() {},
		marking: null,
	});
}

const slider = (container: HTMLElement) => container.querySelector('[role="slider"]');
const heard = (container: HTMLElement) => Number(slider(container)?.getAttribute("aria-valuenow"));
/** The elapsed time the clock prints (the part before the total). */
const clock = (container: HTMLElement) => container.querySelector('[data-slot="viewer-time"]')?.firstElementChild?.textContent;

async function startPlaying(media: FakeMedia): Promise<void> {
	await env.act(async () => void media.play());
}

describe("a frame of playback", () => {
	test("moves the scrubber and the clock, and draws nothing else again - not the buttons, and not the scrubber", async () => {
		const media = new FakeMedia();
		const { container } = await env.mount(transportOf(media));
		await startPlaying(media);
		const buttons = buttonRenders;
		const bars = barRenders;
		expect(buttons).toBeGreaterThan(0);
		expect(bars).toBeGreaterThan(0);
		for (let frame = 1; frame <= 90; frame += 1) {
			media.currentTime = frame / 60;
			await env.runFrames();
		}
		expect(heard(container)).toBeCloseTo(1.5, 6);
		expect(clock(container)).toBe("0:01.5");
		expect(buttonRenders).toBe(buttons);
		expect(barRenders).toBe(bars);
	});

	test("hands the scrubber the playhead to listen to, not a position to draw", async () => {
		const media = new FakeMedia();
		media.currentTime = 4;
		await env.mount(transportOf(media));
		expect(bar?.playhead?.get()).toBe(4);
		expect(bar?.position).toBeUndefined();
		media.currentTime = 6.5;
		await env.act(async () => media.tell("seeked"));
		expect(bar?.playhead?.get()).toBe(6.5);
	});

	test("is asked for only while the recording plays and is on screen", async () => {
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

	test("is not needed to keep the playhead right while paused: the element's own events do", async () => {
		const media = new FakeMedia();
		const { container } = await env.mount(transportOf(media));
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
		const { container, render } = await env.mount(transportOf(first));
		await render(transportOf(second));
		expect(heard(container)).toBe(5);
	});
});

describe("a seek from the scrubber", () => {
	test("puts the playhead where the human pointed at once, before the player has finished seeking", async () => {
		const media = new FakeMedia();
		const { container } = await env.mount(transportOf(media));
		await env.act(async () => bar?.onSeek(7));
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
		const { container } = await env.mount(transportOf(media));
		await env.act(async () => bar?.onSeek(asked));
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
