/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: you type a message on your
 *  phone, press send, and the words vanish — not into the transcript, not back
 *  into the field, nowhere. Measured on a real device 2026-09-07 (Android
 *  emulator, System WebView 113, 412x915): with the wire down the text was gone
 *  in under a second. The `phone` space requires THIS composer, not
 *  composer-classic, and this pack had never been migrated to the delivery
 *  verdict `actions.sendMessage` hands back.
 *
 *  The fix is an ORDER, not a restore: the draft is cleared only AFTER the host
 *  acknowledges delivery. Clear-then-restore cannot work, because with the wire
 *  down `sendMessage` never resolves at all — there is no verdict to restore on.
 *  That is why the never-settling promise below is a first-class case and not a
 *  curiosity: it is the exact device defect.
 *
 *  Leaving the text is visually free — `Composer.submitValue` clears its own
 *  attachment pills but deliberately leaves the TEXT to the controlled `value`
 *  (fraym/packages/ui/src/features/composer/composer-core.tsx) — so the only
 *  thing standing between a user and lost words is the order in `onSubmit`.
 *
 *  HARNESS NOTE: `@fraym/ui` is a HOST-RESOLVED external, never a pack
 *  dependency (see vite.config.ts `rollupOptions.external`), so it is replaced
 *  here by the smallest honest stand-ins: a `Composer` that records the props it
 *  is handed, and a `useObservable` that is the real `useSyncExternalStore`.
 *  What is under test is this pack's OWN section wiring — the send mapping, the
 *  draft persistence, and the acknowledgement. The one part that is NOT a
 *  stand-in is the View-context binding (`useSectionViewContext`): it is the
 *  kit's real hook, mounted under the kit's real `HostStoreProvider` over a
 *  store that answers `seat/scope` for the session under test, exactly as the
 *  host's seat boundary does for a pack. `react`, `react-dom` and
 *  `linkedom` come from the Dimension monorepo this repo is mounted into, which
 *  is where pack tests run (marketplace CI validates only what is standalone).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type HostStore, SEAT_SCOPE_KEY } from "@fraym/driver";
import type { ViewContextEntry } from "../../../../fraym/packages/ui/src/features/composer/composer-view-context";
import * as composerDraft from "../../../../fraym/packages/ui/src/features/composer/session-composer-draft";
import {
	stageSessionViewContext,
	takeSessionViewContexts,
} from "../../../../fraym/packages/ui/src/features/composer/session-composer-draft";
import { sessionRefKey } from "../../../../fraym/packages/ui/src/shell/session-groups";
import { HostStoreProvider } from "../../../../fraym/packages/ui/src/shell/space/store-binding";

// ── The published parts, replaced by stand-ins ───────────────────────────────

interface ComposerCapture {
	readonly value: string;
	readonly onChange: (text: string) => void;
	readonly onSubmit: (text: string, attachments?: readonly unknown[]) => void;
	readonly onStashSend?: (text: string, attachments?: readonly unknown[]) => void;
	readonly viewContexts?: readonly { readonly callId: string }[];
	readonly onRemoveViewContext?: (callId: string) => void;
	readonly disabled: boolean;
}

let composer: ComposerCapture | null = null;

mock.module("@fraym/ui", () => ({
	Composer: (props: ComposerCapture) => {
		composer = props;
		return null;
	},
	GoalComposerSurface: () => null,
	UsageLimitComposerSurface: () => null,
	// The real one is a useSyncExternalStore wrapper; use the real hook so the
	// component's NO_SESSION stability contract is exercised, not faked.
	useObservable: (source: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown }) =>
		useSyncExternalStore(source.subscribe, source.getSnapshot),
	useSlashCommands: () => undefined,
	useFileCompletions: () => undefined,
	useArgumentCompletions: () => undefined,
	// The kit's own binding, not a stand-in: see the last describe block.
	useSectionViewContext: composerDraft.useSectionViewContext,
}));

