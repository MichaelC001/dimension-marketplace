// What a person watches while a document opens in the pane: each stage of the wait is the one really under way.
//
// If these broke: "Reading 0 B of 0 B" would sit still while megabytes stream in, or "Preparing" would show while the
// file is still arriving (and "Reading" while only the drawing is left), so the words stop meaning anything; the
// renderer would load only after the whole file is in, so every open waits for the sum of both instead of the longer;
// a file that opens in a blink would flash three rows at them; a finished document would stay under the spinner, or the
// spinner would leave before the page is drawn and show a blank stage; a failure would sit behind "Reading" instead of
// telling them the file could not be shown, or wait for a download that is never needed before saying so; and a pane
// that loads again (the theme changes, the file changes on disk, Try again) would flash "Reading ..." the instant it
// reloads, as if the whole wait were still going, instead of staying quiet for a blink like a first open, or would
// blank the words already on screen when it reloads while they are still fading.
//
// `DocPane` is rendered for real (linkedom + react-dom under `act`, fake timers advanced by hand). Its three outside
// doors are stood in for: the bytes (`loadDocumentBytes`) and the renderer chunk (`loadRenderer`) are promises the test
// settles, and the renderer's `mount` is a promise the test settles, so every stage boundary is the test's to cross.
import { afterAll, afterEach, beforeAll, describe, expect, jest, mock, spyOn, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { ARTIFACT_OPENING_DELAY_MS } from "@fraym/ui/components/artifact-opening";
import { createElement, Profiler } from "react";
import type * as DocPaneModule from "../app/view/doc-pane";
import type { DocumentLoadOptions, LoadedDocument } from "../app/view/document-bytes";
import * as realBytesModule from "../app/view/document-bytes";
import { FirstWait } from "../app/view/opening";
import type { Mounted, Renderer, Theme } from "../app/view/renderers/types";
import type { DocTab } from "../app/view/tabs";
import type { ViewerKind } from "../src/contract";
import { installReact, type ReactEnv } from "./media-react";
import { silencePaneExtras } from "./pane-extras-door";

let env: ReactEnv;
let unsilence: () => void;
let docPane: typeof DocPaneModule;
const app = { getHostContext: () => ({ theme: "dark" }) } as unknown as App;

/** What the doors answer for the test in progress; `null` outside one, when they behave as they do for every other file. */
interface Armed {
	readonly read: (options: DocumentLoadOptions | undefined) => Promise<LoadedDocument>;
	readonly loadChunk: (kind: ViewerKind) => Promise<Renderer | null>;
}
let armed: Armed | null = null;

beforeAll(async () => {
	env = await installReact();
	// A snapshot taken before the mock goes in: the module's own bindings are live, and must not point back at the mock.
	const realBytes = { ...realBytesModule };
	// Bun cannot lift a module mock, so `renderers` and `document-bytes` stay installed for the rest of the run and answer
	// as they did before when no test here is armed. `renderers` cannot load under bun (Vite's `import.meta.glob`);
	// `document-bytes` is the real module but for the one door the test needs to hold shut. The annotation layer is
	// stood in with nothing for this file only, and put back after it (`unsilence`).
	unsilence = await silencePaneExtras();
	mock.module("../app/view/renderers", () => ({ loadRenderer: (kind: ViewerKind) => (armed === null ? Promise.resolve(null) : armed.loadChunk(kind)) }));
	mock.module("../app/view/document-bytes", () => ({
		...realBytes,
		loadDocumentBytes: (host: App, tab: DocTab, options?: DocumentLoadOptions) => (armed === null ? realBytes.loadDocumentBytes(host, tab, options) : armed.read(options)),
	}));
	// Not a static import: react-dom decides once, when it loads, whether there is a DOM, and the mocks above must be in first.
	docPane = await import("../app/view/doc-pane");
});
afterEach(async () => {
	armed = null;
	// Real timers first: `act` waits on the platform's timers, which a fake clock would stop.
	jest.useRealTimers();
	await env.cleanup();
});
afterAll(() => {
	armed = null;
	unsilence();
	env.restore();
});

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: Error) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** One document opening, with every door held by the test. */
interface Scenario {
	/** The options the pane handed each request for the bytes: the way the read reports `onProgress`. */
	readonly reads: DocumentLoadOptions[];
	/** The kind of each renderer chunk asked for. */
	readonly chunks: ViewerKind[];
	/** The stage each `mount` was handed. */
	readonly mounts: HTMLElement[];
	readonly bytes: Deferred<LoadedDocument>;
	readonly chunk: Deferred<Renderer | null>;
	readonly drawing: Deferred<Mounted>;
	/** What the chunk resolves to; its `mount` answers with {@link Scenario.drawing}. */
	readonly renderer: Renderer;
	/** The bytes streaming in: what the read reports through the `onProgress` the pane gave it. */
	readonly progress: (done: number, total: number) => void;
}

