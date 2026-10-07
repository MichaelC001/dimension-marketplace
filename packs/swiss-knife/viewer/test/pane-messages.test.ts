// What the pane says and does around a document, as the human sees it (docs/design/88 section 6, "no engine words").
//
// A file that would not open: the View used to put the server's own error text in a red banner over "Nothing open / Ask
// the assistant to open a file...": engine words, the path twice, and an empty state that was not true (the human had
// just asked for a file). It is now the pane for that file, with its name in the bar and one sentence saying what to do.
//
// The annotation mode is not a switch any more: the one bar is part of the pane, so a kind that can be marked is in its
// mode from the pane's first frame until the document is gone (a file that did not open has nothing to mark). The layer
// on top (`PaneExtras`) is told the mode, and nothing more about it; the second `ready` after a theme change must not
// take it down. While the document opens the pane shows the opening surface, naming the stage under way.
//
// Rendered for real (linkedom + react-dom under `act`): the View through its own store and reducer (the same actions the
// tool result produces), and the pane on a fake `app` that streams a few bytes and a fake renderer, with the layer on
// top replaced by a recorder of the props the pane renders it with.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { createElement } from "react";
import type * as DocPaneModule from "../app/view/doc-pane";
import { finishMediaWork } from "../app/view/media-lifecycle";
import type { PaneExtrasProps } from "../app/view/pane-shared";
import type { Mounted, Renderer, Theme } from "../app/view/renderers/types";
import { actionFromResult } from "../app/view/result";
import { createViewerStore, type DocTab, type ViewerStore } from "../app/view/tabs";
import type * as ViewerAppModule from "../app/view/viewer-app";
import type { ViewerKind } from "../src/contract";
import { installReact, type ReactEnv } from "./media-react";
import { silencePaneExtras } from "./pane-extras-door";

let env: ReactEnv;
let viewer: typeof ViewerAppModule;
let docPane: typeof DocPaneModule;
let unsilence: () => void;
const app = { getHostContext: () => ({ theme: "dark" }) } as unknown as App;
const at = "C:\\Users\\Me\\notes.wav";

/** Every render of the layer on top, in order: what the pane told it each time. */
const extras: PaneExtrasProps[] = [];
/** What `loadRenderer` answers; a test replaces it, and every test starts with no renderer in this build. */
let loadRendererImpl: (kind: ViewerKind) => Promise<Renderer | null> = async () => null;

beforeAll(async () => {
	env = await installReact();
	// Two modules of the pane cannot load under bun: the annotation layers (the kit's React sources, whose tsconfig react
	// paths bun cannot follow) and the renderer index (Vite's `import.meta.glob`). The layer is stood in by a recorder
	// for the length of this file and then put back (`pane-extras-door.ts`): `pane-extras.test.tsx` mounts the real one
	// in the same process. Bun cannot lift a module mock, so the renderer index stays installed for the rest of the
	// run: no other viewer test loads it. `annotate-modes` is NOT mocked: the pane derives its mode from the real
	// table, and `annotate-modes.test.ts` runs in this process.
	unsilence = await silencePaneExtras(props => {
		extras.push(props);
		return null;
	});
	mock.module("../app/view/renderers", () => ({ loadRenderer: (kind: ViewerKind) => loadRendererImpl(kind) }));
	viewer = await import("../app/view/viewer-app");
	docPane = await import("../app/view/doc-pane");
});
beforeEach(() => {
	extras.length = 0;
	loadRendererImpl = async () => null;
});
afterEach(async () => {
	// Real timers first: `act` waits on the platform's timers, which a fake clock would stop.
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

const error = (text: string) => actionFromResult({ isError: true, content: [{ type: "text", text }] });

describe("the pane for a file that would not open", () => {
	test("a locked file shows its name and one sentence in its own pane: no raw error, no empty state", async () => {
		const store = createViewerStore();
		store.dispatch(error(`"${at}" cannot be opened: EBUSY: resource busy or locked, open '${at}' (EBUSY)`));
		const { container, text } = await show(store);
		const pane = container.querySelector('[data-slot="viewer-pane"][data-failed]');
		expect(pane?.textContent).toContain("notes.wav");
		expect(pane?.textContent).toMatch(/open or locked/);
		expect(text()).not.toMatch(/EBUSY|resource busy|Nothing open|Ask the assistant/);
		// Said once, in one place, and not as the red banner the View uses for news about some other file.
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
		expect(container.querySelector('[data-slot="viewer-root"] > [role="alert"]')).toBeNull();
	});

	test("Copy path is offered where the sentence points to it, and not where there is nothing to copy it for", async () => {
		const denied = createViewerStore();
		denied.dispatch(error(`"${at}" cannot be opened: EACCES: permission denied, open '${at}' (EACCES)`));
		const withButton = await show(denied);
		expect([...withButton.container.querySelectorAll("button")].map(button => button.textContent)).toContain("Copy path");
		await env.cleanup();
		const busy = createViewerStore();
		busy.dispatch(error(`"${at}" cannot be opened: EBUSY: resource busy or locked, open '${at}' (EBUSY)`));
		const without = await show(busy);
		expect([...without.container.querySelectorAll("button")].map(button => button.textContent)).not.toContain("Copy path");
	});

	test("an error that names no file is the card in place of the empty state, never beside it", async () => {
		const store = createViewerStore();
		store.dispatch(error("the path is empty"));
		const { container, text } = await show(store);
		expect(text()).toContain("the path is empty");
		expect(text()).not.toMatch(/Nothing open/);
		expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
	});

	test("a notice that has been dismissed leaves the empty state: the View was told something, it is not waiting any more", async () => {
		const store = createViewerStore();
		store.dispatch(error("the path is empty"));
		const { container, text } = await show(store);
		await env.act(async () => store.dispatch({ type: "dismiss" }));
		expect(text()).toMatch(/Nothing open/);
		// Not the surface that stands in for "no tool result yet".
		expect(container.querySelector('[data-slot="artifact-opening"]')).toBeNull();
	});
});

// ---- The pane around a document ---------------------------------------------------------------------------------

const BYTES = new Uint8Array([1, 2, 3, 4]);
const FRAME = '[data-slot="viewer-stage-frame"]';
const OPENING = '[data-slot="artifact-opening"]';

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}
function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(settle => {
		resolve = settle;
	});
	return { promise, resolve };
}

