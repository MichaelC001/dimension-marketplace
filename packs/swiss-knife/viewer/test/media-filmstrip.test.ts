// The film lane's pictures: what is kept for a file, and when the grabber is asked for one.
//
// Each picture is a seek and an encode, so the filmstrip is held to what that costs: nothing before the lane is on
// screen, one at a time, dropped the moment the lane stops wanting them, never taken twice for the same file, and
// never asked of a video that has shown it will not give one (or is too big to decode a second time).
// FilmstripCache: tested alone, with small bounds so the eviction order is visible. useFilmstrip: rendered for real
// (linkedom + react-dom under `act`); the grabber is a stand-in whose every picture the test delivers, or fails, by hand.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { type FilmFrame, filmSlotTimes, MAX_FILM_SLOTS } from "@dimension/mcp-app-kit/annotate";
import { createElement, type ReactElement } from "react";
import { FILMSTRIP_FILES, FILMSTRIP_FRAMES_PER_FILE, FilmstripCache, type FilmstripOptions, filmable, type ThumbnailSource, useFilmstrip } from "../app/view/media-filmstrip";
import { FrameGrabber, type Thumbnail } from "../app/view/media-frame";
import { installReact, type ReactEnv } from "./media-react";

let env: ReactEnv;
beforeAll(async () => {
	env = await installReact();
});
afterEach(() => env.cleanup());
afterAll(() => env.restore());

