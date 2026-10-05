// The stills a video gives at send time, and what happens to them when the pane goes away. A still
// is taken from a silent second element: opened, sought, drawn. Each of those waits up to eight
// seconds, and four stills are taken one after another - so a pane closed mid-send used to leave a
// detached video decoding for most of a minute. Here the waits are held to the clock they are
// meant to stop on (a test that waited eight seconds would fail on bun's own timeout).
// The drawing itself (canvas, JPEG) is judged in a real browser; linkedom has no canvas, so the encode path runs against a
// stub canvas that records the size and quality it was asked for and answers a JPEG (or not, when a test says so).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	drawnOnFrame,
	drawnRect,
	FRAME_LONG_EDGE,
	FRAME_QUALITY,
	FrameGrabber,
	frameAt,
	frameStepTarget,
	insideFrame,
	THUMB_LONG_EDGE,
	THUMB_QUALITY,
} from "../app/view/media-frame";
import { installDom, type TestDom } from "./dom";

interface StubWindow {
	Event: typeof Event;
	HTMLElement: { prototype: Record<string, unknown> };
	setTimeout: (callback: () => void, ms?: number) => number;
	clearTimeout: (id?: number) => void;
}

let dom: TestDom;
let win: StubWindow;
let realCreate: Document["createElement"];
/** The silent elements the grabber has made, in the order it made them. */
const clones: HTMLVideoElement[] = [];
/** A canvas that records what it is asked for. */
interface StubCanvas {
	width: number;
	height: number;
	/** The arguments of each `drawImage`, in order. */
	drawn: unknown[][];
	/** What each `toDataURL` asked for, with the size the canvas had at that moment. */
	asked: { type: string | undefined; quality: number | undefined; width: number; height: number }[];
	getContext(kind: string): { drawImage(...args: unknown[]): void };
	toDataURL(type?: string, quality?: number): string;
}
const JPEG_ANSWER = "data:image/jpeg;base64,/9j/4AAQ";
const JPEG_BYTES = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
/** What `toDataURL` answers; a test sets it to say "I cannot encode that". */
let encoderAnswer = JPEG_ANSWER;
/** The canvases the grabber has made, in order. */
const canvases: StubCanvas[] = [];
/** Every grabber a test makes, let go of after it so no idle timer outlives the test. */
const grabbers: FrameGrabber[] = [];

function stubCanvas(): StubCanvas {
	const canvas: StubCanvas = {
		width: 0,
		height: 0,
		drawn: [],
		asked: [],
		getContext: () => ({
			drawImage: (...args: unknown[]) => {
				canvas.drawn.push(args);
			},
		}),
		toDataURL: (type, quality) => {
			canvas.asked.push({ type, quality, width: canvas.width, height: canvas.height });
			return encoderAnswer;
		},
	};
	return canvas;
}

beforeAll(() => {
	dom = installDom();
	win = dom.document.defaultView as unknown as StubWindow;
	Object.assign(win.HTMLElement.prototype, { load() {} });
	realCreate = dom.document.createElement.bind(dom.document);
	dom.document.createElement = ((tag: string) => {
		if (tag === "canvas") {
			const canvas = stubCanvas();
			canvases.push(canvas);
			return canvas as unknown as HTMLElement;
		}
		const element = realCreate(tag);
		if (tag === "video") {
			// What an element that has not opened yet reports; `src` reflects to its attribute, as in a browser.
			Object.assign(element, { currentTime: 0, duration: 60, videoWidth: 1920, videoHeight: 1080 });
			Object.defineProperty(element, "src", {
				configurable: true,
				get: () => element.getAttribute("src") ?? "",
				set: (value: string) => element.setAttribute("src", value),
			});
			clones.push(element as unknown as HTMLVideoElement);
		}
		return element;
	}) as Document["createElement"];
});

afterAll(() => {
	dom.document.createElement = realCreate;
	delete win.HTMLElement.prototype.load;
	dom.restore();
});

