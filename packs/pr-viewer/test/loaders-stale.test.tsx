// The loaders (#902): a first-ever read shows a shaped loader; a RE-read over
// painted content dims that content instead of swapping it for a spinner; an
// errored re-read blanks to null so the failure surfaces. Each ruling is
// pinned at the surface a user touches, through a LIVE mount (the loaders are
// effect-driven, so `renderToStaticMarkup` would never show them), and each
// has a named mutant that reddens it:
//
//   1. SUMMARY FIRST LOAD IS A SKELETON, NOT A BLANK. `detail === null` with
//      `loading` shows the aria-labelled skeleton. Mutant: swap it for a bare
//      "Loading…" — the label lookup reddens.
//   2. A SUMMARY REFETCH DIMS THE PAINTED BODY. Detail on screen + re-read →
//      `opacity-60` + `aria-busy` on the same section, skeleton never back.
//      Mutant: blank the value on re-read (skeleton returns) or drop the dim.
//   3. THREADS FIRST LOAD IS A SKELETON. `threads === null` + loading →
//      "Loading review threads"; an empty-list message mid-load would claim a
//      fact the host has not answered yet.
//   4. A THREADS REFETCH KEEPS THE THREADS, DIMMED. Same stale-keep as (2).
//   5. THE DIFF'S FIRST LOAD IS THE DOTS SPINNER. The diff's shape is
//      unpredictable, so the labour-illusion loader: `Spinner kind="dots"`
//      carrying the "Loading diff" label, not a lying skeleton.
//   6. A DIFF REFETCH KEEPS THE FILES, DIMMED.
//   7. useRead KEEPS THE STALE VALUE ACROSS A RE-READ. The hook is the shared
//      mechanism behind 2/4/6: value stays while `loading` flips true; only
//      an ERROR blanks it. Mutant: re-read resets value to null.
//   8. EMPTY COPIES WAIT FOR THE ANSWER. "No review conversations." /
//      "No file changes." appear only when the read has SETTLED — during the
//      load they assert a fact nobody has.

import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DetailView } from "../src/detail-view";
import type { ReviewDetail, ReviewDiffFile, ReviewRef, ReviewSummary, ReviewThread } from "../src/model";
import type { ReviewDiffPayload, WorkspaceDriverShape, WorkspaceRefShape } from "../src/shapes";
import { useRead } from "../src/use-read";

// ── fixtures ────────────────────────────────────────────────────────────────

const REF: ReviewRef = { provider: "github", host: "example.test", repository: "acme/widgets", number: 101 };
const WORKSPACE: WorkspaceRefShape = { workspaceId: "ws-1", path: "/checkout/widgets" };

type Capabilities = ReviewSummary["capabilities"];

function summaryOf(capabilities: Partial<Capabilities> = {}): ReviewSummary {
	return {
		ref: REF,
		url: "https://example.test/acme/widgets/pull/101",
		label: "PR",
		title: "Teach the rail to name a stack",
		state: "open",
		isDraft: false,
		headBranch: "feat/rail",
		baseBranch: "main",
		updatedAt: "2026-09-17T10:00:00.000Z",
		capabilities: { merge: false, draft: false, stackActions: false, ...capabilities },
	};
}

function detailOf(capabilities: Partial<Capabilities> = {}): ReviewDetail {
	return {
		...summaryOf(capabilities),
		body: "The painted body copy.",
		labels: [],
		reviewers: [],
		checks: [],
		viewer: { merge: false, stackRebase: false },
		allowedMergeMethods: ["merge"],
		stack: null,
	};
}

const ONE_THREAD: ReviewThread = {
	id: "t1",
	path: "src/rail.tsx",
	line: 12,
	isResolved: false,
	isOutdated: false,
	comments: [{ id: "c1", author: { login: "ada" }, body: "Fold this branch?", createdAt: "2026-09-17T10:00:00.000Z" }],
};

const ONE_FILE: ReviewDiffFile = { path: "src/rail.tsx", additions: 10, deletions: 2, patch: "@@ -1 +1 @@\n+folded" };

