import { setTimeout as delay } from "node:timers/promises";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface BackoffOptions {
	readonly baseMs: number;
	readonly maxMs: number;
	readonly random?: () => number;
}

export interface RetryOptions extends BackoffOptions {
	readonly attempts: number;
	readonly sleep?: Sleep;
}

export const sleepFor: Sleep = (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined);

export function backoffDelay(attempt: number, options: BackoffOptions): number {
	const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
	return Math.round((options.random ?? Math.random)() * ceiling);
}

export interface Retryable {
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
}

function isRetryable(error: unknown): error is Retryable {
	return typeof error === "object" && error !== null && "retryable" in error && error.retryable === true;
}

export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions, signal?: AbortSignal): Promise<T> {
	const sleep = options.sleep ?? sleepFor;
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (signal?.aborted || !isRetryable(error) || attempt + 1 >= options.attempts) throw error;
			const hinted = error.retryAfterMs === undefined ? 0 : Math.min(error.retryAfterMs, options.maxMs);
			await sleep(Math.max(hinted, backoffDelay(attempt, options)), signal);
		}
	}
}