afterEach(() => {
	clones.length = 0;
	canvases.length = 0;
	encoderAnswer = JPEG_ANSWER;
	for (const grabber of grabbers.splice(0)) grabber.dispose();
});

const source = { currentSrc: "blob:player" } as unknown as HTMLVideoElement;
const tell = (target: HTMLVideoElement, type: string): boolean => target.dispatchEvent(new win.Event(type));
/** Let the promise chains the grabber runs on settle: they hop through a few microtasks before they wait on the clock. */
const settle = async (): Promise<void> => {
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};
/** Open the silent element and let the grab get as far as waiting for its seek to land. */
async function reachSeek(): Promise<HTMLVideoElement> {
	await settle();
	const clone = clones.at(-1) as HTMLVideoElement;
	tell(clone, "loadeddata");
	await settle();
	return clone;
}

describe("a pane that goes away stops a still at once", () => {
	test("while the video is still opening - and the half-opened video is let go of, not left decoding", async () => {
		const grabber = new FrameGrabber(source);
		const still = grabber.grab(5);
		await settle();
		expect(clones).toHaveLength(1);
		expect(clones[0]?.getAttribute("src")).toBe("blob:player");
		grabber.dispose();
		await expect(still).rejects.toBeDefined();
		expect(clones[0]?.getAttribute("src")).toBeNull();
	});

	test("while a seek has not landed: not after the eight seconds it would wait", async () => {
		const grabber = new FrameGrabber(source);
		const still = grabber.grab(5);
		const clone = await reachSeek();
		expect(clone.currentTime).toBe(5);
		grabber.dispose();
		await expect(still).rejects.toBeDefined();
	});

	test("the stills queued behind the one in progress are refused with it, and so is any later one, without opening anything", async () => {
		const grabber = new FrameGrabber(source);
		const first = grabber.grab(5);
		const second = grabber.grab(10);
		const third = grabber.grab(15);
		await reachSeek();
		grabber.dispose();
		for (const still of [first, second, third]) await expect(still).rejects.toBeDefined();
		await expect(grabber.grab(20)).rejects.toBeDefined();
		expect(clones).toHaveLength(1);
	});

	test("…and a still that ends because the pane went leaves no timer behind to drop an element that is already gone", async () => {
		const delays: number[] = [];
		const real = win.setTimeout;
		win.setTimeout = (callback, ms) => {
			delays.push(ms ?? 0);
			return real(callback, ms);
		};
		try {
			const grabber = new FrameGrabber(source);
			const still = grabber.grab(5);
			await reachSeek();
			grabber.dispose();
			await expect(still).rejects.toBeDefined();
			await settle();
		} finally {
			win.setTimeout = real;
		}
		// The only timers are the eight-second waits on the open and the seek; the idle drop is a shorter one.
		expect(delays.length).toBeGreaterThan(0);
		expect(delays.every(ms => ms >= 8000)).toBe(true);
	});
});

describe("one still can be given up on without the rest", () => {
	test("aborting a still stops that one; the next is taken on the same element", async () => {
		const grabber = new FrameGrabber(source);
		const cancel = new AbortController();
		const first = grabber.grab(5, cancel.signal);
		const clone = await reachSeek();
		cancel.abort(new Error("not wanted"));
		await expect(first).rejects.toThrow("not wanted");
		const second = grabber.grab(8);
		await settle();
		// The same silent element, sent to the next moment; the seek is what it now waits on.
		expect(clones).toHaveLength(1);
		expect(clone.currentTime).toBe(8);
		tell(clone, "error");
		await expect(second).rejects.toThrow("seeking failed");
		grabber.dispose();
	});

	test("a still given up on while the video is still opening stops waiting for it at once; the video carries on opening for the next", async () => {
		const grabber = new FrameGrabber(source);
		const cancel = new AbortController();
		const first = grabber.grab(5, cancel.signal);
		await settle();
		cancel.abort(new Error("not wanted"));
		await expect(first).rejects.toThrow("not wanted");
		const second = grabber.grab(8);
		const clone = await reachSeek();
		expect(clones).toHaveLength(1);
		expect(clone.currentTime).toBe(8);
		grabber.dispose();
		await expect(second).rejects.toBeDefined();
	});

	test("a still already unwanted when its turn comes is never taken", async () => {
		const grabber = new FrameGrabber(source);
		const cancel = new AbortController();
		const first = grabber.grab(5);
		const second = grabber.grab(9, cancel.signal);
		cancel.abort(new Error("changed my mind"));
		const clone = await reachSeek();
		tell(clone, "error");
		await expect(first).rejects.toThrow("seeking failed");
		await expect(second).rejects.toThrow("changed my mind");
		expect(clone.currentTime).toBe(5);
		grabber.dispose();
	});
});

