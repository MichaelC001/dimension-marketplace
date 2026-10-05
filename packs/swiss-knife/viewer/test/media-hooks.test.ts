// What the timeline pane keeps about a recording, held to how often it may change.
//
// useDuration: a recording that does not say how long it is moves "how far it can be played so far" with the
// playhead four times a second. The pane draws nothing from that, so it must not be re-rendered for it - the marks list
// and every note field in it went with it.
//
// useWaveform: a decode cannot be cancelled, so every restart of one is another copy of the file and another decode
// running beside the one left behind. Re-asking Annotate on an open tab (a new tab object) and switching tabs back and
// forth must not start one. The start waits for the sound to be on screen AND for the file's OWN player to say a length
// (the gate cannot judge a compressed file without one); a length that is refined afterwards is no reason for another
// decode. The player that was showing when the file changed belongs to the file before it, so its length is never the new
// file's: a revision of another length is judged against the player it is reloaded into.
// Rendered for real (linkedom + react-dom under `act`); the decoder is a stand-in the test settles by hand.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { createElement } from "react";
import { loadPeaks, type PeaksLoader, useDuration, useFailed, useWaveform } from "../app/view/media-hooks";
import { WAVEFORM_BUCKETS, WAVEFORM_DECODE_RATE, WAVEFORM_MAX_BYTES } from "../app/view/media-waveform";
import type { DocTab } from "../app/view/tabs";
import { installReact, type ReactEnv } from "./media-react";

let env: ReactEnv;
beforeAll(async () => {
	env = await installReact();
});
afterEach(() => env.cleanup());
afterAll(() => env.restore());

const ranges = (...ends: number[]): TimeRanges => ({ length: ends.length, start: () => 0, end: (index: number) => ends[index] as number }) as unknown as TimeRanges;

class FakeMedia extends EventTarget {
	duration = 90;
	currentTime = 0;
	seekable = ranges();
	tell(type: string): void {
		this.dispatchEvent(new Event(type));
	}
}

describe("useDuration: the length the marks are made against", () => {
	function Probe({ media, seen }: { media: FakeMedia | null; seen: number[] }): null {
		seen.push(useDuration(media));
		return null;
	}
	const mountProbe = (media: FakeMedia | null) => {
		const seen: number[] = [];
		return env.mount(createElement(Probe, { media, seen })).then(mounted => ({ ...mounted, seen }));
	};
	const tell = (media: FakeMedia, ...types: string[]) => env.act(async () => types.forEach(type => media.tell(type)));

	test("0 until there is an element to ask, then what the element says, and again when it says something else", async () => {
		const media = new FakeMedia();
		media.duration = Number.NaN;
		const { seen } = await mountProbe(media);
		expect(seen.at(-1)).toBe(0);
		media.duration = 90;
		await tell(media, "durationchange");
		expect(seen.at(-1)).toBe(90);
		media.duration = Number.NaN;
		await tell(media, "emptied");
		expect(seen.at(-1)).toBe(0);
		media.duration = 12;
		await tell(media, "loadedmetadata");
		expect(seen.at(-1)).toBe(12);
	});

	test("no element is no length, and a different element is asked afresh", async () => {
		const first = new FakeMedia();
		const second = new FakeMedia();
		second.duration = 30;
		const { seen, render } = await mountProbe(first);
		expect(seen.at(-1)).toBe(90);
		await render(createElement(Probe, { media: null, seen }));
		expect(seen.at(-1)).toBe(0);
		await render(createElement(Probe, { media: second, seen }));
		expect(seen.at(-1)).toBe(30);
	});

	test("a recording that will not say how long it is has no end, and playing it does not redraw the pane", async () => {
		const media = new FakeMedia();
		media.duration = Number.POSITIVE_INFINITY;
		const { seen } = await mountProbe(media);
		expect(seen.at(-1)).toBe(Number.POSITIVE_INFINITY);
		// React renders a component once more the first time it is told what it already holds, before it learns to ignore it.
		await tell(media, "timeupdate");
		const renders = seen.length;
		// The playhead goes on for a minute, four reports a second; how far it can be played moves with it.
		for (let second = 1; second <= 240; second += 1) {
			media.currentTime = second / 4;
			await tell(media, "timeupdate", "progress");
		}
		expect(seen.length).toBe(renders);
	});

	test("…and it is redrawn when the engine does learn the length", async () => {
		const media = new FakeMedia();
		media.duration = Number.POSITIVE_INFINITY;
		const { seen } = await mountProbe(media);
		media.duration = 61.5;
		await tell(media, "durationchange");
		expect(seen.at(-1)).toBe(61.5);
	});

	test("an element swapped for another in one render is never given the first one's length, in that render or after it; it is given its own once it says it", async () => {
		const first = new FakeMedia();
		first.duration = 100;
		const second = new FakeMedia();
		second.duration = Number.NaN;
		const { seen, render } = await mountProbe(first);
		expect(seen.at(-1)).toBe(100);
		const before = seen.length;
		await render(createElement(Probe, { media: second, seen }));
		expect(seen.length).toBeGreaterThan(before);
		expect(seen.slice(before)).not.toContain(100);
		expect(seen.at(-1)).toBe(0);
		second.duration = 60;
		await tell(second, "loadedmetadata");
		expect(seen.at(-1)).toBe(60);
		// The element that was swapped out is no longer listened to.
		first.duration = 80;
		await tell(first, "durationchange");
		expect(seen.at(-1)).toBe(60);
	});
});

