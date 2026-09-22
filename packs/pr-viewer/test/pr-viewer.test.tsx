// The pack's review-shaped rulings, each pinned at the surface a user touches —
// not at the helper that computes it (`model.ts` is covered next door).
//
//   1. CAPABILITIES DECIDE THE TABS. A driver method is necessary and not
//      sufficient: the review's own `capabilities` must also say yes. Both
//      polarities come from one code path.
//   2. AN OFF-SCREEN TAB IS NOT READ. Asserted with call counters on a LIVE
//      mount — `renderToStaticMarkup` runs no effects, so "never called" there
//      would be true of a broken build too.
//   3. A SELECTION WITH NO CHECKOUT BEHIND IT SAYS SO. It used to re-render the
//      identical list, so the assertion is the fallback surface and its action.
//   4. THE HOOKS RUN BEFORE THE NO-STORE RETURN. A storeless mount that later
//      receives one is a real sequence; with a `useMemo` below that return React
//      throws "Rendered more hooks than during the previous render".
//   5. STACK SCOPE IS THE PROVIDER'S — a rebase carries none; a stack merge is
//      absent from under a still-open layer.

import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailView } from "../src/detail-view";
import type { ReviewDetail, ReviewRef, ReviewSummary, Stack, StackLayer } from "../src/model";
import { PrViewer } from "../src/pr-viewer";
import type { HostStoreShape, ReviewDiffPayload, WorkspaceDriverShape, WorkspaceRefShape } from "../src/shapes";

// ── fixtures ────────────────────────────────────────────────────────────────

const REF: ReviewRef = { provider: "github", host: "example.test", repository: "acme/widgets", number: 101 };
const WORKSPACE: WorkspaceRefShape = { workspaceId: "ws-1", path: "/checkout/widgets" };
const URL = "https://example.test/acme/widgets/pull/101";

type Capabilities = ReviewSummary["capabilities"];

