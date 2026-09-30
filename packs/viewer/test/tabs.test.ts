import { describe, expect, test } from "bun:test";
import { actionFromResult } from "../app/view/result";
import { INITIAL_STATE, reduce, type ViewerAction, type ViewerState } from "../app/view/tabs";
import { ANNOTATE_META_KEY, type ViewedFile } from "../src/contract";

const file = (name: string, extra: Partial<ViewedFile> = {}): ViewedFile => ({ path: `/docs/${name}`, filename: name, kind: "text", size: 10, mtimeMs: 1, ...extra });
const open = (name: string, extra: Partial<ViewedFile> = {}): ViewerAction => ({ type: "open", key: `/docs/${name}`, file: file(name, extra) });
const play = (...actions: ViewerAction[]): ViewerState => actions.reduce(reduce, INITIAL_STATE);
const keys = (state: ViewerState) => state.tabs.map(tab => tab.key.split("/").pop());

describe("tab state", () => {
	test("a new path adds a tab and focuses it", () => {
		const state = play(open("a.txt"), open("b.txt"));
		expect(keys(state)).toEqual(["a.txt", "b.txt"]);
		expect(state.activeKey).toBe("/docs/b.txt");
	});

	test("opening the same real path again focuses it and adds nothing", () => {
		const state = play(open("a.txt"), open("b.txt"), open("a.txt"));
		expect(keys(state)).toEqual(["a.txt", "b.txt"]);
		expect(state.activeKey).toBe("/docs/a.txt");
		expect(state.tabs[0]?.revision).toBe(0); // unchanged on disk: no reload
	});

	test("opening it again after it changed bumps the revision (a reload) and keeps its place", () => {
		const state = play(open("a.txt"), open("b.txt"), open("a.txt", { mtimeMs: 2 }), open("b.txt", { size: 11 }));
		expect(keys(state)).toEqual(["a.txt", "b.txt"]);
		expect(state.tabs.map(tab => tab.revision)).toEqual([1, 1]);
	});

	test("closing the front tab shows its right neighbour, else its left, else nothing", () => {
		const three = play(open("a.txt"), open("b.txt"), open("c.txt"), { type: "activate", key: "/docs/b.txt" });
		expect(reduce(three, { type: "close", key: "/docs/b.txt" }).activeKey).toBe("/docs/c.txt");
		const last = play(open("a.txt"), open("b.txt"));
		expect(reduce(last, { type: "close", key: "/docs/b.txt" }).activeKey).toBe("/docs/a.txt");
		expect(reduce(play(open("a.txt")), { type: "close", key: "/docs/a.txt" }).activeKey).toBeNull();
	});

	test("closing a background tab keeps the front tab", () => {
		const state = play(open("a.txt"), open("b.txt"), { type: "close", key: "/docs/a.txt" });
		expect(state.activeKey).toBe("/docs/b.txt");
	});

	test("a refusal is a notice that the next successful open clears, and it never removes a tab", () => {
		const refused = play(open("a.txt"), { type: "refused", message: "nope" });
		expect(refused.notice).toBe("nope");
		expect(keys(refused)).toEqual(["a.txt"]);
		expect(reduce(refused, open("b.txt")).notice).toBeNull();
	});

	test("an open that asks for annotate mode is counted on its tab, including a tab already open and unchanged", () => {
		const asked = (name: string, extra: Partial<ViewedFile> = {}): ViewerAction => ({ type: "open", key: `/docs/${name}`, file: file(name, extra), annotate: true });
		const requests = (state: ViewerState) => state.tabs.map(tab => tab.annotateRequests);
		expect(requests(play(open("a.txt"), asked("b.txt")))).toEqual([0, 1]);
		// Already open and untouched on disk: no reload, but the ask still reaches the pane.
		const again = play(open("a.txt"), asked("a.txt"));
		expect(requests(again)).toEqual([1]);
		expect(again.tabs[0]?.revision).toBe(0);
		expect(requests(play(open("a.txt"), asked("a.txt"), asked("a.txt")))).toEqual([2]);
		// A plain open later neither clears the ask nor adds one; a reload keeps the count and bumps the revision.
		const reloaded = play(asked("a.txt"), open("a.txt"), open("a.txt", { mtimeMs: 2 }));
		expect(requests(reloaded)).toEqual([1]);
		expect(reloaded.tabs[0]?.revision).toBe(1);
		expect(requests(play(asked("a.txt", { mtimeMs: 2 }), asked("a.txt", { mtimeMs: 3 })))).toEqual([2]);
	});
});

describe("actionFromResult", () => {
	const structured = file("a.txt");

	test("an error result becomes a refusal carrying the server's words", () => {
		expect(actionFromResult({ isError: true, content: [{ type: "text", text: "outside the folders the viewer may open" }] })).toEqual({
			type: "refused",
			message: "outside the folders the viewer may open",
		});
	});

	test("the tab key from _meta wins over the path", () => {
		expect(actionFromResult({ structuredContent: structured, _meta: { "ai.insodimension/tab": { key: "REAL" } } })).toMatchObject({ type: "open", key: "REAL" });
		expect(actionFromResult({ structuredContent: structured })).toMatchObject({ type: "open", key: "/docs/a.txt" });
	});

	test("only a result that says annotate: true asks for annotate mode", () => {
		expect(actionFromResult({ structuredContent: structured, _meta: { [ANNOTATE_META_KEY]: true } })).toMatchObject({ type: "open", annotate: true });
		for (const asked of [undefined, false, "true", 1, {}]) {
			const action = actionFromResult({ structuredContent: structured, _meta: { [ANNOTATE_META_KEY]: asked } });
			expect(action).toMatchObject({ type: "open" });
			expect(action).not.toHaveProperty("annotate");
		}
		expect(actionFromResult({ structuredContent: structured })).not.toHaveProperty("annotate");
	});

	test("a result that is not a viewer file opens nothing", () => {
		expect(actionFromResult({ structuredContent: { path: "/x", kind: "spreadsheet" } })).toMatchObject({ type: "refused" });
		expect(actionFromResult({})).toMatchObject({ type: "refused" });
	});
});