describe("a video that would not open is not opened again for every still", () => {
	test("the first still says why; the ones after fail at once, on the same answer, and open nothing", async () => {
		const grabber = new FrameGrabber(source);
		const first = grabber.grab(5);
		await settle();
		tell(clones[0] as HTMLVideoElement, "error");
		await expect(first).rejects.toThrow("opening the video failed");
		await expect(grabber.grab(10)).rejects.toThrow("opening the video failed");
		await expect(grabber.grab(15)).rejects.toThrow("opening the video failed");
		expect(clones).toHaveLength(1);
		grabber.dispose();
	});
});

describe("a still is asked for a time the video has", () => {
	// The silent element is parked at 10 s, so the seek it is asked to make is visible: `currentTime` is where it was sent.
	async function seekAskedFor(at: number, duration: number): Promise<number> {
		const grabber = new FrameGrabber(source);
		const still = grabber.grab(at);
		await settle();
		const clone = clones.at(-1) as HTMLVideoElement;
		Object.assign(clone, { duration, currentTime: 10 });
		tell(clone, "loadeddata");
		await settle();
		const asked = clone.currentTime;
		grabber.dispose();
		await expect(still).rejects.toBeDefined();
		return asked;
	}

	test.each([
		["a time past the end is the end", 500, 60, 60],
		["a time inside is itself", 12.5, 60, 12.5],
		["a time before the start is the start", -3, 60, 0],
		["a time that is not a number is the start: assigned to `currentTime` it would throw", Number.NaN, 60, 0],
		["a video with no end has no end to cut a time at", 500, Number.POSITIVE_INFINITY, 500],
		["...but still has a start", -3, Number.POSITIVE_INFINITY, 0],
		["...and still wants a number", Number.NaN, Number.POSITIVE_INFINITY, 0],
	] as const)("%s", async (_what, at, duration, expected) => {
		expect(await seekAskedFor(at, duration)).toBe(expected);
	});
});

// ── thumbnails: the film lane's small stills, in the same line as the full ones ─────────────────

const newGrabber = (): FrameGrabber => {
	const grabber = new FrameGrabber(source);
	grabbers.push(grabber);
	return grabber;
};
type Take = (grabber: FrameGrabber, at: number) => Promise<unknown>;
const takeStill: Take = (grabber, at) => grabber.grab(at);
const takeThumbnail: Take = (grabber, at) => grabber.thumbnail(at);
/** What a 1920x1080 picture becomes at a long edge. */
const at1080p = (longEdge: number): { width: number; height: number } => ({ width: longEdge, height: Math.round((longEdge * 9) / 16) });
/** Open the silent element, let the seek land: the still in front of the line is now being drawn and encoded. */
async function landSeek(): Promise<HTMLVideoElement> {
	const clone = await reachSeek();
	tell(clone, "seeked");
	await settle();
	return clone;
}

