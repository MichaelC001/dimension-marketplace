// What the pane says it can do about a recording it could not play. "Try again" is for a failure a second try can fix;
// for the others it is a button that does nothing, and the real next step is to take the file to a media player - so
// the pane offers Copy path there, and the human is only told "Path copied" when the path was copied.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ViewerKind } from "../src/contract";
import { VIEWER_KINDS } from "../src/contract";
import { failureAction, isRecording, type RecordingFailure } from "../app/view/media-failure";
import { describeMediaError, OPEN_TIMEOUT_SENTENCE } from "../app/view/media-messages";
import { useCopied } from "../app/view/use-copied";
import { installReact, type ReactEnv } from "./media-react";

describe("which failures offer which action", () => {
	const chromiumCouldNotOpen = "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed";
	const chromiumNoStreams = "DEMUXER_ERROR_NO_SUPPORTED_STREAMS: FFmpegDemuxer: no supported streams";
	test.each<[string, RecordingFailure, "try-again" | "copy-path"]>([
		["a read that failed", { where: "load", message: "The connection dropped" }, "try-again"],
		["the file changed while it was read", { where: "load", message: "The file changed while it was being read. Open it again." }, "try-again"],
		["a server that answered badly", { where: "load", message: "The viewer server sent a malformed chunk." }, "try-again"],
		["a player that never answered", { where: "open", message: OPEN_TIMEOUT_SENTENCE }, "try-again"],
		["a player whose own read of the bytes failed", { where: "open", message: describeMediaError("video", "video/mp4", true, 2) }, "try-again"],
		["bytes that do not open as a recording", { where: "open", message: describeMediaError("video", "video/mp4", true, 4, chromiumCouldNotOpen) }, "copy-path"],
		["a codec the viewer lacks", { where: "open", message: describeMediaError("video", "video/mp4", true, 4) }, "copy-path"],
		["streams the viewer cannot decode", { where: "open", message: describeMediaError("video", "video/x-matroska", false, 4, chromiumNoStreams) }, "copy-path"],
		["a container the viewer does not know", { where: "open", message: describeMediaError("audio", undefined, false, 4) }, "copy-path"],
		["a recording that could not be decoded", { where: "open", message: describeMediaError("audio", "audio/mpeg", true, 3) }, "copy-path"],
		["a player that gave no reason", { where: "open", message: describeMediaError("video", "video/mp4", true, 1) }, "copy-path"],
	])("%s", (_what, failure, action) => {
		expect(failureAction(failure)).toBe(action);
	});

	test("a retry offered for a failure of the file would loop the human through the same sentence: every sentence about the file offers the way out", () => {
		for (const code of [3, 4, undefined, 1, 5]) {
			for (const known of [true, false]) {
				for (const detail of [undefined, chromiumCouldNotOpen, chromiumNoStreams, "DECODER_ERROR_NOT_SUPPORTED"]) {
					const message = describeMediaError("video", "video/webm", known, code, detail);
					expect(failureAction({ where: "open", message })).toBe("copy-path");
				}
			}
		}
	});
});

describe("which kinds are recordings", () => {
	test("audio and video are; nothing else the viewer opens is, so no other kind's error card changes", () => {
		const recordings = VIEWER_KINDS.filter((kind: ViewerKind) => isRecording(kind));
		expect(recordings).toEqual(["audio", "video"]);
	});
});

describe("Path copied", () => {
	let env: ReactEnv;
	let written: string[] = [];
	let clipboardWorks = true;
	// The window's timers: the stand-in DOM has none of its own, so they are a queue the test fires by hand.
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	const original = { clipboard: Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard") };
	// linkedom's windows share their timers: what is replaced here has to be put back for every file that runs after.
	let realTimers: Pick<typeof window, "setTimeout" | "clearTimeout">;
	beforeAll(async () => {
		env = await installReact();
		realTimers = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout };
		Object.assign(window, {
			setTimeout: (callback: () => void) => {
				timers.set(nextTimer, callback);
				return nextTimer++;
			},
			clearTimeout: (handle: number) => void timers.delete(handle),
		});
		Object.defineProperty(globalThis.navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					if (!clipboardWorks) throw new Error("denied");
					written.push(text);
				},
			},
		});
		// What the legacy path needs of the document when the async clipboard is withheld: it, too, fails.
		Object.assign(document, { execCommand: () => false });
		Object.defineProperty(window.HTMLElement.prototype, "select", { configurable: true, value: () => undefined });
	});
	afterEach(async () => {
		await env.cleanup();
		written = [];
		clipboardWorks = true;
		timers.clear();
	});
	afterAll(() => {
		Object.assign(window, realTimers);
		if (original.clipboard) Object.defineProperty(globalThis.navigator, "clipboard", original.clipboard);
		else delete (globalThis.navigator as unknown as Record<string, unknown>).clipboard;
		env.restore();
	});

	let copiedNow = false;
	let copyNow: () => void = () => undefined;
	function Probe({ text }: { text: string }): null {
		const { copied, copy } = useCopied(text);
		copiedNow = copied;
		copyNow = copy;
		return null;
	}
	const copyIt = () => env.act(async () => copyNow());
	/** The moment passes. */
	const timeGoesBy = () =>
		env.act(async () => {
			for (const [handle, callback] of [...timers]) {
				timers.delete(handle);
				callback();
			}
		});

	test("copies the path it was given, says so, and goes back to saying nothing after its moment", async () => {
		await env.mount(createElement(Probe, { text: "C:\\media\\take.mp4" }));
		expect(copiedNow).toBe(false);
		await copyIt();
		expect(written).toEqual(["C:\\media\\take.mp4"]);
		expect(copiedNow).toBe(true);
		await timeGoesBy();
		expect(copiedNow).toBe(false);
	});

	test("a copy that did not happen is not reported as one", async () => {
		clipboardWorks = false;
		await env.mount(createElement(Probe, { text: "C:\\media\\take.mp4" }));
		await copyIt();
		expect(written).toEqual([]);
		expect(copiedNow).toBe(false);
		expect(timers.size).toBe(0);
	});

	test("copying again while it still says copied gives it a whole moment from the last copy, not two overlapping ones", async () => {
		await env.mount(createElement(Probe, { text: "p" }));
		await copyIt();
		await copyIt();
		expect(copiedNow).toBe(true);
		expect(timers.size).toBe(1);
		await timeGoesBy();
		expect(copiedNow).toBe(false);
	});

	test("leaving while it still says copied leaves no moment running", async () => {
		const { unmount } = await env.mount(createElement(Probe, { text: "p" }));
		await copyIt();
		expect(timers.size).toBe(1);
		await unmount();
		expect(timers.size).toBe(0);
	});
});
