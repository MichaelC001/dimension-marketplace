// What the View says while it waits to be told what to open, and where its notices land, as the human sees it.
//
// If these broke: the View would paint "Nothing open / Ask the assistant to open a file" for the frame before the tool
// result that names the file arrives (a flash of the wrong words, said to someone who has just asked for a file); or
// say "Connecting" forever to a host that never sends one, or again after every tab was closed on purpose; or put the
// red notice about some other file above the document the human is reading and shove it down; or open a second file
// with a blank frame, or by tearing down the first; or, while the first file opens, blink "Connecting" out at one of
// the three hand-overs (the shell's fallback, the empty pane, the file's own pane), or make a person who has already
// waited that long wait out another 150 ms of silence; or give a file opened minutes into the View the silence-free
// start that only the files the View was first told about have earned.
//
// The hand-over is timed on ONE controlled clock (the host's surface and the View's are mounted in two roots, and the
// person sees the union), stepped in 10 ms frames and looked at after every frame and after every mount, swap and
// dispatch: a blank run is a number of frames, and the spec allows none (at most one frame would be a display refresh).
//
// Rendered for real (linkedom + react-dom under `act`) through the View's own store and reducer. The files are
// "binary" ones (no renderer, no bytes), except ones that wait on a server that never answers. `main.tsx` cannot be
// imported (it renders into the page as it loads), so the shell's fallback is modelled by the same JSX it renders; that
// wiring itself is not exercised here.
import { afterAll, afterEach, beforeAll, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { ARTIFACT_OPENING_CONNECT_LABEL, ARTIFACT_OPENING_DELAY_MS, ArtifactOpening } from "@fraym/ui/components/artifact-opening";
import type { LaborStep } from "@fraym/ui/components/labor";
import type { App } from "@modelcontextprotocol/ext-apps";
import { createElement, Profiler } from "react";
import { FirstWait, Opening } from "../app/view/opening";
import { createViewerStore, type ViewerStore } from "../app/view/tabs";
import type * as ViewerAppModule from "../app/view/viewer-app";
import type { ViewedFile } from "../src/contract";
import { installReact, type ReactEnv } from "./media-react";
import { silencePaneExtras } from "./pane-extras-door";

let env: ReactEnv;
let viewer: typeof ViewerAppModule;
let unsilence: () => void;
const app = { getHostContext: () => ({ theme: "dark" }) } as unknown as App;
// A server that never answers holds a text file in its loading state, so nothing here races the load.
const silent = { getHostContext: () => ({ theme: "dark" }), callServerTool: () => Promise.withResolvers<never>().promise } as unknown as App;

/** One frame of the controlled clock: finer than a display refresh, so a blank run counted in these is never kinder than the eye. */
const FRAME_MS = 10;

/**
 * The clock the first wait is counted on. Under fake timers `performance.now()` still reads the process's real age, and
 * the first wait is counted from the DOCUMENT's start, so 0 has to mean something: this one is ours, and moves only
 * when `tick` moves the timers with it.
 */
const clock = (() => {
	let now = 0;
	let spy: { mockRestore(): void } | undefined;
	return {
		/** The document's age in ms. */
		now: () => now,
		/** Fake timers and a `performance.now()` of our own, at the document's start. */
		start(): void {
			jest.useFakeTimers();
			now = 0;
			spy = spyOn(performance, "now").mockImplementation(() => now);
		},
		/** Let `ms` go by: the timers due in it fire, and React flushes what they set off. */
		tick: (ms: number): Promise<void> =>
			env.act(async () => {
				now += ms;
				jest.advanceTimersByTime(ms);
			}),
		release(): void {
			spy?.mockRestore();
			spy = undefined;
		},
	};
})();

beforeAll(async () => {
	env = await installReact();
	// The annotation layer beside the document is stood in with nothing until the end of this file (`pane-extras-door.ts`
	// puts the real one back, for the files that sort after it). The renderer index cannot load under bun (Vite's
	// `import.meta.glob`) and no document is opened here, so it stays answered with null; bun cannot lift a module mock, so
	// that one stays installed for the rest of the run: no other viewer test loads it.
	unsilence = await silencePaneExtras();
	mock.module("../app/view/renderers", () => ({ loadRenderer: async () => null }));
	viewer = await import("../app/view/viewer-app");
});
afterEach(async () => {
	// The clock's spy first: it wraps the fake timers' own `performance.now`, which `useRealTimers` puts back for good.
	clock.release();
	// Real timers: `act` waits on the platform's timers, which a fake clock would stop.
	jest.useRealTimers();
	await env.cleanup();
});
afterAll(() => {
	unsilence();
	env.restore();
});

async function show(store: ViewerStore) {
	const view = await env.mount(createElement(viewer.ViewerApp, { app, store }));
	return { ...view, text: () => view.container.textContent ?? "" };
}

const OPENING = '[data-slot="artifact-opening"]';
const file = { path: "C:\\Users\\Me\\report.bin", filename: "report.bin", kind: "binary", size: 12, mtimeMs: 1 } satisfies ViewedFile;
const open = { type: "open", key: file.path, file } as const;
const second = { path: "C:\\Users\\Me\\second.txt", filename: "second.txt", kind: "text", size: 12, mtimeMs: 1 } satisfies ViewedFile;
const paneFor = (key: string) => [...env.document.querySelectorAll('[data-slot="viewer-pane"]')].find(pane => pane.getAttribute("data-key") === key);
const alerts = (container: HTMLElement) => [...container.querySelectorAll('[role="alert"]')];

describe("before the View has been told anything", () => {
	test("an empty View is opening, not empty; the file's tool result replaces the surface with its document pane", async () => {
		const store = createViewerStore();
		const { container, text } = await show(store);
		expect(container.querySelector(OPENING)).not.toBeNull();
		expect(text()).not.toMatch(/Nothing open|Ask the assistant/);

		await env.act(async () => store.dispatch(open));
		expect(container.querySelector('[data-slot="viewer-pane"]')?.textContent).toContain("report.bin");
		// A document's own loading surface lives inside its pane; the one that stood in for "no result yet" is gone.
		const outside = [...container.querySelectorAll(OPENING)].filter(surface => surface.closest('[data-slot="viewer-pane"]') === null);
		expect(outside).toHaveLength(0);
		expect(text()).not.toMatch(/Nothing open|Ask the assistant/);
	});

	test("a host that never sends a result does not leave the View connecting forever", async () => {
		jest.useFakeTimers();
		const { container, text } = await show(createViewerStore());
		expect(container.querySelector(OPENING)).not.toBeNull();

		await env.act(async () => jest.advanceTimersByTime(60_000));
		expect(text()).toContain("Nothing open");
		expect(container.querySelector(OPENING)).toBeNull();
	});
});

describe("after the View has been told what to open", () => {
	test("closing every tab is the real empty state, not the opening surface again", async () => {
		const store = createViewerStore();
		const { container, text } = await show(store);
		await env.act(async () => store.dispatch(open));
		await env.act(async () => store.dispatch({ type: "close", key: open.key }));

		expect(text()).toContain("Nothing open");
		expect(container.querySelector(OPENING)).toBeNull();
		expect(container.querySelector('[data-slot="viewer-pane"]')).toBeNull();
	});

	test("a second file opens with its opening surface up in every frame it is on screen, and the first stays mounted, hidden", async () => {
		// One entry per frame React committed in which the second file's pane existed: did it already hold its surface?
		const frames: boolean[] = [];
		const record = () => {
			const pane = paneFor(second.path);
			if (pane) frames.push(pane.querySelector(OPENING) !== null);
		};
		const store = createViewerStore();
		store.dispatch(open);
		await env.mount(createElement(Profiler, { id: "view", onRender: record }, createElement(viewer.ViewerApp, { app: silent, store })));
		const first = paneFor(open.key);
		expect(first).toBeDefined();

		await env.act(async () => store.dispatch({ type: "open", key: second.path, file: second }));

		// The Profiler is what makes the frames observable: no frames would mean it never reported, not that none were blank.
		expect(frames.length).toBeGreaterThan(0);
		expect(frames).not.toContain(false);
		const shown = paneFor(second.path);
		expect(shown?.querySelector(OPENING)).not.toBeNull();
		// The first file's pane is the same node as before (kept alive for its zoom and scroll), now out of sight; the second's is in sight.
		expect(paneFor(open.key) === first, "the first file's pane was torn down and rebuilt").toBe(true);
		expect(first?.parentElement?.classList.contains("hidden")).toBe(true);
		expect(shown?.parentElement?.classList.contains("hidden")).toBe(false);
	});
});

describe("a notice", () => {
	const message = "The other file is outside the folders this View may read.";
	const noticeIn = (container: HTMLElement) => alerts(container).find(alert => alert.textContent?.includes(message));

	test("about another file floats beside the pane the human is reading and can be dismissed", async () => {
		const store = createViewerStore();
		store.dispatch(open);
		const { container } = await show(store);
		await env.act(async () => store.dispatch({ type: "refused", message }));

		const notice = noticeIn(container);
		expect(notice).toBeDefined();
		const wrapper = container.querySelector('[data-slot="viewer-pane"]')?.parentElement;
		const area = wrapper?.parentElement;
		// Not a row of the View's own column, where it would take height above the pane: it shares the pane's container,
		// after the pane.
		expect(notice?.parentElement === area, "the notice sits in the pane's container, not in the View's column").toBe(true);
		const siblings = [...(area?.children ?? [])];
		expect(siblings.indexOf(notice as Element)).toBeGreaterThan(siblings.indexOf(wrapper as Element));

		const dismiss = notice?.querySelector('button[aria-label="Dismiss"]');
		expect(dismiss).not.toBeNull();
		await env.act(async () => void dismiss?.dispatchEvent(new window.Event("click", { bubbles: true })));
		expect(noticeIn(container)).toBeUndefined();
		expect(container.querySelector('[data-slot="viewer-pane"]')?.textContent).toContain("report.bin");
	});

	test("with nothing open is the one card in the pane, never also the floating banner", async () => {
		const store = createViewerStore();
		store.dispatch({ type: "refused", message });
		const { container, text } = await show(store);

		expect(text()).toContain(message);
		expect(alerts(container)).toHaveLength(1);
		expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
		expect(text()).not.toMatch(/Nothing open|Ask the assistant/);
	});
});

describe("the first wait", () => {
	const SILENCE = ARTIFACT_OPENING_DELAY_MS;
	const CONNECTING = ARTIFACT_OPENING_CONNECT_LABEL;
	type Mounted = Awaited<ReturnType<ReactEnv["mount"]>>;
	/** The person's screen: the host's root over the iframe, and the View's root inside it (once there is one). */
	interface Screen {
		host?: Mounted;
		view?: Mounted;
	}
	/** What the person reads at one instant: the words of each root's opening surface, a fading one included (it is still on screen). */
	interface Frame {
		readonly at: number;
		readonly host: string;
		readonly view: string;
		readonly viewUp: boolean;
	}
	type Script = ReadonlyArray<readonly [at: number, step: (screen: Screen) => Promise<void>]>;

	/** What the host puts over the iframe from the instant the tab exists until the handshake completes. */
	const hostSurface = (open: boolean) =>
		createElement(ArtifactOpening, { steps: [{ id: "connect", label: CONNECTING, status: "active" }] satisfies LaborStep[], open });
	/** The shell's fallback until the handshake: `main.tsx`'s own JSX (see the note at the top of this file). */
	const shellFallback = () => createElement(FirstWait, null, createElement("div", { className: "relative h-full" }, createElement(Opening, { name: "", stage: "connect" })));

	const mountHost = async (screen: Screen) => void (screen.host = await env.mount(hostSurface(true)));
	const handshake = async (screen: Screen) => screen.host?.render(hostSurface(false));
	const mountShellFallback = async (screen: Screen) => void (screen.view = await env.mount(shellFallback()));
	const swapToViewer = (store: ViewerStore) => async (screen: Screen) => screen.view?.render(createElement(viewer.ViewerApp, { app: silent, store }));
	const fileArrives = (store: ViewerStore) => async () => env.act(async () => store.dispatch({ type: "open", key: second.path, file: second }));

	const said = (frame: Frame) => `${frame.host} ${frame.view}`.trim();
	const wordsOf = (root: HTMLElement | undefined) =>
		[...(root?.querySelectorAll(OPENING) ?? [])]
			.map(surface => surface.textContent ?? "")
			.join(" ")
			.trim();

	/** Runs the document's clock from its start to `until`, each step at its time, and writes down what is on screen right after every step (the frame a surface was mounted, swapped or told something in) and after every frame. */
	async function play(script: Script, until: number): Promise<{ readonly frames: Frame[]; readonly screen: Screen }> {
		const screen: Screen = {};
		const frames: Frame[] = [];
		const record = () => void frames.push({ at: clock.now(), host: wordsOf(screen.host?.container), view: wordsOf(screen.view?.container), viewUp: screen.view !== undefined });
		let next = 0;
		for (;;) {
			while (next < script.length && script[next][0] <= clock.now()) {
				await script[next++][1](screen);
				record();
			}
			if (clock.now() >= until) return { frames, screen };
			await clock.tick(FRAME_MS);
			record();
		}
	}

	test("a slow open keeps 'Connecting' on screen in every frame once the silence is over, through the shell's fallback, the empty pane and the file's pane, which then names the file", async () => {
		clock.start();
		const handshakeAt = SILENCE + 250;
		const store = createViewerStore();
		const { frames, screen } = await play(
			[
				[0, mountHost],
				[handshakeAt, handshake],
				[handshakeAt, mountShellFallback],
				[handshakeAt + 50, swapToViewer(store)],
				[handshakeAt + 100, fileArrives(store)],
			],
			handshakeAt + 500,
		);

		// The Profiler-less equivalent of "a frame was observed": the clock really ran, and every instant was written down.
		expect(frames.at(-1)?.at).toBe(handshakeAt + 500);
		expect(frames.filter(frame => frame.at < SILENCE && said(frame) !== "").map(frame => frame.at), "frames that spoke inside the silence").toEqual([]);
		// The spec allows at most one blank frame at a hand-over; the hand-over is held to none.
		expect(frames.filter(frame => frame.at >= SILENCE && !said(frame).includes(CONNECTING)).map(frame => frame.at), "frames without 'Connecting' once the silence was over").toEqual([]);
		// The host fades over the View for a motion beat: the View's own surface must already be saying what the host's is, or the words dip as the host fades.
		expect(frames.filter(frame => frame.viewUp && !frame.view.includes(CONNECTING)).map(frame => frame.at), "frames where the View's own surface was silent").toEqual([]);
		const reading = paneFor(second.path)?.querySelector('[data-slot="labor-step"][data-step="read"]');
		expect(reading?.textContent).toContain(`Reading ${second.filename}`);
		expect(screen.view).toBeDefined();
	});

	test("a fast open says nothing before the silence is over, speaks at its end and never stops, though the host never spoke and three surfaces take turns", async () => {
		clock.start();
		const handshakeAt = SILENCE - 50;
		const store = createViewerStore();
		const { frames } = await play(
			[
				[0, mountHost],
				[handshakeAt, handshake],
				[handshakeAt, mountShellFallback],
				[SILENCE, swapToViewer(store)],
				[SILENCE + 50, fileArrives(store)],
			],
			SILENCE + 550,
		);

		const spoke = frames.find(frame => said(frame) !== "");
		expect(frames.filter(frame => frame.at < SILENCE && said(frame) !== "").map(frame => frame.at), "frames that spoke inside the silence").toEqual([]);
		// A View surface opened at age 100 owes the person 50 more ms, not 150: the wait began when the tab did.
		expect(spoke?.at).toBeGreaterThanOrEqual(SILENCE);
		expect(spoke?.at).toBeLessThan(SILENCE + FRAME_MS);
		expect(frames.filter(frame => frame.at >= (spoke?.at ?? 0) && said(frame) === "").map(frame => frame.at), "frames that fell silent after the words came").toEqual([]);
	});

	test("a file opened later waits on its own silence: its ground at once, its rows only after the delay, however old the View is", async () => {
		clock.start();
		await clock.tick(5000);
		const store = createViewerStore();
		store.dispatch(open);
		await env.mount(createElement(viewer.ViewerApp, { app: silent, store }));
		await fileArrives(store)();

		const rows = () => paneFor(second.path)?.querySelectorAll('[data-slot="labor-step"]').length;
		expect(paneFor(second.path)?.querySelector(OPENING)).not.toBeNull();
		expect(rows()).toBe(0);
		await clock.tick(SILENCE - FRAME_MS);
		expect(rows()).toBe(0);
		await clock.tick(FRAME_MS);
		expect(rows()).toBeGreaterThan(0);
		expect(paneFor(second.path)?.querySelector('[data-step="read"]')?.textContent).toContain(`Reading ${second.filename}`);
	});

	test("a View that already holds its file when it first renders speaks in that first frame and never paints the empty pane", async () => {
		clock.start();
		// The host's own surface has been speaking since the silence ended; this View's first render comes after.
		await clock.tick(SILENCE + 250);
		const store = createViewerStore();
		store.dispatch({ type: "open", key: second.path, file: second });
		const frames: Array<{ readonly pane: boolean; readonly speaking: boolean; readonly strays: number; readonly statement: boolean }> = [];
		const record = () => {
			const pane = paneFor(second.path);
			frames.push({
				pane: pane !== undefined,
				speaking: pane?.querySelector('[data-slot="artifact-opening-steps"]') != null,
				strays: [...env.document.querySelectorAll(OPENING)].filter(surface => surface.closest('[data-slot="viewer-pane"]') === null).length,
				statement: /Nothing open/.test(env.document.body.textContent ?? ""),
			});
		};
		await env.mount(createElement(Profiler, { id: "view", onRender: record }, createElement(viewer.ViewerApp, { app: silent, store })));

		// A file that waits on a server that never answers is on its opening surface in every frame the View commits.
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.filter(frame => !frame.pane || !frame.speaking || frame.strays > 0 || frame.statement)).toEqual([]);
	});
});
