import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { useChangePoll } from "../app/view/library/use-change-poll";
import { installReact, type ReactEnv } from "./media-react";

const INTERVAL_MS = 2500;

interface PendingRead {
	readonly resolve: (marker: string) => void;
	readonly reject: (error: Error) => void;
	readonly signal: AbortSignal;
}

interface ScheduledTimer {
	readonly callback: () => void;
	readonly delay: number;
}

let env: ReactEnv;
let realTimers: Pick<typeof window, "setTimeout" | "clearTimeout">;
const timers = new Map<number, ScheduledTimer>();
let nextTimer = 1;
let reads: PendingRead[] = [];
let changes = 0;

const read = (signal: AbortSignal): Promise<string> =>
	new Promise<string>((resolve, reject) => {
		reads.push({ resolve, reject, signal });
	});

function Probe(): null {
	useChangePoll(read, INTERVAL_MS, () => {
		changes += 1;
	});
	return null;
}

const settle = () =>
	env.act(async () => {
		for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
	});

const answer = async (marker: string): Promise<void> => {
	reads.shift()?.resolve(marker);
	await settle();
};

const fail = async (): Promise<void> => {
	reads.shift()?.reject(new Error("the server did not answer"));
	await settle();
};

const timeGoesBy = () =>
	env.act(async () => {
		for (const [handle, timer] of [...timers]) {
			timers.delete(handle);
			timer.callback();
		}
	});

const tabIs = async (visibility: "hidden" | "visible"): Promise<void> => {
	Object.defineProperty(env.document, "visibilityState", { value: visibility, configurable: true });
	const view = env.document.defaultView as Window & typeof globalThis;
	await env.act(async () => void env.document.dispatchEvent(new view.Event("visibilitychange")));
};

beforeAll(async () => {
	env = await installReact();
	realTimers = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout };
	Object.assign(window, {
		setTimeout: (callback: () => void, delay: number) => {
			timers.set(nextTimer, { callback, delay });
			return nextTimer++;
		},
		clearTimeout: (handle: number) => void timers.delete(handle),
	});
});

afterEach(async () => {
	await env.cleanup();
	Reflect.deleteProperty(env.document, "visibilityState");
	timers.clear();
	reads = [];
	changes = 0;
});

afterAll(() => {
	Object.assign(window, realTimers);
	env.restore();
});

describe("polling a change marker", () => {
	test("it reads on mount and after every interval, and tells the owner only when the marker differs from the last one read", async () => {
		await env.mount(createElement(Probe));
		expect(reads).toHaveLength(1);

		await answer("a");
		expect(changes).toBe(0);
		expect([...timers.values()].map(timer => timer.delay)).toEqual([INTERVAL_MS]);

		const beats: { readonly marker: string; readonly changesAfter: number }[] = [
			{ marker: "a", changesAfter: 0 },
			{ marker: "b", changesAfter: 1 },
			{ marker: "b", changesAfter: 1 },
			{ marker: "a", changesAfter: 2 },
		];
		for (const beat of beats) {
			await timeGoesBy();
			expect(reads).toHaveLength(1);
			await answer(beat.marker);
			expect(changes).toBe(beat.changesAfter);
		}
	});

	test("reads never overlap: nothing asks again while a slow read is out, whether the interval passes or the tab is shown", async () => {
		await env.mount(createElement(Probe));
		expect(reads).toHaveLength(1);

		await timeGoesBy();
		await timeGoesBy();
		await tabIs("visible");
		expect(reads).toHaveLength(1);

		await answer("a");
		await timeGoesBy();
		expect(reads).toHaveLength(1);
	});

	test("a hidden tab is not read, and showing it reads at once instead of waiting out the interval", async () => {
		await tabIs("hidden");
		await env.mount(createElement(Probe));
		await timeGoesBy();
		await timeGoesBy();
		expect(reads).toHaveLength(0);

		await tabIs("visible");
		expect(reads).toHaveLength(1);
		await answer("a");

		await tabIs("hidden");
		await timeGoesBy();
		await timeGoesBy();
		expect(reads).toHaveLength(0);

		await tabIs("visible");
		expect(reads).toHaveLength(1);
		await answer("b");
		expect(changes).toBe(1);
	});

	test("a read that fails changes nothing and is tried again at the next beat against the marker held before it", async () => {
		await env.mount(createElement(Probe));
		await answer("a");
		await timeGoesBy();
		await fail();
		expect(changes).toBe(0);

		await timeGoesBy();
		expect(reads).toHaveLength(1);
		await answer("b");
		expect(changes).toBe(1);
	});

	test("once unmounted its read is aborted, a late answer says nothing, and neither the interval nor the tab asks again", async () => {
		const view = await env.mount(createElement(Probe));
		await answer("a");
		await timeGoesBy();
		const inFlight = reads[0];
		expect(inFlight?.signal.aborted).toBe(false);

		await view.unmount();
		expect(inFlight?.signal.aborted).toBe(true);

		await answer("b");
		expect(changes).toBe(0);
		await timeGoesBy();
		await tabIs("visible");
		expect(reads).toHaveLength(0);
	});
});
