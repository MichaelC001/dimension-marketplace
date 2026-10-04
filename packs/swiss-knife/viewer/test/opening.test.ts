// What a person sees while a file opens, and what it would feel like if each contract broke.
//
// Silent for a fast load: a file that opens in a blink must not flash "Connecting / Reading / Preparing" at them for
// one frame, and a slow one must not sit blank. The steps are real: "Reading ... 1.0 MB of 4.0 MB" with a bar that
// follows the actual bytes, never a made-up percentage and never a stage that jumps back. The file is named, or "the
// file" while its name is not known yet, never "Reading  ". When the document is ready the surface lets go: every
// step reads done, it fades, and it is gone, so the document is not left under a spinner.
//
// Heard as well as seen: the surface is a polite live region, so a screen reader is read "Reading notes.wav" once and
// never again as the bytes tick (a count in the words would re-announce the whole row at every tick); the counts are
// drawn for the eye, and the progress bar carries them for assistive tech instead. A file name can carry a
// right-to-left override: it is drawn in its own isolate so it cannot turn "Reading" or the counts around.
//
// One wait, not three: the shell's surface, the empty pane's and the file's own are the View's FIRST wait, counted
// from the document's start, so the words do not blink out at each hand-over; a file opened later, or the same surface
// opened again, waits its own silence, or the first thing a person sees of every later file would be a flash of rows.
//
// `Opening` is rendered directly (linkedom + react-dom under `act`) with fake timers: the delay and the fade-out beat
// are advanced by hand, never waited for. The first-wait tests also own the document's clock (`performance.now()`),
// since under fake timers it keeps the real age of the process.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { createElement, type ReactElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { ARTIFACT_OPENING_CONNECT_LABEL } from "@fraym/ui/components/artifact-opening";
import { FirstWait, Opening, type OpeningProps, type OpeningStage } from "../app/view/opening";
import { installReact, type ReactEnv } from "./media-react";

let env: ReactEnv;

beforeAll(async () => {
	env = await installReact();
});
beforeEach(() => {
	jest.useFakeTimers();
});
afterEach(async () => {
	await env.cleanup();
	jest.useRealTimers();
});
afterAll(() => env.restore());

const MB = 1024 * 1024;
const STAGE_ORDER: readonly OpeningStage[] = ["connect", "read", "prepare"];

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
/** Every bidi control (embeddings, overrides, isolates, marks): none may sit beside a file name outside its isolate. */
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/** The text under `node`, leaving out every element subtree `skip` picks. */
function textWithout(node: Node, skip: (element: Element) => boolean): string {
	if (node.nodeType === TEXT_NODE) return node.textContent ?? "";
	if (node.nodeType !== ELEMENT_NODE || skip(node as Element)) return "";
	return [...node.childNodes].map(child => textWithout(child, skip)).join("");
}

/** `within` wraps what is rendered (a provider around the surface), on first mount and on every re-render. */
async function show(props: OpeningProps, within: (opening: ReactElement) => ReactElement = opening => opening) {
	const view = await env.mount(within(createElement(Opening, props)));
	const root = view.container;
	const rows = () => [...root.querySelectorAll<HTMLElement>('[data-slot="labor-step"]')];
	const row = (id: OpeningStage) => rows().find(r => r.getAttribute("data-step") === id);
	const bar = () => root.querySelector<HTMLElement>('[data-slot="artifact-opening-progress"]');
	return {
		ground: () => root.querySelector('[data-slot="artifact-opening"]'),
		words: () => root.querySelector('[data-slot="artifact-opening-steps"]'),
		ids: () => rows().map(r => r.getAttribute("data-step")),
		statuses: () => rows().map(r => r.getAttribute("data-status")),
		rowText: (id: OpeningStage) => row(id)?.textContent?.trim(),
		bdis: (id: OpeningStage) => [...(row(id)?.querySelectorAll("bdi") ?? [])].map(b => b.textContent),
		outsideBdi: (id: OpeningStage) => {
			const target = row(id);
			return target && textWithout(target, element => element.nodeName.toLowerCase() === "bdi");
		},
		text: () => root.textContent ?? "",
		spoken: () => textWithout(root, element => element.getAttribute("aria-hidden") === "true"),
		hidden: () => [...root.querySelectorAll('[aria-hidden="true"]')].map(element => element.textContent).join(""),
		progressbars: () => root.querySelectorAll('[role="progressbar"]').length,
		bar,
		barWidth: () => bar()?.firstElementChild?.getAttribute("style")?.match(/width:\s*([\d.]+%)/)?.[1],
		isEmpty: () => root.childNodes.length === 0,
		render: (next: OpeningProps) => view.render(within(createElement(Opening, next))),
		wait: (ms: number) => env.act(async () => void jest.advanceTimersByTime(ms)),
	};
}

