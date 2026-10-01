// The View's own tab strip (v1: the host gives one tab per server, so the
// documents share it). A pure reducer plus a tiny external store, and the store
// lives at MODULE scope on purpose: the tool result that mounts the View arrives
// before React's first effect, and a store owned by a component would drop it.
import { useSyncExternalStore } from "react";
import type { ViewedFile } from "../../src/contract";

export interface DocTab extends ViewedFile {
	/** The document's identity: the real path the server resolved. */
	readonly key: string;
	/** Bumped when the same file is opened again and has CHANGED on disk. */
	readonly revision: number;
	/** How many opens of this document asked for annotate mode. A count, not a flag: each ask turns the layer on again, even for a tab already open. */
	readonly annotateRequests: number;
	/**
	 * Set on a tab for a file that did NOT open (locked, unreadable, gone): the pane for it says why in one sentence and
	 * has no document and nothing to mark. The next open of the same file replaces it.
	 */
	readonly failure?: OpenFailureText;
}

/** What a file that would not open says to the human: one sentence, and whether copying its path is the way out. */
export interface OpenFailureText {
	readonly message: string;
	readonly copyPath: boolean;
}

export interface ViewerState {
	readonly tabs: readonly DocTab[];
	readonly activeKey: string | null;
	/** The last refusal or failure, shown until dismissed or a file opens. */
	readonly notice: string | null;
}

export type ViewerAction =
	| { readonly type: "open"; readonly key: string; readonly file: ViewedFile; /** The open asked for annotate mode. */ readonly annotate?: boolean }
	/** A file the server could not open: `path` is the one the error named, when it named one. */
	| { readonly type: "failed"; readonly failure: OpenFailureText; readonly path?: string }
	| { readonly type: "refused"; readonly message: string }
	| { readonly type: "activate"; readonly key: string }
	| { readonly type: "close"; readonly key: string }
	| { readonly type: "dismiss" };

export const INITIAL_STATE: ViewerState = { tabs: [], activeKey: null, notice: null };

/** Whether two paths name the same file as far as a name can tell: letter case and the direction of the slashes do not matter. */
function sameFile(a: string, b: string): boolean {
	const plain = (path: string) => path.replaceAll("\\", "/").toLowerCase();
	return plain(a) === plain(b);
}

export function reduce(state: ViewerState, action: ViewerAction): ViewerState {
	switch (action.type) {
		case "open": {
			const asked = action.annotate === true ? 1 : 0;
			// A file that failed to open and now opens: its failed tab gives way to the real one, even when the two name
			// the path differently (a link, another letter case).
			const standing = state.tabs.filter(tab => tab.failure === undefined || tab.key === action.key || !sameFile(tab.path, action.file.path));
			const at = standing.findIndex(tab => tab.key === action.key);
			if (at === -1) {
				const tab: DocTab = { ...action.file, key: action.key, revision: 0, annotateRequests: asked };
				return { tabs: [...standing, tab], activeKey: action.key, notice: null };
			}
			// The same file again: focus it, and reload it only if it moved under us (a failed tab always reloads).
			const existing = standing[at] as DocTab;
			const changed = existing.failure !== undefined || existing.size !== action.file.size || existing.mtimeMs !== action.file.mtimeMs;
			const annotateRequests = existing.annotateRequests + asked;
			const tabs =
				changed || asked > 0
					? standing.map((tab, index) => {
							if (index !== at) return tab;
							return changed ? { ...action.file, key: action.key, revision: existing.revision + 1, annotateRequests } : { ...existing, annotateRequests };
						})
					: standing;
			return { tabs, activeKey: action.key, notice: null };
		}
		case "failed": {
			const { path } = action;
			// An error that names no file has nothing to attach to: it is said as a notice.
			if (path === undefined) return { ...state, notice: action.failure.message };
			const at = state.tabs.findIndex(tab => sameFile(tab.path, path));
			const there = state.tabs[at];
			// A document that is open is still what it was: the failure is news about the file, not about that tab.
			if (there !== undefined && there.failure === undefined) return { ...state, activeKey: there.key, notice: action.failure.message };
			const filename = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
			const failed: DocTab = { path, filename, kind: "binary", size: 0, mtimeMs: 0, key: there?.key ?? path, revision: 0, annotateRequests: 0, failure: action.failure };
			return { tabs: at === -1 ? [...state.tabs, failed] : state.tabs.map((tab, index) => (index === at ? failed : tab)), activeKey: failed.key, notice: null };
		}
		case "refused":
			return { ...state, notice: action.message };
		case "activate":
			return state.tabs.some(tab => tab.key === action.key) ? { ...state, activeKey: action.key } : state;
		case "close": {
			const at = state.tabs.findIndex(tab => tab.key === action.key);
			if (at === -1) return state;
			const tabs = state.tabs.filter(tab => tab.key !== action.key);
			if (state.activeKey !== action.key) return { ...state, tabs };
			// Closing the front tab shows its right neighbour, else its left one.
			const next = tabs[at] ?? tabs[at - 1];
			return { ...state, tabs, activeKey: next?.key ?? null };
		}
		case "dismiss":
			return state.notice === null ? state : { ...state, notice: null };
	}
}

export interface ViewerStore {
	getState(): ViewerState;
	dispatch(action: ViewerAction): void;
	subscribe(listener: () => void): () => void;
}

export function createViewerStore(): ViewerStore {
	let state = INITIAL_STATE;
	const listeners = new Set<() => void>();
	return {
		getState: () => state,
		dispatch(action) {
			const next = reduce(state, action);
			if (next === state) return;
			state = next;
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export function useViewerState(store: ViewerStore): ViewerState {
	return useSyncExternalStore(store.subscribe, store.getState);
}