const detailProps = {
	reviewRef: REF,
	link: undefined,
	workspace: WORKSPACE,
	act: () => {},
	onBack: null,
	settledActions: 0,
	actionNotice: null,
} as const;

const DOM_GLOBALS = ["window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof DOM_GLOBALS)[number];
let priorDomGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
const roots: Root[] = [];

/** A live mount: render, gesture, query. (The pr-viewer.test.tsx idiom.) */
interface MountedDom {
	readonly render: (node: ReactNode) => Promise<void>;
	readonly click: (element: Element) => Promise<void>;
	readonly find: (selector: string) => Element[];
	readonly text: () => string;
}

function mount(): MountedDom {
	const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
	priorDomGlobals ??= Object.fromEntries(
		DOM_GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	) as Record<DomGlobal, PropertyDescriptor | undefined>;
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const container = window.document.getElementById("root") as unknown as HTMLElement;
	const root = createRoot(container);
	roots.push(root);
	return {
		render: async (node: ReactNode) => {
			await act(async () => {
				root.render(node);
			});
		},
		// React 19 delegates onClick at the root container, so a bubbling native
		click: async (element: Element) => {
			await act(async () => {
				element.dispatchEvent(new Event("click", { bubbles: true }));
			});
		},
		find: (selector: string) => [...container.querySelectorAll(selector)],
		text: () => container.textContent ?? "",
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	if (priorDomGlobals) {
		for (const key of DOM_GLOBALS) {
			const descriptor = priorDomGlobals[key];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		priorDomGlobals = undefined;
	}
});

/** A read the test settles BY HAND: each host call hands back the next
 *  deferred, so a test can observe the loading surface and then let the
 *  answer land — the refetch cases need both on one mount. */
interface Gate<T> {
	resolve(value: T): void;
	reject(error: unknown): void;
}


/** A promise the test settles by hand. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ── the gated detail driver: skeleton on first load, dim on refetch ────────
/** A detail driver whose reads the test settles in order; `settledActions`
 *  re-keys the read, which is exactly how a settled review action re-asks. */
function gatedDetailDriver(payloads: readonly ReviewDetail[]) {
	const gates: Gate<ReviewDetail>[] = [];
	let served = 0;
	const driver: WorkspaceDriverShape = {
		getReview: () =>
			new Promise<ReviewDetail>((resolve, reject) => {
				gates.push({ resolve, reject });
			}),
	};
	return {
		driver,
		gates,
		settle: () => {
			const gate = gates.shift();
			gate?.resolve(payloads[served] ?? payloads[payloads.length - 1] ?? (detailOf() as ReviewDetail));
			served += 1;
		},
	};
}

// ── 3 + 4. the threads tab: skeleton on first load, dim on refetch ─────────

function gatedThreadsDriver(pages: readonly (readonly ReviewThread[])[]) {
	const gates: Gate<readonly ReviewThread[]>[] = [];
	const driver: WorkspaceDriverShape = {
		getReviewThreads: () =>
			new Promise<readonly ReviewThread[]>((resolve, reject) => {
				gates.push({ resolve, reject });
			}),
	};
	return {
		driver,
		gates,
		settle: () => {
			const gate = gates.shift();
			gate?.resolve(pages[0] ?? []);
		},
	};
}

// ── 5 + 6. the diff tab: dots on first load, dim on refetch ────────────────

function gatedDiffDriver(payloads: readonly ReviewDiffPayload[]) {
	const gates: Gate<ReviewDiffPayload>[] = [];
	const driver: WorkspaceDriverShape = {
		getReviewDiff: () =>
			new Promise<ReviewDiffPayload>((resolve, reject) => {
				gates.push({ resolve, reject });
			}),
	};
	return {
		driver,
		gates,
		settle: () => {
			const gate = gates.shift();
			gate?.resolve(payloads[0] ?? { files: [], truncated: false });
		},
	};
}

const byText = (elements: readonly Element[], needle: string): Element[] =>
	elements.filter(element => (element.textContent ?? "").trim() === needle);

function one(elements: readonly Element[], what: string): Element {
	if (elements.length !== 1) throw new Error(`expected exactly one ${what}, found ${elements.length}`);
	return elements[0] as Element;
}

/** The tab bar's own buttons, exact-match scoped (the words "threads" and
 *  "diff" also occur in body copy). Same idiom as pr-viewer.test.tsx. */
const tabButton = (dom: MountedDom, name: string): Element => one(byText(dom.find("nav button"), name), `${name} tab button`);

// ── 1. summary first load: the skeleton, never a bare Loading ──────────────

describe("the summary tab's loaders", () => {
	test("first load with no detail painted shows the skeleton, not a bare Loading", async () => {
		const { driver, gates, settle } = gatedDetailDriver([detailOf()]);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} summary={summaryOf()} driver={driver} />);

		// The read is in flight: the shaped skeleton is the ONLY loading surface.
		// A bare-text mutant ("Loading…") has no such element.
		const skeleton = one(dom.find('[aria-label="Loading review details"]'), "summary skeleton");
		expect(skeleton.textContent).toBe("");
		expect(dom.text()).not.toContain("Loading review details…");
		// A first load has NOTHING painted: no dimmed section either — dimming
		// content that does not exist would be the stale-keep mutant's tell.
		expect(dom.find('[aria-busy="true"]')).toHaveLength(0);
		expect(gates).toHaveLength(1);

		settle();
		await act(async () => {});
		expect(dom.find('[aria-label="Loading review details"]')).toHaveLength(0);
		expect(dom.text()).toContain("The painted body copy.");
	});

	test("a refetch over painted content dims it — opacity-60, aria-busy, no skeleton", async () => {
		const { driver, settle } = gatedDetailDriver([detailOf(), detailOf()]);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} settledActions={0} summary={summaryOf()} driver={driver} />);
		settle();
		await act(async () => {});
		expect(dom.text()).toContain("The painted body copy.");

		// A settled action re-keys the read: the painted detail stays on screen,
		// dimmed, while the re-read is in flight. A value-blanking mutant would
		// swap this for the skeleton; a dim-dropping mutant loses opacity-60.
		await dom.render(<DetailView {...detailProps} settledActions={1} summary={summaryOf()} driver={driver} />);
		const dimmed = one(dom.find('section[aria-busy="true"]'), "dimmed summary section");
		expect(dimmed.className).toContain("opacity-60");
		expect(dom.text()).toContain("The painted body copy.");
		expect(dom.find('[aria-label="Loading review details"]')).toHaveLength(0);

		// The re-read lands: the dim lifts, the content refreshes in place.
		settle();
		await act(async () => {});
		expect(dom.find('section[aria-busy="true"]')).toHaveLength(0);
		expect(dom.text()).toContain("The painted body copy.");
	});
});