describe("silent for a fast load, speaks for a slow one", () => {
	test("the ground is up at once with nothing written on it until the wait has lasted past the delay", async () => {
		const view = await show({ name: "notes.wav", stage: "connect" });
		expect(view.ground()).not.toBeNull();
		expect(view.ids()).toEqual([]);
		expect(view.text()).toBe("");

		await view.wait(100);
		expect(view.ground()).not.toBeNull();
		expect(view.ids()).toEqual([]);
		expect(view.text()).toBe("");

		await view.wait(100);
		expect(view.ids()).toEqual(["connect", "read", "prepare"]);
	});

	test("a load that finishes inside the delay never shows a row, not even while the surface fades out", async () => {
		const view = await show({ name: "notes.wav", stage: "read", loaded: MB, total: 4 * MB });
		await view.wait(100);
		await view.render({ name: "notes.wav", stage: "prepare", open: false });
		expect(view.ids()).toEqual([]);

		// The delay would have run out here, then the fade-out beat, and the surface leaves: no row at any point.
		for (const ms of [49, 1, 100, 1000]) {
			await view.wait(ms);
			expect(view.ids()).toEqual([]);
			expect(view.text()).toBe("");
		}
	});
});

describe("the stages are the real ones", () => {
	const expected: ReadonlyArray<readonly [OpeningStage, readonly string[]]> = [
		["connect", ["active", "pending", "pending"]],
		["read", ["done", "active", "pending"]],
		["prepare", ["done", "done", "active"]],
	];

	test.each(expected)("%s: connect, read, prepare read %j in that order", async (stage, statuses) => {
		const view = await show({ name: "notes.wav", stage });
		await view.wait(200);
		expect(view.ids()).toEqual(["connect", "read", "prepare"]);
		expect(view.statuses()).toEqual([...statuses]);
	});

	test("one surface follows a file through its stages: each moves the statuses on, none goes back or skips", async () => {
		const view = await show({ name: "notes.wav", stage: "connect" });
		await view.wait(200);
		const seen = [view.statuses()];
		for (const stage of ["read", "prepare"] as const) {
			await view.render({ name: "notes.wav", stage });
			seen.push(view.statuses());
		}
		expect(seen).toEqual(expected.map(([, statuses]) => [...statuses]));
		expect(view.ids()).toEqual([...STAGE_ORDER]);
	});
});

describe("byte progress is the real count", () => {
	test("reading shows the formatted bytes read of the total and a bar at that fraction, both following new counts", async () => {
		const view = await show({ name: "notes.wav", stage: "read", loaded: MB, total: 4 * MB });
		await view.wait(200);
		expect(view.rowText("read")).toMatch(/1\.0 MB.*4\.0 MB/);
		expect(view.barWidth()).toBe("25%");

		await view.render({ name: "notes.wav", stage: "read", loaded: 3 * MB, total: 4 * MB });
		expect(view.rowText("read")).toMatch(/3\.0 MB.*4\.0 MB/);
		expect(view.barWidth()).toBe("75%");
	});

	test("nothing read yet is a real zero: the count says 0 B and the bar is there, empty", async () => {
		const view = await show({ name: "notes.wav", stage: "read", loaded: 0, total: 4 * MB });
		await view.wait(200);
		expect(view.rowText("read")).toMatch(/0 B.*4\.0 MB/);
		expect(view.barWidth()).toBe("0%");
	});

	const unmeasured: ReadonlyArray<readonly [string, Pick<OpeningProps, "loaded" | "total">]> = [
		["no total", { loaded: MB }],
		["a total of zero", { loaded: MB, total: 0 }],
		["no bytes read count", { total: 4 * MB }],
		["no counts at all", {}],
	];

	test.each(unmeasured)("reading with %s shows no byte text and no bar: no numbers are made up", async (_name, counts) => {
		const view = await show({ name: "notes.wav", stage: "read", ...counts });
		await view.wait(200);
		expect(view.rowText("read")).toBe("Reading notes.wav");
		expect(view.bar()).toBeNull();
	});

	test.each(["connect", "prepare"] as const)("%s shows no byte text and no bar even when counts are passed in", async stage => {
		const view = await show({ name: "notes.wav", stage, loaded: MB, total: 4 * MB });
		await view.wait(200);
		expect(view.text()).not.toMatch(/\d/);
		expect(view.bar()).toBeNull();
	});

	test("the bar and the byte text leave when the read ends and the stage moves on", async () => {
		const view = await show({ name: "notes.wav", stage: "read", loaded: 4 * MB, total: 4 * MB });
		await view.wait(200);
		expect(view.barWidth()).toBe("100%");

		await view.render({ name: "notes.wav", stage: "prepare", loaded: 4 * MB, total: 4 * MB });
		expect(view.bar()).toBeNull();
		expect(view.text()).not.toMatch(/\d/);
	});
});

