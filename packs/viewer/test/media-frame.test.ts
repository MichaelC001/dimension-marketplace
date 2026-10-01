// The stills a video gives at send time, and what happens to them when the pane goes away. A still
// is taken from a silent second element: opened, sought, drawn. Each of those waits up to eight
// seconds, and four stills are taken one after another - so a pane closed mid-send used to leave a
// detached video decoding for most of a minute. Here the waits are held to the clock they are
// meant to stop on (a test that waited eight seconds would fail on bun's own timeout).
// The drawing itself (canvas, JPEG) is judged in a real browser; linkedom has no canvas.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { FrameGrabber } from "../app/view/media-frame";
import { installDom, type TestDom } from "./dom";

interface StubWindow {
	Event: typeof Event;
	HTMLElement: { prototype: Record<string, unknown> };
	setTimeout: (callback: () => void, ms?: number) => number;
}

let dom: TestDom;
let win: StubWindow;
let realCreate: Document["createElement"];
/** The silent elements the grabber has made, in the order it made them. */
const clones: HTMLVideoElement[] = [];

beforeAll(() => {
	dom = installDom();
	win = dom.document.defaultView as unknown as StubWindow;
	Object.assign(win.HTMLElement.prototype, { load() {} });
	realCreate = dom.document.createElement.bind(dom.document);
	dom.document.createElement = ((tag: string) => {
		const element = realCreate(tag);
		if (tag === "video") {
			// What an element that has not opened yet reports; `src` reflects to its attribute, as in a browser.
			Object.assign(element, { currentTime: 0, duration: 60, videoWidth: 640, videoHeight: 360 });
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
