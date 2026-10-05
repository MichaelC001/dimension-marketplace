import { describe, expect, test } from "bun:test";
import { actionFromResult, describeOpenFailure } from "../app/view/result";
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

describe("a file that would not open", () => {
	const failed = (path: string, message = "locked", copyPath = false): ViewerAction => ({ type: "failed", path, failure: { message, copyPath } });

	test("is a tab of its own, in front, that says why: not a banner over an empty pane", () => {
		const state = play(failed("C:\\docs\\a.wav", "Another program has this file open or locked."));
		expect(state.tabs).toHaveLength(1);
		expect(state.tabs[0]).toMatchObject({ filename: "a.wav", path: "C:\\docs\\a.wav", failure: { message: "Another program has this file open or locked." } });
		expect(state.activeKey).toBe(state.tabs[0]?.key);
		expect(state.notice).toBeNull();
	});

	test("an error that names no file has nothing to hold a tab, and is said as a notice instead", () => {
		const state = play(failed("C:\\docs\\a.wav"), { type: "failed", failure: { message: "The path is empty.", copyPath: false } });
		expect(state.tabs).toHaveLength(1);
		expect(state.notice).toBe("The path is empty.");
	});

	test("a document that is open stays what it was when a second open of it fails: the news is a notice, and it comes to the front", () => {
		const state = play(open("a.txt"), open("b.txt"), failed("/docs/a.txt", "locked"));
		expect(state.tabs.map(tab => tab.failure)).toEqual([undefined, undefined]);
		expect(state.activeKey).toBe("/docs/a.txt");
		expect(state.notice).toBe("locked");
	});

	test("failing again replaces the words on the same tab, however the path is cased or slashed", () => {
		const state = play(failed("C:\\Docs\\a.wav", "locked"), failed("c:/docs/A.WAV", "gone"));
		expect(state.tabs).toHaveLength(1);
		expect(state.tabs[0]?.failure?.message).toBe("gone");
	});

	test("the same file opening gives the failed tab way, even when the two spell the path differently and the file is empty", () => {
		const failedTab = failed("C:\\Docs\\a.txt");
		const opened: ViewerAction = { type: "open", key: "c:/docs/a.txt", file: file("a.txt", { path: "c:/docs/a.txt", size: 0, mtimeMs: 0 }) };
		const state = play(failedTab, opened);
		expect(state.tabs).toHaveLength(1);
		expect(state.tabs[0]?.failure).toBeUndefined();
		expect(state.activeKey).toBe("c:/docs/a.txt");
	});

	test("an open with the very key of a failed tab reloads it even when nothing about the file differs from the placeholder", () => {
		const state = play(failed("/docs/a.txt"), { type: "open", key: "/docs/a.txt", file: file("a.txt", { size: 0, mtimeMs: 0 }) });
		expect(state.tabs).toHaveLength(1);
		expect(state.tabs[0]?.failure).toBeUndefined();
	});

	test("another file's failed tab is left alone by an open of a different file", () => {
		const state = play(failed("/docs/a.txt"), open("b.txt"));
		expect(state.tabs.map(tab => tab.filename)).toEqual(["a.txt", "b.txt"]);
		expect(state.tabs[0]?.failure).toBeDefined();
	});
});

describe("what a human is told when a file would not open", () => {
	const at = "C:\\Users\\Me\\notes.wav";
	const said = (text: string) => describeOpenFailure(text);
	// The engine's own words, as the server writes them for the model: the code, twice the path.
	const BUSY = `"${at}" cannot be opened: EBUSY: resource busy or locked, open '${at}' (EBUSY)`;
	const DENIED = `"${at}" cannot be opened: EACCES: permission denied, open '${at}' (EACCES)`;
	const GONE = `"${at}" cannot be opened: ENOENT: no such file or directory, stat '${at}' (ENOENT)`;
	const TOO_BIG = `"${at}" cannot be opened: ERR_FS_FILE_TOO_LARGE: File size (3000000000) is greater than 2 GiB (ERR_FS_FILE_TOO_LARGE)`;
	const NOT_A_FILE = `"${at}" cannot be opened: not a regular file`;

	test("each common cause is one plain sentence with no engine word and no path in it, and each is a different sentence", () => {
		const causes = [BUSY, DENIED, GONE, TOO_BIG, NOT_A_FILE].map(text => said(text).failure.message);
		for (const sentence of causes) {
			expect(sentence).not.toMatch(/\bE[A-Z]{3,}\b|ERR_|\(|\\|'/);
			expect(sentence.split(/[.!?]\s/).filter(Boolean)).toHaveLength(1);
		}
		expect(new Set(causes).size).toBe(5);
	});

	test("the file the error names is found, so the sentence can be shown in the pane for that file", () => {
		for (const text of [BUSY, DENIED, GONE, TOO_BIG, NOT_A_FILE]) expect(said(text).path).toBe(at);
		expect(said(`no such file: "/home/me/a.txt"`).path).toBe("/home/me/a.txt");
		expect(said(`refused to open "\\\\server\\share\\a.txt": a network path`).path).toBe("\\\\server\\share\\a.txt");
	});

	test("a way out that is copying the path is offered where the sentence points to it, and only there", () => {
		expect([BUSY, DENIED, GONE, TOO_BIG, NOT_A_FILE].map(text => said(text).failure.copyPath)).toEqual([false, true, false, true, false]);
	});

	test("the cause is read from the words, never from the name of a folder: folders named like other causes do not change what happened", () => {
		// A refusal inside a folder called "resource busy or locked" is a refusal; a locked file inside "permission denied" is a lock.
		const denied = `"C:\\resource busy or locked\\a.wav" cannot be opened: EACCES: permission denied, open 'C:\\resource busy or locked\\a.wav' (EACCES)`;
		const busy = `"C:\\permission denied\\no such file\\a.wav" cannot be opened: EBUSY: resource busy or locked, open 'C:\\permission denied\\no such file\\a.wav' (EBUSY)`;
		expect(said(denied).failure).toEqual(said(DENIED).failure);
		expect(said(busy).failure).toEqual(said(BUSY).failure);
	});

	test("a refusal the server already wrote as a sentence is kept as written; with no file to hold a tab it has no path", () => {
		const outside = `"/etc/hosts" is outside the folders the viewer may open (/home/me). Ask the user to add its folder.`;
		expect(said(outside)).toEqual({ failure: { message: outside, copyPath: false }, path: "/etc/hosts" });
		const relative = `"notes.txt" is not an absolute path; pass the full path to the file`;
		expect(said(relative).path).toBeUndefined();
		expect(said("the path is empty").path).toBeUndefined();
	});

	test("a quoted word that is not a path (a tool's name in the host's own words) is not a file", () => {
		expect(said(`Tool "view_file" failed: timed out`).path).toBeUndefined();
	});

	test("an error with no words still says something", () => {
		expect(said("").failure.message).toMatch(/could not be opened/);
	});

	test("an error result is read as that failure, and a result that opened nothing is still a refusal", () => {
		expect(actionFromResult({ isError: true, content: [{ type: "text", text: BUSY }] })).toEqual({ type: "failed", ...said(BUSY) });
		expect(actionFromResult({ isError: true, content: [{ type: "image" }, { type: "text", text: "no such file: \"/a/b\"" }] })).toMatchObject({ type: "failed", path: "/a/b" });
	});
});

describe("actionFromResult", () => {
	const structured = file("a.txt");

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