function arm(): Scenario {
	const reads: DocumentLoadOptions[] = [];
	const chunks: ViewerKind[] = [];
	const mounts: HTMLElement[] = [];
	const bytes = deferred<LoadedDocument>();
	const chunk = deferred<Renderer | null>();
	const drawing = deferred<Mounted>();
	const renderer: Renderer = {
		mount: (stage: HTMLElement) => {
			mounts.push(stage);
			return drawing.promise;
		},
	};
	armed = {
		read: options => {
			reads.push(options ?? {});
			return bytes.promise;
		},
		loadChunk: kind => {
			chunks.push(kind);
			return chunk.promise;
		},
	};
	const progress = (done: number, total: number): void => {
		const report = reads[0]?.onProgress;
		if (report === undefined) throw new Error("the pane never asked for the bytes");
		report(done, total);
	};
	return { reads, chunks, mounts, bytes, chunk, drawing, renderer, progress };
}

const MB = 1024 * 1024;
/** What the server said the file's size was when it was listed: deliberately NOT the total the read reports below. */
const LISTED_SIZE = 2 * MB;
const IN_HAND: LoadedDocument = { bytes: new Uint8Array([1, 2, 3, 4]), truncated: false };
/** Well past one motion beat: the surface has finished fading and has left. */
const FADE_OUT_MS = 1000;
/** Inside one motion beat (the shortest is 90 ms): the surface has begun to fade and is still there. */
const INSIDE_FADE_MS = 50;
/** "1.0 MB", "512 B": the counts the read row prints. */
const BYTE_COUNT = /\d+(\.\d+)? (B|KB|MB|GB)\b/;

const FRAME = '[data-slot="viewer-stage-frame"]';
const SURFACE = `${FRAME} [data-slot="artifact-opening"]`;
const ROW = `${SURFACE} [data-slot="labor-step"]`;
const ERROR_CARD = `${FRAME} [role="alert"]`;

/** The surface over the document: `open`, `closed` (fading out, every row done) or `gone` (not in the tree). A string, so a failure prints a word and not a DOM. */
const surfaceState = (container: HTMLElement): "open" | "closed" | "gone" => (container.querySelector(SURFACE)?.getAttribute("data-state") as "open" | "closed" | null) ?? "gone";
const count = (container: HTMLElement, selector: string): number => container.querySelectorAll(selector).length;
/** Each row as `step:status`, top to bottom: what the human reads off the surface. */
const steps = (container: HTMLElement): string[] => [...container.querySelectorAll(ROW)].map(row => `${row.getAttribute("data-step")}:${row.getAttribute("data-status")}`);
const readRow = (container: HTMLElement): string => container.querySelector(`${ROW}[data-step="read"]`)?.textContent ?? "";
const ahead = (ms: number) => env.act(async () => void jest.advanceTimersByTime(ms));
const mounted = (): Mounted => ({ destroy() {}, zoom() {} });

let seq = 0;
/** What the pane is given the second time it loads: the page's theme changed, or the file did (a new revision). */
interface Reload {
	readonly theme?: Theme;
	readonly revision?: number;
}

/**
 * Opens a picture in the pane (nothing media-specific runs) with every door held, on a clock the test moves. With
 * `firstWait` the pane is one the View was first told about, as `ViewerApp` seats it (inside `FirstWait`).
 * `reload` hands the SAME mounted pane the next theme or revision, with the doors held anew (the first load's promises
 * are spent), and answers with that scenario and the frames the reload drew: the rows on screen after each commit it
 * made, in order, which is every state a person could have seen.
 */
