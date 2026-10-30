import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createElement } from "react";
import type * as PaneModule from "../app/view/library/library-pane";
import type { LibraryItem, ShareSummary } from "../../src/library/types";
import { mapKitReact, standInRenderers } from "./kit-react";
import { installReact, type ReactEnv } from "./media-react";

mapKitReact();
standInRenderers();

const VIEWPORT = { width: 900, height: 480 };
const PAGE_ROWS = 40;

interface ServedQuery {
	readonly cursor: string | undefined;
	readonly signal: AbortSignal | undefined;
	readonly release: () => void;
	readonly fail: () => void;
}

interface ServerState {
	rows: LibraryItem[];
	revision: number;
	foreign: number;
	holding: boolean;
	holdingRevision: boolean;
	failing: boolean;
	pageRows: number;
	comments: unknown[];
	midWrite: (() => void) | null;
}

let env: ReactEnv;
let pane: typeof PaneModule;
let realTimers: Pick<typeof window, "setTimeout" | "clearTimeout">;
const timers = new Map<number, () => void>();
let nextTimer = 1;
const scrolls = new WeakMap<object, number>();

let server: ServerState;
let queries: ServedQuery[];
let held: ServedQuery[];
let revisionReads: number;
let commentFetches: number;
let heldRevisions: (() => void)[];

const row = (id: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({
	id,
	path: `/work/${id}.png`,
	name: `${id}.png`,
	tags: [],
	kind: "image",
	mime: "image/png",
	size: 10,
	mtimeMs: 1,
	source: "present",
	starred: false,
	state: "live",
	createdAt: 1,
	presentedAt: 1,
	hasThumb: true,
	shares: [],
	...extra,
});

const share = (comments: number, unread: number): ShareSummary => ({
	id: "s1",
	host: "p2p",
	url: "https://relay.example/a/s1",
	audience: { kind: "link" },
	version: 1,
	versionAt: 1,
	allowComments: true,
	comments,
	unread,
});

const comment = (body: string) => ({
	id: `c-${body}`,
	shareId: "s1",
	author: "Ana",
	body,
	anchor: { startMs: 1500 },
	version: 1,
	createdAt: 5,
	readAt: 1,
	shareUrl: "https://relay.example/a/s1",
});

const structured = (data: object): CallToolResult => ({ content: [], structuredContent: { ...data } });

function pageAt(cursor: string | undefined, starredOnly: boolean) {
	const rows = starredOnly ? server.rows.filter(each => each.starred) : server.rows;
	const offset = cursor === undefined ? 0 : Number(cursor.slice(1));
	const end = offset + server.pageRows;
	return { items: rows.slice(offset, end), ...(end < rows.length ? { next: `c${end}` } : {}), total: rows.length };
}

const marker = (): string => `${server.revision}:${server.foreign}`;

const app = {
	callServerTool: (params: { name: string; arguments?: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<CallToolResult> => {
		const args = params.arguments ?? {};
		switch (params.name) {
			case "library_query": {
				const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
				const answer = structured(pageAt(cursor, args.starred === true));
				if (server.failing) {
					queries.push({ cursor, signal: options?.signal, release: () => undefined, fail: () => undefined });
					return Promise.reject(new Error("the library is busy"));
				}
				if (!server.holding) {
					queries.push({ cursor, signal: options?.signal, release: () => undefined, fail: () => undefined });
					return Promise.resolve(answer);
				}
				return new Promise<CallToolResult>((resolve, reject) => {
					const query: ServedQuery = { cursor, signal: options?.signal, release: () => resolve(answer), fail: () => reject(new Error("the read was cancelled")) };
					queries.push(query);
					held.push(query);
				});
			}
			case "library_revision":
				revisionReads += 1;
				if (server.holdingRevision) return new Promise<CallToolResult>(resolve => heldRevisions.push(() => resolve(structured({ revision: marker() }))));
				return Promise.resolve(structured({ revision: marker() }));
			case "library_update": {
				const before = marker();
				server.revision += 1;
				server.rows = server.rows.map(each => (each.id === args.id ? { ...each, starred: args.starred === true } : each));
				server.midWrite?.();
				return Promise.resolve(structured({ item: server.rows.find(each => each.id === args.id), revision: { before, after: marker() } }));
			}
			case "library_facets":
				return Promise.resolve(structured({ kinds: {}, workspaces: [], tags: [], starred: 0, shared: 0, discarded: 0 }));
			case "library_thumbs":
				return Promise.resolve(structured({ base: "http://thumbs.test" }));
			case "library_check":
				return Promise.resolve(structured({ items: [] }));
			case "share_comments":
				commentFetches += 1;
				return Promise.resolve(structured({ comments: server.comments }));
			case "library_open":
				return new Promise<CallToolResult>(() => undefined);
			default:
				return Promise.reject(new Error(`the fake server has no ${params.name}`));
		}
	},
	sendMessage: async () => ({}),
} as unknown as App;

beforeAll(async () => {
	env = await installReact();
	realTimers = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout };
	Object.assign(window, {
		setTimeout: (callback: () => void) => {
			timers.set(nextTimer, callback);
			return nextTimer++;
		},
		clearTimeout: (handle: number) => void timers.delete(handle),
	});
	const proto = window.HTMLElement.prototype;
	Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => VIEWPORT.width });
	Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => VIEWPORT.height });
	Object.defineProperty(proto, "scrollTop", {
		configurable: true,
		get(this: object) {
			return scrolls.get(this) ?? 0;
		},
		set(this: object, value: number) {
			scrolls.set(this, value);
		},
	});
	pane = await import("../app/view/library/library-pane");
});