describe("a thumbnail is a small JPEG of the video at a time; a still is a big one", () => {
	test("a thumbnail is drawn over the whole canvas at the thumbnail size and quality, and is handed on as the canvas's own data URL", async () => {
		const thumb = newGrabber().thumbnail(5);
		const clone = await landSeek();
		const size = at1080p(THUMB_LONG_EDGE);
		await expect(thumb).resolves.toEqual({ src: JPEG_ANSWER, ...size });
		expect(canvases).toHaveLength(1);
		expect(canvases[0]?.asked).toEqual([{ type: "image/jpeg", quality: THUMB_QUALITY, ...size }]);
		const drawn = canvases[0]?.drawn ?? [];
		expect(drawn).toHaveLength(1);
		expect(drawn[0]?.[0]).toBe(clone);
		expect(drawn[0]?.slice(1)).toEqual([0, 0, size.width, size.height]);
	});

	test("a still is the other shape: the still's size and quality, its bytes the decoded JPEG", async () => {
		const still = newGrabber().grab(5);
		await landSeek();
		const size = at1080p(FRAME_LONG_EDGE);
		await expect(still).resolves.toEqual({ bytes: JPEG_BYTES, mimeType: "image/jpeg", ...size });
		expect(canvases[0]?.asked).toEqual([{ type: "image/jpeg", quality: FRAME_QUALITY, ...size }]);
	});

	test.each([
		["a still, when the engine can only answer `data:,`", takeStill, "data:,"],
		["a still, when the engine answers a PNG", takeStill, "data:image/png;base64,iVBORw0KGgo="],
		["a thumbnail, when the engine can only answer `data:,`", takeThumbnail, "data:,"],
		["a thumbnail, when the engine answers a PNG", takeThumbnail, "data:image/png;base64,iVBORw0KGgo="],
	] as const)("%s, is refused as not encoded, and the line is not stuck behind it", async (_what, take, answer) => {
		const grabber = newGrabber();
		encoderAnswer = answer;
		const taken = take(grabber, 5);
		await landSeek();
		await expect(taken).rejects.toThrow("could not be encoded");
		// The next one at the same moment needs no seek: the element is where it was sent.
		encoderAnswer = JPEG_ANSWER;
		await expect(take(grabber, 5)).resolves.toBeDefined();
	});
});

describe("a thumbnail and a full still wait in one line", () => {
	test.each([
		["a thumbnail behind a still", takeStill, FRAME_LONG_EDGE, takeThumbnail, THUMB_LONG_EDGE],
		["a still behind a thumbnail", takeThumbnail, THUMB_LONG_EDGE, takeStill, FRAME_LONG_EDGE],
	] as const)("%s starts only once the one in front has ended", async (_what, ahead, aheadEdge, behind, behindEdge) => {
		const grabber = newGrabber();
		const first = ahead(grabber, 3);
		const second = behind(grabber, 7);
		const clone = await reachSeek();
		// Parked where the first was sent: the second has not been asked to seek, nor drawn anything.
		expect(clone.currentTime).toBe(3);
		expect(canvases).toHaveLength(0);
		tell(clone, "seeked");
		await first;
		await settle();
		expect(clone.currentTime).toBe(7);
		expect(canvases).toHaveLength(1);
		tell(clone, "seeked");
		await second;
		expect(canvases.map(canvas => canvas.width)).toEqual([aheadEdge, behindEdge]);
		expect(clones).toHaveLength(1);
	});
});