function summaryOf(capabilities: Partial<Capabilities> = {}): ReviewSummary {
	return {
		ref: REF,
		url: URL,
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

/** The loaded detail carries the list summary's capabilities, so a test that
 *  outlives the read asserts the gate and not a tab list that changed shape
 *  when `head` moved from summary to detail. */
function detailOf(capabilities: Partial<Capabilities> = {}): ReviewDetail {
	return {
		...summaryOf(capabilities),
		body: "",
		labels: [],
		reviewers: [],
		checks: [],
		viewer: { merge: false, stackRebase: false },
		allowedMergeMethods: ["merge"],
		stack: null,
	};
}

/** How many times each driver method was asked, per mount. */
interface DriverCalls {
	review: number;
	threads: number;
	diff: number;
}

/** Every method the instrument may call, present and counting — presence is
 *  only HALF of each gate. */
function spyDriver(capabilities: Partial<Capabilities>): {
	readonly driver: WorkspaceDriverShape;
	readonly calls: DriverCalls;
} {
	const calls: DriverCalls = { review: 0, threads: 0, diff: 0 };
	const driver: WorkspaceDriverShape = {
		getReview: () => {
			calls.review += 1;
			return Promise.resolve(detailOf(capabilities));
		},
		getReviewThreads: () => {
			calls.threads += 1;
			return Promise.resolve([]);
		},
		getReviewDiff: () => {
			calls.diff += 1;
			const payload: ReviewDiffPayload = { files: [], truncated: false };
			return Promise.resolve(payload);
		},
	};
	return { driver, calls };
}

/** One recorded intent, exactly as the component handed it over. */
interface Act {
	readonly intent: string;
	readonly payload: unknown;
}

/** A host store by key: one snapshot per cell, never moving, and an act log. */
function fakeStore(cells: Readonly<Record<string, unknown>>): {
	readonly store: HostStoreShape;
	readonly acts: readonly Act[];
} {
	const acts: Act[] = [];
	const store: HostStoreShape = {
		watch<T>(key: string) {
			return { getSnapshot: () => cells[key] as T | undefined, subscribe: () => () => {} };
		},
		act(intent: string, payload?: unknown) {
			acts.push({ intent, payload });
		},
	};
	return { store, acts };
}

const detailProps = {
	reviewRef: REF,
	link: undefined,
	workspace: WORKSPACE,
	act: () => {},
	onBack: null,
	settledActions: 0,
	actionNotice: null,
} as const;

/** The tab bar's own buttons, in order. Scoped to the `nav`: the words
 *  "threads" and "diff" also occur in the tabs' body copy, so a substring test
 *  on the markup would pass with the gate ripped out. */
function tabsOf(markup: string): readonly string[] {
	const { document } = parseHTML(`<!doctype html><html><body>${markup}</body></html>`);
	return [...document.querySelectorAll("nav button")].map(button => (button.textContent ?? "").trim());
}

const DOM_GLOBALS = ["window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof DOM_GLOBALS)[number];
let priorDomGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
const roots: Root[] = [];

/** A live mount: render, gesture, query. */
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

function one(elements: readonly Element[], what: string): Element {
	if (elements.length !== 1) throw new Error(`expected exactly one ${what}, found ${elements.length}`);
	return elements[0] as Element;
}

const byText = (elements: readonly Element[], needle: string): Element[] =>
	elements.filter(element => (element.textContent ?? "").includes(needle));

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

// ── 1. the review's capabilities decide the tabs ────────────────────────────

describe("DetailView's tab bar", () => {
	test("a review whose capabilities withhold threads and the diff offers neither tab", () => {
		const { driver } = spyDriver({ reviewThreads: false, diff: false });
		const markup = renderToStaticMarkup(
			<DetailView {...detailProps} summary={summaryOf({ reviewThreads: false, diff: false })} driver={driver} />,
		);
		// Not merely "no threads tab": with summary alone qualifying, the whole
		// nav is gone rather than a one-tab bar that reads as a choice.
		expect(tabsOf(markup)).toEqual([]);
	});

	test("the same driver on a review that allows both draws both tabs", () => {
		const { driver } = spyDriver({ reviewThreads: true, diff: true });
		const markup = renderToStaticMarkup(
			<DetailView {...detailProps} summary={summaryOf({ reviewThreads: true, diff: true })} driver={driver} />,
		);
		expect(tabsOf(markup)).toEqual(["summary", "threads", "diff"]);
	});

	test("each capability gates its own tab", () => {
		const { driver } = spyDriver({ reviewThreads: true, diff: false });
		const threadsOnly = renderToStaticMarkup(
			<DetailView {...detailProps} summary={summaryOf({ reviewThreads: true, diff: false })} driver={driver} />,
		);
		expect(tabsOf(threadsOnly)).toEqual(["summary", "threads"]);
		const diffOnly = renderToStaticMarkup(
			<DetailView {...detailProps} summary={summaryOf({ reviewThreads: false, diff: true })} driver={driver} />,
		);
		expect(tabsOf(diffOnly)).toEqual(["summary", "diff"]);
	});

	test("a driver that cannot read a diff hides the tab the review would allow", () => {
		const { driver } = spyDriver({ diff: true });
		const { getReviewDiff: _omitted, ...withoutDiff } = driver;
		const markup = renderToStaticMarkup(
			<DetailView {...detailProps} summary={summaryOf({ reviewThreads: true, diff: true })} driver={withoutDiff} />,
		);
		expect(tabsOf(markup)).toEqual(["summary", "threads"]);
	});
});

// ── 2. an off-screen tab is never read ──────────────────────────────────────

describe("DetailView's reads", () => {
	test("the summary tab reads the detail and nothing else, and the diff arrives only on the tab", async () => {
		const capabilities = { reviewThreads: false, diff: true };
		const { driver, calls } = spyDriver(capabilities);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} summary={summaryOf(capabilities)} driver={driver} />);

		// The detail read proves effects ran here — without it the two zeroes
		// below would be satisfied by a component that rendered nothing.
		expect(calls.review).toBe(1);
		expect(calls.diff).toBe(0); // large, and behind a tab nobody opened
		// The method exists; this review says no line threads do.
		expect(calls.threads).toBe(0);

		const diffTab = one(byText(dom.find("nav button"), "diff"), "diff tab button");
		await dom.click(diffTab);
		expect(calls.diff).toBe(1);
		expect(calls.threads).toBe(0);
	});

	test("the threads read happens once the review says threads exist", async () => {
		const capabilities = { reviewThreads: true, diff: false };
		const { driver, calls } = spyDriver(capabilities);
		const dom = mount();
		await dom.render(<DetailView {...detailProps} summary={summaryOf(capabilities)} driver={driver} />);
		expect(calls.threads).toBe(1);
		expect(calls.diff).toBe(0);
	});
});

// ── 2b. the detail header's outward affordances ─────────────────────────────
//
// The header's external glyph used to emit a BARE `openReview`, which the
// mounted viewer answered itself (a refresh, not a browser). The fix names the
// destination with `external: true` — asserted exactly, so a dropped key
// reddens — and the Close button borrows the host's own noun (`PR`/`MR`) and
// the destructive treatment, verified on static markup where the word "Close"
// would otherwise match any of the panel's other chrome.

describe("DetailView's header", () => {
	test("the external glyph asks for the browser, naming the destination exactly", async () => {
		const { driver } = spyDriver({});
		const acts: Act[] = [];
		const dom = mount();
		await dom.render(
			<DetailView
				{...detailProps}
				summary={summaryOf()}
				driver={driver}
				act={(intent, payload) => {
					acts.push({ intent, payload });
				}}
			/>,
		);

		const open = one(dom.find('button[aria-label="Open on example.test"]'), "open-on-host button");
		await dom.click(open);
		expect(acts).toHaveLength(1);
		expect(acts[0]?.intent).toBe("openReview");
		expect(acts[0]?.payload).toEqual({ ref: REF, url: URL, external: true });
	});
});

describe("the header's Close button", () => {
	/** DetailView with everything else identical except the host's noun. The
	 *  read is driven by the driver fixture, so a live mount is unnecessary. */
	function markupFor(label: ReviewSummary["label"]): string {
		const { driver } = spyDriver({});
		return renderToStaticMarkup(
			<DetailView {...detailProps} summary={{ ...summaryOf(), label }} driver={driver} />,
		);
	}

	test("a PR closes under the host's own noun, with the destructive treatment", () => {
		const { document } = parseHTML(`<!doctype html><html><body>${markupFor("PR")}</body></html>`);
		const button = one(
			[...document.querySelectorAll("button")].filter(b => (b.textContent ?? "").trim() === "Close PR"),
			"Close PR button",
		);
		// The destructive treatment is visible at rest — red text, red hairline
		// — not the ghost that only appeared on hover and read as a label.
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("data-variant")).toBe("destructive");
		expect(button.className).toContain("text-fr-del");
		expect(button.className).toContain("border-fr-del-line");
	});

	test("an MR closes under the same noun swap, no host word hardcoded", () => {
		const { document } = parseHTML(`<!doctype html><html><body>${markupFor("MR")}</body></html>`);
		const button = one(
			[...document.querySelectorAll("button")].filter(b => (b.textContent ?? "").trim() === "Close MR"),
			"Close MR button",
		);
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("data-variant")).toBe("destructive");
		expect(button.className).toContain("text-fr-del");
		expect(button.className).toContain("border-fr-del-line");
	});

	test("a closed review offers no Close at all — reopen replaces it", () => {
		const { driver } = spyDriver({});
		const markup = renderToStaticMarkup(
			<DetailView {...detailProps} summary={{ ...summaryOf(), state: "closed" }} driver={driver} />,
		);
		const { document } = parseHTML(`<!doctype html><html><body>${markup}</body></html>`);
		const texts = [...document.querySelectorAll("button")].map(b => (b.textContent ?? "").trim());
		expect(texts.filter(text => text.startsWith("Close"))).toHaveLength(0);
		expect(texts).toContain("Reopen");
	});
});