describe("useFailed: a recording the player gave up on partway cannot be marked", () => {
	class Player extends EventTarget {
		error: MediaError | null = null;
		fail(): void {
			this.error = { code: 3, message: "" } as MediaError;
			this.dispatchEvent(new Event("error"));
		}
	}
	function Probe({ media, seen }: { media: Player | null; seen: boolean[] }): null {
		seen.push(useFailed(media));
		return null;
	}
	const mountProbe = (media: Player | null) => {
		const seen: boolean[] = [];
		return env.mount(createElement(Probe, { media, seen })).then(mounted => ({ ...mounted, seen }));
	};

	test("false for a player that has not failed, true once it says so, false again when a new source clears it", async () => {
		const media = new Player();
		const { seen } = await mountProbe(media);
		expect(seen.at(-1)).toBe(false);
		await env.act(async () => media.fail());
		expect(seen.at(-1)).toBe(true);
		media.error = null;
		await env.act(async () => void media.dispatchEvent(new Event("emptied")));
		expect(seen.at(-1)).toBe(false);
		await env.act(async () => media.fail());
		media.error = null;
		await env.act(async () => void media.dispatchEvent(new Event("loadstart")));
		expect(seen.at(-1)).toBe(false);
	});

	test("a player that was already failed when it is first seen is failed", async () => {
		const media = new Player();
		media.error = { code: 4, message: "" } as MediaError;
		const { seen } = await mountProbe(media);
		expect(seen.at(-1)).toBe(true);
	});

	test("no player is not failed, and a different player is asked afresh", async () => {
		const broken = new Player();
		broken.error = { code: 3, message: "" } as MediaError;
		const fine = new Player();
		const { seen, render } = await mountProbe(broken);
		expect(seen.at(-1)).toBe(true);
		await render(createElement(Probe, { media: null, seen }));
		expect(seen.at(-1)).toBe(false);
		await render(createElement(Probe, { media: broken, seen }));
		await render(createElement(Probe, { media: fine, seen }));
		expect(seen.at(-1)).toBe(false);
	});

	test("a player that has gone is no longer listened to", async () => {
		const media = new Player();
		const { seen, render } = await mountProbe(media);
		await render(createElement(Probe, { media: null, seen }));
		const renders = seen.length;
		await env.act(async () => media.fail());
		expect(seen.length).toBe(renders);
	});
});

