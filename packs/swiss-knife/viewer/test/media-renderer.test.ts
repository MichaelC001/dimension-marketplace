import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import audio from "../app/view/renderers/audio";
import type { MountContext, Renderer } from "../app/view/renderers/types";
import video from "../app/view/renderers/video";
import { installDom, stage, type TestDom } from "./dom";

const RECORDING_URL = "http://127.0.0.1:45678/media/0123456789abcdef0123456789abcdef0123456789abcdef";
const MP4 = "video/mp4";
const MKV = "video/x-matroska";
const WEBM = "video/webm";
const MP3 = "audio/mpeg";
const NO_BYTES = new Uint8Array();
const ctx = (filename: string, mime: string): MountContext => ({ filename, theme: "dark", mediaSource: { url: RECORDING_URL, mime } });

/** The parts of linkedom's window these tests reach into; it is not the DOM lib's `Window`. */
interface StubWindow {
	Event: typeof Event;
	HTMLElement: { prototype: Record<string, unknown> };
	setTimeout: unknown;
	clearTimeout: unknown;
}
/** What an element is told its engine would say. */
type StubMedia = HTMLElement & { error?: { code: number } };

let dom: TestDom;
let win: StubWindow;
const made: Blob[] = [];
const revoked: string[] = [];
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
let canPlay = "maybe";
const calls = { pause: 0, load: 0 };
const STUBBED = ["pause", "load", "play", "canPlayType", "src"] as const;

beforeAll(() => {
	dom = installDom();
	// linkedom's window is not the DOM lib's `Window`; this file reads the few members it needs through `StubWindow`.
	win = dom.document.defaultView as unknown as StubWindow;
	Object.assign(win.HTMLElement.prototype, {
		pause() {
			calls.pause += 1;
		},
		load() {
			calls.load += 1;
		},
		play: async () => undefined,
		canPlayType: () => canPlay,
	});
	Object.defineProperty(win.HTMLElement.prototype, "src", {
		configurable: true,
		get: function (this: HTMLElement): string {
			return this.getAttribute("src") ?? "";
		},
		set: function (this: HTMLElement, value: string): void {
			this.setAttribute("src", value);
		},
	});
	URL.createObjectURL = (blob: Blob | MediaSource) => {
		made.push(blob as Blob);
		return `blob:test/${made.length}`;
	};
	URL.revokeObjectURL = (url: string) => void revoked.push(url);
});

afterAll(() => {
	URL.createObjectURL = original.create;
	URL.revokeObjectURL = original.revoke;
	for (const name of STUBBED) delete win.HTMLElement.prototype[name];
	dom.restore();
});

afterEach(() => {
	made.length = 0;
	revoked.length = 0;
	calls.pause = 0;
	calls.load = 0;
	canPlay = "maybe";
	dom.document.body.replaceChildren();
});

/** Mount, then tell the element what its engine would: it opened, or it failed with this code. */
async function mounted(renderer: Renderer, mime: string, name: string, outcome: "opened" | { error: number }) {
	const el = stage(dom.document);
	const pending = renderer.mount(el, NO_BYTES, ctx(name, mime));
	await Promise.resolve();
	const media: StubMedia | null = el.querySelector('[data-slot="viewer-media"]');
	if (media === null) throw new Error("the renderer mounted no media element");
	if (outcome === "opened") {
		media.dispatchEvent(new win.Event("loadedmetadata"));
	} else {
		media.error = { code: outcome.error };
		media.dispatchEvent(new win.Event("error"));
	}
	return { el, media, pending };
}