let seq = 0;
/** A tab no other test has read: the bytes of a document are cached per key, and a hit would skip the read a test is watching. */
function tabOf(kind: ViewerKind, over: Partial<DocTab> = {}): DocTab {
	seq += 1;
	const filename = `doc-${seq}.${kind}`;
	return { key: `doc-${seq}`, path: `C:\\docs\\${filename}`, filename, kind, size: BYTES.length, mtimeMs: 1, revision: 0, annotateRequests: 0, ...over };
}

/** An `app` whose `read_file_chunk` streams {@link BYTES}, once `gate` (if any) opens. `reads` is the offset of every chunk asked for. */
function fakeApp(gate?: Promise<void>): { readonly app: App; readonly reads: number[] } {
	const reads: number[] = [];
	const fake = {
		getHostContext: () => ({ theme: "dark" }),
		callServerTool: async (call: { readonly arguments?: Record<string, unknown> }) => {
			const offset = Number(call.arguments?.offset ?? 0);
			const length = Number(call.arguments?.length ?? 0);
			reads.push(offset);
			await gate;
			const part = BYTES.slice(offset, offset + length);
			const structuredContent = { base64: Buffer.from(part).toString("base64"), offset, length: part.length, size: BYTES.length, eof: offset + part.length >= BYTES.length };
			return { content: [], structuredContent };
		},
		openLink: async () => ({}),
	};
	return { app: fake as unknown as App, reads };
}

const pane = (tab: DocTab, host: App, theme: Theme = "dark") => createElement(docPane.DocPane, { app: host, tab, active: true, theme });
const rendererOf = (mount: Renderer["mount"]): Renderer => ({ mount });
const mounted = (): Mounted => ({ destroy() {}, zoom() {} });

/** The props the layer on top was last rendered with. */
function latest(): PaneExtrasProps {
	const props = extras.at(-1);
	if (props === undefined) throw new Error("the layer on top was never rendered");
	return props;
}
const modesSeen = (): (PaneExtrasProps["mode"])[] => [...new Set(extras.map(props => props.mode))];
const paneIn = (container: HTMLElement): Element => {
	const found = container.querySelector('[data-slot="viewer-pane"]');
	if (found === null) throw new Error("no pane");
	return found;
};
/** Whether the opening surface is up over the document, in the stage frame. */
const surfaceUp = (container: HTMLElement): boolean => container.querySelector(`${FRAME} ${OPENING}[data-state="open"]`) !== null;
const activeStep = (container: HTMLElement): { readonly id: string | null; readonly text: string } | null => {
	const step = container.querySelector(`${FRAME} [data-slot="labor-step"][data-status="active"]`);
	return step === null ? null : { id: step.getAttribute("data-step"), text: step.textContent ?? "" };
};