/** The session keys this file staged View context under, emptied after each test: the store is
 *  a module global. */
const stagedKeys: string[] = [];

/** A View declares context for the session a `mount(sessionId, …)` below will compose into. */
function stage(sessionId: string, entry: ViewContextEntry): void {
	const key = sessionRefKey({ workspaceId: "ws1", sessionId });
	stagedKeys.push(key);
	stageSessionViewContext(key, entry);
}

// Static imports are hoisted above `mock.module`, so the module under test must
// be pulled in after the stand-ins are registered.
const IndependentComposer = (await import("../src/index")).default;

// ── DOM harness ──────────────────────────────────────────────────────────────

const globalNames = ["window", "document", "navigator", "HTMLElement", "Element", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof globalNames)[number];

let originalGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
let container: HTMLElement;
const roots: Root[] = [];

beforeEach(() => {
	const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
	originalGlobals ??= Object.fromEntries(
		globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
	) as Record<DomGlobal, PropertyDescriptor | undefined>;
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	container = window.document.getElementById("root") as unknown as HTMLElement;
	composer = null;
});

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	for (const name of globalNames) {
		const descriptor = originalGlobals?.[name];
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals = undefined;
	composer = null;
	for (const key of stagedKeys.splice(0)) takeSessionViewContexts(key);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SENT = "roll the deploy back, the p99 just tripled";
const NEWER = "actually hold on, page the on-call first";

/** A stable snapshot source: `useObservable` is useSyncExternalStore, so an
 *  unstable getSnapshot would loop rather than fail. */
const SESSION = { subscribe: () => () => {}, getSnapshot: () => null };

function deferred<T>() {
	let settle!: (value: T) => void;
	const promise = new Promise<T>(resolve => {
		settle = resolve;
	});
	return { promise, settle };
}

/** The store the host's seat boundary hands a pack: it answers ONE key, `seat/scope`, the
 *  session the seat is bound to. `follow` is the host re-binding the seat when the human
 *  switches session — the scope moves with the section's `sessionRef` prop. The snapshot is
 *  the same object until it moves (an unstable one would loop `useSyncExternalStore`). */
function seatStore(initialSessionId: string) {
	const scopeFor = (sessionId: string) => ({ sessionId, workspaceId: "ws1", agent: null });
	let scope = scopeFor(initialSessionId);
	const listeners = new Set<() => void>();
	const store: HostStore = {
		read: <T,>(key: string) => (key === SEAT_SCOPE_KEY ? (scope as T) : undefined),
		watch: <T,>(key: string) => ({
			getSnapshot: () => (key === SEAT_SCOPE_KEY ? (scope as T) : undefined),
			subscribe: (listener: () => void) => {
				if (key !== SEAT_SCOPE_KEY) return () => {};
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		}),
		act: () => {},
	};
	const follow = (sessionId: string) => {
		scope = scopeFor(sessionId);
		for (const listener of [...listeners]) listener();
	};
	return { store, follow };
}

interface Mounted {
	readonly sent: unknown[];
	/** Re-render the SAME instance against a different session. */
	rerender(sessionId: string): Promise<void>;
	unmount(): Promise<void>;
}

function propsFor(sessionId: string, sendMessage: (input: unknown) => Promise<boolean | void>) {
	return {
		sessionRef: { workspaceId: "ws1", sessionId },
		placeholder: "Ask anything",
		actions: { sendMessage, interruptRunForQueuedMessage: async () => {} },
		session: SESSION,
		disabled: false,
		opening: false,
		continuation: { continued: false },
	} as const;
}

async function mount(sessionId: string, reply: (input: unknown) => Promise<boolean | void>): Promise<Mounted> {
	const sent: unknown[] = [];
	const sendMessage = (input: unknown) => {
		sent.push(input);
		return reply(input);
	};
	const seat = seatStore(sessionId);
	const tree = (id: string) =>
		createElement(HostStoreProvider, { store: seat.store }, createElement(IndependentComposer, propsFor(id, sendMessage)));
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(tree(sessionId)));
	return {
		sent,
		rerender: async (nextId: string) => {
			await act(async () => {
				seat.follow(nextId);
				root.render(tree(nextId));
			});
		},
		unmount: async () => {
			await act(async () => root.unmount());
		},
	};
}

/** What a fresh mount of the same session shows — i.e. what survived in the
 *  module-level per-session `drafts` map after the component went away. This is
 *  the product behaviour that map exists for: switch away mid-sentence, come
 *  back, the words are still there. */
async function reopen(sessionId: string): Promise<string> {
	const again = await mount(sessionId, async () => true);
	const value = value_();
	await again.unmount();
	return value;
}

function value_(): string {
	if (!composer) throw new Error("Composer was never rendered");
	return composer.value;
}

async function type(text: string): Promise<void> {
	const onChange = composer?.onChange;
	if (!onChange) throw new Error("Composer was never rendered");
	await act(async () => onChange(text));
}

async function submit(text: string): Promise<void> {
	const onSubmit = composer?.onSubmit;
	if (!onSubmit) throw new Error("Composer was never rendered");
	await act(async () => onSubmit(text, []));
}

/** Let every already-queued microtask in the submit chain run. Nothing here
 *  waits on the clock — an unsettled send stays unsettled forever, which is
 *  precisely the device condition. */
async function flush(): Promise<void> {
	await act(async () => {
		for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
	});
}

// ── Contracts ────────────────────────────────────────────────────────────────

describe("an unacknowledged send keeps the words", () => {
	test("a send that NEVER settles leaves the text on screen and in the draft map (the device defect)", async () => {
		// The wire is down: `sendMessage` returns a promise that never resolves,
		// so there is no verdict at all — not false, not an error, nothing.
		const view = await mount("never-settles", () => new Promise<boolean>(() => {}));
		await type(SENT);
		await submit(SENT);
		await flush();

		expect(view.sent).toEqual([SENT]);
		expect(value_()).toBe(SENT);

		await view.unmount();
		expect(await reopen("never-settles")).toBe(SENT);
	});

	test("a send the host REFUSES (false) leaves the text on screen and in the draft map", async () => {
		const view = await mount("refused", async () => false);
		await type(SENT);
		await submit(SENT);
		await flush();

		expect(view.sent).toEqual([SENT]);
		expect(value_()).toBe(SENT);

		await view.unmount();
		expect(await reopen("refused")).toBe(SENT);
	});

	test("a host older than the verdict contract (undefined) counts as UNDELIVERED, never a silent success", async () => {
		const view = await mount("legacy-host", async () => undefined);
		await type(SENT);
		await submit(SENT);
		await flush();

		expect(view.sent).toEqual([SENT]);
		expect(value_()).toBe(SENT);

		await view.unmount();
		expect(await reopen("legacy-host")).toBe(SENT);
	});
});

describe("an acknowledged send drops the copy", () => {
	test("a delivered send (true) empties the field and removes the session's draft-map entry", async () => {
		const view = await mount("delivered", async () => true);
		await type(SENT);
		await submit(SENT);
		await flush();

		expect(view.sent).toEqual([SENT]);
		expect(value_()).toBe("");

		await view.unmount();
		expect(await reopen("delivered")).toBe("");
	});

	test("attachments travel with the text, and delivery still clears", async () => {
		// The wire shape the reference's sendComposed produces; a delivered send
		// must clear regardless of which shape went out.
		const view = await mount("delivered-with-image", async () => true);
		await type(SENT);
		const onSubmit = composer?.onSubmit;
		if (!onSubmit) throw new Error("Composer was never rendered");
		await act(async () => onSubmit(SENT, [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }]));
		await flush();

		expect(view.sent).toEqual([
			{ text: SENT, attachments: [{ kind: "image", mimeType: "image/png", data: "AAAA", name: "shot.png" }] },
		]);
		expect(value_()).toBe("");
	});
});