describe("the rows name the file", () => {
	test("reading and preparing say which file", async () => {
		const view = await show({ name: "notes.wav", stage: "prepare" });
		await view.wait(200);
		expect(view.rowText("read")).toBe("Reading notes.wav");
		expect(view.rowText("prepare")).toBe("Preparing notes.wav");
	});

	test("before the name is known they say the file, with no empty gap, and connecting stays the shared words", async () => {
		const view = await show({ name: "", stage: "read", loaded: MB, total: 4 * MB });
		await view.wait(200);
		expect(view.rowText("connect")).toBe(ARTIFACT_OPENING_CONNECT_LABEL);
		expect(view.rowText("read")).toMatch(/^Reading the file\b/);
		expect(view.rowText("prepare")).toBe("Preparing the file");
		expect(view.text()).not.toMatch(/\s{2,}/);
	});

	// The name is the file's own, so it can be anything: a right-to-left override in it must not reorder "Reading" or the
	// counts drawn beside it, which only holds if the name sits in its own bidi isolate and nothing outside it carries
	// a bidi control of its own.
	const hostile: ReadonlyArray<readonly [string, string]> = [
		["a leading right-to-left override", "\u202Egpj.exe"],
		["an override inside the name", "a\u202Eb"],
	];

	test.each(hostile)("%s stays in its own isolate: the name is drawn whole and nothing beside it carries a bidi control", async (_why, name) => {
		const view = await show({ name, stage: "read", loaded: MB, total: 4 * MB });
		await view.wait(200);
		for (const [id, verb] of [["read", "Reading"], ["prepare", "Preparing"]] as const) {
			expect(view.bdis(id)).toEqual([name]);
			const beside = view.outsideBdi(id);
			expect(beside).not.toMatch(BIDI_CONTROL);
			expect(beside).toMatch(new RegExp(`^${verb}\\b`));
		}
		expect(view.outsideBdi("read")).toMatch(/1\.0 MB.*4\.0 MB/);
	});

	test("no name draws no isolate at all, not an empty one", async () => {
		const view = await show({ name: "", stage: "read", loaded: MB, total: 4 * MB });
		await view.wait(200);
		expect(view.ids()).toEqual([...STAGE_ORDER]);
		for (const id of STAGE_ORDER) expect(view.bdis(id)).toEqual([]);
	});
});

describe("ready", () => {
	test("closing marks every row done whatever stage it was in, and the surface leaves only after the fade beat", async () => {
		const view = await show({ name: "notes.wav", stage: "read", loaded: MB, total: 4 * MB });
		await view.wait(200);
		expect(view.statuses()).toEqual(["done", "active", "pending"]);

		await view.render({ name: "notes.wav", stage: "read", loaded: MB, total: 4 * MB, open: false });
		expect(view.statuses()).toEqual(["done", "done", "done"]);
		expect(view.bar()).toBeNull();
		expect(view.ground()).not.toBeNull();

		await view.wait(100);
		expect(view.ground()).not.toBeNull();

		await view.wait(1000);
		expect(view.ground()).toBeNull();
		expect(view.isEmpty()).toBe(true);
	});
});