describe("the annotation mode of the pane", () => {
	test("a picture is in its marking mode from the pane's first frame, while it loads and once it is ready, with no mode switch handed down", async () => {
		const mounting = deferred<Mounted>();
		loadRendererImpl = async () => rendererOf(() => mounting.promise);
		const { container } = await env.mount(pane(tabOf("image"), fakeApp().app));

		// First frame and loading: the renderer is still mounting, and the layer is already up.
		expect(extras[0]?.ready).toBe(false);
		expect(latest().ready).toBe(false);
		expect(paneIn(container).getAttribute("data-annotate")).toBe("marks");

		await env.act(async () => mounting.resolve(mounted()));
		expect(latest().ready).toBe(true);
		expect(paneIn(container).getAttribute("data-annotate")).toBe("marks");

		expect(modesSeen()).toEqual(["marks"]);
		expect(extras.some(props => "onMode" in props)).toBe(false);
	});

	test("reloading for a theme change never takes the layer down: the second ready is in the same mode as the first", async () => {
		const themes: Theme[] = [];
		loadRendererImpl = async () =>
			rendererOf(async (_el, _bytes, ctx) => {
				themes.push(ctx.theme);
				return mounted();
			});
		const host = fakeApp().app;
		const tab = tabOf("image");
		const view = await env.mount(pane(tab, host, "dark"));
		expect(latest().ready).toBe(true);

		const before = extras.length;
		await view.render(pane(tab, host, "light"));
		expect(themes).toEqual(["dark", "light"]);
		const reload = extras.slice(before);
		// It did go back to loading and came up ready again; at no render of it was the layer without its mode.
		expect(reload.some(props => !props.ready)).toBe(true);
		expect(latest().ready).toBe(true);
		expect(reload.map(props => props.mode)).toEqual(reload.map(() => "marks"));
		expect(paneIn(view.container).getAttribute("data-annotate")).toBe("marks");
	});

	test("a file card has nothing to mark in any phase", async () => {
		const mounting = deferred<Mounted>();
		loadRendererImpl = async () => rendererOf(() => mounting.promise);
		const { container } = await env.mount(pane(tabOf("binary"), fakeApp().app));
		expect(latest().ready).toBe(false);
		await env.act(async () => mounting.resolve(mounted()));
		expect(latest().ready).toBe(true);

		expect(modesSeen()).toEqual([null]);
		expect(paneIn(container).hasAttribute("data-annotate")).toBe(false);
	});

	// Each of these is a pane that stops with a card in the stage's place. Whatever the kind could be marked for, there is
	// nothing on screen to mark, so the layer on top is told `null`: no marking help, list or send button under the card.
	// name, the tab, its renderer (none: this build has none for it), what the layer was told while the pane was still
	// loading (the kind's own mode, from the first frame), and a sentence the card must carry.
	type DidNotOpen = readonly [string, () => DocTab, Renderer | null, PaneExtrasProps["mode"], string | undefined];
	const DID_NOT_OPEN: readonly DidNotOpen[] = [
		[
			"the renderer failed to open the picture",
			() => tabOf("image"),
			rendererOf(async () => {
				throw new Error("The picture is damaged.");
			}),
			"marks",
			"The picture is damaged.",
		],
		["there is no renderer for the picture in this build", () => tabOf("image"), null, "marks", undefined],
	];
	test.each(DID_NOT_OPEN)("a document that did not open has nothing to mark: %s", async (_name, tab, renderer, before, says) => {
		loadRendererImpl = async () => renderer;
		const { container } = await env.mount(pane(tab(), fakeApp().app));

		expect(extras[0]?.mode).toBe(before);
		expect(latest().mode).toBeNull();
		expect(latest().ready).toBe(false);
		expect(paneIn(container).hasAttribute("data-annotate")).toBe(false);
		const card = container.querySelector(`${FRAME} [role="alert"]`);
		expect(card).not.toBeNull();
		if (says !== undefined) expect(card?.textContent).toContain(says);
	});

	test("a second try that opens the file brings the layer back", async () => {
		let attempts = 0;
		loadRendererImpl = async () =>
			rendererOf(async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("The decoder gave up.");
				return mounted();
			});
		const { container } = await env.mount(pane(tabOf("image"), fakeApp().app));
		expect(latest().mode).toBeNull();

		const retry = container.querySelector(`${FRAME} [role="alert"] button`);
		expect(retry).not.toBeNull();
		await env.act(async () => void retry?.dispatchEvent(new window.Event("click", { bubbles: true })));

		expect(attempts).toBe(2);
		expect(latest().ready).toBe(true);
		expect(latest().mode).toBe("marks");
		expect(paneIn(container).getAttribute("data-annotate")).toBe("marks");
	});
});