describe("FilmstripCache: what is kept for a file, and how much of it", () => {
	test("pictures come back in time order, whatever order they were taken in", () => {
		const cache = new FilmstripCache();
		cache.set("a.mp4", 30, "c");
		cache.set("a.mp4", 0, "a");
		cache.set("a.mp4", 15.25, "b");
		expect(cache.frames("a.mp4")).toEqual([
			{ at: 0, src: "a" },
			{ at: 15.25, src: "b" },
			{ at: 30, src: "c" },
		]);
	});

	test("a picture is found by its whole millisecond: 0.4 ms off is the same picture, 0.6 ms off is another", () => {
		const cache = new FilmstripCache();
		cache.set("a.mp4", 2.0004, "x");
		expect(cache.has("a.mp4", 2)).toBe(true);
		expect(cache.has("a.mp4", 1.9996)).toBe(true);
		expect(cache.has("a.mp4", 2.0006)).toBe(false);
		expect(cache.frames("a.mp4")).toEqual([{ at: 2, src: "x" }]);
	});

	test("taking the picture for a time again replaces it rather than adding a second one", () => {
		const cache = new FilmstripCache();
		cache.set("a.mp4", 1, "old");
		cache.set("a.mp4", 1.0001, "new");
		expect(cache.frames("a.mp4")).toEqual([{ at: 1, src: "new" }]);
	});

	test("each file has its own pictures: the same time in two files is two pictures", () => {
		const cache = new FilmstripCache();
		cache.set("a.mp4", 5, "of a");
		cache.set("b.mp4", 5, "of b");
		expect(cache.frames("a.mp4")).toEqual([{ at: 5, src: "of a" }]);
		expect(cache.frames("b.mp4")).toEqual([{ at: 5, src: "of b" }]);
		expect(cache.has("c.mp4", 5)).toBe(false);
	});

	test("a file keeps at most its bound in pictures: the oldest taken go first, and the other file's are not touched", () => {
		const cache = new FilmstripCache(4, 3);
		cache.set("other.mp4", 1, "kept");
		for (const at of [1, 2, 3, 4, 5]) cache.set("a.mp4", at, `p${at}`);
		expect(cache.frames("a.mp4")).toEqual([
			{ at: 3, src: "p3" },
			{ at: 4, src: "p4" },
			{ at: 5, src: "p5" },
		]);
		expect(cache.has("a.mp4", 1)).toBe(false);
		expect(cache.frames("other.mp4")).toEqual([{ at: 1, src: "kept" }]);
	});

	test("a file's pictures cannot grow without end: past the bound, only the newest are kept; and the widest lane's own pictures all fit", () => {
		const cache = new FilmstripCache();
		for (let at = 0; at < FILMSTRIP_FRAMES_PER_FILE + 7; at++) cache.set("a.mp4", at, `p${at}`);
		const kept = cache.frames("a.mp4");
		expect(kept).toHaveLength(FILMSTRIP_FRAMES_PER_FILE);
		expect(kept[0]?.at).toBe(7);
		expect(kept.at(-1)?.at).toBe(FILMSTRIP_FRAMES_PER_FILE + 6);

		const widest = new FilmstripCache();
		const times = filmSlotTimes(60, MAX_FILM_SLOTS);
		times.forEach((at, index) => widest.set("wide.mp4", at, `w${index}`));
		expect(times.every(at => widest.has("wide.mp4", at))).toBe(true);
	});

	test("files cannot pile up either: past the bound, the ones opened longest ago go, pictures and all", () => {
		const cache = new FilmstripCache();
		const opened = FILMSTRIP_FILES + 3;
		for (let file = 0; file < opened; file++) cache.set(`f${file}.mp4`, 0, `f${file}`);
		for (let file = 0; file < opened; file++) {
			const kept = file >= opened - FILMSTRIP_FILES;
			expect(cache.has(`f${file}.mp4`, 0)).toBe(kept);
			expect(cache.frames(`f${file}.mp4`)).toHaveLength(kept ? 1 : 0);
		}
	});

	test("the file that goes is the one least recently added to: taking another picture for an older file keeps it", () => {
		const cache = new FilmstripCache(2, 48);
		cache.set("a.mp4", 0, "a0");
		cache.set("b.mp4", 0, "b0");
		cache.set("a.mp4", 10, "a10");
		cache.set("c.mp4", 0, "c0");
		expect(cache.frames("b.mp4")).toEqual([]);
		expect(cache.frames("a.mp4")).toEqual([
			{ at: 0, src: "a0" },
			{ at: 10, src: "a10" },
		]);
		expect(cache.frames("c.mp4")).toEqual([{ at: 0, src: "c0" }]);
	});

	test("a failure is held in the same bound of files as pictures: the file opened longest ago goes, whatever it holds", () => {
		const failures = new FilmstripCache(2, 48);
		failures.fail("a.mp4");
		failures.fail("b.mp4");
		failures.fail("c.mp4");
		expect(failures.unfilmable("a.mp4")).toBe(false);
		expect(failures.unfilmable("b.mp4")).toBe(true);
		expect(failures.unfilmable("c.mp4")).toBe(true);

		const mixed = new FilmstripCache(2, 48);
		mixed.set("a.mp4", 0, "a0");
		mixed.fail("b.mp4");
		mixed.set("c.mp4", 0, "c0");
		expect(mixed.frames("a.mp4")).toEqual([]);
		expect(mixed.unfilmable("b.mp4")).toBe(true);
		expect(mixed.frames("c.mp4")).toEqual([{ at: 0, src: "c0" }]);

		const pictures = new FilmstripCache(2, 48);
		pictures.fail("a.mp4");
		pictures.set("b.mp4", 0, "b0");
		pictures.set("c.mp4", 0, "c0");
		expect(pictures.unfilmable("a.mp4")).toBe(false);
		expect(pictures.frames("b.mp4")).toEqual([{ at: 0, src: "b0" }]);
	});

	test("failing a file makes it the most recently used: it outlives the file opened before it, with its pictures", () => {
		const again = new FilmstripCache(2, 48);
		again.fail("a.mp4");
		again.fail("b.mp4");
		again.fail("a.mp4");
		again.fail("c.mp4");
		expect(again.unfilmable("a.mp4")).toBe(true);
		expect(again.unfilmable("b.mp4")).toBe(false);
		expect(again.unfilmable("c.mp4")).toBe(true);

		const cache = new FilmstripCache(2, 48);
		cache.set("a.mp4", 0, "a0");
		cache.set("b.mp4", 0, "b0");
		cache.fail("a.mp4");
		cache.set("c.mp4", 0, "c0");
		expect(cache.frames("b.mp4")).toEqual([]);
		expect(cache.frames("a.mp4")).toEqual([{ at: 0, src: "a0" }]);
		expect(cache.unfilmable("a.mp4")).toBe(true);
	});

	test("a failure is its file's own, and more pictures for the file do not undo it, even past the bound of pictures", () => {
		const cache = new FilmstripCache(4, 3);
		expect(cache.unfilmable("unknown.mp4")).toBe(false);
		cache.set("a.mp4", 0, "a0");
		expect(cache.unfilmable("a.mp4")).toBe(false);
		cache.fail("a.mp4");
		expect(cache.unfilmable("b.mp4")).toBe(false);
		for (const at of [1, 2, 3, 4, 5]) cache.set("a.mp4", at, `p${at}`);
		expect(cache.frames("a.mp4").map(frame => frame.at)).toEqual([3, 4, 5]);
		expect(cache.unfilmable("a.mp4")).toBe(true);
	});
});