describe("useWaveform: one decode per file, started once the sound is on screen and the file's own player says how long it is", () => {
	const app = {} as App;
	const tabOf = (over: Partial<DocTab> = {}): DocTab => ({
		key: "/music/take.wav",
		path: "/music/take.wav",
		filename: "take.wav",
		kind: "audio",
		size: 1_000_000,
		mtimeMs: 1,
		revision: 0,
		annotateRequests: 0,
		...over,
	});
	interface Run {
		readonly tab: DocTab;
		readonly signal: AbortSignal;
		/** The length the loader was asked against: what the player said when the decode started. */
		readonly duration: number;
		finish(values: Float32Array | null): void;
		fail(error: Error): void;
	}
	/** A decoder the test settles by hand: every call is a decode that has started and not finished. */
	function decoder() {
		const runs: Run[] = [];
		const load: PeaksLoader = (_app, tab, signal, duration) => new Promise<Float32Array | null>((finish, fail) => runs.push({ tab, signal, duration, finish, fail }));
		return { runs, load };
	}
	/** What each decode was asked, for the file modified at `mtimeMs`: the length it was held to. */
	const askedFor = (runs: readonly Run[], mtimeMs: number): number[] => runs.filter(run => run.tab.mtimeMs === mtimeMs).map(run => run.duration);
	const PEAKS = Float32Array.from([0.2, 1, 0.4]);
	/** A length the player has said, for the tests that are about something else. */
	const LENGTH = 120;
	/** A player that says it is `duration` seconds long. */
	const playerOf = (duration = LENGTH): FakeMedia => Object.assign(new FakeMedia(), { duration });
	/** The player says another length and tells whoever listens, the way an element does when its metadata arrives or its estimate settles. */
	const say = (media: FakeMedia, duration: number, type = "durationchange") =>
		env.act(async () => {
			media.duration = duration;
			media.tell(type);
		});
	const seen: { value: Float32Array | undefined } = { value: undefined };
	function Probe({ tab, startable, media, load }: { tab: DocTab; startable: boolean; media: FakeMedia | null; load: PeaksLoader }): null {
		seen.value = useWaveform(app, tab, startable, media, load);
		return null;
	}
	afterEach(() => {
		seen.value = undefined;
	});
	const element = (tab: DocTab, startable: boolean, load: PeaksLoader, media: FakeMedia | null) => createElement(Probe, { tab, startable, media, load });

	test("a pane that is not on screen starts nothing even when its player has said how long it is; once it is, exactly one decode starts, against the length the player gives at that moment", async () => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const media = playerOf(300);
		const { render } = await env.mount(element(tab, false, load, media));
		await say(media, 290);
		await render(element(tab, false, load, media));
		expect(runs).toHaveLength(0);
		await say(media, 280);
		await render(element(tab, true, load, media));
		expect(runs).toHaveLength(1);
		expect(runs[0]?.duration).toBe(280);
	});

	test("a length refined after the decode started (a VBR estimate settling) neither starts another decode nor restarts the first", async () => {
		const { runs, load } = decoder();
		const media = playerOf(300);
		await env.mount(element(tabOf(), true, load, media));
		expect(runs).toHaveLength(1);
		expect(runs[0]?.duration).toBe(300);
		await say(media, 290);
		await say(media, 0);
		await say(media, 295);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.signal.aborted).toBe(false);
		await env.act(async () => runs[0]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
	});

	test.each([
		["0, what a player says before it knows", 0],
		["NaN, what a media element says before its metadata is in", Number.NaN],
		["Infinity, a recording that does not say how long it is", Number.POSITIVE_INFINITY],
	])("a length of %s starts no decode even on screen; when the player says a number, exactly one starts against that number", async (_what, unsaid) => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const media = playerOf(unsaid);
		const { render } = await env.mount(element(tab, true, load, media));
		expect(runs).toHaveLength(0);
		await render(element(tab, false, load, media));
		await render(element(tab, true, load, media));
		expect(runs).toHaveLength(0);
		await say(media, 42, "loadedmetadata");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.duration).toBe(42);
		await say(media, 41);
		expect(runs).toHaveLength(1);
	});

	test("asking Annotate again on the open tab (a new tab object for the same file) neither restarts the decode nor stops it", async () => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const media = playerOf();
		const { render } = await env.mount(element(tab, true, load, media));
		await render(element({ ...tab, annotateRequests: 1 }, true, load, media));
		await render(element({ ...tab, annotateRequests: 2, revision: 3 }, true, load, media));
		expect(runs).toHaveLength(1);
		expect(runs[0]?.signal.aborted).toBe(false);
		await env.act(async () => runs[0]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
	});

	test("looking at another tab and coming back neither restarts the decode nor stops it: it finishes while the human is away", async () => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const media = playerOf();
		const { render } = await env.mount(element(tab, true, load, media));
		await render(element(tab, false, load, media));
		expect(runs[0]?.signal.aborted).toBe(false);
		await env.act(async () => runs[0]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
		await render(element(tab, true, load, media));
		await render(element(tab, false, load, media));
		await render(element(tab, true, load, media));
		expect(runs).toHaveLength(1);
		expect(seen.value).toBe(PEAKS);
	});

	test.each<[string, (run: Run | undefined) => void]>([
		["finds nothing to draw (resolves null)", run => run?.finish(null)],
		["fails (this engine cannot decode it)", run => run?.fail(new Error("this engine cannot decode it"))],
	])("a loader that %s leaves a plain track, and the file is not decoded again whatever the player and the pane do next", async (_what, settle) => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const media = playerOf(300);
		const { render } = await env.mount(element(tab, true, load, media));
		await env.act(async () => settle(runs[0]));
		expect(seen.value).toBeUndefined();
		await render(element(tab, false, load, media));
		await render(element(tab, true, load, media));
		await say(media, 0);
		await say(media, 290);
		await render(element({ ...tab, annotateRequests: 1 }, true, load, media));
		await render(element(tab, true, load, null));
		await render(element(tab, true, load, playerOf(290)));
		expect(runs).toHaveLength(1);
		expect(seen.value).toBeUndefined();
	});

	test.each<[string, Partial<DocTab>]>([
		["its modification time", { mtimeMs: 2 }],
		["its size", { size: 1_000_001 }],
		["its key (another file of the same size and time)", { key: "/music/other.wav", path: "/music/other.wav", filename: "other.wav" }],
	])("the file changing in %s starts its own decode against the player it is reloaded into; the old file's picture is not the new file's", async (_what, over) => {
		const { runs, load } = decoder();
		const { render } = await env.mount(element(tabOf(), true, load, playerOf(300)));
		await env.act(async () => runs[0]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
		await render(element(tabOf(over), true, load, null));
		expect(seen.value).toBeUndefined();
		expect(runs).toHaveLength(1);
		await render(element(tabOf(over), true, load, playerOf(240)));
		expect(seen.value).toBeUndefined();
		expect(runs).toHaveLength(2);
		expect(runs[1]?.duration).toBe(240);
		const NEW = Float32Array.from([0.9, 0.1]);
		await env.act(async () => runs[1]?.finish(NEW));
		expect(seen.value).toBe(NEW);
	});

	test("a new revision of the file is judged against its own player, never the one the file before it had: the stale render waits, and so does a player that has not said its length", async () => {
		const { runs, load } = decoder();
		const first = tabOf({ mtimeMs: 1, size: 1_000_000 });
		const second = tabOf({ mtimeMs: 2, size: 600_000 });
		const before = playerOf(100);
		const { render } = await env.mount(element(first, true, load, before));
		expect(askedFor(runs, 1)).toEqual([100]);
		// The pane has not reloaded yet: the new revision, on screen, with the player (and the 100 s) of the one before.
		await render(element(second, true, load, before));
		expect(runs[0]?.signal.aborted).toBe(true);
		expect(askedFor(runs, 2)).toEqual([]);
		// The pane reloads: no player, then a new one that has no length until its metadata is in.
		await render(element(second, true, load, null));
		expect(askedFor(runs, 2)).toEqual([]);
		const after = playerOf(Number.NaN);
		await render(element(second, true, load, after));
		expect(askedFor(runs, 2)).toEqual([]);
		await say(after, 60, "loadedmetadata");
		expect(askedFor(runs, 2)).toEqual([60]);
		expect(runs).toHaveLength(2);
		expect(runs[1]?.signal.aborted).toBe(false);
		await env.act(async () => runs[1]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
	});

	test("a decode still running when the file changes is stopped, and its late answer is never the new file's picture", async () => {
		const { runs, load } = decoder();
		const { render } = await env.mount(element(tabOf({ mtimeMs: 1 }), true, load, playerOf()));
		await render(element(tabOf({ mtimeMs: 2 }), true, load, null));
		expect(runs[0]?.signal.aborted).toBe(true);
		await render(element(tabOf({ mtimeMs: 2 }), true, load, playerOf(50)));
		expect(runs).toHaveLength(2);
		expect(runs[1]?.signal.aborted).toBe(false);
		await env.act(async () => runs[0]?.finish(Float32Array.from([1, 1])));
		expect(seen.value).toBeUndefined();
		await env.act(async () => runs[1]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
	});

	test("the player showing when the file changed is never taken for the new file's, however many renders it stays for and whatever it says; the next player found is", async () => {
		const { runs, load } = decoder();
		const first = tabOf({ mtimeMs: 1 });
		const second = tabOf({ mtimeMs: 2 });
		const carried = playerOf(100);
		const { render } = await env.mount(element(first, true, load, carried));
		for (const tab of [second, { ...second }, { ...second, annotateRequests: 1 }]) await render(element(tab, true, load, carried));
		await say(carried, 80);
		await say(carried, 90, "loadedmetadata");
		await render(element(second, false, load, carried));
		await render(element(second, true, load, carried));
		expect(askedFor(runs, 2)).toEqual([]);
		expect(runs).toHaveLength(1);
		await render(element(second, true, load, null));
		await render(element(second, true, load, playerOf(60)));
		expect(askedFor(runs, 1)).toEqual([100]);
		expect(askedFor(runs, 2)).toEqual([60]);
	});

	test("the pane mounting its player again for the same file (the theme changing) neither restarts the decode nor stops it, and drops no picture already made", async () => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const { render } = await env.mount(element(tab, true, load, playerOf()));
		// Mid-decode: the element goes, and a new one comes that has not read its metadata yet.
		await render(element(tab, true, load, null));
		await render(element(tab, true, load, playerOf(Number.NaN)));
		expect(runs).toHaveLength(1);
		expect(runs[0]?.signal.aborted).toBe(false);
		await env.act(async () => runs[0]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
		// Once it is made: another remount.
		await render(element(tab, true, load, null));
		expect(seen.value).toBe(PEAKS);
		await render(element(tab, true, load, playerOf()));
		expect(seen.value).toBe(PEAKS);
		expect(runs).toHaveLength(1);
	});

	test("a player swapped for another in the very render that puts the pane on screen is not asked for the first one's length: nothing starts until the new player says its own", async () => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const { render } = await env.mount(element(tab, false, load, playerOf(100)));
		const swapped = playerOf(Number.NaN);
		await render(element(tab, true, load, swapped));
		expect(runs).toHaveLength(0);
		await say(swapped, 60, "loadedmetadata");
		expect(runs.map(run => run.duration)).toEqual([60]);
	});

	test("a file too big to count the cost of is never decoded", async () => {
		const { runs, load } = decoder();
		await env.mount(element(tabOf({ size: WAVEFORM_MAX_BYTES + 1 }), true, load, playerOf()));
		expect(runs).toHaveLength(0);
		const { runs: more, load: again } = decoder();
		await env.mount(element(tabOf({ size: WAVEFORM_MAX_BYTES }), true, again, playerOf()));
		expect(more).toHaveLength(1);
	});

	test("the pane going away stops the decode", async () => {
		const { runs, load } = decoder();
		const { unmount } = await env.mount(element(tabOf(), true, load, playerOf()));
		await unmount();
		expect(runs[0]?.signal.aborted).toBe(true);
	});
});