// ── 3. a selection with no checkout behind it ───────────────────────────────

const reviewsKey = `workspace/${WORKSPACE.workspaceId}/reviews`;

describe("PrViewer with a workspace but no driver", () => {
	test("selecting a review states the mount cannot read it, and can still open it on the host", async () => {
		const { store, acts } = fakeStore({ [reviewsKey]: [summaryOf({ reviewThreads: true, diff: true })] });
		const dom = mount();
		await dom.render(<PrViewer sessionId={null} workspace={WORKSPACE} workspaceDriver={null} store={store} />);

		// Before the gesture: the list, no fallback — exactly the markup the
		// pre-fix build ALSO produced AFTER the click, so the assertions below
		// discriminate the fix from the swallowed selection.
		expect(dom.text()).toContain("Also in this checkout");
		expect(dom.find('[data-slot="pr-viewer-no-detail"]')).toHaveLength(0);

		const row = one(byText(dom.find("button"), "#101"), "review row select button");
		await dom.click(row);

		const fallback = one(dom.find('[data-slot="pr-viewer-no-detail"]'), "no-detail surface");
		const stated = fallback.textContent ?? "";
		expect(stated).toContain("#101");
		expect(stated).toContain("acme/widgets");
		// The list is GONE: the selection was answered, not swallowed.
		expect(dom.text()).not.toContain("Also in this checkout");

		const open = one(dom.find('button[aria-label="Open on example.test"]'), "open-on-host button");
		await dom.click(open);
		expect(acts).toHaveLength(1);
		expect(acts[0]?.intent).toBe("openReview");
		// Exact, not a subset: the whole point of the fix is that `external`
		// NAMES the destination, so a payload without it routes to the viewer
		// itself — and `env` rides along only because the provider's `act`
		// folds it in, not the button. A dropped or renamed key must fail here.
		expect(acts[0]?.payload).toEqual({ ref: REF, url: URL, env: WORKSPACE, external: true });
	});
});

