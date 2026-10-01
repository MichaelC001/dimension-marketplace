// How long a recording is, and what a recording that will not say does to a mark. A capture made
// as it was recorded (a browser's MediaRecorder writes WebM this way) reports its length as
// `Infinity`. Reading that as 0 clamped every seek to [0, 0] and stamped every mark 0:00 for a
// moment that was not at 0:00 - the agent was told wrong times with full confidence. These hold
// the length to what the element says, and to what the engine learns when it is asked properly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { keySeek, type LengthSource, type MediaLength, readLength, resolveLength, sameLength, seekTarget } from "../app/view/media-length";
import { installDom, type TestDom } from "./dom";

let dom: TestDom;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.restore());

const ranges = (...ends: number[]): TimeRanges =>
	({ length: ends.length, start: () => 0, end: (index: number) => ends[index] as number }) as unknown as TimeRanges;
const source = (over: Partial<{ duration: number; currentTime: number; seekable: TimeRanges }> = {}): LengthSource => ({
	duration: 90,
	currentTime: 0,
	seekable: ranges(),
	...over,
});

describe("readLength", () => {
	test("a recording that says how long it is: that is its length, and how far it can be played", () => {
		expect(readLength(source({ duration: 90.5 }))).toEqual({ duration: 90.5, reach: 90.5, unbounded: false });
	});

	test("one not loaded yet (NaN), empty, or nonsense has no length and holds only the start", () => {
		for (const duration of [Number.NaN, 0, -3, Number.NEGATIVE_INFINITY]) {
			expect(readLength(source({ duration })), String(duration)).toEqual({ duration: 0, reach: 0, unbounded: false });
		}
	});

	test("one that will not say (Infinity) is unbounded, not zero-long: it has a start and no end", () => {
		const length = readLength(source({ duration: Number.POSITIVE_INFINITY, currentTime: 12, seekable: ranges(40) }));
		expect(length).toEqual({ duration: Number.POSITIVE_INFINITY, reach: 40, unbounded: true });
	});

	test("an unbounded recording can be played as far as the playhead has gone, even where nothing is said to be seekable", () => {
		expect(readLength(source({ duration: Number.POSITIVE_INFINITY, currentTime: 7 })).reach).toBe(7);
		expect(readLength(source({ duration: Number.POSITIVE_INFINITY, currentTime: 70, seekable: ranges(40) })).reach).toBe(70);
	});

	test("what the engine cannot put a number on is not a place the bar can reach", () => {
		// A live stream's seekable range can end at Infinity; a negative or NaN playhead is not a position.
		expect(readLength(source({ duration: Number.POSITIVE_INFINITY, seekable: ranges(Number.POSITIVE_INFINITY) })).reach).toBe(0);
		expect(readLength(source({ duration: Number.POSITIVE_INFINITY, currentTime: Number.NaN, seekable: ranges(20, 55) })).reach).toBe(55);
		expect(readLength(source({ duration: Number.POSITIVE_INFINITY, currentTime: -4 })).reach).toBe(0);
	});

	test("two readings of the same answer are the same state", () => {
		const a = readLength(source({ duration: 60 }));
		expect(sameLength(a, readLength(source({ duration: 60 })))).toBe(true);
		expect(sameLength(a, readLength(source({ duration: 61 })))).toBe(false);
		const open = readLength(source({ duration: Number.POSITIVE_INFINITY, currentTime: 3 }));
		expect(sameLength(open, readLength(source({ duration: Number.POSITIVE_INFINITY, currentTime: 4 })))).toBe(false);
		expect(sameLength(open, readLength(source({ duration: Number.POSITIVE_INFINITY, currentTime: 3 })))).toBe(true);
		expect(sameLength({ duration: 0, reach: 0, unbounded: false }, open)).toBe(false);
	});
});