// ── 3 + 4. the threads tab: skeleton on first load, dim on refetch ─────────

describe("the threads tab's loaders", () => {
	test("first load with no threads painted shows the skeleton, not an empty-list claim", async () => {
		const capabilities: Partial<Capabilities> = { reviewThreads: true, diff: false };
		const { driver, gates, settle } = gatedThreadsDriver([[ONE_THREAD]]);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} summary={summaryOf(capabilities)} driver={driver} />);
		// The threads read fires at mount; its skeleton lives on the tab.
		await dom.click(tabButton(dom, "threads"));

		expect(gates).toHaveLength(1);
		expect(one(dom.find('[data-slot="skeleton-group"]'), "threads skeleton").textContent).toContain(
			"Loading review threads",
		);
		// The host has not answered: the empty list is NOT a fact yet.
		expect(dom.text()).not.toContain("No review conversations.");

		settle();
		await act(async () => {});
		expect(dom.find('[data-slot="skeleton-group"]')).toHaveLength(0);
		expect(dom.text()).toContain("src/rail.tsx:12");
		expect(dom.text()).toContain("1 open · 0 resolved");
	});

	test("a refetch keeps the painted threads dimmed — opacity-60, no skeleton", async () => {
		const capabilities: Partial<Capabilities> = { reviewThreads: true, diff: false };
		const { driver, settle } = gatedThreadsDriver([[ONE_THREAD], [ONE_THREAD]]);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} settledActions={0} summary={summaryOf(capabilities)} driver={driver} />);
		settle();
		await act(async () => {});
		await dom.click(tabButton(dom, "threads"));
		expect(dom.text()).toContain("1 open · 0 resolved");

		// The refetch (new key): the threads stay on screen, dimmed. A
		// value-blanking mutant would show the skeleton; a dim-drop loses
		// opacity-60.
		await dom.render(<DetailView {...detailProps} settledActions={1} summary={summaryOf(capabilities)} driver={driver} />);
		const dimmed = one(dom.find('[class*="opacity-60"]'), "dimmed threads container");
		expect(dimmed.textContent).toContain("1 open · 0 resolved");
		expect(dom.find('[data-slot="skeleton-group"]')).toHaveLength(0);

		settle();
		await act(async () => {});
		expect(dom.find('div[aria-busy="true"]')).toHaveLength(0);
		expect(dom.text()).toContain("1 open · 0 resolved");
	});
});