describe("the ticking counts are for the eye, not for the live region", () => {
	// 2.5 of 4 MB is 62.5%: the bar rounds it up, as the fraction of bytes it stands for does.
	const ticks = [
		{ loaded: MB, counts: "1.0 MB of 4.0 MB", now: "25" },
		{ loaded: 2.5 * MB, counts: "2.5 MB of 4.0 MB", now: "63" },
		{ loaded: 4 * MB, counts: "4.0 MB of 4.0 MB", now: "100" },
	];
	const reading = (loaded: number): OpeningProps => ({ name: "notes.wav", stage: "read", loaded, total: 4 * MB });

	test("each tick of a read says the same words aloud, byte for byte, while the counts drawn for the eye follow", async () => {
		const view = await show(reading(MB));
		await view.wait(200);
		const aloud = view.spoken();
		expect(aloud).toMatch(/Reading.*notes\.wav/);

		for (const tick of ticks) {
			await view.render(reading(tick.loaded));
			expect(view.spoken()).toBe(aloud);
			expect(view.spoken()).not.toMatch(/\d/);
			expect(view.hidden()).toContain(tick.counts);
			expect(view.rowText("read")).toContain(tick.counts);
		}
	});

	test("the progress bar carries the real fraction, the counts and the file as the counts tick", async () => {
		const view = await show(reading(MB));
		await view.wait(200);

		for (const tick of ticks) {
			await view.render(reading(tick.loaded));
			const bar = view.bar();
			expect(bar?.getAttribute("role")).toBe("progressbar");
			expect(bar?.getAttribute("aria-valuemin")).toBe("0");
			expect(bar?.getAttribute("aria-valuemax")).toBe("100");
			expect(bar?.getAttribute("aria-valuenow")).toBe(tick.now);
			expect(bar?.getAttribute("aria-valuetext")).toBe(tick.counts);
			expect(bar?.getAttribute("aria-label")).toBe("Reading notes.wav");
		}
	});

	const unmeasured: ReadonlyArray<readonly [string, Pick<OpeningProps, "loaded" | "total">]> = [
		["no total", { loaded: MB }],
		["a total of zero", { loaded: MB, total: 0 }],
	];

	test.each(unmeasured)("with %s there is no progress bar and no hidden count, and the same words are read as with counts", async (_why, counts) => {
		const measured = await show(reading(MB));
		await measured.wait(200);

		const view = await show({ name: "notes.wav", stage: "read", ...counts });
		await view.wait(200);
		expect(view.progressbars()).toBe(0);
		expect(view.hidden()).not.toMatch(/\d/);
		expect(view.spoken()).toBe(measured.spoken());
	});
});