describe("a thumbnail can be given up on, like a still", () => {
	test("aborting one whose seek has not landed stops it at once, draws nothing, and the line moves on to the next", async () => {
		const grabber = newGrabber();
		const cancel = new AbortController();
		const first = grabber.thumbnail(5, cancel.signal);
		const clone = await reachSeek();
		cancel.abort(new Error("not wanted"));
		await expect(first).rejects.toThrow("not wanted");
		expect(canvases).toHaveLength(0);
		const second = grabber.thumbnail(8);
		await settle();
		expect(clones).toHaveLength(1);
		expect(clone.currentTime).toBe(8);
		tell(clone, "seeked");
		await expect(second).resolves.toMatchObject({ src: JPEG_ANSWER });
		expect(canvases).toHaveLength(1);
	});

	test("one already unwanted when its turn comes behind a still is never taken", async () => {
		const grabber = newGrabber();
		const cancel = new AbortController();
		const still = grabber.grab(5);
		const thumb = grabber.thumbnail(9, cancel.signal);
		cancel.abort(new Error("changed my mind"));
		const clone = await reachSeek();
		tell(clone, "seeked");
		await expect(still).resolves.toMatchObject({ mimeType: "image/jpeg" });
		await expect(thumb).rejects.toThrow("changed my mind");
		expect(clone.currentTime).toBe(5);
		expect(canvases).toHaveLength(1);
	});

	test("the pane going away refuses the thumbnails queued behind the one in progress, and any later, without opening anything", async () => {
		const grabber = newGrabber();
		const first = grabber.thumbnail(5);
		const second = grabber.thumbnail(10);
		const third = grabber.grab(15);
		await reachSeek();
		grabber.dispose();
		for (const taken of [first, second, third]) await expect(taken).rejects.toMatchObject({ name: "AbortError" });
		await expect(grabber.thumbnail(20)).rejects.toMatchObject({ name: "AbortError" });
		expect(clones).toHaveLength(1);
		expect(canvases).toHaveLength(0);
	});
});

describe("a video that would not open is not opened again for a thumbnail, or by one", () => {
	test.each([
		["a still fails to open: a thumbnail after it fails the same way", takeStill, takeThumbnail],
		["a thumbnail fails to open: a still after it fails the same way", takeThumbnail, takeStill],
	] as const)("%s", async (_what, ahead, behind) => {
		const grabber = newGrabber();
		const first = ahead(grabber, 5);
		await settle();
		tell(clones[0] as HTMLVideoElement, "error");
		await expect(first).rejects.toThrow("opening the video failed");
		await expect(behind(grabber, 10)).rejects.toThrow("opening the video failed");
		expect(clones).toHaveLength(1);
	});
});

// ── a clone let go of before it opened ───────────────────────────────────────────────────────────

/** Timers by hand: the grabber's eight and four second waits are advanced, not slept. */
interface FakeClock {
	/** Run every timer that falls due within `ms` more, earliest first, and leave the clock `ms` later. */
	advance(ms: number): void;
}

/**
 * Run `body` with `window.setTimeout` and `clearTimeout` on a clock the test moves. The grabbers are let go of
 * before the real timers come back (their ids would mean something else to them). A macrotask is waited out at
 * the end because bun fails the test that is running when a rejection nobody handled is reported, and only
 * reports it once the microtasks have drained.
 */
async function onFakeClock(body: (clock: FakeClock) => Promise<void>): Promise<void> {
	const real = { setTimeout: win.setTimeout, clearTimeout: win.clearTimeout };
	const timers = new Map<number, { due: number; callback: () => void }>();
	let now = 0;
	let issued = 0;
	win.setTimeout = (callback, ms = 0) => {
		issued += 1;
		timers.set(issued, { due: now + ms, callback });
		return issued;
	};
	win.clearTimeout = id => {
		if (id !== undefined) timers.delete(id);
	};
	const clock: FakeClock = {
		advance(ms) {
			const end = now + ms;
			for (;;) {
				let next: [number, { due: number; callback: () => void }] | undefined;
				for (const entry of timers) if (entry[1].due <= end && (next === undefined || entry[1].due < next[1].due)) next = entry;
				if (next === undefined) break;
				timers.delete(next[0]);
				now = next[1].due;
				next[1].callback();
			}
			now = end;
		},
	};
	try {
		await body(clock);
	} finally {
		for (const grabber of grabbers.splice(0)) grabber.dispose();
		win.setTimeout = real.setTimeout;
		win.clearTimeout = real.clearTimeout;
	}
	await new Promise<void>(resolve => setImmediate(resolve));
}