describe("the header of the pane", () => {
	test("carries no mode switch: no pill, no Done; the strip the annotation tools dock into is part of the pane, under the header", async () => {
		loadRendererImpl = async () => rendererOf(async () => mounted());
		const { container } = await env.mount(pane(tabOf("image"), fakeApp().app));
		expect(latest().ready).toBe(true);

		const names = (root: Element): string[] => [...root.querySelectorAll("button")].map(button => button.getAttribute("aria-label") ?? button.textContent ?? "");
		const root = paneIn(container);
		const header = root.querySelector('[data-slot="viewer-toolbar"]');
		if (header === null) throw new Error("no header");
		// The query reaches the header's real buttons, so the absence below is not an empty search.
		expect(names(header)).toContain("Copy path");
		expect(names(root).filter(name => /mark|comment|pick|done/i.test(name))).toEqual([]);

		const strip = root.querySelector('[data-slot="viewer-mode-strip"]');
		expect(strip).not.toBeNull();
		expect(header.contains(strip)).toBe(false);
		const order = [...root.querySelectorAll('[data-slot="viewer-toolbar"], [data-slot="viewer-mode-strip"], [data-slot="viewer-stage-frame"]')].map(el => el.getAttribute("data-slot"));
		expect(order).toEqual(["viewer-toolbar", "viewer-mode-strip", "viewer-stage-frame"]);
	});
});

describe("the opening surface of the pane", () => {
	test("covers the document in its stage frame from the first frame, names the stage under way, and is put down when the document is ready", async () => {
		jest.useFakeTimers();
		const chunk = deferred();
		const rendererLoaded = deferred<Renderer>();
		const mounting = deferred<Mounted>();
		const asked: ViewerKind[] = [];
		loadRendererImpl = kind => {
			asked.push(kind);
			return rendererLoaded.promise;
		};
		const { app: host, reads } = fakeApp(chunk.promise);
		const tab = tabOf("image");
		const { container } = await env.mount(pane(tab, host));

		// Both start together: the renderer's chunk loads while the bytes stream in, not before or after them.
		expect(asked).toEqual(["image"]);
		expect(reads).toEqual([0]);
		expect(surfaceUp(container)).toBe(true);

		// The surface says nothing for a short silence, then names what is really happening: the bytes are being read.
		await env.act(async () => void jest.advanceTimersByTime(1000));
		const reading = activeStep(container);
		expect(reading?.id).toBe("read");
		expect(reading?.text).toContain(tab.filename);

		// The bytes are in hand and the renderer is still being loaded: preparing.
		await env.act(async () => chunk.resolve());
		expect(activeStep(container)?.id).toBe("prepare");
		expect(surfaceUp(container)).toBe(true);

		// The renderer is in and the document is being drawn: still preparing, still covered.
		await env.act(async () => rendererLoaded.resolve(rendererOf(() => mounting.promise)));
		expect(activeStep(container)?.id).toBe("prepare");
		expect(surfaceUp(container)).toBe(true);

		await env.act(async () => mounting.resolve(mounted()));
		expect(latest().ready).toBe(true);
		expect(surfaceUp(container)).toBe(false);
	});
});

function mediaApp(gate?: Promise<void>, closing?: (token: string) => Promise<void>) {
	const leases = new Set<string>();
	const chunks: unknown[] = [];
	const granted: string[] = [];
	const canceled = new Set<string>();
	const host = {
		getHostContext: () => ({ theme: "dark" }),
		callServerTool: async (call: { name: string; arguments?: Record<string, unknown> }) => {
			if (call.name === "open_media") {
				const token = String(call.arguments?.token);
				await gate;
				if (canceled.has(token)) throw new Error("Media admission was canceled.");
				leases.add(token);
				granted.push(token);
				return { content: [], structuredContent: { token, url: `http://127.0.0.1:45678/media/${token}`, mime: "video/mp4" } };
			}
			if (call.name === "close_media") {
				const token = String(call.arguments?.token);
				await closing?.(token);
				canceled.add(token);
				leases.delete(token);
				return { content: [], structuredContent: {} };
			}
			chunks.push(call);
			throw new Error("A recording must not be downloaded as document chunks.");
		},
		openLink: async () => ({}),
	};
	return { app: host as unknown as App, leases, chunks, granted };
}

