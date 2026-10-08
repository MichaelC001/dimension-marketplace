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