describe("a late acknowledgement cannot overwrite what came after it", () => {
	test("words typed while the send is in flight survive a delivered acknowledgement", async () => {
		const answer = deferred<boolean>();
		const view = await mount("typed-newer", () => answer.promise);
		await type(SENT);
		await submit(SENT);
		await type(NEWER);

		await act(async () => answer.settle(true));
		await flush();

		expect(value_()).toBe(NEWER);
		await view.unmount();
		expect(await reopen("typed-newer")).toBe(NEWER);
	});

	test("an acknowledgement for a session the user has LEFT does not empty the field in front of them", async () => {
		// Submit under session A, then the host re-renders this instance against
		// session B while the answer is still in flight. `sentKey` was bound
		// before the await, so the answer belongs to A: A's map entry is dropped,
		// but the local field — which is what the reader is looking at now — must
		// not be touched by a session they are no longer in.
		const answer = deferred<boolean>();
		const view = await mount("left-session-a", () => answer.promise);
		await type(SENT);
		await submit(SENT);
		await view.rerender("left-session-b");

		await act(async () => answer.settle(true));
		await flush();

		// TWO FACTS ARE GLUED TOGETHER ON THIS LINE, AND THE SECOND IS A DEFECT.
		// (1) The contract this test defends: A's late acknowledgement did not
		//     empty the field in front of a reader who has already moved on.
		// (2) NOT a contract — CROSS-SESSION DRAFT BLEED, recorded here as
		//     CURRENT behaviour, not as desired behaviour: the field the reader
		//     sees under session B still holds session A's words. `draft` is
		//     `useState(() => drafts.get(draftKey) ?? "")` (src/index.tsx:67),
		//     initialised ONCE, and the host mounts this section with no `key` —
		//     the session arrives as a prop
		//     (fraym/packages/ui/src/shell/workspace-session-pane-core.tsx:217) —
		//     so a session switch REUSES this instance and the old text stays on
		//     screen. The next keystroke then persists A's words under B's key.
		//     The classic composer is immune because it derives the draft FROM
		//     the key: `useSessionComposerDraft(draftKey)`
		//     (fraym/packages/ui/src/shell/space/impls/composer-classic.tsx:58-59),
		//     which re-reads whenever the key changes.
		//     When that fix lands here this line becomes `.toBe("")`, and fact
		//     (1) loses its on-screen surface — assert it through A's map entry
		//     (the `reopen` below) at that point, not through the visible value.
		expect(value_()).toBe(SENT);
		await view.unmount();
		// A's delivered copy is gone — the map is keyed, so the right session's
		// copy was the one dropped.
		expect(await reopen("left-session-a")).toBe("");
	});
});