async function open(options: { readonly firstWait?: boolean } = {}) {
	jest.useFakeTimers();
	const scenario = arm();
	seq += 1;
	const filename = `opening-${seq}.png`;
	const tab: DocTab = { key: `opening-${seq}`, path: `C:\\docs\\${filename}`, filename, kind: "image", size: LISTED_SIZE, mtimeMs: 1, revision: 0, annotateRequests: 0 };
	let now = { theme: "dark" as Theme, revision: 0 };
	const commits: string[][] = [];
	const pane = () => {
		const view = createElement(docPane.DocPane, { app, tab: { ...tab, revision: now.revision }, active: true, theme: now.theme });
		return createElement(Profiler, { id: "pane", onRender: () => void commits.push(steps(env.document.body)) }, options.firstWait === true ? createElement(FirstWait, null, view) : view);
	};
	const { container, render } = await env.mount(pane());
	const reload = async (change: Reload) => {
		const next = arm();
		now = { ...now, ...change };
		const before = commits.length;
		await render(pane());
		return { scenario: next, frames: commits.slice(before) };
	};
	return { scenario, container, tab, reload };
}

/** The bytes come in, the renderer chunk arrives, the document is drawn: the door answers that ready the pane. */
async function drawn(scenario: Scenario): Promise<void> {
	await env.act(async () => scenario.bytes.resolve(IN_HAND));
	await env.act(async () => scenario.chunk.resolve(scenario.renderer));
	await env.act(async () => scenario.drawing.resolve(mounted()));
}

describe("reading: the bytes are really streaming in", () => {
	test("the read row shows the counts last reported by the read, and each new report replaces them", async () => {
		const { scenario, container } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		expect(steps(container)).toEqual(["connect:done", "read:active", "prepare:pending"]);

		await env.act(async () => void scenario.progress(1 * MB, 4 * MB));
		expect(readRow(container)).toContain("1.0 MB of 4.0 MB");
		expect(steps(container)).toEqual(["connect:done", "read:active", "prepare:pending"]);

		await env.act(async () => void scenario.progress(3 * MB, 4 * MB));
		expect(readRow(container)).toContain("3.0 MB of 4.0 MB");
	});

	test("the renderer chunk arriving before the bytes does not end the read: it is still reading, still counting", async () => {
		const { scenario, container } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		await env.act(async () => void scenario.progress(1 * MB, 4 * MB));

		await env.act(async () => scenario.chunk.resolve(scenario.renderer));
		expect(steps(container)).toEqual(["connect:done", "read:active", "prepare:pending"]);
		expect(readRow(container)).toContain("1.0 MB of 4.0 MB");
		expect(scenario.mounts).toHaveLength(0);
	});
});

describe("preparing: from the moment the bytes are in hand until the document is drawn", () => {
	test("the renderer chunk is asked for while the bytes are still being requested, not after them or before them", async () => {
		const { scenario } = await open();
		// Neither door has answered, and both have been asked: the two waits overlap instead of adding up.
		expect(scenario.reads).toHaveLength(1);
		expect(scenario.chunks).toEqual(["image"]);
	});

	test("the bytes arriving starts preparing at once, with the renderer chunk still loading: no byte counts, and the surface stays up", async () => {
		const { scenario, container } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		await env.act(async () => void scenario.progress(1 * MB, 4 * MB));
		expect(steps(container)).toEqual(["connect:done", "read:active", "prepare:pending"]);

		await env.act(async () => scenario.bytes.resolve(IN_HAND));
		expect(steps(container)).toEqual(["connect:done", "read:done", "prepare:active"]);
		expect(readRow(container)).not.toMatch(BYTE_COUNT);

		// The bytes alone do not make a document: nothing is drawn, so nothing is ready however long it takes.
		await ahead(FADE_OUT_MS);
		expect(scenario.mounts).toHaveLength(0);
		expect(steps(container)).toEqual(["connect:done", "read:done", "prepare:active"]);
		expect(surfaceState(container)).toBe("open");
	});
});

