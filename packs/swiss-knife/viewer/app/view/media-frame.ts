// The video side of marking a moment: a still of the picture at a time (what the agent is
// shown beside "1. at 0:12.4 - cut the cough"), and the length of one frame (what `,` and `.`
// step by).
//
// A STILL is taken from a second, silent element on the same object URL, never from the
// player the human is watching. The player stays where it is and keeps playing; nothing
// seeks, flashes through four frames or loses its place while "Request edits" works. That
// is the doc's "seek, wait for `seeked`, draw, restore the playhead" with the restore made
// unnecessary. It encodes with `toDataURL`, not `toBlob`: the kit measured (paint.ts) that
// `toBlob` waits for an idle period, ~1 s each, on a page that is quiet while the human
// reads; the synchronous encoder costs what the pixels cost (a few ms at 768 px).
import { clampTime, type FrameGrab } from "@dimension/mcp-app-kit/annotate";

/** The long edge of a still, in pixels: enough to read a face or a caption, and ~60 KB. */
export const FRAME_LONG_EDGE = 768;
export const FRAME_QUALITY = 0.82;
/** Each wait in a grab (the element opening, a seek landing) gives up after this long. */
const GRAB_TIMEOUT_MS = 8000;
/** The silent element is dropped after this long without a grab. */
const IDLE_MS = 4000;