describe("a stray second Enter cannot post the message twice", () => {
	test("resubmitting the SAME text while the first send is unresolved does not send twice", async () => {
		// The device condition from the first contract in this file: the wire is
		// down, so `sendMessage` never resolves — and because the words
		// deliberately stay on screen, the reader believes the send failed and
		// presses Enter again.
		const view = await mount("double-enter", () => new Promise<boolean>(() => {}));
		await type(SENT);
		await submit(SENT);
		await flush();
		await submit(SENT);
		await flush();

		expect(view.sent).toEqual([SENT]);
		// Still unacknowledged, so this remains the only copy of the words.
		expect(value_()).toBe(SENT);
	});

	test("editing the text and resubmitting while the first send is unresolved DOES send", async () => {
		// The guard is keyed `(draftKey, text)`. Keyed on the session alone it
		// would swallow the correction the reader typed BECAUSE the first send
		// looked like it failed — a worse bug than the duplicate it prevents.
		const view = await mount("edit-and-resend", () => new Promise<boolean>(() => {}));
		await type(SENT);
		await submit(SENT);
		await flush();
		await type(NEWER);
		await submit(NEWER);
		await flush();

		expect(view.sent).toEqual([SENT, NEWER]);
	});
});

// ── a View's staged context ──────────────────────────────────────────────────
//
// WHAT BREAKS IN THE PRODUCT IF THESE GO RED: a phone (or any space that binds THIS
// composer instead of the classic one) stops showing what a View told the agent on the human's
// behalf, or stops carrying it. The hook is the kit's REAL `useSectionViewContext` — the same
// store the classic composer and a View's `ui/message` use, bound to the seat's session through
// the `seat/scope` store `mount` provides — not a stand-in, because "spent by the send, back on
// a failure" is the store's behaviour and a stand-in could only echo the pack's wiring.