describe("streamed recording pane lifecycle", () => {
	test.each(["audio", "video"] as const)("a large %s opens without document chunks and releases its lease on unmount", async kind => {
		const host = mediaApp();
		loadRendererImpl = async () => rendererOf(async (stage, bytes, context) => {
			if (bytes.length !== 0 || context.mediaSource === undefined) throw new Error("No streaming recording source.");
			const media = stage.ownerDocument.createElement(kind);
			media.setAttribute("src", context.mediaSource.url);
			stage.append(media);
			return { destroy: () => media.remove() };
		});
		const view = await env.mount(pane(tabOf(kind, { size: 80 * 1024 * 1024 }), host.app));
		expect(latest().ready).toBe(true);
		expect(host.leases.size).toBe(1);
		expect(host.chunks).toEqual([]);
		await view.unmount();
		expect(host.leases.size).toBe(0);
	});

	test("an open result arriving after unmount is immediately released and never mounted", async () => {
		const opening = deferred();
		const host = mediaApp(opening.promise);
		let mounts = 0;
		loadRendererImpl = async () => rendererOf(async () => {
			mounts++;
			return mounted();
		});
		const view = await env.mount(pane(tabOf("video", { size: 80 * 1024 * 1024 }), host.app));
		await view.unmount();
		await env.act(async () => opening.resolve());
		expect(host.granted).toEqual([]);
		expect(host.leases.size).toBe(0);
		expect(mounts).toBe(0);
		expect(host.chunks).toEqual([]);
	});

	test("a decoder failure releases the acquired lease while leaving the failure actionable", async () => {
		const host = mediaApp();
		loadRendererImpl = async () => rendererOf(async () => {
			throw new Error("This recording is damaged.");
		});
		const view = await env.mount(pane(tabOf("video"), host.app));
		expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("This recording is damaged.");
		expect(latest().ready).toBe(false);
		expect(host.leases.size).toBe(0);
		expect(host.chunks).toEqual([]);
	});

	test("outer teardown awaits cancellation but not a blocked admission and never mounts late playback", async () => {
		const opening = deferred();
		const closing = deferred();
		const host = mediaApp(opening.promise, () => closing.promise);
		let mounts = 0;
		loadRendererImpl = async () => rendererOf(async () => {
			mounts++;
			return mounted();
		});
		const view = await env.mount(pane(tabOf("video"), host.app));
		await view.unmount();
		let finished = false;
		const drain = finishMediaWork(host.app).then(() => {
			finished = true;
		});
		try {
			await env.act(async () => {});
			expect(finished).toBe(false);
			await env.act(async () => closing.resolve());
			expect(finished).toBe(true);
			await drain;
			await env.act(async () => opening.resolve());
			expect(host.granted).toEqual([]);
			expect(host.leases.size).toBe(0);
			expect(mounts).toBe(0);
		} finally {
			opening.resolve();
			closing.resolve();
			await drain;
		}
	});

	test("outer teardown waits for every pane's independent release", async () => {
		const firstClose = deferred();
		const secondClose = deferred();
		let firstToken: string | undefined;
		const host = mediaApp(undefined, token => token === firstToken ? firstClose.promise : secondClose.promise);
		loadRendererImpl = async () => rendererOf(async () => mounted());
		const view = await env.mount(createElement("div", null, pane(tabOf("audio"), host.app), pane(tabOf("video"), host.app)));
		firstToken = host.granted[0];
		expect(host.leases.size).toBe(2);
		await view.unmount();
		let finished = false;
		const drain = finishMediaWork(host.app).then(() => {
			finished = true;
		});
		try {
			await env.act(async () => firstClose.resolve());
			expect([...host.leases]).toEqual([host.granted[1]]);
			expect(finished).toBe(false);
			await env.act(async () => secondClose.resolve());
			await drain;
			expect(host.leases.size).toBe(0);
		} finally {
			firstClose.resolve();
			secondClose.resolve();
			await drain;
		}
	});

	test("a delayed failed admission cannot hold outer teardown open or mount playback", async () => {
		const opening = deferred();
		const host = mediaApp(opening.promise.then(() => {
			throw new Error("The recording is no longer available.");
		}));
		let mounts = 0;
		loadRendererImpl = async () => rendererOf(async () => {
			mounts++;
			return mounted();
		});
		const view = await env.mount(pane(tabOf("audio"), host.app));
		await view.unmount();
		let finished = false;
		const drain = finishMediaWork(host.app).then(() => {
			finished = true;
		});
		try {
			await env.act(async () => {});
			expect(finished).toBe(true);
			await drain;
			await env.act(async () => opening.resolve());
			expect(host.leases.size).toBe(0);
			expect(mounts).toBe(0);
		} finally {
			opening.resolve();
			await drain;
		}
	});
});