beforeEach(() => {
	server = { rows: [], revision: 1, foreign: 0, holding: false, holdingRevision: false, failing: false, pageRows: PAGE_ROWS, comments: [], midWrite: null };
	queries = [];
	held = [];
	revisionReads = 0;
	commentFetches = 0;
	heldRevisions = [];
});

afterEach(async () => {
	await env.cleanup();
	timers.clear();
});

afterAll(() => {
	Object.assign(window, realTimers);
	const proto = window.HTMLElement.prototype;
	for (const name of ["clientWidth", "clientHeight", "scrollTop"]) Reflect.deleteProperty(proto, name);
	env.restore();
});

const settle = () =>
	env.act(async () => {
		for (let turn = 0; turn < 24; turn += 1) await Promise.resolve();
	});

const beat = async (): Promise<void> => {
	await env.act(async () => {
		for (const [handle, callback] of [...timers]) {
			timers.delete(handle);
			callback();
		}
	});
	await settle();
};

const changeTo = async (next: LibraryItem[]): Promise<void> => {
	server.rows = next;
	server.revision += 1;
	await beat();
};

const releaseAll = async (): Promise<void> => {
	while (held.length > 0) {
		held.shift()?.release();
		await settle();
	}
};

const releaseRevisions = async (): Promise<void> => {
	while (heldRevisions.length > 0) {
		heldRevisions.shift()?.();
		await settle();
	}
};

function fire(target: Element | null, type: string, init: object = {}): Promise<void> {
	if (target === null) throw new Error(`nothing to send ${type} to`);
	const view = env.document.defaultView as Window & typeof globalThis;
	return env.act(async () => void target.dispatchEvent(Object.assign(new view.Event(type, { bubbles: true, cancelable: true }), init)));
}

const libraryPane = (active: boolean) => createElement(pane.LibraryPane, { app, request: { requests: 0 }, active, theme: "dark" });

async function mountPane(): Promise<HTMLElement> {
	const { container } = await env.mount(libraryPane(true));
	await settle();
	return container;
}