// ── 5 + 6. the diff tab: dots on first load, dim on refetch ────────────────

describe("the diff tab's loaders", () => {
	test("first load with no diff painted shows the dots spinner, not a skeleton or the files", async () => {
		const capabilities: Partial<Capabilities> = { reviewThreads: false, diff: true };
		const { driver, gates, settle } = gatedDiffDriver([{ files: [ONE_FILE], truncated: false }]);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} summary={summaryOf(capabilities)} driver={driver} />);
		// The diff's fetch is the TAB's own: mounting it is the guard, so the
		// read starts here, and the first-load surface is observable at once.
		await dom.click(tabButton(dom, "diff"));

		expect(gates).toHaveLength(1);
		// The labour-illusion loader: dots, with the label, and its text.
		one(dom.find('div[aria-label="Loading diff"]'), "diff loader wrapper");
		const dots = one(dom.find('[data-spinner-kind="dots"]'), "dots spinner");
		expect(dots.getAttribute("aria-label")).toBe("Loading diff");
		expect(dom.text()).toContain("Loading diff…");
		// Nothing painted: no files, no dim.
		expect(dom.find("details")).toHaveLength(0);
		expect(dom.find('[aria-busy="true"].opacity-60')).toHaveLength(0);

		settle();
		await act(async () => {});
		expect(dom.find('[aria-label="Loading diff"]')).toHaveLength(0);
		expect(dom.text()).toContain("1 file changed");
		expect(dom.text()).toContain("src/rail.tsx");
	});

	test("a refetch keeps the painted files dimmed — opacity-60, no spinner", async () => {
		const capabilities: Partial<Capabilities> = { reviewThreads: false, diff: true };
		const { driver, settle } = gatedDiffDriver([{ files: [ONE_FILE], truncated: false }, { files: [ONE_FILE], truncated: false }]);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} settledActions={0} summary={summaryOf(capabilities)} driver={driver} />);
		await dom.click(tabButton(dom, "diff"));
		settle();
		await act(async () => {});
		expect(dom.text()).toContain("1 file changed");

		// The refetch (new cacheKey): the files stay, dimmed.
		await dom.render(<DetailView {...detailProps} settledActions={1} summary={summaryOf(capabilities)} driver={driver} />);
		const dimmed = one(dom.find('[class*="opacity-60"]'), "dimmed diff container");
		expect(dimmed.textContent).toContain("src/rail.tsx");
		expect(dom.find('[aria-label="Loading diff"]')).toHaveLength(0);

		settle();
		await act(async () => {});
		expect(dom.find('div[aria-busy="true"]')).toHaveLength(0);
		expect(dom.text()).toContain("1 file changed");
	});
});

// ── 7. the hook: stale value survives a re-read; only an error blanks ──────