describe("loadPeaks: the file is held to the length the player gave, before the decode and again after it", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext");
	afterEach(() => {
		if (original === undefined) Reflect.deleteProperty(globalThis, "OfflineAudioContext");
		else Object.defineProperty(globalThis, "OfflineAudioContext", original);
	});

	// 100 frames of MPEG 1 Layer III, 128 kbps, 44.1 kHz, stereo: 417 bytes each, 1152 samples each, 2.61 s in all.
	const FRAMES = 100;
	const FRAME_BYTES = 417;
	const SONG = new Uint8Array(FRAMES * FRAME_BYTES);
	for (let index = 0; index < FRAMES; index += 1) SONG.set([0xff, 0xfb, 0x90, 0x00], index * FRAME_BYTES);
	/** What the frames play for, and what a player reads off them. */
	const SONG_SECONDS = (FRAMES * 1152) / 44_100;
	/** The samples of that sound at the rate it is decoded at. */
	const SONG_DECODED = Math.round(SONG_SECONDS * WAVEFORM_DECODE_RATE);

	/** Bytes that read as no recording: a fixed pseudo-random run (it holds 0xFF bytes, but never three frames of one stream). */
	const NOISE = (() => {
		let state = 12345;
		return Uint8Array.from({ length: 8000 }, () => {
			state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
			return state >>> 24;
		});
	})();

	const ascii = (text: string): number[] => [...Buffer.from(text, "latin1")];
	/** The first bytes of a container this viewer does not draw, then filler: 20 KB, an ordinary size for 10 s of a compressed track. */
	const containerOf = (...head: number[]): Uint8Array => {
		const bytes = new Uint8Array(20_000);
		bytes.set(head);
		return bytes;
	};
	/** The MP3 above with one stray byte before its first frame: a sniffer could read other bytes than the ones that were counted. */
	const STRAY = Uint8Array.from([0x00, ...SONG]);
	const WAV_RATE = 22_050;
	/** An uncompressed WAV (mono, 16-bit) of `seconds`: its 44-byte header, then silence. */
	const wavOf = (seconds: number): Uint8Array => {
		const data = WAV_RATE * 2 * seconds;
		const bytes = new Uint8Array(44 + data);
		const view = new DataView(bytes.buffer);
		bytes.set(ascii("RIFF"), 0);
		view.setUint32(4, 36 + data, true);
		bytes.set(ascii("WAVEfmt "), 8);
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, WAV_RATE, true);
		view.setUint32(28, WAV_RATE * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		bytes.set(ascii("data"), 36);
		view.setUint32(40, data, true);
		return bytes;
	};

	let seq = 0;
	/** An app whose `read_file_chunk` serves `file`, and a tab for it no other test has read (the bytes of a document are cached per key). */
	function served(file: Uint8Array): { readonly app: App; readonly tab: DocTab; readonly reads: number[] } {
		seq += 1;
		const reads: number[] = [];
		const app = {
			callServerTool: async (call: { readonly arguments?: Record<string, unknown> }) => {
				const offset = Number(call.arguments?.offset ?? 0);
				const length = Number(call.arguments?.length ?? 0);
				reads.push(offset);
				const part = file.slice(offset, offset + length);
				return { content: [], structuredContent: { base64: Buffer.from(part).toString("base64"), offset, length: part.length, size: file.length, eof: offset + part.length >= file.length } };
			},
		} as unknown as App;
		const filename = `take-${seq}.mp3`;
		const tab: DocTab = { key: `loadpeaks-${seq}`, path: `/music/${filename}`, filename, kind: "audio", size: file.length, mtimeMs: 1, revision: 0, annotateRequests: 0 };
		return { app, tab, reads };
	}

	/** What the engine's decoder was asked and made to do. */
	interface Heard {
		constructed: number;
		/** The bytes of every file `decodeAudioData` was handed. */
		readonly decoded: Uint8Array[];
		/** The channels read out of the sound. */
		readonly read: number[];
	}
	/** An engine whose decoder makes a sound of `length` samples: silent in its first half, loud in its second. `during` runs while it decodes. */
	function install(sound: { readonly length: number; readonly during?: () => void }): Heard {
		const heard: Heard = { constructed: 0, decoded: [], read: [] };
		const samples = new Float32Array(sound.length);
		samples.fill(0.8, sound.length / 2);
		Object.defineProperty(globalThis, "OfflineAudioContext", {
			configurable: true,
			writable: true,
			value: class {
				constructor() {
					heard.constructed += 1;
				}
				decodeAudioData(file: ArrayBuffer): Promise<unknown> {
					heard.decoded.push(new Uint8Array(file));
					sound.during?.();
					return Promise.resolve({
						numberOfChannels: 1,
						length: sound.length,
						getChannelData: (index: number) => {
							heard.read.push(index);
							return samples;
						},
					});
				}
			},
		});
		return heard;
	}

	test.each<[string, Uint8Array, number]>([
		["bytes that are no recording the viewer knows, whatever length the player says", NOISE, 90],
		["an MP3 whose frames play 2.6 s, against a player that says 30 s", SONG, 30],
		["an MP3 with one stray byte before its first frame, though the player agrees with its frames", STRAY, 2.6],
		["an Ogg, whose length the player says is a plausible 10 s", containerOf(...ascii("OggS"), 0, 2), 10],
		["a FLAC, whose length the player says is a plausible 10 s", containerOf(...ascii("fLaC"), 0, 0, 0, 0x22), 10],
		["an M4A, whose length the player says is a plausible 10 s", containerOf(0, 0, 0, 0x20, ...ascii("ftypM4A ")), 10],
		["a WebM, whose length the player says is a plausible 10 s", containerOf(0x1a, 0x45, 0xdf, 0xa3, 0x9f), 10],
	])("%s: nothing is decoded, and the answer is a plain track", async (_what, file, said) => {
		// A decoder that would agree with the player: only the gate stands between these bytes and a picture.
		const heard = install({ length: Math.round(said * WAVEFORM_DECODE_RATE) });
		const { app, tab } = served(file);
		expect(await loadPeaks(app, tab, new AbortController().signal, said)).toBeNull();
		expect(heard.constructed).toBe(0);
		expect(heard.decoded).toHaveLength(0);
	});

	test("an MP3 whose frames play what the player says is decoded, from the file's own bytes, and its loudness comes back", async () => {
		const heard = install({ length: SONG_DECODED });
		const { app, tab } = served(SONG);
		const peaks = await loadPeaks(app, tab, new AbortController().signal, 2.6);
		expect(peaks).not.toBeNull();
		expect(peaks).toHaveLength(WAVEFORM_BUCKETS);
		// The sound's second half is the loud one: the picture is that sound's, not a blank.
		expect(peaks?.[0]).toBe(0);
		expect(peaks?.at(-1)).toBe(1);
		expect(heard.constructed).toBe(1);
		expect(heard.decoded).toHaveLength(1);
		expect(Buffer.from(heard.decoded[0] as Uint8Array).equals(Buffer.from(SONG))).toBe(true);
	});

	test("a WAV is judged on its own header and decoded from its own bytes, and its loudness comes back", async () => {
		const wav = wavOf(2);
		const heard = install({ length: 2 * WAVEFORM_DECODE_RATE });
		const { app, tab } = served(wav);
		const peaks = await loadPeaks(app, tab, new AbortController().signal, 2);
		expect(peaks).toHaveLength(WAVEFORM_BUCKETS);
		expect(peaks?.[0]).toBe(0);
		expect(peaks?.at(-1)).toBe(1);
		expect(heard.decoded).toHaveLength(1);
		expect(Buffer.from(heard.decoded[0] as Uint8Array).equals(Buffer.from(wav))).toBe(true);
	});

	test("a file the gate lets through whose sound is not the length the player gave (a header that lied) is a plain track, and no channel is read out", async () => {
		// The same frames, the same 2.6 s from the player; the decoder makes 10 s of sound out of them.
		const heard = install({ length: 10 * WAVEFORM_DECODE_RATE });
		const { app, tab } = served(SONG);
		expect(await loadPeaks(app, tab, new AbortController().signal, 2.6)).toBeNull();
		expect(heard.constructed).toBe(1);
		expect(heard.read).toHaveLength(0);
	});

	test("a pane that went away ends it: before the file is read, and while the sound is being decoded", async () => {
		const before = new AbortController();
		before.abort();
		const idle = install({ length: SONG_DECODED });
		const first = served(SONG);
		await expect(loadPeaks(first.app, first.tab, before.signal, 2.6)).rejects.toBeDefined();
		expect(first.reads).toHaveLength(0);
		expect(idle.constructed).toBe(0);

		const during = new AbortController();
		const heard = install({ length: SONG_DECODED, during: () => during.abort() });
		const second = served(SONG);
		await expect(loadPeaks(second.app, second.tab, during.signal, 2.6)).rejects.toBeDefined();
		expect(heard.decoded).toHaveLength(1);
		expect(heard.read).toHaveLength(0);
	});
});
