import { describe, expect, test } from "bun:test";
import { actionFromResult } from "../app/view/result";
import { INITIAL_STATE, LIBRARY_KEY, reduce, type ViewerAction, type ViewerState } from "../app/view/tabs";
import type { ViewedFile } from "../src/contract";

const file: ViewedFile = { path: "/work/a.pdf", filename: "a.pdf", kind: "pdf", size: 10, mtimeMs: 1 };
const openFile: ViewerAction = { type: "open", key: file.path, file };
const play = (...actions: ViewerAction[]): ViewerState => actions.reduce(reduce, INITIAL_STATE);

describe("the library tab", () => {
	test("an open_library result opens the pinned library tab and carries what it asked for", () => {
		const action = actionFromResult({ structuredContent: { mode: "library", workspace: "/work", query: "deck" } });
		expect(action).toEqual({ type: "library", workspace: "/work", query: "deck" });
		const state = play(action);
		expect(state.activeKey).toBe(LIBRARY_KEY);
		expect(state.library).toEqual({ workspace: "/work", query: "deck", requests: 1 });
		expect(state.tabs).toEqual([]);
	});

	test("a view_file result still opens a document, beside the library", () => {
		const state = play({ type: "library" }, actionFromResult({ structuredContent: file }));
		expect(state.tabs.map(tab => tab.key)).toEqual([file.path]);
		expect(state.activeKey).toBe(file.path);
		expect(state.library).not.toBeNull();
	});

	test("asking for the library again brings it to the front and counts the ask, so a new query applies", () => {
		const state = play({ type: "library" }, openFile, { type: "library", query: "video" });
		expect(state.activeKey).toBe(LIBRARY_KEY);
		expect(state.library).toEqual({ query: "video", requests: 2 });
		expect(state.tabs).toHaveLength(1);
	});

	test("closing the last document falls back to the library, and the library itself cannot be closed", () => {
		const state = play({ type: "library" }, openFile, { type: "close", key: file.path });
		expect(state.activeKey).toBe(LIBRARY_KEY);
		expect(reduce(state, { type: "close", key: LIBRARY_KEY })).toBe(state);
	});

	test("activating the library works only once it is open", () => {
		expect(reduce(play(openFile), { type: "activate", key: LIBRARY_KEY }).activeKey).toBe(file.path);
		expect(reduce(play({ type: "library" }, openFile), { type: "activate", key: LIBRARY_KEY }).activeKey).toBe(LIBRARY_KEY);
	});

	test("a result that only looks like a library open is refused", () => {
		expect(actionFromResult({ structuredContent: { mode: "library", workspace: "" } }).type).toBe("refused");
		expect(actionFromResult({ structuredContent: { mode: "gallery" } }).type).toBe("refused");
	});
});