describe("ready: the document is drawn", () => {
	test("the surface stays up through the drawing, then every row reads done, it fades and leaves, and nothing covers the stage", async () => {
		const { scenario, container } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		await env.act(async () => scenario.bytes.resolve(IN_HAND));
		await env.act(async () => scenario.chunk.resolve(scenario.renderer));

		// The bytes are in and the renderer is in; the document is still being drawn, so it is still preparing.
		expect(scenario.mounts).toHaveLength(1);
		expect(steps(container)).toEqual(["connect:done", "read:done", "prepare:active"]);
		expect(surfaceState(container)).toBe("open");

		await env.act(async () => scenario.drawing.resolve(mounted()));
		expect(steps(container)).toEqual(["connect:done", "read:done", "prepare:done"]);
		expect(surfaceState(container)).toBe("closed");

		await ahead(FADE_OUT_MS);
		expect(surfaceState(container)).toBe("gone");
		expect(count(container, `${FRAME} [data-slot="viewer-stage"]`)).toBe(1);
		expect(count(container, `${FRAME} [role="status"]`)).toBe(0);
		expect(count(container, ERROR_CARD)).toBe(0);
	});
});

describe("a fast load is silent", () => {
	test("everything resolving inside the delay shows the ground and no row at any moment, and the ground leaves after the beat", async () => {
		const { scenario, container } = await open();
		// The ground is up on the first frame, with nothing written on it.
		expect(surfaceState(container)).toBe("open");
		expect(steps(container)).toEqual([]);

		await ahead(ARTIFACT_OPENING_DELAY_MS - 1);
		expect(steps(container)).toEqual([]);
		await env.act(async () => scenario.chunk.resolve(scenario.renderer));
		await env.act(async () => scenario.bytes.resolve(IN_HAND));
		await env.act(async () => scenario.drawing.resolve(mounted()));
		expect(surfaceState(container)).toBe("closed");

		// The delay would have run out here, then the fade-out beat: no row shows at any point.
		for (const ms of [1, ARTIFACT_OPENING_DELAY_MS, 100, FADE_OUT_MS]) {
			await ahead(ms);
			expect(steps(container)).toEqual([]);
			expect(container.querySelector(SURFACE)?.textContent ?? "").toBe("");
		}
		expect(surfaceState(container)).toBe("gone");
	});
});

describe("a failure", () => {
	test("the bytes failing replaces the surface with the error card and its message, at once", async () => {
		const { scenario, container } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		expect(steps(container)).toEqual(["connect:done", "read:active", "prepare:pending"]);

		await env.act(async () => scenario.bytes.reject(new Error("The file changed while it was being read. Open it again.")));
		const card = container.querySelector(ERROR_CARD);
		expect(card?.textContent).toContain("This file could not be shown");
		expect(card?.textContent).toContain("The file changed while it was being read. Open it again.");
		expect(surfaceState(container)).toBe("gone");
		expect(scenario.mounts).toHaveLength(0);
	});

	test("the renderer chunk failing while the bytes are still streaming says so at once, without waiting for the download", async () => {
		const { scenario, container } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		await env.act(async () => void scenario.progress(1 * MB, 4 * MB));

		await env.act(async () => scenario.chunk.reject(new Error("Could not load the picture viewer.")));
		const card = container.querySelector(ERROR_CARD);
		expect(card?.textContent).toContain("This file could not be shown");
		expect(card?.textContent).toContain("Could not load the picture viewer.");
		expect(surfaceState(container)).toBe("gone");
	});

	test("the error card is not taken back by the bytes arriving afterwards", async () => {
		const { scenario, container } = await open();
		await env.act(async () => scenario.chunk.reject(new Error("Could not load the picture viewer.")));
		expect(count(container, ERROR_CARD)).toBe(1);

		await env.act(async () => scenario.bytes.resolve(IN_HAND));
		await ahead(FADE_OUT_MS);
		expect(container.querySelector(ERROR_CARD)?.textContent).toContain("Could not load the picture viewer.");
		expect(surfaceState(container)).toBe("gone");
	});
});