const ANNOTATION = {
	callId: "browser/view#1",
	serverId: "browser",
	tool: "browser_view",
	label: "Browser · example.com",
	text: "browserId: b-7\nThe human circled the checkout button.",
	images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
};

const chipIds = () => (composer?.viewContexts ?? []).map(chip => chip.callId);

describe("a View's staged context in the independent composer", () => {
	test("it shows as chips, and the ✕ withdraws one", async () => {
		stage("chips", ANNOTATION);
		await mount("chips", async () => true);
		expect(chipIds()).toEqual(["browser/view#1"]);

		await act(async () => composer?.onRemoveViewContext?.("browser/view#1"));

		expect(chipIds()).toEqual([]);
	});

	test("the composer's own send carries it once: words as typed, the fence for the model, the image attached", async () => {
		stage("carry", ANNOTATION);
		const view = await mount("carry", async () => true);
		await type(SENT);

		await submit(SENT);
		await flush();
		await type("and one more thing");
		await submit("and one more thing");
		await flush();

		expect(view.sent).toHaveLength(2);
		const [first, second] = view.sent as [{ text: string; expansion: string; attachments: unknown[] }, unknown];
		// The human's words stay what they typed; the model-facing text carries the View's body
		// inside ONE open/close pair that names the same nonce. The fence's exact wording is the
		// kit's, pinned in the kit's own tests, not here.
		expect(first.text).toBe(SENT);
		expect(first.expansion.startsWith(SENT)).toBe(true);
		expect(first.expansion).toContain(ANNOTATION.text);
		expect(first.expansion).toMatch(/<artifact-context id="([0-9a-f]+)"[^>]*>[\s\S]*<\/artifact-context id="\1">$/);
		expect(first.attachments).toEqual([
			{ kind: "image", mimeType: "image/png", data: "iVBORw0KGgo=", name: "Browser · example.com" },
		]);
		// ...and it rode ONE message: the next goes out as typed.
		expect(second).toBe("and one more thing");
		expect(chipIds()).toEqual([]);
	});

	test("a chip the human removed is not sent", async () => {
		stage("removed", ANNOTATION);
		const view = await mount("removed", async () => true);
		// Guard: the chip really was there to remove.
		expect(chipIds()).toEqual(["browser/view#1"]);
		await act(async () => composer?.onRemoveViewContext?.("browser/view#1"));
		await type(SENT);

		await submit(SENT);
		await flush();

		expect(view.sent).toEqual([SENT]);
	});

	test("a send the host refuses puts the chip back beside the words that stayed", async () => {
		stage("refused-chip", ANNOTATION);
		const view = await mount("refused-chip", async () => false);
		await type(SENT);

		await submit(SENT);
		await flush();

		expect(view.sent).toHaveLength(1);
		expect(value_()).toBe(SENT);
		expect(chipIds()).toEqual(["browser/view#1"]);
	});

	test("a stash send never lived in this field, so it spends nothing", async () => {
		stage("stash", ANNOTATION);
		const view = await mount("stash", async () => true);

		await act(async () => composer?.onStashSend?.("parked words", []));
		await flush();

		expect(view.sent).toEqual(["parked words"]);
		expect(chipIds()).toEqual(["browser/view#1"]);
	});
});
