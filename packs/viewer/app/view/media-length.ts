// How long a recording is, as the player and the marks need to know it.
//
// A recording usually says: `duration` is a number of seconds. A capture made as it was recorded
// (a browser's MediaRecorder writes WebM this way) often does not - its header never got the length,
// and the element reports `Infinity`. Treating that as 0 was the failure to avoid: every seek clamped
// to [0, 0] and every mark was stamped 0:00 for a moment that was not at 0:00, with full confidence.
//
// So the length is asked for properly first (`resolveLength`: seek past the end and the engine, which
// has to read to the end to honour that, learns the real one), and a recording that still will not say
// is called UNBOUNDED: it has a start and no end. Its marks are made at the time the human hears, kept
// at or after the start only, and the transport says so in one sentence.
import { clampTime, seekForKey } from "@dimension/mcp-app-kit/annotate";

/** What a person is told while they mark a recording that does not say how long it is. */
export const UNBOUNDED_SENTENCE = "This recording does not say how long it is, so marks use the time you hear.";

/** How long the engine is given to learn the length after the seek past the end. */
export const RESOLVE_MS = 3000;

/** The parts of a media element the length is read from. */
export type LengthSource = Pick<HTMLMediaElement, "duration" | "currentTime" | "seekable">;

export interface MediaLength {
	/**
	 * For the marks, the message and the keys: the length in seconds; `Infinity` for a recording that does not
	 * say how long it is; 0 until it is known.
	 */
	readonly duration: number;
	/** For the bar and the clock: how far into the recording the player can go so far. Always a finite number. */
	readonly reach: number;
	/** The recording does not say how long it is. */
	readonly unbounded: boolean;
}

/** Where the last range the engine can seek in ends; 0 when it has none or cannot say. */
function seekableEnd(media: Pick<HTMLMediaElement, "seekable">): number {
	const { seekable } = media;
	if (seekable === undefined || seekable.length === 0) return 0;
	const end = seekable.end(seekable.length - 1);
	return Number.isFinite(end) && end > 0 ? end : 0;
}

export function readLength(media: LengthSource): MediaLength {
	const { duration } = media;
	if (duration === Number.POSITIVE_INFINITY) {
		const position = Number.isFinite(media.currentTime) && media.currentTime > 0 ? media.currentTime : 0;
		return { duration, reach: Math.max(seekableEnd(media), position), unbounded: true };
	}
	// NaN is "not loaded yet"; a length of nothing is not one a recording can be marked against either.
	const known = Number.isFinite(duration) && duration > 0 ? duration : 0;
	return { duration: known, reach: known, unbounded: false };
}

export function sameLength(a: MediaLength, b: MediaLength): boolean {
	return a.duration === b.duration && a.reach === b.reach && a.unbounded === b.unbounded;
}

/** `seconds` kept where the recording can be: [0, its length] - and for one with no end, anywhere from its start. */
export function seekTarget(seconds: number, length: MediaLength): number {
	return clampTime(seconds, length.duration);
}

/**
 * Where a key pressed outside the scrubber moves the playhead, or `null` when it is not a seeking key. A recording
 * with no end has no End; the key takes it as far as it can be played.
 */
export function keySeek(key: string, shift: boolean, position: number, length: MediaLength): number | null {
	const to = seekForKey(key, shift, position, length.duration);
	return to === null && key === "End" && length.unbounded ? length.reach : to;
}

export interface ResolveOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

/**
 * Ask a recording that reports no length for it: seek far past any end, and the engine, which must read on to
 * honour that, learns where the recording really stops. Settles when the length is known, when the seek has
 * landed without it, or when `timeoutMs` is out - and puts the playhead back at the start every time. A recording
 * that does say how long it is is left alone. Rejects (still restoring the playhead) if `signal` aborts.
 */
export function resolveLength(media: HTMLMediaElement, { timeoutMs = RESOLVE_MS, signal }: ResolveOptions = {}): Promise<void> {
	if (media.duration !== Number.POSITIVE_INFINITY) return Promise.resolve();
	if (signal?.aborted === true) return Promise.reject(signal.reason);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const done = (aborted: boolean): void => {
		window.clearTimeout(timer);
		media.removeEventListener("durationchange", onChange);
		media.removeEventListener("seeked", onSeeked);
		signal?.removeEventListener("abort", onAbort);
		media.currentTime = 0;
		if (aborted) reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		else resolve();
	};
	const onChange = (): void => {
		if (Number.isFinite(media.duration)) done(false);
	};
	// The seek landed: whatever the engine was going to learn on the way, it has by now.
	const onSeeked = (): void => done(false);
	const onAbort = (): void => done(true);
	const timer = window.setTimeout(() => done(false), timeoutMs);
	media.addEventListener("durationchange", onChange);
	media.addEventListener("seeked", onSeeked);
	signal?.addEventListener("abort", onAbort, { once: true });
	media.currentTime = Number.MAX_SAFE_INTEGER;
	return promise;
}
