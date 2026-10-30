import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { useChangePoll } from "../app/view/library/use-change-poll";
import type { RevisionSpan } from "../../src/library/revision";
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
let adopt: (span: RevisionSpan) => void = () => undefined;

const read = (signal: AbortSignal): Promise<string> =>
	new Promise<string>((resolve, reject) => {
		reads.push({ resolve, reject, signal });
	});

function Probe({ active }: { readonly active: boolean }): null {
	adopt = useChangePoll(
		read,
		INTERVAL_MS,
		() => {
			changes += 1;
		},
		active,
	);
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
	adopt = () => undefined;
});

afterAll(() => {
	Object.assign(window, realTimers);
	env.restore();
});

describe("polling a change marker", () => {
	test("it reads on mount and after every interval, and tells the owner only when the marker differs from the last one read", async () => {
		await env.mount(createElement(Probe, { active: true }));
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
		await env.mount(createElement(Probe, { active: true }));
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
		await env.mount(createElement(Probe, { active: true }));
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
		await env.mount(createElement(Probe, { active: true }));
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
		const view = await env.mount(createElement(Probe, { active: true }));
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

describe("polling only while the Library is the one shown", () => {
	test("while inactive nothing is read however many intervals pass or the tab changes; becoming active reads at once, and the interval takes over after", async () => {
		const view = await env.mount(createElement(Probe, { active: false }));
		for (let beat = 0; beat < 3; beat += 1) await timeGoesBy();
		await tabIs("hidden");
		await tabIs("visible");
		await timeGoesBy();
		expect(reads).toHaveLength(0);

		await view.render(createElement(Probe, { active: true }));
		expect(reads).toHaveLength(1);
		await answer("1:5");
		expect([...timers.values()].map(timer => timer.delay)).toEqual([INTERVAL_MS]);
		await timeGoesBy();
		expect(reads).toHaveLength(1);
	});

	test("the marker read before going inactive is kept: a change made meanwhile is told once, on the first read after", async () => {
		const view = await env.mount(createElement(Probe, { active: true }));
		await answer("1:5");
		await view.render(createElement(Probe, { active: false }));
		await timeGoesBy();
		await timeGoesBy();
		expect(reads).toHaveLength(0);
		expect(changes).toBe(0);

		await view.render(createElement(Probe, { active: true }));
		expect(reads).toHaveLength(1);
		await answer("2:5");
		expect(changes).toBe(1);

		await timeGoesBy();
		await answer("2:5");
		expect(changes).toBe(1);
	});
});

describe("writes the owner made itself", () => {
	const writes: readonly { readonly name: string; readonly spans: readonly RevisionSpan[]; readonly next: string; readonly told: number }[] = [
		{ name: "one alone: the next read finds the marker it adopted and tells nobody", spans: [{ before: "1:5", after: "2:5" }], next: "2:5", told: 0 },
		{
			name: "two in a row are adopted in order and tell nobody",
			spans: [
				{ before: "1:5", after: "2:5" },
				{ before: "2:5", after: "3:5" },
			],
			next: "3:5",
			told: 0,
		},
		{ name: "one followed by another process's commit: that commit is told", spans: [{ before: "1:5", after: "2:5" }], next: "2:6", told: 1 },
		{ name: "one made after another process committed, with no read between: that commit is told", spans: [{ before: "1:6", after: "2:6" }], next: "2:6", told: 1 },
		{ name: "one with another process's commit inside it: told", spans: [{ before: "1:5", after: "2:6" }], next: "2:6", told: 1 },
	];

	for (const each of writes) {
		test(each.name, async () => {
			await env.mount(createElement(Probe, { active: true }));
			await answer("1:5");
			for (const span of each.spans) adopt(span);
			await timeGoesBy();
			await answer(each.next);
			expect(changes).toBe(each.told);
		});
	}

	test("adopted before any read it is no baseline: the first read sets it, whatever it says, and tells nobody", async () => {
		await env.mount(createElement(Probe, { active: true }));
		adopt({ before: "1:5", after: "2:5" });
		await answer("1:5");
		expect(changes).toBe(0);

		await timeGoesBy();
		await answer("1:5");
		expect(changes).toBe(0);
	});
});