describe("a recording that opens", () => {
	test.each([
		["video", video, "take.mp4", MP4],
		["audio", audio, "take.mp3", MP3],
	] as const)("%s plays the leased URL itself, with no native controls and a dock under it for the transport", async (tag, renderer, filename, mime) => {
		const { el, media, pending } = await mounted(renderer, mime, filename, "opened");
		await pending;
		expect(media.tagName.toLowerCase()).toBe(tag);
		expect(media.getAttribute("src")).toBe(RECORDING_URL);
		expect(media.getAttribute("controls")).toBeNull();
		expect(media.getAttribute("preload") ?? Reflect.get(media, "preload")).toBe("metadata");
		expect(media.getAttribute("crossorigin") ?? Reflect.get(media, "crossOrigin")).toBe("anonymous");
		expect(el.querySelector('[data-slot="viewer-media-dock"]')).not.toBeNull();
		// The dock sits AFTER the element's stage: the transport is under the picture, not over it.
		const parts = [...(el.querySelector(".vw-media")?.children ?? [])].map(child => child.className);
		expect(parts).toEqual(["vw-media-stage", "vw-media-dock"]);
		expect(made).toEqual([]);
	});

	test("a sound gets a card with its name, set as text and never as markup", async () => {
		const hostile = '<img src=x onerror="alert(1)">.mp3';
		const { el, pending } = await mounted(audio, MP3, hostile, "opened");
		await pending;
		const card = el.querySelector('[data-slot="viewer-media-card"]');
		expect(card?.querySelector(".vw-media-name")?.textContent).toBe(hostile);
		expect(card?.querySelector("img")).toBeNull();
	});

	test("destroy lets go of the decoder and the DOM, and revokes no URL: the address is the server's, not an object URL's", async () => {
		const { el, media, pending } = await mounted(video, MP4, "take.mp4", "opened");
		const handle = await pending;
		expect(media.getAttribute("src")).toBe(RECORDING_URL);
		handle.destroy();
		expect(el.querySelector(".vw-media")).toBeNull();
		expect(calls.pause).toBeGreaterThan(0);
		// The source is dropped and the element told to reload with none: that is what frees the decoder.
		expect(media.getAttribute("src")).toBeNull();
		expect(calls.load).toBeGreaterThan(0);
		expect(revoked).toEqual([]);
	});

	test("it offers no zoom and no pages: a recording has neither", async () => {
		const { pending } = await mounted(video, MP4, "take.mp4", "opened");
		const handle = await pending;
		expect(handle.zoom).toBeUndefined();
		expect(handle.goto).toBeUndefined();
		expect(handle.pageCount).toBeUndefined();
		handle.destroy();
	});
});