describe("a clone let go of before it opened does not fail the video when it gives up", () => {
	/**
	 * A grab whose clone never loads, given up on: the idle drop lets go of that clone at 4 s - stripping its source
	 * before it opened - while the clone's own eight second wait on opening is still running.
	 */
	async function slowCloneLetGo(clock: FakeClock): Promise<FrameGrabber> {
		const grabber = newGrabber();
		const cancel = new AbortController();
		const first = grabber.grab(5, cancel.signal);
		await settle();
		const slow = clones[0] as HTMLVideoElement;
		cancel.abort(new Error("not wanted"));
		await expect(first).rejects.toThrow("not wanted");
		clock.advance(4000);
		expect(slow.getAttribute("src")).toBeNull();
		expect(clones).toHaveLength(1);
		return grabber;
	}

	test("…while the clone that replaced it is mid-use: that clone stays in use, and the video stays openable", () =>
		onFakeClock(async clock => {
			const grabber = await slowCloneLetGo(clock);
			const second = grabber.grab(8);
			await settle();
			expect(clones).toHaveLength(2);
			const fresh = clones[1] as HTMLVideoElement;
			let loads = 0;
			fresh.load = () => {
				loads += 1;
			};
			tell(fresh, "loadeddata");
			await settle();
			expect(fresh.currentTime).toBe(8);
			// 8 s in: the slow clone's wait on opening is over. The fresh one is part-way through its seek.
			clock.advance(4000);
			await settle();
			expect(fresh.getAttribute("src")).toBe("blob:player");
			expect(loads).toBe(0);
			tell(fresh, "seeked");
			await expect(second).resolves.toMatchObject({ mimeType: "image/jpeg" });
			// Not failed for good: the next still is taken on the same fresh clone.
			const third = grabber.grab(12);
			await settle();
			expect(fresh.currentTime).toBe(12);
			tell(fresh, "seeked");
			await expect(third).resolves.toMatchObject({ mimeType: "image/jpeg" });
			expect(clones).toHaveLength(2);
		}));

	test("…while nothing is in hand: the next still opens a new clone", () =>
		onFakeClock(async clock => {
			const grabber = await slowCloneLetGo(clock);
			clock.advance(4000);
			await settle();
			const second = grabber.grab(8);
			await settle();
			expect(clones).toHaveLength(2);
			await landSeek();
			await expect(second).resolves.toMatchObject({ mimeType: "image/jpeg" });
		}));

	test("the clone in hand failing to open is the video failing for good: later stills, or thumbnails, are refused at once, opening nothing, and the clone is let go of", () =>
		onFakeClock(async clock => {
			const grabber = newGrabber();
			const first = grabber.grab(5);
			await settle();
			clock.advance(8000);
			await expect(first).rejects.toThrow("opening the video timed out");
			await expect(grabber.grab(10)).rejects.toThrow("opening the video timed out");
			await expect(grabber.thumbnail(15)).rejects.toThrow("opening the video timed out");
			expect(clones).toHaveLength(1);
			expect(clones[0]?.getAttribute("src")).toBeNull();
		}));
});

