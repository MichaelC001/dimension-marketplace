import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { CodeLifetime } from "../src/code/host/runtime-port";
import type { BrowserOpener } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { BrowserRuntimeError } from "../src/store";
import { chromePidsByProfile, chromePidsByThrowaway, isAlive, waitUntilGone } from "./chrome-processes";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, teardown, waitUntil } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const IDLE_MS = 4_000;
const UNHELD_MS = 2_000;
const HELD_OUTLASTS_GRACE_MS = UNHELD_MS * 3;
const CLOSES_WITHIN_MS = 30_000;

const asSession = (session: string, caller: "model" | "app" = "model"): BrowserOpener => ({ caller, session });

const leases: Array<() => void> = [];

afterEach(async () => {
	for (const release of leases.splice(0)) release();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

interface RunningChrome {
	main: number;
	all: number[];
}

async function chromeOfProfile(rootDir: string, profile: string): Promise<RunningChrome> {
	const found = (await chromePidsByProfile(rootDir)).get(profile);
	if (found === undefined || found.main === undefined) throw new Error(`no Chrome is running for the profile ${profile}`);
	return { main: found.main, all: found.all };
}

async function openProfile(runtime: BrowserRuntime, rootDir: string, profile: string, opener: BrowserOpener, code?: CodeLifetime): Promise<{ browserId: string; chrome: RunningChrome }> {
	const { browserId } = await runtime.open({ profile, viewport: VIEWPORT }, opener, code);
	return { browserId, chrome: await chromeOfProfile(rootDir, profile) };
}

async function refusal(work: () => Promise<unknown>): Promise<BrowserRuntimeError> {
	try {
		await work();
	} catch (error) {
		if (error instanceof BrowserRuntimeError) return error;
		throw error;
	}
	throw new Error("expected the call to be refused, but it resolved");
}

function driverOf(runtime: BrowserRuntime, browserId: string): { close(): Promise<void> } {
	const seam = runtime as unknown as { byId: Map<string, { driver: { close(): Promise<void> } }> };
	const entry = seam.byId.get(browserId);
	if (entry === undefined) throw new Error("the browser is not listed");
	return entry.driver;
}

describeWithChrome("a saved profile's browser nobody calls", () => {
	test(
		"is closed whoever opened it, by pid, and the profile folder stays and opens again",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { profileIdleMs: IDLE_MS });
			const byPerson = await openProfile(runtime, rootDir, "by-person", asSession("person", "app"));
			const byStepTool = await openProfile(runtime, rootDir, "by-step-tool", { ...asSession("chat-a"), tool: "browser_open" });
			const joined = await openProfile(runtime, rootDir, "joined", asSession("person", "app"));
			await runtime.open({ profile: "joined", viewport: VIEWPORT }, asSession("chat-a"));
			await runtime.close(joined.browserId, "model", undefined, asSession("chat-a"));
			expect(isAlive(joined.chrome.main)).toBe(true);

			const everyChrome = [byPerson, byStepTool, joined].flatMap((opened) => opened.chrome.all);
			expect(await waitUntilGone(everyChrome, CLOSES_WITHIN_MS)).toEqual([]);

			for (const [opened, profile] of [[byPerson, "by-person"], [byStepTool, "by-step-tool"], [joined, "joined"]] as const) {
				const told = await refusal(() => runtime.state(opened.browserId));
				expect(told.code).toBe("unknown_browser");
				expect(told.message).toStartWith("unknown or already closed browserId");
				expect(told.message).toContain(`saved profile "${profile}"`);
				expect(told.message).toContain("its sign-ins are kept");
				expect(existsSync(join(rootDir, "profiles", profile, "chrome"))).toBe(true);
			}
			const reopened = await runtime.open({ profile: "by-person", viewport: VIEWPORT }, asSession("person", "app"));
			expect(reopened.browserId).not.toBe(byPerson.browserId);
			expect(isAlive((await chromeOfProfile(rootDir, "by-person")).main)).toBe(true);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is kept by calls, by a View joined to it and by the person's wheel; silence alone ends it",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { profileIdleMs: IDLE_MS });
			const watched = await openProfile(runtime, rootDir, "watched", asSession("chat-a"));
			leases.push(runtime.viewing(watched.browserId));
			const taken = await openProfile(runtime, rootDir, "taken", asSession("chat-a"));
			await runtime.control(taken.browserId, "take", "app");
			const called = await openProfile(runtime, rootDir, "called", asSession("chat-a"));
			const silent = await openProfile(runtime, rootDir, "silent", asSession("chat-a"));

			await waitUntil(
				"the silent browser's Chrome to be closed by the clock while the called one is called throughout",
				async () => {
					await runtime.state(called.browserId);
					return await waitUntilGone(silent.chrome.all, 0);
				},
				(left) => left.length === 0,
				CLOSES_WITHIN_MS,
			);
			for (const kept of [called, watched, taken]) expect(isAlive(kept.chrome.main)).toBe(true);

			await runtime.control(taken.browserId, "return", "app");
			expect(await waitUntilGone(taken.chrome.all, CLOSES_WITHIN_MS)).toEqual([]);
			for (const release of leases.splice(0)) release();
			expect(await waitUntilGone(watched.chrome.all, CLOSES_WITHIN_MS)).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an idle close that fails is tried again until the Chrome is gone, and the lock is released with it",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { profileIdleMs: 2_000, throwawayIdleMs: 1_000 });
			const stuck = await openProfile(runtime, rootDir, "stuck", asSession("chat-a"));
			const driver = driverOf(runtime, stuck.browserId);
			const close = driver.close.bind(driver);
			let attempts = 0;
			driver.close = async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("the browser did not shut down");
				await close();
			};

			expect(await waitUntilGone(stuck.chrome.all, CLOSES_WITHIN_MS)).toEqual([]);
			expect(attempts).toBeGreaterThan(1);
			const reopened = await runtime.open({ profile: "stuck", viewport: VIEWPORT }, asSession("chat-a"));
			expect(reopened.browserId).not.toBe(stuck.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("a browser nobody holds any more", () => {
	test(
		"is given up once the host says its last holder's session ended; a browser another session still holds is not",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { unheldIdleMs: UNHELD_MS });
			const sole = await openProfile(runtime, rootDir, "sole", asSession("chat-a"));
			const shared = await openProfile(runtime, rootDir, "shared", asSession("chat-a"));
			await runtime.open({ profile: "shared", viewport: VIEWPORT }, asSession("chat-b"));
			const persisted = await openProfile(runtime, rootDir, "persisted", asSession("chat-d"), { idleMs: 600_000, persist: true });
			const throwawaysBefore = new Set((await chromePidsByThrowaway(rootDir)).keys());
			const throwaway = await runtime.open({ viewport: VIEWPORT }, asSession("chat-a"));
			const throwawayChrome = [...(await chromePidsByThrowaway(rootDir))].find(([dir]) => !throwawaysBefore.has(dir))?.[1];
			if (throwawayChrome === undefined) throw new Error("the throwaway browser has no Chrome");

			await runtime.endProfileSession("chat-a");
			expect(await waitUntilGone([...sole.chrome.all, ...throwawayChrome.all], CLOSES_WITHIN_MS)).toEqual([]);
			expect((await refusal(() => runtime.state(throwaway.browserId))).code).toBe("unknown_browser");
			await Bun.sleep(HELD_OUTLASTS_GRACE_MS);
			for (const held of [shared, persisted]) expect(isAlive(held.chrome.main)).toBe(true);

			await runtime.endProfileSession("chat-b");
			expect(await waitUntilGone(shared.chrome.all, CLOSES_WITHIN_MS)).toEqual([]);
			await Bun.sleep(HELD_OUTLASTS_GRACE_MS);
			expect(isAlive(persisted.chrome.main)).toBe(true);

			await runtime.endProfileSession("chat-d");
			expect(await waitUntilGone(persisted.chrome.all, CLOSES_WITHIN_MS)).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is given up shortly after the last chat lets go of a browser a View was watching, once the View leaves",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { unheldIdleMs: UNHELD_MS });
			const watched = await openProfile(runtime, rootDir, "watched", asSession("chat-a"));
			const release = runtime.viewing(watched.browserId);
			leases.push(release);

			await runtime.close(watched.browserId, "model", undefined, asSession("chat-a"));
			await Bun.sleep(HELD_OUTLASTS_GRACE_MS);
			expect(isAlive(watched.chrome.main)).toBe(true);

			release();
			expect(await waitUntilGone(watched.chrome.all, CLOSES_WITHIN_MS)).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describe("the idle options are numbers a timer can hold", () => {
	test("a value above what setTimeout takes or that is not a positive number is refused for the saved-profile and unheld clocks too", async () => {
		const rootDir = await createRoot();
		for (const bad of [2_147_483_648, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => newRuntime(rootDir, { profileIdleMs: bad })).toThrow(RangeError);
			expect(() => newRuntime(rootDir, { unheldIdleMs: bad })).toThrow(RangeError);
		}
		expect(() => newRuntime(rootDir, { profileIdleMs: 2_147_483_647, unheldIdleMs: 2_147_483_647 })).not.toThrow();
	});
});
