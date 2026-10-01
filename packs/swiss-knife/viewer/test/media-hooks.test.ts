// What the timeline pane keeps about a recording, held to how often it may change.
//
// useDuration: a recording that does not say how long it is moves "how far it can be played so far" with the
// playhead four times a second. The pane draws nothing from that, so it must not be re-rendered for it - the marks list
// and every note field in it went with it.
//
// useWaveform: a decode cannot be cancelled, so every restart of one is another copy of the file and another decode
// running beside the one left behind. Re-asking Annotate on an open tab (a new tab object) and switching tabs back and
// forth must not start one. Rendered for real (linkedom + react-dom under `act`); the decoder is a stand-in the test
// settles by hand.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { createElement } from "react";
import { type PeaksLoader, useDuration, useFailed, useWaveform } from "../app/view/media-hooks";
import { WAVEFORM_MAX_BYTES } from "../app/view/media-waveform";
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

describe("useWaveform: one decode per file", () => {
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
		finish(values: Float32Array | null): void;
		fail(error: Error): void;
	}
	/** A decoder the test settles by hand: every call is a decode that has started and not finished. */
	function decoder() {
		const runs: Run[] = [];
		const load: PeaksLoader = (_app, tab, signal) => new Promise<Float32Array | null>((finish, fail) => runs.push({ tab, signal, finish, fail }));
		return { runs, load };
	}
	const PEAKS = Float32Array.from([0.2, 1, 0.4]);
	const seen: { value: Float32Array | undefined } = { value: undefined };
	function Probe({ tab, startable, load }: { tab: DocTab; startable: boolean; load: PeaksLoader }): null {
		seen.value = useWaveform(app, tab, startable, load);
		return null;
	}
	afterEach(() => {
		seen.value = undefined;
	});
	const element = (tab: DocTab, startable: boolean, load: PeaksLoader) => createElement(Probe, { tab, startable, load });

	test("nothing is decoded until the sound is on screen, and then once", async () => {
		const { runs, load } = decoder();
		const { render } = await env.mount(element(tabOf(), false, load));
		expect(runs).toHaveLength(0);
		await render(element(tabOf(), true, load));
		expect(runs).toHaveLength(1);
	});

	test("asking Annotate again on the open tab (a new tab object for the same file) neither restarts the decode nor stops it", async () => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const { render } = await env.mount(element(tab, true, load));
		await render(element({ ...tab, annotateRequests: 1 }, true, load));
		await render(element({ ...tab, annotateRequests: 2, revision: 3 }, true, load));
		expect(runs).toHaveLength(1);
		expect(runs[0]?.signal.aborted).toBe(false);
		await env.act(async () => runs[0]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
	});

	test("looking at another tab and coming back neither restarts the decode nor stops it: it finishes while the human is away", async () => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const { render } = await env.mount(element(tab, true, load));
		await render(element(tab, false, load));
		expect(runs[0]?.signal.aborted).toBe(false);
		await env.act(async () => runs[0]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
		await render(element(tab, true, load));
		await render(element(tab, false, load));
		await render(element(tab, true, load));
		expect(runs).toHaveLength(1);
		expect(seen.value).toBe(PEAKS);
	});

	test("a decode that failed is a plain track, and is not tried again each time the tab is shown", async () => {
		const { runs, load } = decoder();
		const tab = tabOf();
		const { render } = await env.mount(element(tab, true, load));
		await env.act(async () => runs[0]?.fail(new Error("this engine cannot decode it")));
		await render(element(tab, false, load));
		await render(element(tab, true, load));
		expect(runs).toHaveLength(1);
		expect(seen.value).toBeUndefined();
	});

	test("a plain track when the loader finds nothing to draw", async () => {
		const { runs, load } = decoder();
		await env.mount(element(tabOf(), true, load));
		await env.act(async () => runs[0]?.finish(null));
		expect(seen.value).toBeUndefined();
	});

	test("the file changing on disk stops the old decode and starts the new one; the old file's picture is not the new file's", async () => {
		const { runs, load } = decoder();
		const { render } = await env.mount(element(tabOf({ mtimeMs: 1 }), true, load));
		await env.act(async () => runs[0]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
		await render(element(tabOf({ mtimeMs: 2 }), true, load));
		expect(seen.value).toBeUndefined();
		expect(runs).toHaveLength(2);
		const NEW = Float32Array.from([0.9, 0.1]);
		await env.act(async () => runs[1]?.finish(NEW));
		expect(seen.value).toBe(NEW);
	});

	test("a decode still running when the file changes is stopped, and its late answer is not drawn for the new file", async () => {
		const { runs, load } = decoder();
		const { render } = await env.mount(element(tabOf({ mtimeMs: 1 }), true, load));
		await render(element(tabOf({ mtimeMs: 2 }), true, load));
		expect(runs).toHaveLength(2);
		expect(runs[0]?.signal.aborted).toBe(true);
		expect(runs[1]?.signal.aborted).toBe(false);
		await env.act(async () => runs[0]?.finish(Float32Array.from([1, 1])));
		expect(seen.value).toBeUndefined();
		await env.act(async () => runs[1]?.finish(PEAKS));
		expect(seen.value).toBe(PEAKS);
	});

	test("a file too big to count the cost of is never decoded", async () => {
		const { runs, load } = decoder();
		await env.mount(element(tabOf({ size: WAVEFORM_MAX_BYTES + 1 }), true, load));
		expect(runs).toHaveLength(0);
		const { runs: more, load: again } = decoder();
		await env.mount(element(tabOf({ size: WAVEFORM_MAX_BYTES }), true, again));
		expect(more).toHaveLength(1);
	});

	test("the pane going away stops the decode", async () => {
		const { runs, load } = decoder();
		const { unmount } = await env.mount(element(tabOf(), true, load));
		await unmount();
		expect(runs[0]?.signal.aborted).toBe(true);
	});
});
