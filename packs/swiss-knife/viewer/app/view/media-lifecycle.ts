import type { App } from "@modelcontextprotocol/ext-apps";

const outstanding = new WeakMap<App, Set<Promise<unknown>>>();

export function trackMediaWork<T>(app: App, work: Promise<T>): Promise<T> {
	let pending = outstanding.get(app);
	if (pending === undefined) {
		pending = new Set();
		outstanding.set(app, pending);
	}
	pending.add(work);
	const settled = () => pending.delete(work);
	void work.then(settled, settled);
	return work;
}

export async function finishMediaWork(app: App): Promise<void> {
	const pending = outstanding.get(app);
	while (pending !== undefined && pending.size > 0) await Promise.allSettled([...pending]);
	outstanding.delete(app);
}

/** How often a pane tells the server it still holds a recording. The server may reclaim a lease that showed no sign of life for five minutes once its table is full, so this stays far inside that even when a hidden frame's timers are slowed to one a minute. */
export const RENEW_EVERY_MS = 30_000;

/**
 * Keeps one recording held for as long as its pane is open, and says when the server no longer holds it.
 *
 * The server frees a lease when its pane closes it, but a pane can vanish without running any code (its session
 * switched away, its column collapsed, a reload), so the server also needs proof of life. This is that proof: while the
 * pane exists it asks every `RENEW_EVERY_MS`; a pane that is gone stops asking, which is all the server needs to know.
 * A call that fails (the bridge is busy or away) is not a verdict: the next tick asks again. Only the server saying it no
 * longer holds the lease calls `onLost`, and only once.
 */
export function keepRecordingHeld(renew: () => Promise<boolean>, onLost: () => void): () => void {
	let stopped = false;
	let asking = false;
	const timer = setInterval(() => {
		if (asking) return;
		asking = true;
		renew().then(
			alive => {
				if (stopped || alive) return;
				stopped = true;
				clearInterval(timer);
				onLost();
			},
			() => undefined,
		).finally(() => {
			asking = false;
		});
	}, RENEW_EVERY_MS);
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