describe("the size of the picture the player has", () => {
	test("is read from the player each time it is asked, and is 0 x 0 while the player has no picture", () => {
		const player = { currentSrc: "blob:player", videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement;
		const grabber = new FrameGrabber(player);
		grabbers.push(grabber);
		expect(grabber.size).toEqual({ width: 0, height: 0 });
		Object.assign(player, { videoWidth: 1280, videoHeight: 720 });
		expect(grabber.size).toEqual({ width: 1280, height: 720 });
		Object.assign(player, { videoWidth: 720, videoHeight: 1280 });
		expect(grabber.size).toEqual({ width: 720, height: 1280 });
	});
});

// ── drawing on a frame ─────────────────────────────────────────────────────────────────────────

/** Frame lengths a video can have: the common rates and the two ends of what `estimateFrameSeconds` accepts. */
const CADENCES = [
	["30 fps", 1 / 30],
	["60 fps", 1 / 60],
	["24 fps", 1 / 24],
	["240 fps, the shortest frame", 1 / 240],
	["4 fps, the longest frame", 0.25],
] as const;
/** Where frames begin: near the start, a minute in, an hour in, and a time on no frame grid. */
const frameStarts = (frame: number): number[] => [1, 2, 30, 1800, 107999].map(count => count * frame).concat(12.345);

describe("where the picture is drawn in its box", () => {
	const NONE = { left: 0, top: 0, width: 0, height: 0 };

	test.each([
		["a box wider than the video has bars left and right, and the picture the full height", [100, 100, 400, 200], { left: 100, top: 0, width: 200, height: 200 }],
		["a box taller than the video has bars above and below, and the picture the full width", [100, 100, 200, 400], { left: 0, top: 100, width: 200, height: 200 }],
		["a box the video's own size is filled", [1920, 1080, 1920, 1080], { left: 0, top: 0, width: 1920, height: 1080 }],
		["a smaller box of the video's shape is filled", [1920, 1080, 640, 360], { left: 0, top: 0, width: 640, height: 360 }],
		["a small video is enlarged to fill the box: 64x36 in 640x640 is drawn 640x360, centred", [64, 36, 640, 640], { left: 0, top: 140, width: 640, height: 360 }],
		["a portrait video in a landscape box is pillarboxed", [1080, 1920, 1920, 1080], { left: 656.25, top: 0, width: 607.5, height: 1080 }],
	] as const)("%s", (_what, [videoW, videoH, boxW, boxH], expected) => {
		const rect = drawnRect(videoW, videoH, boxW, boxH);
		expect(rect.left).toBeCloseTo(expected.left, 9);
		expect(rect.top).toBeCloseTo(expected.top, 9);
		expect(rect.width).toBeCloseTo(expected.width, 9);
		expect(rect.height).toBeCloseTo(expected.height, 9);
	});

	test.each([
		["a video with no picture yet reports 0x0", [0, 0, 640, 360]],
		["a video with no width", [0, 360, 640, 360]],
		["a video with no height", [640, 0, 640, 360]],
		["a box with no room", [640, 360, 0, 0]],
		["a box with no width", [640, 360, 0, 360]],
		["a box with no height", [640, 360, 640, 0]],
		["a negative video", [-640, 360, 640, 360]],
		["a negative box", [640, 360, -640, 360]],
		["a video whose size is not a number", [Number.NaN, 360, 640, 360]],
		["a box whose size is not a number", [640, 360, Number.NaN, 360]],
		["an unbounded video", [Number.POSITIVE_INFINITY, 360, 640, 360]],
		["an unbounded box", [640, 360, 640, Number.POSITIVE_INFINITY]],
	] as const)("there is nothing to draw on for %s", (_what, [videoW, videoH, boxW, boxH]) => {
		expect(drawnRect(videoW, videoH, boxW, boxH)).toEqual(NONE);
	});

	test("whatever the shapes, the picture keeps its shape, fits the box, touches it on one axis and sits in the middle", () => {
		const videos = [[1920, 1080], [1080, 1920], [64, 36], [640, 640], [1, 1], [4096, 16]] as const;
		const boxes = [[640, 360], [360, 640], [1000, 1000], [1, 1], [333, 777], [3840, 2160]] as const;
		for (const [videoW, videoH] of videos) {
			for (const [boxW, boxH] of boxes) {
				const where = `${videoW}x${videoH} in ${boxW}x${boxH}`;
				const { left, top, width, height } = drawnRect(videoW, videoH, boxW, boxH);
				const eps = 1e-9 * Math.max(boxW, boxH);
				expect(Math.abs(width / height - videoW / videoH) / (videoW / videoH), where).toBeLessThan(1e-9);
				expect(left, where).toBeGreaterThanOrEqual(-eps);
				expect(top, where).toBeGreaterThanOrEqual(-eps);
				expect(left + width, where).toBeLessThanOrEqual(boxW + eps);
				expect(top + height, where).toBeLessThanOrEqual(boxH + eps);
				expect(Math.min(Math.abs(boxW - width), Math.abs(boxH - height)), where).toBeLessThan(eps);
				expect(Math.abs(left - (boxW - width - left)), where).toBeLessThan(eps);
				expect(Math.abs(top - (boxH - height - top)), where).toBeLessThan(eps);
			}
		}
	});
});

describe("the time a drawing is given", () => {
	test.each(CADENCES)("%s: within a frame and a half of the presented frame it is that frame's start, so drawings on one frame share a time; farther off, the playhead itself", (_label, frame) => {
		for (const showing of frameStarts(frame)) {
			for (const offset of [-1.4, -1, -0.5, 0, 0.5, 0.99, 1, 1.4]) {
				expect(frameAt(showing, showing + offset * frame, frame), `${offset} frames from ${showing}`).toBe(showing);
			}
			for (const offset of [-10, -2, -1.6, 1.6, 2, 10]) {
				const playhead = showing + offset * frame;
				expect(frameAt(showing, playhead, frame), `${offset} frames from ${showing}`).toBe(playhead);
			}
		}
	});

	test("a frame and a half away is out (strict), a hair nearer is in, on either side", () => {
		// A quarter-second frame: 0.375 s is exactly one and a half of them, and every number here is exact in binary.
		expect(frameAt(10, 10.375, 0.25)).toBe(10.375);
		expect(frameAt(10, 9.625, 0.25)).toBe(9.625);
		expect(frameAt(10, 10.37, 0.25)).toBe(10);
		expect(frameAt(10, 9.63, 0.25)).toBe(10);
	});

	test("after a seek the presented frame is still the old one: the playhead is the time, forwards or back", () => {
		expect(frameAt(10, 95.2, 1 / 30)).toBe(95.2);
		expect(frameAt(95.2, 10, 1 / 30)).toBe(10);
	});
});

describe("which drawings are on screen with the playhead where it is", () => {
	test.each(CADENCES)("%s: a drawing is on screen from a tenth of a frame before its frame to the end of it, and not at the next frame's start", (_label, frame) => {
		const hair = frame * 1e-6;
		for (const at of frameStarts(frame)) {
			expect(drawnOnFrame(at, at - frame * 0.1, frame), `a tenth before ${at}`).toBe(true);
			expect(drawnOnFrame(at, at - frame * 0.1 - hair, frame), `a hair before that, ${at}`).toBe(false);
			expect(drawnOnFrame(at, at + frame - hair, frame), `a hair before the next frame, ${at}`).toBe(true);
			expect(drawnOnFrame(at, at + frame, frame), `the next frame's start, ${at}`).toBe(false);
			// Between the edges, sampled mid-tenth so no sample sits on one: in exactly from -0.1 to 1 frames.
			for (let tenth = -20; tenth <= 30; tenth += 1) {
				const fraction = (tenth + 0.5) / 10;
				expect(drawnOnFrame(at, at + fraction * frame, frame), `${fraction} frames from ${at}`).toBe(fraction >= -0.1 && fraction < 1);
			}
		}
	});

	test.each(CADENCES)("%s: stepping a frame either way leaves the drawing on screen and shows the neighbour's; seeking to insideFrame shows it", (_label, frame) => {
		for (const at of frameStarts(frame)) {
			const forward = frameStepTarget(at, frame, 1);
			const back = frameStepTarget(at, frame, -1);
			expect(drawnOnFrame(at, forward, frame), `forward from ${at}`).toBe(false);
			expect(drawnOnFrame(at, back, frame), `back from ${at}`).toBe(false);
			expect(drawnOnFrame(at + frame, forward, frame), `next frame's drawing, from ${at}`).toBe(true);
			expect(drawnOnFrame(at - frame, back, frame), `previous frame's drawing, from ${at}`).toBe(true);
			const seek = insideFrame(at, frame);
			expect(seek).toBeCloseTo(at + frame * 0.1, 9);
			expect(drawnOnFrame(at, seek, frame), `a seek into ${at}`).toBe(true);
		}
	});

	test.each(CADENCES)("%s: stepping back from the very first frame goes nowhere, so its drawing stays", (_label, frame) => {
		expect(drawnOnFrame(0, frameStepTarget(0, frame, -1), frame)).toBe(true);
	});
});
