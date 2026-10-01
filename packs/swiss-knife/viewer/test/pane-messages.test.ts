// What the pane says when there is no document to show, as the human sees it (docs/design/88 section 6, "no engine words").
//
// A file that would not open: the View used to put the server's own error text in a red banner over "Nothing open / Ask
// the assistant to open a file...": engine words, the path twice, and an empty state that was not true (the human had
// just asked for a file). It is now the pane for that file, with its name in the bar and one sentence saying what to do.
// A recording past the size the viewer plays: its sentence must point at what is in front of the human.
//
// Rendered for real (linkedom + react-dom under `act`) through the View's own store and reducer: the same actions the
// tool result produces. No document is loaded in any of these, so no renderer is mounted.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { createElement } from "react";
import { actionFromResult } from "../app/view/result";
import { createViewerStore, type ViewerStore } from "../app/view/tabs";
import type * as DocPaneModule from "../app/view/doc-pane";
import type * as ViewerAppModule from "../app/view/viewer-app";
import { installReact, type ReactEnv } from "./media-react";

let env: ReactEnv;
let viewer: typeof ViewerAppModule;
let docPane: typeof DocPaneModule;
const app = { getHostContext: () => ({ theme: "dark" }) } as unknown as App;
const at = "C:\\Users\\Me\\notes.wav";

beforeAll(async () => {
	env = await installReact();
	// Two modules of the pane cannot load under bun: the annotation layers (the kit's React sources, whose tsconfig react
	// paths bun cannot follow) and the renderer index (Vite's `import.meta.glob`). No document is opened here, so neither
	// is used. Bun cannot lift a module mock, so both stay installed for the rest of the run: no other viewer test loads them.
	mock.module("../app/view/pane-extras", () => ({ PaneExtras: () => null, annotationModes: () => [] }));
	mock.module("../app/view/renderers", () => ({ loadRenderer: async () => null }));
	viewer = await import("../app/view/viewer-app");
	docPane = await import("../app/view/doc-pane");
});
afterEach(() => env.cleanup());
afterAll(() => env.restore());

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

	test("with nothing to report and nothing open, the empty state is still the empty state", async () => {
		const { text } = await show(createViewerStore());
		expect(text()).toMatch(/Nothing open/);
	});
});

describe("the pane for a recording too large to play", () => {
	test("says the limit and the size, and points at the button under it - not at a bar that is somewhere else", async () => {
		const tab = { key: "k", path: "C:\\rec\\big.wav", filename: "big.wav", kind: "audio", size: 67.3 * 1024 * 1024, mtimeMs: 1, revision: 0, annotateRequests: 0 } as const;
		const { container } = await env.mount(createElement(docPane.DocPane, { app, tab, active: true, theme: "dark" }));
		const card = container.querySelector('[data-slot="viewer-stage-frame"] [role="alert"]');
		const sentence = card?.querySelector("p:nth-of-type(2)")?.textContent ?? "";
		expect(sentence).toContain("64.0 MB");
		expect(sentence).toContain("67.3 MB");
		// The way out is copying the path, and the button for it is in this card; the sentence must not send the human elsewhere for it.
		expect(sentence).toMatch(/copy its path/i);
		expect(sentence).not.toMatch(/above|below|bar/i);
		expect([...(card?.querySelectorAll("button") ?? [])].map(button => button.textContent)).toEqual(["Copy path"]);
	});
});
