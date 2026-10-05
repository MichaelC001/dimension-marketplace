/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the person watching a `browser_run` cell drive a browser in the View is not offered "Take over". The View offers it only while the browser's `agentActionAt` is
 *  recent, and a cell is ONE long call, not a series of timed actions, so the runtime has to keep reporting an agent as acting for as long as a cell holds the browser; if it does not, a cell clicking through
 *  a signed-in page for a minute cannot be stopped by the person at all. And the other way round: the person's own steps, or a cell that was refused because they already have the wheel, must never read as
 *  an agent acting, or the View offers Take over on a browser nobody is driving (or never lets go of one).
 *
 *  A cell holds a browser through the code seam (`require`/`hold`), exactly as the code host does for the length of a run. State is read as the View reads it (`browser_state` passes it through unchanged for
 *  the "app" caller), against a real headless Chrome. Cells may hold only a throwaway browser, which is what these tests open. Time is the test's: the runtime stamps with `Date.now()`, so a minute of a cell
 *  running is one jump of the system clock, and the clock is always put back (the real timers and Chrome never stop).
 */
import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { CodeLifetime, CodeSeam } from "../src/code/host/runtime-port";
import type { BrowserRuntime } from "../src/runtime";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, failureCode, startFixture, teardown } from "./fixture";

afterEach(async () => {
	setSystemTime();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

/** While a cell holds a browser the activity time the View reads is never older than this (the runtime's CELL_ACTIVITY_BEAT_MS). */
const BEAT_MS = 2_000;
/** Longer than the beat: a value that moves in beats has certainly crossed one. */
const PAST_A_BEAT_MS = BEAT_MS + 300;
/** A cell that runs for a minute: five times what the View keeps offering Take over for after an agent's last action. */
const A_MINUTE_MS = 60_000;

/** The lifetime a cell's browser has: a long idle clock, not kept for the person. */
const CELL: CodeLifetime = { idleMs: 1_800_000, persist: false };

interface CellBrowser {
	runtime: BrowserRuntime;
	seam: CodeSeam;
	browserId: string;
}

/** A throwaway browser a cell opened (`browser.open`), before any cell has run on it. */
async function cellBrowser(): Promise<CellBrowser> {
	const { runtime } = await createRuntime();
	const seam = runtime.codeSeam();
	const { browserId } = await seam.open({}, { caller: "model", session: "s-cell" }, CELL);
	return { runtime, seam, browserId };
}

/** One cell running on the browser, as the code host holds it for a run. Returns what ends it. */
const hold = ({ seam, browserId }: CellBrowser): (() => void) => seam.hold(seam.require(browserId));

/** `agentActionAt` as the View reads it: null when no agent has acted here. */
const readAt = async ({ runtime, browserId }: CellBrowser): Promise<number | null> => (await runtime.state(browserId)).agentActionAt;

/** `readAt` where an agent must have acted. */
async function actedAt(browser: CellBrowser): Promise<number> {
	const at = await readAt(browser);
	if (at === null) throw new Error("the View was told no agent has acted on this browser");
	return at;
}

/** The clock stands still at `at` (epoch ms) until the test moves it. */
const clockAt = (at: number): void => setSystemTime(new Date(at));

describeWithChrome("a cell driving a browser is an agent acting on it", () => {
	test(
		"a browser nobody drove reads as not acted on, the person's own steps do not change that, and a cell that holds it is acting now",
		async () => {
			const browser = await cellBrowser();
			const pages = startFixture();
			expect(await readAt(browser)).toBeNull();

			// The person's own step is not the agent working.
			await browser.runtime.act(browser.browserId, { kind: "navigate", url: pages.url("/nav") }, "app");
			expect(await readAt(browser)).toBeNull();

			const started = Date.now();
			const end = hold(browser);
			const at = await actedAt(browser);
			expect(at).toBeGreaterThanOrEqual(started - BEAT_MS);
			expect(at).toBeLessThanOrEqual(Date.now());
			end();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a cell that runs for a minute keeps the browser acting for the whole run, the moment it ends lingers, and then nothing moves",
		async () => {
			const browser = await cellBrowser();
			// On a beat, so the reads below say which side of the next one they are on.
			const start = Math.ceil(Date.now() / BEAT_MS) * BEAT_MS;
			clockAt(start);
			const end = hold(browser);
			const first = await actedAt(browser);

			// The View samples a browser's state four times a second and is sent it only when it differs: inside a beat the value holds still, or a running cell would cost a push per sample.
			clockAt(start + BEAT_MS - 500);
			expect(await actedAt(browser)).toBe(first);

			// Past one beat, the View is told of newer activity: a long cell is not one recent moment at its start.
			clockAt(start + PAST_A_BEAT_MS);
			expect(await actedAt(browser)).toBeGreaterThan(first);

			// A minute in, it is still within a beat of now, not a minute old: the person can still take over.
			clockAt(start + A_MINUTE_MS);
			const midRun = await actedAt(browser);
			expect(start + A_MINUTE_MS - midRun).toBeLessThan(BEAT_MS);
			expect(midRun).toBeLessThanOrEqual(start + A_MINUTE_MS);

			// Ending: the last moment is when the cell ended, so the person has the whole window after even a short cell.
			const ended = start + A_MINUTE_MS + 700;
			clockAt(ended);
			end();
			const lingering = await actedAt(browser);
			expect(lingering).toBe(ended);

			// And it stays that moment: the browser does not read as being worked on forever, nor as never having been.
			clockAt(ended + PAST_A_BEAT_MS);
			expect(await readAt(browser)).toBe(lingering);
			clockAt(ended + A_MINUTE_MS);
			expect(await readAt(browser)).toBe(lingering);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the browser is acted on while ANY cell holds it: ending a cell twice ends it once, and the last cell to end stops it",
		async () => {
			const browser = await cellBrowser();
			const start = Date.now();
			clockAt(start);
			const first = hold(browser);
			const second = hold(browser);

			// The first cell ends, and its end is asked for again: the second is still running.
			first();
			first();
			clockAt(start + PAST_A_BEAT_MS);
			const whileSecondRuns = await actedAt(browser);
			expect(start + PAST_A_BEAT_MS - whileSecondRuns).toBeLessThan(BEAT_MS);

			const ended = start + PAST_A_BEAT_MS + 700;
			clockAt(ended);
			second();
			const lingering = await actedAt(browser);
			expect(lingering).toBe(ended);
			clockAt(ended + PAST_A_BEAT_MS);
			expect(await readAt(browser)).toBe(lingering);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a cell refused because the person has the wheel is not an agent acting: the activity the View reads does not change",
		async () => {
			const browser = await cellBrowser();
			const pages = startFixture();
			// An agent acted a moment ago, so there is a value to be changed.
			await browser.runtime.act(browser.browserId, { kind: "navigate", url: pages.url("/nav") }, "model");
			const acted = await actedAt(browser);

			await browser.runtime.control(browser.browserId, "take", "app");
			expect(await failureCode(async () => hold(browser))).toBe("human_driving");
			expect(await readAt(browser)).toBe(acted);
			// Nor does a refusal leave a cell counted: a beat later it still reads as that moment.
			clockAt(Date.now() + PAST_A_BEAT_MS);
			expect(await readAt(browser)).toBe(acted);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
