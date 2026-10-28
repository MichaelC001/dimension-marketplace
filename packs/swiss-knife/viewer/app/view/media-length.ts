import { clampTime, type MediaLength, seekForKey } from "@dimension/mcp-app-kit/annotate";

export const UNBOUNDED_SENTENCE = "This recording does not say how long it is, so notes use the time you hear.";

export const RESOLVE_MS = 3000;

export function seekTarget(seconds: number, length: MediaLength): number {
	return clampTime(seconds, length.duration);
}

export function keySeek(key: string, shift: boolean, position: number, length: MediaLength): number | null {
	const to = seekForKey(key, shift, position, length.duration);
	return to === null && key === "End" && length.unbounded ? length.reach : to;
}

export interface ResolveOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

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
	const onSeeked = (): void => done(false);
	const onAbort = (): void => done(true);
	const timer = window.setTimeout(() => done(false), timeoutMs);
	media.addEventListener("durationchange", onChange);
	media.addEventListener("seeked", onSeeked);
	signal?.addEventListener("abort", onAbort, { once: true });
	media.currentTime = Number.MAX_SAFE_INTEGER;
	return promise;
}