describe("useRead's stale-while-revalidate", () => {
	test("a re-read keeps the painted value with loading true; only an error blanks it", async () => {
		const seen: { value: string | null; error: string | null; loading: boolean }[] = [];
		function Probe({ read, cacheKey }: { readonly read: (() => Promise<string>) | null; readonly cacheKey: string }) {
			const state = useRead(read, cacheKey);
			seen.push({ value: state.value, error: state.error, loading: state.loading });
			return null;
		}
		const dom = mount();
		let gate = deferred<string>();
		await dom.render(<Probe read={() => gate.promise} cacheKey="k1" />);
		// First-ever read: nothing painted, loading true.
		expect(seen.at(-1)).toEqual({ value: null, error: null, loading: true });

		await act(async () => {
			gate.resolve("stale body");
		});
		expect(seen.at(-1)).toEqual({ value: "stale body", error: null, loading: false });

		// A re-read (the host hands a fresh closure over a new key): the old
		// value STAYS while loading flips true — the dim-what-is-painted input.
		// A mutant that resets value to null here blanks every refetch.
		let gate2 = deferred<string>();
		await dom.render(<Probe read={() => gate2.promise} cacheKey="k2" />);
		expect(seen.at(-1)).toEqual({ value: "stale body", error: null, loading: true });

		// The re-read FAILS: it blanks, so the error surfaces instead of a
		// quietly stale number.
		await act(async () => {
			gate2.reject(new Error("host unreachable"));
		});
		expect(seen.at(-1)?.value).toBeNull();
		expect(seen.at(-1)?.loading).toBe(false);
		expect(seen.at(-1)?.error).toBe("host unreachable");

		// And a later successful read paints again (the blank is not sticky).
		let gate3 = deferred<string>();
		await dom.render(<Probe read={() => gate3.promise} cacheKey="k3" />);
		await act(async () => {
			gate3.resolve("fresh body");
		});
		expect(seen.at(-1)).toEqual({ value: "fresh body", error: null, loading: false });
	});
});

// ── 8. the empty copies wait for the answer ────────────────────────────────

describe("the empty copies", () => {
	test("No review conversations. appears only when the threads read settled empty", async () => {
		const capabilities: Partial<Capabilities> = { reviewThreads: true, diff: false };
		// Two empty answers: the first settles the empty list; the refetch (a
		// settled action re-keys the read) is left in flight over stale [] — the
		// copy must WAIT while `loading` (a mutant dropping `&& !loading` paints
		// "No review conversations." the moment the refetch begins).
		const { driver, settle } = gatedThreadsDriver([[], []]);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} summary={summaryOf(capabilities)} driver={driver} />);
		await dom.click(tabButton(dom, "threads"));
		// Mid-load: the copy would claim a fact the host has not given.
		expect(dom.text()).not.toContain("No review conversations.");

		settle();
		await act(async () => {});
		expect(dom.text()).toContain("No review conversations.");

		// The refetch over the painted empty list: the copy withdraws while the
		// read is in flight, and returns when it settles empty again.
		await dom.render(<DetailView {...detailProps} settledActions={1} summary={summaryOf(capabilities)} driver={driver} />);
		expect(dom.text()).not.toContain("No review conversations.");
		settle();
		await act(async () => {});
		expect(dom.text()).toContain("No review conversations.");
	});

	test("No file changes. appears only when the diff read settled empty", async () => {
		const capabilities: Partial<Capabilities> = { reviewThreads: false, diff: true };
		// Same shape as the threads copy: settled-empty first, then a refetch in
		// flight over the painted empty diff — the copy must WAIT while loading.
		const { driver, settle } = gatedDiffDriver([{ files: [], truncated: false }, { files: [], truncated: false }]);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} summary={summaryOf(capabilities)} driver={driver} />);
		await dom.click(tabButton(dom, "diff"));
		// Mid-load: absent while the host is still thinking.
		expect(dom.text()).not.toContain("No file changes.");

		settle();
		await act(async () => {});
		expect(dom.text()).toContain("No file changes.");

		await dom.render(<DetailView {...detailProps} settledActions={1} summary={summaryOf(capabilities)} driver={driver} />);
		expect(dom.text()).not.toContain("No file changes.");
		settle();
		await act(async () => {});
		expect(dom.text()).toContain("No file changes.");
	});
});