// ── 4. the store may arrive after the mount ─────────────────────────────────

describe("PrViewer's hook order", () => {
	test("a mount that starts with no store survives the store arriving", async () => {
		const dom = mount();
		await dom.render(<PrViewer sessionId={null} workspace={WORKSPACE} workspaceDriver={null} store={undefined} />);
		expect(dom.text()).toContain("No store on this mount");

		const { store } = fakeStore({ [reviewsKey]: [summaryOf()] });
		await dom.render(<PrViewer sessionId={null} workspace={WORKSPACE} workspaceDriver={null} store={store} />);

		// The list the store's cell feeds, on the SAME root — a hook-count throw
		// here is React refusing the render, and the surface stays blank.
		expect(dom.text()).toContain("Also in this checkout");
		expect(byText(dom.find("button"), "#101")).toHaveLength(1);
	});
});

// ── 5. stack scope is the provider's, and the surface obeys it ──────────────
//
// A REBASE acts on #N alone — the stack's number, or the heads the merge path
// computes, is refused outright. A MERGE lands the WHOLE stack, so one asked
// for from under a still-open layer is refused, and the button is absent there
// rather than offered. Both need the LOADED detail (`viewer.*` lives there), so
// these run on a mount rather than a static render.

const LAYERS: readonly StackLayer[] = [
	{ number: 100, headBranch: "feat/base", headSha: "sha100", state: "open", title: "Base layer" },
	{ number: 101, headBranch: "feat/rail", headSha: "sha101", state: "open", title: "Middle layer" },
	{ number: 102, headBranch: "feat/top", headSha: "sha102", state: "open", title: "Top layer" },
];
const STACK: Stack = { kind: "native", number: 100, base: "main", layers: LAYERS };

/** One review of the stack above, with the viewer's own permissions. Every
 *  OTHER input to the gate is satisfied — open and mergeable, `merge`,
 *  `stackActions`, a headSha per layer, no drafts — so the only thing that
 *  differs between the polarities is WHICH layer is being looked at. */
async function mountStackLayer(
	number: number,
	viewer: { readonly merge: boolean; readonly stackRebase: boolean },
): Promise<{ readonly dom: MountedDom; readonly acts: readonly Act[] }> {
	const ref: ReviewRef = { ...REF, number };
	const capabilities: Partial<Capabilities> = { merge: true, stackActions: true };
	const detail: ReviewDetail = { ...detailOf(capabilities), ref, viewer, stack: STACK };
	const acts: Act[] = [];
	const driver: WorkspaceDriverShape = { getReview: () => Promise.resolve(detail) };
	const dom = mount();
	await dom.render(
		<DetailView
			{...detailProps}
			reviewRef={ref}
			summary={{ ...summaryOf(capabilities), ref }}
			driver={driver}
			act={(intent, payload) => {
				acts.push({ intent, payload });
			}}
		/>,
	);
	return { dom, acts };
}

describe("the stack actions", () => {
	test("Rebase stack asks for the review's own branch update, with no stack scope attached", async () => {
		const { dom, acts } = await mountStackLayer(101, { merge: false, stackRebase: true });
		const rebase = one(byText(dom.find("button"), "Rebase stack"), "rebase-stack button");
		await dom.click(rebase);
		expect(acts).toHaveLength(1);
		expect(acts[0]?.intent).toBe("reviewAction");
		// Exact, not a subset: `stackNumber` / `expectedStackHeads` riding along
		// is what the provider refuses, so an extra key must fail here.
		expect(acts[0]?.payload).toEqual({ ref: { ...REF, number: 101 }, action: "update-branch" });
	});

	test("Merge stack is absent from a middle layer and present from the top one", async () => {
		const middle = await mountStackLayer(101, { merge: true, stackRebase: false });
		// The stack itself is on screen and the plain merge is offered, so the
		// rest of the gate is satisfied — only the open layer above suppressed it.
		expect(middle.dom.text()).toContain("Stack · 3 layers on main");
		expect(byText(middle.dom.find("button"), "Merge")).toHaveLength(1);
		expect(byText(middle.dom.find("button"), "Merge stack")).toHaveLength(0);

		const top = await mountStackLayer(102, { merge: true, stackRebase: false });
		expect(byText(top.dom.find("button"), "Merge stack")).toHaveLength(1);
	});
});