describe("the first wait is counted from the document's start, a later wait from its own", () => {
	// `performance.now()` under fake timers keeps the real process age, so the document's age is a counter of ours: it
	// moves only when `tick` moves it, together with the timers, and the spy is put back after each test.
	let clockMs = 0;
	let clock: { mockRestore(): void };
	beforeEach(() => {
		clockMs = 0;
		clock = spyOn(performance, "now").mockImplementation(() => clockMs);
	});
	afterEach(() => clock.mockRestore());

	const firstWait = (opening: ReactElement) => createElement(FirstWait, null, opening);
	const notFirstWait = (opening: ReactElement) => createElement(FirstWait, { of: false, children: opening });
	const connecting: OpeningProps = { name: "", stage: "connect" };
	/** What the clock helpers need of a view from `show`. */
	interface Waiting {
		readonly words: () => Element | null;
		readonly wait: (ms: number) => Promise<void>;
	}
	const fadesIn = (view: Waiting) => view.words()?.classList.contains("animate-in");

	function tick(view: Waiting, ms: number) {
		clockMs += ms;
		return view.wait(ms);
	}

	// 150 is exactly the delay: a document that old has already waited it out.
	test.each([150, 400])("a surface opening in the first wait at document age %d ms is speaking on its first frame, with no fade-in", async age => {
		clockMs = age;
		const firstFrame = env.document.createElement("div");
		firstFrame.innerHTML = renderToString(firstWait(createElement(Opening, connecting)));
		expect(firstFrame.querySelectorAll('[data-slot="labor-step"]')).toHaveLength(STAGE_ORDER.length);

		const view = await show(connecting, firstWait);
		expect(view.ids()).toEqual([...STAGE_ORDER]);
		expect(fadesIn(view)).toBe(false);
	});

	test.each([
		["outside any first wait", (opening: ReactElement) => opening],
		["inside a first wait that it is not part of", notFirstWait],
	])("the same surface %s keeps its own 150 ms of silence however old the document is, then fades in", async (_where, within) => {
		clockMs = 400;
		const view = await show(connecting, within);
		expect(view.ground()).not.toBeNull();
		expect(view.ids()).toEqual([]);

		await tick(view, 149);
		expect(view.ids()).toEqual([]);

		await tick(view, 1);
		expect(view.ids()).toEqual([...STAGE_ORDER]);
		expect(fadesIn(view)).toBe(true);
	});

	test.each([
		[100, 50],
		[140, 10],
	])("a first-wait surface opening at document age %d ms is silent for exactly the %d ms that are left of the delay", async (age, left) => {
		clockMs = age;
		const view = await show(connecting, firstWait);
		expect(view.ground()).not.toBeNull();
		expect(view.ids()).toEqual([]);

		await tick(view, left - 1);
		expect(view.ids()).toEqual([]);

		await tick(view, 1);
		expect(view.ids()).toEqual([...STAGE_ORDER]);
		expect(fadesIn(view)).toBe(true);
	});

	test("a first-wait surface that closes, leaves and opens again waits the full silence again: the document's credit is for the first opening only", async () => {
		clockMs = 400;
		const view = await show(connecting, firstWait);
		expect(view.ids()).toEqual([...STAGE_ORDER]);

		await view.render({ ...connecting, open: false });
		await tick(view, 1000);
		expect(view.ground()).toBeNull();

		await tick(view, 600);
		await view.render(connecting);
		expect(view.ground()).not.toBeNull();
		expect(view.ids()).toEqual([]);

		await tick(view, 149);
		expect(view.ids()).toEqual([]);

		await tick(view, 1);
		expect(view.ids()).toEqual([...STAGE_ORDER]);
		expect(fadesIn(view)).toBe(true);
	});

	// Surfaces under ONE first wait, one per key: the keys that are up are what is rendered. A test changes `up` and
	// renders again, so a surface leaves or arrives while the first wait (and its credit) stays mounted.
	let up: readonly string[] = [];
	const together = () => createElement(FirstWait, null, ...up.map(key => createElement(Opening, { ...connecting, key })));

	test("the credit is for the first surface only: once it has left, the next one under the same first wait waits its own silence", async () => {
		clockMs = 400;
		up = ["first"];
		const view = await show(connecting, together);
		expect(view.ids()).toEqual([...STAGE_ORDER]);

		up = [];
		await view.render(connecting);
		expect(view.ground()).toBeNull();

		up = ["next"];
		await view.render(connecting);
		expect(view.ground()).not.toBeNull();
		expect(view.ids()).toEqual([]);

		await tick(view, 149);
		expect(view.ids()).toEqual([]);

		await tick(view, 1);
		expect(view.ids()).toEqual([...STAGE_ORDER]);
		expect(fadesIn(view)).toBe(true);
	});

	test("a surface that takes over from another in the same commit still counts from the document's start: the hand-over does not blink", async () => {
		clockMs = 400;
		up = ["pane"];
		const view = await show(connecting, together);
		expect(view.ids()).toEqual([...STAGE_ORDER]);

		up = ["file"];
		await view.render(connecting);
		expect(view.ids()).toEqual([...STAGE_ORDER]);
		expect(fadesIn(view)).toBe(false);
	});

	test("the wait is not over while a surface of it is still up: one leaving does not take the credit from one that arrives meanwhile", async () => {
		clockMs = 400;
		up = ["a", "b"];
		const view = await show(connecting, together);
		expect(view.ids()).toEqual([...STAGE_ORDER, ...STAGE_ORDER]);

		up = ["b"];
		await view.render(connecting);
		expect(view.ids()).toEqual([...STAGE_ORDER]);

		up = ["b", "c"];
		await view.render(connecting);
		expect(view.ids()).toEqual([...STAGE_ORDER, ...STAGE_ORDER]);
	});

	test("React's StrictMode effect probe is not a surface leaving: one that arrives while the probed surface is up still counts from the document's start", async () => {
		clockMs = 400;
		up = ["a"];
		const view = await show(connecting, () => createElement(StrictMode, null, together()));
		expect(view.ids()).toEqual([...STAGE_ORDER]);
		expect(fadesIn(view)).toBe(false);

		up = ["a", "b"];
		await view.render(connecting);
		expect(view.ids()).toEqual([...STAGE_ORDER, ...STAGE_ORDER]);
	});
});