describe("a seek is never sent to the start for want of a length", () => {
	const unbounded: MediaLength = { duration: Number.POSITIVE_INFINITY, reach: 40, unbounded: true };
	const bounded: MediaLength = { duration: 90, reach: 90, unbounded: false };
	const notLoaded: MediaLength = { duration: 0, reach: 0, unbounded: false };

	test("inside a recording that has a length, a time is kept inside it", () => {
		expect(seekTarget(30, bounded)).toBe(30);
		expect(seekTarget(500, bounded)).toBe(90);
		expect(seekTarget(-5, bounded)).toBe(0);
	});

	test("in a recording with no end a mark at 5:00 is gone to at 5:00 - not at 0:00, and not at the 0:40 known so far", () => {
		expect(seekTarget(300, unbounded)).toBe(300);
		expect(seekTarget(0.4, unbounded)).toBe(0.4);
		expect(seekTarget(-5, unbounded)).toBe(0);
	});

	test("one not loaded yet holds the start: there is nowhere else to be", () => {
		expect(seekTarget(30, notLoaded)).toBe(0);
	});

	test("the keys: arrows move five seconds and Shift one; Home is the start; End is the end - or, with none, as far as it plays", () => {
		expect(keySeek("ArrowRight", false, 10, bounded)).toBe(15);
		expect(keySeek("ArrowLeft", true, 10, bounded)).toBe(9);
		expect(keySeek("ArrowRight", false, 88, bounded)).toBe(90);
		expect(keySeek("Home", false, 50, bounded)).toBe(0);
		expect(keySeek("End", false, 50, bounded)).toBe(90);
		expect(keySeek("ArrowRight", false, 300, unbounded)).toBe(305);
		expect(keySeek("ArrowLeft", false, 2, unbounded)).toBe(0);
		expect(keySeek("Home", false, 300, unbounded)).toBe(0);
		expect(keySeek("End", false, 300, unbounded)).toBe(40);
		expect(keySeek("a", false, 300, unbounded)).toBeNull();
	});
});

/** A media element that records every playhead it is told to go to, and answers a seek the way a test says its engine does. */
class StubMedia extends EventTarget {
	duration = Number.POSITIVE_INFINITY;
	seekable = ranges();
	readonly seeks: number[] = [];
	onSeek: (to: number) => void = () => undefined;
	#at = 0;
	get currentTime(): number {
		return this.#at;
	}
	set currentTime(to: number) {
		this.#at = to;
		this.seeks.push(to);
		this.onSeek(to);
	}
	say(type: string): void {
		this.dispatchEvent(new Event(type));
	}
}
const asMedia = (stub: StubMedia): HTMLMediaElement => stub as unknown as HTMLMediaElement;

describe("resolveLength asks a recording that will not say how long it is", () => {
	test("the engine learns the length on the way to the end: it is known, and the playhead is back at the start", async () => {
		const media = new StubMedia();
		media.onSeek = to => {
			if (to === 0) return;
			media.duration = 125.4;
			media.say("durationchange");
			media.say("seeked");
		};
		await resolveLength(asMedia(media), { timeoutMs: 5000 });
		expect(media.seeks).toEqual([Number.MAX_SAFE_INTEGER, 0]);
		expect(readLength(media as unknown as LengthSource)).toEqual({ duration: 125.4, reach: 125.4, unbounded: false });
	});

	test("the seek lands and the engine still does not say: it is given up on at once, the playhead is back at the start, and the recording is unbounded", async () => {
		const media = new StubMedia();
		media.seekable = ranges(33);
		media.onSeek = to => {
			if (to !== 0) media.say("seeked");
		};
		await resolveLength(asMedia(media), { timeoutMs: 5000 });
		expect(media.seeks).toEqual([Number.MAX_SAFE_INTEGER, 0]);
		expect(readLength(media as unknown as LengthSource).unbounded).toBe(true);
	});

	test("an engine that says nothing at all is waited for only so long", async () => {
		const media = new StubMedia();
		const started = performance.now();
		await resolveLength(asMedia(media), { timeoutMs: 20 });
		expect(performance.now() - started).toBeLessThan(2000);
		expect(media.seeks).toEqual([Number.MAX_SAFE_INTEGER, 0]);
	});

	test("a recording that says how long it is is not touched", async () => {
		const media = new StubMedia();
		media.duration = 90;
		await resolveLength(asMedia(media));
		expect(media.seeks).toEqual([]);
	});

	test("a pane that goes away stops the wait at once and still puts the playhead back", async () => {
		const media = new StubMedia();
		const controller = new AbortController();
		const pending = resolveLength(asMedia(media), { timeoutMs: 60_000, signal: controller.signal });
		controller.abort(new Error("the pane went away"));
		await expect(pending).rejects.toThrow("the pane went away");
		expect(media.seeks).toEqual([Number.MAX_SAFE_INTEGER, 0]);
	});

	test("a pane already gone never moves the playhead", async () => {
		const media = new StubMedia();
		const controller = new AbortController();
		controller.abort(new Error("already gone"));
		await expect(resolveLength(asMedia(media), { signal: controller.signal })).rejects.toThrow("already gone");
		expect(media.seeks).toEqual([]);
	});

	test("it is settled once: a late event after the answer does not seek again", async () => {
		const media = new StubMedia();
		media.onSeek = to => {
			if (to !== 0) media.say("seeked");
		};
		await resolveLength(asMedia(media), { timeoutMs: 5000 });
		media.say("seeked");
		media.say("durationchange");
		expect(media.seeks).toEqual([Number.MAX_SAFE_INTEGER, 0]);
	});
});