describe("a recording that will not open", () => {
	test("a viewer that does not know the container says which one, in one sentence, and leaves nothing behind", async () => {
		canPlay = "";
		const { el, media, pending } = await mounted(video, MKV, "take.mkv", { error: 4 });
		await expect(pending).rejects.toThrow("The viewer cannot play Matroska files");
		expect(el.querySelector(".vw-media")).toBeNull();
		expect(media.getAttribute("src")).toBeNull();
		expect(calls.load).toBeGreaterThan(0);
	});

	test("a container it knows with a codec it cannot play is a codec problem, not a container problem", async () => {
		canPlay = "maybe";
		const { pending } = await mounted(video, MP4, "take.mp4", { error: 4 });
		await expect(pending).rejects.toThrow("The viewer cannot play this file's codec");
	});

	test("a damaged file is called damaged", async () => {
		const { pending } = await mounted(audio, MP3, "take.mp3", { error: 3 });
		await expect(pending).rejects.toThrow(/damaged/);
	});

	test("a file that never reports its length is given up on, with a sentence, not a spinner for ever", async () => {
		const timers: (() => void)[] = [];
		const real = { set: win.setTimeout, clear: win.clearTimeout };
		win.setTimeout = (callback: () => void) => timers.push(callback);
		win.clearTimeout = () => undefined;
		try {
			const el = stage(dom.document);
			const pending = video.mount(el, NO_BYTES, ctx("take.mp4", MP4));
			await Promise.resolve();
			expect(timers).toHaveLength(1);
			timers[0]?.();
			await expect(pending).rejects.toThrow("This file took too long to open.");
			expect(el.querySelector(".vw-media")).toBeNull();
			expect(calls.load).toBeGreaterThan(0);
		} finally {
			win.setTimeout = real.set;
			win.clearTimeout = real.clear;
		}
	});

	test.each([
		["video", video],
		["audio", audio],
	] as const)("%s given no source to play from says so in one sentence and appends nothing to the stage", async (_tag, renderer) => {
		const el = stage(dom.document);
		const settled = renderer.mount(el, Uint8Array.of(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70), { filename: "take.mp4", theme: "dark" }).then(
			() => "mounted",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await hop();
		expect(el.childElementCount).toBe(0);
		expect(made).toEqual([]);
		expect(await settled).toBe("This recording has no source to play from.");
	});
});

/** The element a mount made, set up the way an engine that has just reported `loadedmetadata` would leave it. */
function opening(el: HTMLElement, duration: number): HTMLMediaElement {
	const media = el.querySelector('[data-slot="viewer-media"]') as HTMLMediaElement;
	Object.assign(media, { duration, currentTime: 0 });
	return media;
}
const hop = async (): Promise<void> => {
	for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe("a recording that does not say how long it is", () => {
	test("is asked for its length before anything reads it as zero: sought past the end, then put back at the start with the length it gave", async () => {
		const el = stage(dom.document);
		const pending = video.mount(el, NO_BYTES, ctx("capture.webm", WEBM));
		await hop();
		const media = opening(el, Number.POSITIVE_INFINITY);
		media.dispatchEvent(new win.Event("loadedmetadata"));
		await hop();
		expect(media.currentTime).toBe(Number.MAX_SAFE_INTEGER);
		Object.assign(media, { duration: 42 });
		media.dispatchEvent(new win.Event("durationchange"));
		const handle = await pending;
		expect(media.currentTime).toBe(0);
		expect(media.duration).toBe(42);
		handle.destroy();
	});

	test("one that still will not say after the seek is opened all the same, at the start: it is played, and its marks use the time heard", async () => {
		const el = stage(dom.document);
		const pending = audio.mount(el, NO_BYTES, ctx("capture.mp3", MP3));
		await hop();
		const media = opening(el, Number.POSITIVE_INFINITY);
		media.dispatchEvent(new win.Event("loadedmetadata"));
		await hop();
		media.dispatchEvent(new win.Event("seeked"));
		const handle = await pending;
		expect(media.currentTime).toBe(0);
		expect(media.duration).toBe(Number.POSITIVE_INFINITY);
		expect(el.querySelector(".vw-media")).not.toBeNull();
		handle.destroy();
	});

	test("a recording that says its length is not sought at all", async () => {
		const el = stage(dom.document);
		const pending = video.mount(el, NO_BYTES, ctx("take.mp4", MP4));
		await hop();
		const media = opening(el, 90);
		media.dispatchEvent(new win.Event("loadedmetadata"));
		const handle = await pending;
		expect(media.currentTime).toBe(0);
		handle.destroy();
	});
});

describe("a pane that goes away while a recording is still opening", () => {
	const gone = (): Error => new Error("the pane went away");

	test("stops the wait at once, not at the twenty seconds it would run to, and leaves nothing behind", async () => {
		const controller = new AbortController();
		const el = stage(dom.document);
		const pending = video.mount(el, NO_BYTES, { ...ctx("take.mp4", MP4), signal: controller.signal });
		await hop();
		expect(el.querySelector(".vw-media")).not.toBeNull();
		controller.abort(gone());
		await expect(pending).rejects.toThrow("the pane went away");
		expect(el.querySelector(".vw-media")).toBeNull();
		expect(calls.load).toBeGreaterThan(0);
	});

	test("…and so does a pane that goes while the length is still being asked for", async () => {
		const controller = new AbortController();
		const el = stage(dom.document);
		const pending = video.mount(el, NO_BYTES, { ...ctx("capture.webm", WEBM), signal: controller.signal });
		await hop();
		const media = opening(el, Number.POSITIVE_INFINITY);
		media.dispatchEvent(new win.Event("loadedmetadata"));
		await hop();
		controller.abort(gone());
		await expect(pending).rejects.toThrow("the pane went away");
		expect(el.querySelector(".vw-media")).toBeNull();
		expect(calls.load).toBeGreaterThan(0);
	});

	test("one that was gone before it began makes nothing at all", async () => {
		const controller = new AbortController();
		controller.abort(gone());
		const el = stage(dom.document);
		await expect(video.mount(el, NO_BYTES, { ...ctx("take.mp4", MP4), signal: controller.signal })).rejects.toThrow("the pane went away");
		expect(el.childElementCount).toBe(0);
	});

	test("a recording that opened before the pane went is the pane's to destroy: abort afterwards does not touch it", async () => {
		const controller = new AbortController();
		const el = stage(dom.document);
		const pending = video.mount(el, NO_BYTES, { ...ctx("take.mp4", MP4), signal: controller.signal });
		await hop();
		opening(el, 90).dispatchEvent(new win.Event("loadedmetadata"));
		const handle = await pending;
		controller.abort(gone());
		expect(el.querySelector(".vw-media")).not.toBeNull();
		expect(calls.load).toBe(0);
		handle.destroy();
		expect(el.querySelector(".vw-media")).toBeNull();
	});
});