/** `width`x`height` scaled so the long edge is at most `longEdge`; never enlarged, never below 1 px. */
export function frameSize(width: number, height: number, longEdge: number = FRAME_LONG_EDGE): { width: number; height: number } {
	const scale = Math.min(1, longEdge / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const JPEG_PREFIX = "data:image/jpeg;base64,";

/** The bytes a `canvas.toDataURL("image/jpeg")` answer carries, or `null` when the answer is not a JPEG (an engine that cannot encode answers `data:,`). */
export function jpegBytes(dataUrl: string): Uint8Array | null {
	if (!dataUrl.startsWith(JPEG_PREFIX)) return null;
	const binary = atob(dataUrl.slice(JPEG_PREFIX.length));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes.length > 0 ? bytes : null;
}

/** Resolve on `type`, reject on the element's `error`, on the time running out, or on `signal`. The listeners are always removed. */
function once(target: HTMLMediaElement, type: string, what: string, signal: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const finish = (outcome: () => void): void => {
		window.clearTimeout(timer);
		target.removeEventListener(type, onDone);
		target.removeEventListener("error", onError);
		signal.removeEventListener("abort", onAbort);
		outcome();
	};
	const onDone = (): void => finish(resolve);
	const onError = (): void => finish(() => reject(new Error(`${what} failed`)));
	const onAbort = (): void => finish(() => reject(signal.reason));
	const timer = window.setTimeout(() => finish(() => reject(new Error(`${what} timed out`))), GRAB_TIMEOUT_MS);
	if (signal.aborted) {
		onAbort();
		return promise;
	}
	target.addEventListener(type, onDone);
	target.addEventListener("error", onError);
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/** Wait for `promise`, but not past `signal`: the wait ends the moment it aborts, and `promise` carries on unwatched. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	const { promise: gone, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, gone]).finally(() => signal.removeEventListener("abort", onAbort));
}

/**
 * Takes stills of one video. One silent element, opened on first use, one still at a time, let go of when idle.
 *
 * Nothing here can outlive its caller: a still asked for with a `signal` stops when it aborts, and `dispose()` (the
 * pane going away) stops the one in progress, refuses the ones queued behind it, and refuses any later.
 * A video that would not open once will not open again, so the stills still to take do not each wait it out.
 */
/**
 * A signal that aborts when either of two does. `AbortSignal.any` would say this in one call, but it
 * needs Safari 17.4 and the desktop app's macOS webview is whatever WebKit the machine has; this works
 * everywhere and removes its listeners once it fires.
 */
function eitherAborts(first: AbortSignal, second: AbortSignal): AbortSignal {
	const merged = new AbortController();
	const stop = (source: AbortSignal): void => {
		first.removeEventListener("abort", onFirst);
		second.removeEventListener("abort", onSecond);
		merged.abort(source.reason);
	};
	const onFirst = (): void => stop(first);
	const onSecond = (): void => stop(second);
	if (first.aborted) merged.abort(first.reason);
	else if (second.aborted) merged.abort(second.reason);
	else {
		first.addEventListener("abort", onFirst, { once: true });
		second.addEventListener("abort", onSecond, { once: true });
	}
	return merged.signal;
}

export class FrameGrabber {
	readonly #source: HTMLVideoElement;
	readonly #life = new AbortController();
	#clone: Promise<HTMLVideoElement> | null = null;
	#element: HTMLVideoElement | null = null;
	#openFailure: unknown;
	#queue: Promise<unknown> = Promise.resolve();
	#idle: number | undefined;

	constructor(source: HTMLVideoElement) {
		this.#source = source;
	}

	#open(): Promise<HTMLVideoElement> {
		if (this.#openFailure !== undefined) return Promise.reject(this.#openFailure);
		if (this.#clone === null) {
			const clone = document.createElement("video");
			clone.muted = true;
			clone.preload = "auto";
			clone.playsInline = true;
			const opened = once(clone, "loadeddata", "opening the video", this.#life.signal);
			// The player's own object URL: the bytes are shared, not copied or read again.
			clone.src = this.#source.currentSrc;
			this.#element = clone;
			this.#clone = opened.then(() => clone);
			this.#clone.catch(error => {
				this.#openFailure = error;
				this.release();
			});
		}
		return this.#clone;
	}

	/** A still of the video at `at` seconds. Stills are taken one after another, whoever asks. */
	grab(at: number, signal?: AbortSignal): Promise<FrameGrab> {
		const stop = signal === undefined ? this.#life.signal : eitherAborts(this.#life.signal, signal);
		const taken = this.#queue.then(() => this.#take(at, stop));
		this.#queue = taken.catch(() => undefined);
		return taken;
	}

	async #take(at: number, stop: AbortSignal): Promise<FrameGrab> {
		stop.throwIfAborted();
		window.clearTimeout(this.#idle);
		try {
			const clone = await until(this.#open(), stop);
			const target = clampTime(at, clone.duration);
			if (Math.abs(clone.currentTime - target) > 0.0005) {
				const landed = once(clone, "seeked", "seeking", stop);
				clone.currentTime = target;
				await landed;
			}
			if (clone.videoWidth === 0 || clone.videoHeight === 0) throw new Error("this video has no picture to take");
			const size = frameSize(clone.videoWidth, clone.videoHeight);
			const canvas = document.createElement("canvas");
			canvas.width = size.width;
			canvas.height = size.height;
			const context = canvas.getContext("2d");
			if (context === null) throw new Error("no 2D canvas");
			context.drawImage(clone, 0, 0, size.width, size.height);
			const bytes = jpegBytes(canvas.toDataURL("image/jpeg", FRAME_QUALITY));
			if (bytes === null) throw new Error("the picture could not be encoded");
			return { bytes, mimeType: "image/jpeg", width: size.width, height: size.height };
		} finally {
			if (!this.#life.signal.aborted) this.#idle = window.setTimeout(() => this.release(), IDLE_MS);
		}
	}

	/** Let go of the silent element (and the decoder behind it), whether or not it had finished opening. A later `grab` opens a new one. */
	release(): void {
		window.clearTimeout(this.#idle);
		const element = this.#element;
		this.#element = null;
		this.#clone = null;
		if (element === null) return;
		element.removeAttribute("src");
		element.load();
	}

	/** The pane is done with this video: stop what is in progress, refuse what is waiting or comes later, and let go of the element. */
	dispose(): void {
		this.#life.abort();
		this.release();
	}
}

// ── frame length ─────────────────────────────────────────────────────────

/** Frame durations outside this are not a frame rate: 240 fps to 4 fps. */
const MIN_FRAME_SECONDS = 1 / 240;
const MAX_FRAME_SECONDS = 0.25;

/**
 * The length of one frame, from the times (seconds) successive frames were put on screen. The smallest gap
 * is a frame; it is believed only when at least three gaps agree with it, so a dropped frame (a gap of two)
 * or a seek (a gap of anything) cannot pass for the rate. `null` while there is not enough to say.
 */
export function estimateFrameSeconds(presented: readonly number[]): number | null {
	const gaps: number[] = [];
	for (let index = 1; index < presented.length; index += 1) {
		const gap = (presented[index] as number) - (presented[index - 1] as number);
		if (gap >= MIN_FRAME_SECONDS && gap <= MAX_FRAME_SECONDS) gaps.push(gap);
	}
	if (gaps.length < 3) return null;
	const smallest = Math.min(...gaps);
	const agreeing = gaps.filter(gap => gap <= smallest * 1.2);
	return agreeing.length >= 3 ? agreeing.reduce((sum, gap) => sum + gap, 0) / agreeing.length : null;
}

/**
 * Where to seek to show the frame before (-1) or after (+1) the one showing, which began at `presented`. Not
 * exactly one frame away: a seek shows the frame whose interval holds the time, so landing on a boundary is
 * landing on either, depending on rounding. A tenth of a frame inside the neighbour is unambiguous.
 */
export function frameStepTarget(presented: number, frameSeconds: number, direction: 1 | -1): number {
	return Math.max(0, presented + frameSeconds * (direction + 0.1));
}

/** Frame rate assumed until playback has shown a real one. */
export const DEFAULT_FRAME_SECONDS = 1 / 30;
/** Presented times kept for the estimate. */
const KEEP_PRESENTED = 16;

/**
 * Watches a video's frames reach the screen (`requestVideoFrameCallback`) to learn how long a frame is, and
 * which one is showing. In an engine without it, a frame is 1/30 s and "showing" is the current time.
 */
export class FrameClock {
	readonly #video: HTMLVideoElement;
	#handle = 0;
	#presented: number[] = [];
	#seconds = DEFAULT_FRAME_SECONDS;
	#disposed = false;

	constructor(video: HTMLVideoElement) {
		this.#video = video;
		this.#watch();
	}

	/** The frame length in seconds. */
	get frameSeconds(): number {
		return this.#seconds;
	}

	/** When the frame now showing began; the playhead until a frame has been seen. */
	get showing(): number {
		return this.#presented.at(-1) ?? this.#video.currentTime;
	}

	#watch(): void {
		if (this.#disposed || typeof this.#video.requestVideoFrameCallback !== "function") return;
		this.#handle = this.#video.requestVideoFrameCallback((_now, metadata) => {
			const last = this.#presented.at(-1);
			// A seek puts a frame on screen too, with a time that says nothing about the rate; keep it as "showing" but not as a sample.
			if (last !== undefined && metadata.mediaTime < last) this.#presented = [];
			this.#presented.push(metadata.mediaTime);
			if (this.#presented.length > KEEP_PRESENTED) this.#presented.shift();
			this.#seconds = estimateFrameSeconds(this.#presented) ?? this.#seconds;
			this.#watch();
		});
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#handle !== 0) this.#video.cancelVideoFrameCallback?.(this.#handle);
	}
}