async function mountTab(): Promise<{ readonly container: HTMLElement; readonly show: (active: boolean) => Promise<void> }> {
	const { container, render } = await env.mount(libraryPane(true));
	await settle();
	return {
		container,
		show: async active => {
			await render(libraryPane(active));
			await settle();
		},
	};
}

const options = (container: HTMLElement) => [...container.querySelectorAll('[role="option"]')];
const loadedRows = (container: HTMLElement) => Number(options(container)[0]?.getAttribute("aria-setsize"));
const option = (container: HTMLElement, id: string) => container.querySelector(`#library-item-${id}`);
const showing = (container: HTMLElement, text: string) => (container.textContent ?? "").includes(text);
const flashing = (container: HTMLElement) => showing(container, "Opening the library…") || container.querySelector(".animate-pulse") !== null;

describe("an open Library follows the library without being reopened", () => {
	test("a change shows up in the list in place: the rows stay, nothing says it is loading, and the new row arrives", async () => {
		server.rows = [row("a"), row("b"), row("c")];
		const container = await mountPane();
		expect(showing(container, "a.png")).toBe(true);
		expect(queries).toHaveLength(1);

		server.holding = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();

		expect(queries).toHaveLength(2);
		expect(showing(container, "a.png")).toBe(true);
		expect(showing(container, "fresh.png")).toBe(false);
		expect(flashing(container)).toBe(false);

		await releaseAll();
		expect(showing(container, "fresh.png")).toBe(true);
		expect(showing(container, "a.png")).toBe(true);
		expect(loadedRows(container)).toBe(4);
		expect(flashing(container)).toBe(false);
	});

	test("an item that changed is shown as changed: a new star and a new title replace the old ones in its row", async () => {
		server.rows = [row("a"), row("b")];
		const container = await mountPane();
		expect(container.querySelector('[role="option"] [title="Starred"]')).toBeNull();

		await changeTo([row("a", { starred: true, title: "Launch trailer" }), row("b")]);

		expect(showing(container, "Launch trailer")).toBe(true);
		expect(showing(container, "a.png")).toBe(false);
		expect(container.querySelectorAll('[role="option"] [title="Starred"]')).toHaveLength(1);
	});

	test("with no change of the revision nothing is queried again, however long it is left open", async () => {
		server.rows = [row("a"), row("b")];
		const container = await mountPane();
		for (let beats = 0; beats < 4; beats += 1) await beat();

		expect(revisionReads).toBeGreaterThanOrEqual(4);
		expect(queries).toHaveLength(1);
		expect(flashing(container)).toBe(false);
	});

	test("the selected row stays selected after the rows move under it", async () => {
		server.rows = [row("a"), row("b"), row("c")];
		const container = await mountPane();
		const grid = container.querySelector('[data-slot="library-grid"]');
		await fire(grid, "keydown", { key: "ArrowRight" });
		await fire(grid, "keydown", { key: "ArrowRight" });
		expect(option(container, "b")?.getAttribute("aria-selected")).toBe("true");
		expect(option(container, "b")?.getAttribute("aria-posinset")).toBe("2");

		await changeTo([row("fresh"), row("a"), row("b"), row("c")]);

		expect(option(container, "b")?.getAttribute("aria-selected")).toBe("true");
		expect(option(container, "b")?.getAttribute("aria-posinset")).toBe("3");
		expect(container.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(1);
	});

	test("every page that was loaded is read again before the list changes: two pages open never shrink to one on the way", async () => {
		server.pageRows = 80;
		server.rows = Array.from({ length: 200 }, (_, index) => row(`r${index}`));
		const container = await mountPane();
		expect(loadedRows(container)).toBe(80);
		const grid = container.querySelector('[data-slot="library-grid"]');
		await fire(grid, "keydown", { key: "ArrowRight" });
		await fire(grid, "keydown", { key: "End" });
		await settle();
		expect(loadedRows(container)).toBe(160);
		const before = queries.length;

		server.holding = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		held[0]?.release();
		await settle();

		expect(loadedRows(container)).toBe(160);
		expect(showing(container, "200 artifacts")).toBe(true);
		await releaseAll();
		expect(queries.slice(before).map(query => query.cursor)).toEqual([undefined, "c80"]);
		expect(loadedRows(container)).toBe(160);
		expect(showing(container, "201 artifacts")).toBe(true);
		expect(option(container, "r79")?.getAttribute("aria-selected")).toBe("true");
		expect(option(container, "r79")?.getAttribute("aria-posinset")).toBe("81");
	});

	test("a change while a next page is loading waits for the page, then refreshes the rows it holds", async () => {
		server.rows = Array.from({ length: 100 }, (_, index) => row(`r${index}`));
		server.holding = true;
		const container = await mountPane();
		held[0]?.release();
		await settle();
		expect(held.map(query => query.cursor)).toEqual([undefined, `c${PAGE_ROWS}`]);

		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		await beat();
		expect(queries).toHaveLength(2);

		held[1]?.release();
		await settle();
		expect(queries.map(query => query.cursor)).toEqual([undefined, `c${PAGE_ROWS}`, undefined]);

		await releaseAll();
		expect(queries.slice(2).map(query => query.cursor)).toEqual([undefined, `c${PAGE_ROWS}`]);
		expect(loadedRows(container)).toBe(2 * PAGE_ROWS);
		expect(showing(container, "fresh.png")).toBe(true);
	});

	test("a second change while a refresh reads starts no second read; it is refreshed once the first lands", async () => {
		server.rows = [row("a"), row("b")];
		const container = await mountPane();

		server.holding = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		server.rows = [row("fresher"), ...server.rows];
		server.revision += 1;
		await beat();
		await beat();
		expect(queries).toHaveLength(2);
		expect(showing(container, "fresh.png")).toBe(false);

		held[0]?.release();
		await settle();
		expect(showing(container, "fresh.png")).toBe(true);
		expect(showing(container, "fresher.png")).toBe(false);
		expect(queries).toHaveLength(3);

		await releaseAll();
		expect(showing(container, "fresher.png")).toBe(true);
		expect(queries).toHaveLength(3);
	});

	test("choosing another filter while a refresh reads aborts that read, and its late answer never replaces the new filter's rows", async () => {
		server.rows = [row("a", { starred: true }), row("b"), row("c")];
		const container = await mountPane();
		expect(queries).toHaveLength(1);

		server.holding = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		const refresh = held[0];
		expect(refresh?.signal?.aborted).toBe(false);

		await fire(container.querySelector('button[title="Starred"]'), "click");
		expect(refresh?.signal?.aborted).toBe(true);
		held[1]?.release();
		await settle();
		refresh?.release();
		await settle();

		expect(showing(container, "a.png")).toBe(true);
		expect(showing(container, "fresh.png")).toBe(false);
		expect(showing(container, "b.png")).toBe(false);
		expect(loadedRows(container)).toBe(1);
	});

	test("a refresh that fails leaves the rows as they were with nothing loading, and is tried again on the next beat", async () => {
		server.rows = [row("a"), row("b"), row("c")];
		const container = await mountPane();
		expect(queries).toHaveLength(1);

		server.failing = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		await settle();
		expect(queries).toHaveLength(2);
		expect(showing(container, "a.png")).toBe(true);
		expect(showing(container, "fresh.png")).toBe(false);
		expect(loadedRows(container)).toBe(3);
		expect(flashing(container)).toBe(false);

		server.failing = false;
		await settle();
		expect(queries).toHaveLength(2);
		expect(showing(container, "fresh.png")).toBe(false);

		await beat();
		expect(queries).toHaveLength(3);
		expect(showing(container, "fresh.png")).toBe(true);
		expect(loadedRows(container)).toBe(4);
		expect(flashing(container)).toBe(false);
	});

	test("a refresh cut short by a filter change is not tried again: the beats after it ask for nothing more", async () => {
		server.rows = [row("a", { starred: true }), row("b")];
		const container = await mountPane();

		server.holding = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		const refresh = held[0];
		await fire(container.querySelector('button[title="Starred"]'), "click");
		held[1]?.release();
		await settle();
		refresh?.fail();
		await settle();
		expect(queries).toHaveLength(3);

		await beat();
		await beat();
		expect(queries).toHaveLength(3);
		expect(showing(container, "a.png")).toBe(true);
		expect(loadedRows(container)).toBe(1);
	});

	test("a refresh waiting to be tried again leaves nothing scheduled when the Library is closed", async () => {
		server.rows = [row("a")];
		await mountPane();
		await beat();
		const polling = timers.size;
		server.failing = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		await settle();
		expect(queries).toHaveLength(2);
		expect(timers.size).toBe(polling + 1);

		await env.cleanup();

		expect(timers.size).toBe(0);
	});

	test("a refresh waiting to be tried again is dropped when another filter is chosen: the beats after it ask for nothing more", async () => {
		server.rows = [row("a", { starred: true }), row("b")];
		const container = await mountPane();

		server.failing = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		expect(queries).toHaveLength(2);

		server.failing = false;
		await fire(container.querySelector('button[title="Starred"]'), "click");
		await settle();
		expect(queries).toHaveLength(3);
		expect(loadedRows(container)).toBe(1);

		await beat();
		await beat();
		expect(queries).toHaveLength(3);
		expect(showing(container, "a.png")).toBe(true);
		expect(loadedRows(container)).toBe(1);
	});

	test("a refresh still reading when the Library is closed schedules nothing when its read fails afterwards", async () => {
		server.rows = [row("a")];
		await mountPane();
		server.holding = true;
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await beat();
		expect(held).toHaveLength(1);

		await env.cleanup();
		held[0]?.fail();
		await settle();

		expect(timers.size).toBe(0);
	});
});

describe("an open artifact page follows the library too", () => {
	const openPage = async (container: HTMLElement, id: string): Promise<Element> => {
		await fire(option(container, id), "click");
		const page = container.querySelector('[data-slot="artifact-page"]');
		if (page === null) throw new Error("the page did not open");
		return page;
	};
	const tab = (container: HTMLElement, label: string) => container.querySelector(`[role="tab"][title="${label}"]`);

	test("it stays open on the same page and its Comments tab shows the new count and the unread dot", async () => {
		server.rows = [row("a", { shares: [share(0, 0)] }), row("b")];
		const container = await mountPane();
		const page = await openPage(container, "a");
		expect(tab(container, "Comments")?.textContent).toBe("Comments");

		await changeTo([row("a", { shares: [share(2, 1)] }), row("b")]);

		expect(container.querySelector('[data-slot="artifact-page"]')).toBe(page);
		expect(tab(container, "Comments")?.textContent).toBe("Comments21 new");
		expect(flashing(container)).toBe(false);
	});

	test("an open Comments panel lists a comment that arrived after it was opened", async () => {
		server.rows = [row("a", { shares: [share(0, 0)] })];
		const container = await mountPane();
		await openPage(container, "a");
		await fire(tab(container, "Comments"), "click");
		expect(showing(container, "No comments yet")).toBe(true);
		expect(commentFetches).toBe(1);

		server.comments = [comment("tighten the landing")];
		await changeTo([row("a", { shares: [share(1, 1)] })]);

		expect(showing(container, "tighten the landing")).toBe(true);
		expect(showing(container, "No comments yet")).toBe(false);
		expect(commentFetches).toBe(2);
	});
});

describe("a write the Library made itself is not a change to follow", () => {
	const mountSelecting = async (): Promise<HTMLElement> => {
		server.rows = [row("a"), row("b"), row("c")];
		const container = await mountPane();
		await fire(container.querySelector('[data-slot="library-grid"]'), "keydown", { key: "ArrowRight" });
		expect(option(container, "a")?.getAttribute("aria-selected")).toBe("true");
		return container;
	};
	const starSelected = async (container: HTMLElement): Promise<void> => {
		await fire(container.querySelector('[data-slot="library-grid"]'), "keydown", { key: "s" });
		await settle();
		expect(container.querySelectorAll('[role="option"] [title="Starred"]')).toHaveLength(1);
	};

	test("alone, it is not read back as a change: the beats after it ask for no rows and nothing says it is loading", async () => {
		const container = await mountSelecting();
		await starSelected(container);
		await beat();
		await beat();

		expect(queries).toHaveLength(1);
		expect(flashing(container)).toBe(false);
	});

	test("made after another process changed the library, it does not hide that change: the next beat reloads in place and the new row arrives", async () => {
		const container = await mountSelecting();
		server.foreign += 1;
		server.rows = [row("fresh"), ...server.rows];
		await starSelected(container);
		await beat();

		expect(queries).toHaveLength(2);
		expect(showing(container, "fresh.png")).toBe(true);
		expect(flashing(container)).toBe(false);
	});

	test("with another process's commit landing inside it, that commit is not hidden either", async () => {
		const container = await mountSelecting();
		server.midWrite = () => {
			server.foreign += 1;
			server.rows = [row("fresh"), ...server.rows];
		};
		await starSelected(container);
		await beat();

		expect(queries).toHaveLength(2);
		expect(showing(container, "fresh.png")).toBe(true);
		expect(flashing(container)).toBe(false);
	});
});

describe("a Library behind another tab", () => {
	test("asks nothing while it is behind; shown again after a change it reloads the rows it holds once, in place, and not again", async () => {
		server.rows = [row("a"), row("b"), row("c")];
		const { container, show } = await mountTab();
		expect(queries).toHaveLength(1);

		await show(false);
		const readsBefore = revisionReads;
		for (let beats = 0; beats < 4; beats += 1) await beat();
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		for (let beats = 0; beats < 4; beats += 1) await beat();
		expect(revisionReads).toBe(readsBefore);
		expect(queries).toHaveLength(1);
		expect(showing(container, "fresh.png")).toBe(false);

		server.holding = true;
		await show(true);
		expect(held.map(query => query.cursor)).toEqual([undefined]);
		expect(showing(container, "a.png")).toBe(true);
		expect(flashing(container)).toBe(false);

		await releaseAll();
		expect(showing(container, "fresh.png")).toBe(true);
		expect(loadedRows(container)).toBe(4);
		expect(flashing(container)).toBe(false);
		await beat();
		await beat();
		expect(queries).toHaveLength(2);
	});

	test("shown again with nothing changed meanwhile, it asks for no rows at all", async () => {
		server.rows = [row("a"), row("b")];
		const { container, show } = await mountTab();
		await show(false);
		await beat();
		await beat();
		await show(true);
		await beat();

		expect(queries).toHaveLength(1);
		expect(flashing(container)).toBe(false);
	});

	test("a change that a read already out brought in as the tab was left waits until the tab is shown, then reloads once", async () => {
		server.rows = [row("a"), row("b")];
		const { container, show } = await mountTab();
		server.holdingRevision = true;
		await beat();
		expect(heldRevisions).toHaveLength(1);

		await show(false);
		server.rows = [row("fresh"), ...server.rows];
		server.revision += 1;
		await releaseRevisions();
		await beat();
		expect(queries).toHaveLength(1);
		expect(showing(container, "fresh.png")).toBe(false);

		server.holdingRevision = false;
		await show(true);
		expect(queries).toHaveLength(2);
		expect(showing(container, "fresh.png")).toBe(true);
		await beat();
		expect(queries).toHaveLength(2);
	});
});