describe("useFilmstrip: the pictures of a film lane, one seek at a time", () => {
	const KEY = "/clips/take.mp4:1000:1";
	const OTHER = "/clips/other.mp4:2000:1";

	interface Call {
		readonly at: number;
		readonly signal: AbortSignal | undefined;
		deliver(src: string): void;
		fail(error: Error): void;
	}
	interface Size {
		readonly width: number;
		readonly height: number;
	}
	/** A video of an ordinary size: one the strip takes pictures of. */
	const NORMAL: Size = { width: 1280, height: 720 };
	interface Rig {
		readonly calls: Call[];
		readonly cache: FilmstripCache;
		/** How many times a source of this rig was let go of, in all. */
		readonly released: number;
		/** A new grabber that logs its calls to the same list. */
		grab(size?: Size): ThumbnailSource;
		element(over?: Partial<ProbeProps>): ReactElement;
	}
	/** What `env.mount` hands back to re-render or unmount what it mounted. */
	interface Mounted {
		render(next: ReactElement): Promise<void>;
		unmount(): Promise<void>;
	}
	/** The grabbers the test settles by hand: every call is a picture asked for and not yet delivered. */
	function rig(size: Size = NORMAL): Rig {
		const calls: Call[] = [];
		let released = 0;
		const grab = (shape: Size = size): ThumbnailSource => ({
			size: shape,
			release: () => {
				released += 1;
			},
			thumbnail: (at, signal) =>
				new Promise<Thumbnail>((resolve, reject) => {
					calls.push({ at, signal, deliver: src => resolve({ src, width: 96, height: 54 }), fail: reject });
				}),
		});
		const cache = new FilmstripCache();
		const source = grab();
		const element = (over: Partial<ProbeProps> = {}) => createElement(Probe, { source, file: KEY, duration: 60, slots: 4, enabled: true, cache, ...over });
		return {
			calls,
			grab,
			cache,
			element,
			get released() {
				return released;
			},
		};
	}
	/** `key` is React's own, and never reaches a component's props: the file the filmstrip is of is `file` here. */
	interface ProbeProps extends Omit<FilmstripOptions, "key"> {
		readonly file: string;
	}
	const seen: { frames: readonly FilmFrame[]; failed: boolean; failedLog: boolean[]; renders: number } = { frames: [], failed: false, failedLog: [], renders: 0 };
	function Probe({ file, ...options }: ProbeProps): null {
		const strip = useFilmstrip({ ...options, key: file });
		seen.frames = strip.frames;
		seen.failed = strip.failed;
		// What every render said, so "failed from the very first render" and "never flashed not-failed" can be told apart from "failed in the end".
		seen.failedLog.push(strip.failed);
		seen.renders += 1;
		return null;
	}
	afterEach(() => {
		seen.frames = [];
		seen.failed = false;
		seen.failedLog = [];
		seen.renders = 0;
	});

	function nth(calls: readonly Call[], index: number): Call {
		const call = calls[index];
		if (!call) throw new Error(`call ${index} was never made (${calls.length} were)`);
		return call;
	}
	const deliver = (calls: readonly Call[], index: number, src: string) => env.act(async () => nth(calls, index).deliver(src));
	const fail = (calls: readonly Call[], index: number, error: Error) => env.act(async () => nth(calls, index).fail(error));
	/** Deliver every picture as it is asked for, until none is waiting: the times asked for, in order. (Bounded, so a runaway restart loop is a failure and not a hang.) */
	async function drain(calls: readonly Call[], from = 0): Promise<number[]> {
		for (let done = from; done < calls.length && done < 64; done++) await deliver(calls, done, `p${done}`);
		return calls.slice(from).map(call => call.at);
	}

	test("nothing is asked for until the pane is enabled, has a source and a length; then it starts, at the first cell", async () => {
		const { calls, element } = rig();
		const { render } = await env.mount(element({ enabled: false }));
		await render(element({ enabled: false, slots: 8 }));
		await render(element({ source: null }));
		await render(element({ duration: 0 }));
		await render(element({ duration: Number.NaN }));
		expect(calls).toHaveLength(0);
		await render(element());
		expect(calls.map(call => call.at)).toEqual([0]);
	});

	test.each([
		["4 cells over a minute", 60, 4, [0, 15, 30, 45]],
		// 16 is the most cells a lane holds (MAX_FILM_SLOTS): 100 asked for is 16 taken, evenly over the 32 s.
		["more cells than a lane may hold", 32, 100, Array.from({ length: 16 }, (_, index) => index * 2)],
		["no cells is still one", 10, 0, [0]],
		["a fractional count is whole cells", 10, 2.9, [0, 5]],
	])("%s: the times asked for are the start of each cell, in order, one at a time", async (_what, duration, slots, expected) => {
		const { calls, element } = rig();
		await env.mount(element({ duration, slots }));
		const asked: number[] = [];
		for (let index = 0; index < expected.length; index++) {
			// Only the picture just delivered's successor is in flight: the next never starts before this one settles.
			expect(calls).toHaveLength(index + 1);
			asked.push(nth(calls, index).at);
			await deliver(calls, index, `p${index}`);
		}
		expect(asked).toEqual(expected);
		expect(calls).toHaveLength(expected.length);
	});

	test("each picture is shown the moment it arrives, in time order, with one re-render apiece; nothing arriving is nothing redrawn", async () => {
		const { calls, element } = rig();
		const { render } = await env.mount(element());
		const none = seen.frames;
		await render(element());
		expect(seen.frames).toBe(none);

		let renders = seen.renders;
		await deliver(calls, 0, "a");
		expect(seen.frames).toEqual([{ at: 0, src: "a" }]);
		expect(seen.renders - renders).toBe(1);
		const afterFirst = seen.frames;
		await render(element());
		expect(seen.frames).toBe(afterFirst);

		renders = seen.renders;
		await deliver(calls, 1, "b");
		expect(seen.frames).toEqual([
			{ at: 0, src: "a" },
			{ at: 15, src: "b" },
		]);
		expect(seen.renders - renders).toBe(1);
	});

	test.each([
		["disabling", (r: Rig) => r.element({ enabled: false }), false],
		["the source going away", (r: Rig) => r.element({ source: null }), false],
		["unmounting", null, false],
		["a different cell count", (r: Rig) => r.element({ slots: 8 }), true],
		["a different length", (r: Rig) => r.element({ duration: 90 }), true],
		["a different file", (r: Rig) => r.element({ file: OTHER }), true],
		["a different source", (r: Rig) => r.element({ source: r.grab() }), true],
	])("%s aborts the call in progress and drops the rest; the picture that arrives after is neither stored nor shown", async (_what, next, restarts) => {
		const r = rig();
		const { render, unmount } = await env.mount(r.element());
		const stale = nth(r.calls, 0);
		expect(stale.signal?.aborted).toBe(false);
		if (next === null) await unmount();
		else await render(next(r));
		expect(stale.signal?.aborted).toBe(true);
		// A restart is one new call (the first cell again), made with a signal of its own; otherwise nothing more is asked.
		expect(r.calls).toHaveLength(restarts ? 2 : 1);
		if (restarts) expect(nth(r.calls, 1).signal?.aborted).toBe(false);

		await env.act(async () => stale.deliver("stale"));
		expect(r.calls).toHaveLength(restarts ? 2 : 1);
		expect(r.cache.has(KEY, 0)).toBe(false);
		expect(r.cache.has(OTHER, 0)).toBe(false);
		expect(seen.frames).toEqual([]);
		// Stopped, not finished: the decoder is the next run's to reuse or the pane's to drop, never let go of by the run that was cut off.
		expect(r.released).toBe(0);
	});

	test.each([
		["the first picture", 0],
		["a picture in the middle", 2],
		["the last picture", 3],
	])("%s failing (a seek that never lands) gives the file up: the run stops there, the pictures before it stay, and the decoder is let go of once", async (_which, failing) => {
		const r = rig();
		await env.mount(r.element());
		for (let index = 0; index < failing; index++) await deliver(r.calls, index, `p${index}`);
		expect(seen.failed).toBe(false);
		await fail(r.calls, failing, new Error("seeking timed out"));
		// The cells after it are never asked: the same video would fail each of them too, at a wait apiece.
		expect(r.calls).toHaveLength(failing + 1);
		expect(seen.failed).toBe(true);
		expect(seen.frames.map(frame => frame.src)).toEqual(Array.from({ length: failing }, (_, index) => `p${index}`));
		expect(r.released).toBe(1);
	});

	test.each([
		["the lane being resized", (r: Rig, mounted: Mounted) => mounted.render(r.element({ slots: 8 }))],
		["the pane being paused and resumed", async (r: Rig, mounted: Mounted) => {
			await mounted.render(r.element({ enabled: false }));
			await mounted.render(r.element());
		}],
		["the pane mounting its renderer again over a new source, with the cache it shares", async (r: Rig, mounted: Mounted) => {
			await mounted.unmount();
			await env.mount(r.element({ source: r.grab() }));
		}],
	])("a failed file is remembered: %s asks for nothing, and says so from the first render", async (_what, later) => {
		const r = rig();
		const mounted = await env.mount(r.element());
		await fail(r.calls, 0, new Error("seeking timed out"));
		expect(seen.failed).toBe(true);
		seen.failedLog = [];
		await later(r, mounted);
		expect(r.calls).toHaveLength(1);
		expect(seen.failedLog.length).toBeGreaterThan(0);
		expect(seen.failedLog.every(failed => failed)).toBe(true);
		expect(r.released).toBe(1);
	});

	test.each([
		["another file", OTHER],
		["the same file after it changed", "/clips/take.mp4:1000:2"],
	])("%s is asked, whatever became of the first; and the first stays failed when it comes back", async (_what, other) => {
		const r = rig();
		const { render } = await env.mount(r.element());
		await fail(r.calls, 0, new Error("seeking timed out"));
		await render(r.element({ file: other }));
		expect(seen.failed).toBe(false);
		expect(r.calls).toHaveLength(2);
		expect(nth(r.calls, 1).signal?.aborted).toBe(false);
		await deliver(r.calls, 1, "of other");
		expect(seen.frames).toEqual([{ at: 0, src: "of other" }]);

		const asked = r.calls.length;
		await render(r.element());
		expect(seen.failed).toBe(true);
		expect(seen.frames).toEqual([]);
		expect(r.calls).toHaveLength(asked);
	});

	test("a video whose seeks never complete costs one wait per file, not one per run: once the wait ran out, no run asks again", async () => {
		const r = rig();
		const { render, unmount } = await env.mount(r.element());
		// The one call hangs: the grabber's own wait for a seek that never lands is what ends it, and the test plays that out by hand.
		expect(r.calls).toHaveLength(1);
		await fail(r.calls, 0, new Error("seeking timed out"));
		expect(seen.failed).toBe(true);
		for (const slots of [5, 6, 7, 8, 16]) await render(r.element({ slots }));
		await render(r.element({ enabled: false }));
		await render(r.element());
		await render(r.element({ duration: 90 }));
		await unmount();
		await env.mount(r.element());
		expect(r.calls).toHaveLength(1);
		expect(seen.failed).toBe(true);

		// Another file costs its own wait, once.
		const other = await env.mount(r.element({ file: OTHER }));
		expect(r.calls).toHaveLength(2);
		expect(seen.failed).toBe(false);
		await fail(r.calls, 1, new Error("seeking timed out"));
		for (const slots of [5, 8]) await other.render(r.element({ file: OTHER, slots }));
		expect(r.calls).toHaveLength(2);
		expect(seen.failed).toBe(true);
	});

	test.each([
		["no size at all (0 x 0)", 0, 0],
		["no width", 0, 720],
		["no height", 1280, 0],
		["3841 x 2161, just over the budget", 3841, 2161],
		["4096 x 2160, over it by width alone", 4096, 2160],
		["16384 x 16384", 16384, 16384],
	])("a video of %s is never asked for a picture: the file is failed at once, and stays so however many runs follow", async (_what, width, height) => {
		const r = rig({ width, height });
		const { render, unmount } = await env.mount(r.element());
		expect(seen.failed).toBe(true);
		await render(r.element({ slots: 8 }));
		await render(r.element({ enabled: false }));
		await render(r.element());
		await unmount();
		await env.mount(r.element());
		expect(r.calls).toHaveLength(0);
		expect(seen.failed).toBe(true);
	});

	test.each([
		["3840 x 2160, exactly the budget", 3840, 2160],
		["2160 x 3840, the same budget standing up", 2160, 3840],
		["1920 x 1080", 1920, 1080],
	])("a video of %s is asked: the strip starts at its first cell and the file is not failed", async (_what, width, height) => {
		const r = rig({ width, height });
		await env.mount(r.element());
		expect(r.calls.map(call => call.at)).toEqual([0]);
		expect(seen.failed).toBe(false);
	});

	for (const [stopped, stop, resume] of [
		["a different cell count", (r: Rig) => r.element({ slots: 5 }), null],
		["pausing", (r: Rig) => r.element({ enabled: false }), (r: Rig) => r.element()],
	] as const) {
		for (const [ending, error] of [
			["an AbortError", new DOMException("The operation was aborted.", "AbortError")],
			["the seek's own timeout, arriving too late", new Error("seeking timed out")],
		] as const) {
			test(`${stopped} stops the run in progress; its call ending in ${ending} neither fails the file nor lets go of the decoder, and the next run is asked`, async () => {
				const r = rig();
				const { render } = await env.mount(r.element());
				const inFlight = nth(r.calls, 0);
				await render(stop(r));
				expect(inFlight.signal?.aborted).toBe(true);
				await env.act(async () => inFlight.fail(error));
				expect(seen.failed).toBe(false);
				expect(r.cache.unfilmable(KEY)).toBe(false);
				expect(r.released).toBe(0);

				if (resume !== null) await render(resume(r));
				expect(r.calls.map(call => call.at)).toEqual([0, 0]);
				expect(nth(r.calls, 1).signal?.aborted).toBe(false);
				await deliver(r.calls, 1, "again");
				expect(seen.frames).toEqual([{ at: 0, src: "again" }]);
				await drain(r.calls, 2);
				expect(seen.failed).toBe(false);
				expect(r.released).toBe(1);
			});
		}
	}

	test("a run that takes every cell lets go of the decoder once, at its end and not before; a complete filmstrip then asks for nothing and lets go of nothing", async () => {
		const r = rig();
		const { render } = await env.mount(r.element());
		for (let index = 0; index < 3; index++) await deliver(r.calls, index, `p${index}`);
		expect(r.released).toBe(0);
		await deliver(r.calls, 3, "p3");
		expect(r.calls).toHaveLength(4);
		expect(r.released).toBe(1);
		expect(seen.failed).toBe(false);
		expect(seen.frames).toHaveLength(4);

		await render(r.element({ enabled: false }));
		await render(r.element());
		await env.mount(r.element());
		expect(r.calls).toHaveLength(4);
		expect(r.released).toBe(1);
	});

	test("the real grabber over a player too big to decode twice never opens a second decoder; the same grabber over an ordinary one does", async () => {
		const player = (width: number, height: number) => ({ currentSrc: "blob:player", videoWidth: width, videoHeight: height }) as unknown as HTMLVideoElement;
		const settle = () =>
			env.act(async () => {
				for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
			});
		const real = env.document.createElement.bind(env.document);
		const created = spyOn(env.document, "createElement").mockImplementation(((tag: string) => {
			const element = real(tag);
			// linkedom's elements cannot `load()`, which letting go of the grabber's element does.
			if (tag === "video") Object.assign(element, { load() {} });
			return element;
		}) as Document["createElement"]);
		const clones = (): number => created.mock.calls.filter(([tag]) => tag === "video").length;
		const huge = new FrameGrabber(player(16384, 16384));
		const normal = new FrameGrabber(player(1280, 720));
		try {
			const props = { file: KEY, duration: 60, slots: 4, enabled: true };
			const first = await env.mount(createElement(Probe, { ...props, source: huge, cache: new FilmstripCache() }));
			await settle();
			expect(seen.failed).toBe(true);
			expect(clones()).toBe(0);
			await first.unmount();

			// The control: the same wiring over an ordinary video does open one, so the count above is not blind.
			const second = await env.mount(createElement(Probe, { ...props, source: normal, cache: new FilmstripCache() }));
			await settle();
			expect(seen.failed).toBe(false);
			expect(clones()).toBe(1);
			await second.unmount();
		} finally {
			created.mockRestore();
			huge.dispose();
			normal.dispose();
		}
	});

	test("pausing keeps what was taken; resuming asks for the interrupted picture again, not for the ones already taken", async () => {
		const { calls, element } = rig();
		const { render } = await env.mount(element());
		await deliver(calls, 0, "a");
		await render(element({ enabled: false }));
		expect(nth(calls, 1).signal?.aborted).toBe(true);
		expect(seen.frames).toEqual([{ at: 0, src: "a" }]);
		await render(element());
		expect(calls.map(call => call.at)).toEqual([0, 15, 15]);
	});

	test("mounting again for the same file asks only for what is missing, and shows what there is at once", async () => {
		const { calls, cache, element } = rig();
		const first = await env.mount(element());
		await deliver(calls, 0, "a");
		await deliver(calls, 1, "b");
		await first.unmount();
		expect(nth(calls, 2).signal?.aborted).toBe(true);
		expect(cache.frames(KEY)).toHaveLength(2);

		await env.mount(element());
		expect(seen.frames).toEqual([
			{ at: 0, src: "a" },
			{ at: 15, src: "b" },
		]);
		expect(calls.map(call => call.at).slice(3)).toEqual([30]);
		await deliver(calls, 3, "c");
		await deliver(calls, 4, "d");
		expect(calls.map(call => call.at).slice(3)).toEqual([30, 45]);
		expect(seen.frames.map(frame => frame.src)).toEqual(["a", "b", "c", "d"]);

		// A filmstrip that is complete asks for nothing at all.
		const asked = calls.length;
		await env.mount(element());
		expect(calls).toHaveLength(asked);
		expect(seen.frames).toHaveLength(4);
	});

	test("a different file is a different filmstrip: it starts empty, and the first file's pictures are still there when it comes back", async () => {
		const { calls, element } = rig();
		const { render } = await env.mount(element());
		await deliver(calls, 0, "a");
		await render(element({ file: OTHER }));
		expect(seen.frames).toEqual([]);
		expect(calls.map(call => call.at)).toEqual([0, 15, 0]);
		await render(element());
		expect(seen.frames).toEqual([{ at: 0, src: "a" }]);
		expect(calls.map(call => call.at)).toEqual([0, 15, 0, 15]);
	});

	test("a different cell count asks only for the times the earlier count did not already take", async () => {
		const { calls, element } = rig();
		const { render } = await env.mount(element());
		expect(await drain(calls)).toEqual([0, 15, 30, 45]);
		await render(element({ slots: 8 }));
		expect(seen.frames).toHaveLength(4);
		expect(await drain(calls, 4)).toEqual([7.5, 22.5, 37.5, 52.5]);
		expect(seen.frames.map(frame => frame.at)).toEqual([0, 7.5, 15, 22.5, 30, 37.5, 45, 52.5]);
	});

	test("a pane that mounts its renderer again, with no cache of its own, finds the pictures the last mount took", async () => {
		const { calls, grab } = rig();
		// The module's cache outlives this test (and a re-run of this file): a file nothing else has taken pictures of is a name no one else uses.
		const options = { source: grab(), file: `/clips/shared-cache-${crypto.randomUUID()}.mp4:7:7`, duration: 60, slots: 2, enabled: true };
		const first = await env.mount(createElement(Probe, options));
		expect(await drain(calls)).toEqual([0, 30]);
		await first.unmount();
		await env.mount(createElement(Probe, options));
		expect(calls).toHaveLength(2);
		expect(seen.frames.map(frame => frame.src)).toEqual(["p0", "p1"]);
	});
});

describe("filmable: which pictures the strip opens a second decoder for", () => {
	test.each([
		[1920, 1080, true],
		[3840, 2160, true],
		[2160, 3840, true],
		[1, 1, true],
		[3841, 2161, false],
		[4096, 2160, false],
		[16384, 16384, false],
		[0, 0, false],
		[0, 720, false],
		[1280, 0, false],
		[-1280, 720, false],
		[1280, -720, false],
		[-1280, -720, false],
		[Number.NaN, 720, false],
		[1280, Number.NaN, false],
		[Number.POSITIVE_INFINITY, 720, false],
		[Number.POSITIVE_INFINITY, 0, false],
		[Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false],
	])("%p x %p is %p", (width, height, expected) => {
		expect(filmable(width, height)).toBe(expected);
	});
});