describe("a reload is a new wait", () => {
	const READING = ["connect:done", "read:active", "prepare:pending"];

	test.each<[string, Reload]>([
		["the page's theme changes", { theme: "light" }],
		["the file changes on disk (a new revision)", { revision: 1 }],
	])("%s: the pane loads it again behind the ground at once, and the words come only after the full delay", async (_what, change) => {
		const { scenario, container, reload } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		expect(steps(container)).toEqual(READING);
		await drawn(scenario);
		await ahead(FADE_OUT_MS);
		expect(surfaceState(container)).toBe("gone");

		const { scenario: again, frames } = await reload(change);
		expect(again.reads).toHaveLength(1);
		// The first frame of the new wait, and every frame the reload drew, is the ground and nothing written on it.
		expect(surfaceState(container)).toBe("open");
		expect(frames.flat(), "the rows on screen after each commit of the reload").toEqual([]);
		expect(container.querySelector(SURFACE)?.textContent ?? "").toBe("");

		await ahead(ARTIFACT_OPENING_DELAY_MS - 1);
		expect(steps(container)).toEqual([]);
		await ahead(1);
		expect(steps(container)).toEqual(READING);
	});

	test("a reload while the last surface is still fading keeps the words on screen, now reading live: no frame of the ground alone", async () => {
		const { scenario, container, reload } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		await drawn(scenario);
		expect(surfaceState(container)).toBe("closed");
		expect(steps(container)).toEqual(["connect:done", "read:done", "prepare:done"]);

		await ahead(INSIDE_FADE_MS);
		const { frames } = await reload({ theme: "light" });
		expect(surfaceState(container)).toBe("open");
		expect(steps(container)).toEqual(READING);
		expect(
			frames.map(rows => rows.length),
			"how many rows were on screen after each commit of the reload",
		).toEqual(frames.map(() => READING.length));
	});

	test("Try again after a failure is a new wait: the ground at once, the words only after the full delay", async () => {
		const { scenario, container } = await open();
		await ahead(ARTIFACT_OPENING_DELAY_MS);
		expect(steps(container)).toEqual(READING);
		await env.act(async () => scenario.bytes.reject(new Error("The file changed while it was being read. Open it again.")));
		expect(container.querySelector(ERROR_CARD)?.textContent).toContain("This file could not be shown");

		const again = arm();
		const retry = container.querySelector(`${ERROR_CARD} button`);
		expect(retry?.textContent).toBe("Try again");
		await env.act(async () => void retry?.dispatchEvent(new window.Event("click", { bubbles: true })));
		expect(again.reads).toHaveLength(1);
		expect(count(container, ERROR_CARD)).toBe(0);
		expect(surfaceState(container)).toBe("open");
		expect(steps(container)).toEqual([]);

		await ahead(ARTIFACT_OPENING_DELAY_MS - 1);
		expect(steps(container)).toEqual([]);
		await ahead(1);
		expect(steps(container)).toEqual(READING);
	});

	test("Try again on a file the View was first told about is a wait of its own: the first wait's head start is spent, and the full delay is owed again", async () => {
		// The document's age is `performance.now()`: held by the test, and moved only with the timers. It is 100 ms old
		// when the pane opens, so a first wait has 50 ms of silence left.
		const AGE_AT_OPEN = 100;
		let age = AGE_AT_OPEN;
		const clock = spyOn(performance, "now").mockImplementation(() => age);
		const tick = (ms: number) =>
			env.act(async () => {
				age += ms;
				jest.advanceTimersByTime(ms);
			});
		try {
			const { scenario, container } = await open({ firstWait: true });
			// The first wait counts from the document's start, not from the pane's mount.
			expect(steps(container)).toEqual([]);
			await tick(ARTIFACT_OPENING_DELAY_MS - AGE_AT_OPEN - 1);
			expect(steps(container)).toEqual([]);
			await tick(1);
			expect(steps(container)).toEqual(READING);

			await env.act(async () => scenario.bytes.reject(new Error("The file changed while it was being read. Open it again.")));
			expect(surfaceState(container)).toBe("gone");
			// The human reads the card; the document is old now.
			await tick(5000);

			const again = arm();
			await env.act(async () => void container.querySelector(`${ERROR_CARD} button`)?.dispatchEvent(new window.Event("click", { bubbles: true })));
			expect(again.reads).toHaveLength(1);
			expect(surfaceState(container)).toBe("open");
			expect(steps(container)).toEqual([]);

			await tick(ARTIFACT_OPENING_DELAY_MS - 1);
			expect(steps(container)).toEqual([]);
			await tick(1);
			expect(steps(container)).toEqual(READING);
		} finally {
			clock.mockRestore();
		}
	});
});
