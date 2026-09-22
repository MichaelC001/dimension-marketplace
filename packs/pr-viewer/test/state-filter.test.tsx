// The list's state filter (dimension#909): the chip bar above the list, and
// the pure predicate the chips and the rows share.
//
// WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a filter is how a person reads
// a busy list — GitHub's Open/Closed filters are the direction. If the counts
// were wrong (e.g. derived from the FILTERED list instead of the total), the
// chip would understate what it can reveal and hide rows the list would show.
// If `conflicting` did not fold into `open`, a conflicted review — the state a
// person filters FOR — would vanish under the one chip they reach for. If the
// unsynced link did not count as open, a not-yet-synced link would disappear
// from every state view while still drawing as an open row at `all`. If the
// empty copy went missing, a narrowed view with no matches would read as a
// broken blank panel.
//
// Seam: the predicate is tested directly (it is exported, pure, and the chips'
// counts and the rows' survival both go through it); the chip bar and the
// narrowing are tested on a LIVE `PrViewer` mount with mixed states across
// BOTH groups — a structural grep of the source could never catch a chip bar
// that renders but does not narrow. `isDraft` / `mergeability` fixtures are
// mapped through the REAL `reviewPillState` (reached via the predicate), so
// the tests never restate the fold table.
import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { HostStoreProvider, REVIEW_PILL_TINT, registerStandardFact } from "@fraym/ui";
import type { ReviewRef, ReviewSummary, SessionReviewLink } from "../src/model";
import { PrViewer, reviewMatchesFilter, type ReviewStateFilter } from "../src/pr-viewer";
import type { HostStoreShape, WorkspaceRefShape } from "../src/shapes";

// ── fixtures ────────────────────────────────────────────────────────────────

const REF: ReviewRef = { provider: "github", host: "example.test", repository: "acme/widgets", number: 101 };
const WORKSPACE: WorkspaceRefShape = { workspaceId: "ws-1", path: "/checkout/widgets" };

function summaryOf(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
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
		capabilities: { merge: false, draft: false, stackActions: false },
		...overrides,
	};
}

/** A session link, optionally carrying its own synced snapshot. `snapshot:
 *  null` with no matching checkout row is the unsynced case. */
function linkOf(number: number, snapshot: ReviewSummary | null): SessionReviewLink {
	return {
		ref: { ...REF, number },
		url: `https://example.test/acme/widgets/pull/${number}`,
		source: "created",
		snapshot: snapshot ? { ...snapshot, syncedAt: "2026-09-18T09:00:00.000Z" } : null,
		stack: null,
	};
}

// The predicate's input set: every state a summary can present, all mapped
// through the REAL `reviewPillState` inside `reviewMatchesFilter`. `unsynced`
// is the null link — the row's own open fallback.
const FIXTURES: Readonly<Record<string, ReviewSummary | null>> = {
	open: summaryOf(),
	conflicting: summaryOf({ mergeability: "conflicting" }),
	draft: summaryOf({ isDraft: true }),
	merged: summaryOf({ state: "merged" }),
	closed: summaryOf({ state: "closed" }),
	unsynced: null,
};

// Each filter's surviving set — the contract, one row per state.
const PASSES: Readonly<Record<ReviewStateFilter, readonly string[]>> = {
	all: ["open", "conflicting", "draft", "merged", "closed", "unsynced"],
	open: ["open", "conflicting", "unsynced"],
	draft: ["draft"],
	merged: ["merged"],
	closed: ["closed"],
};

// ── mount ───────────────────────────────────────────────────────────────────

const roots: Root[] = [];
const factHandles: (() => void)[] = [];

/** A live mount: render, query — the same seam as `review-row.test.tsx`.
 *  `PrViewer`'s hooks subscribe to plain observables, no timers. Globals are
 *  assigned per mount and deliberately NOT restored (see that file's note:
 *  the kit's own suites reassign `globalThis.window` per suite). The gesture
 *  helpers below wrap their updates in `act`, so the initial render does too. */
async function render(node: ReactNode): Promise<Document> {
	const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const container = window.document.getElementById("root") as HTMLElement;
	const root = createRoot(container);
	roots.push(root);
	await act(async () => flushSync(() => root.render(node)));
	return window.document;
}

/** A host store by key: one snapshot per cell, never moving. `read` IS
 *  `watch().getSnapshot()` (the driver's own identity), so the provider seat
 *  and the prop-drilled store can never disagree. */
function fakeStore(cells: Readonly<Record<string, unknown>>): HostStoreShape & { read<T>(key: string): T | undefined } {
	return {
		read<T>(key: string) {
			return cells[key] as T | undefined;
		},
		watch<T>(key: string) {
			return { getSnapshot: () => cells[key] as T | undefined, subscribe: () => () => {} };
		},
		act() {},
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	for (const unregister of factHandles.splice(0)) unregister();
});

// ── chip queries ────────────────────────────────────────────────────────────

/** The filter bar: the mount's ONE `role="group"`. */
function filterGroup(doc: Document): HTMLElement {
	const group = doc.querySelector('[role="group"]');
	if (!group) throw new Error("PrViewer rendered no filter group");
	if (group.getAttribute("aria-label") !== "Filter reviews by state") throw new Error("filter group lost its aria-label");
	return group as HTMLElement;
}

function chips(group: HTMLElement): readonly HTMLElement[] {
	return [...group.querySelectorAll("button")] as HTMLElement[];
}

/** The chip whose text starts with the filter's label. */
function chip(group: HTMLElement, label: string): HTMLElement {
	const found = chips(group).find(el => (el.textContent ?? "").trim().startsWith(label));
	if (!found) throw new Error(`no "${label}" chip`);
	return found;
}

/** The list's visible rows. */
function rows(doc: Document): readonly HTMLElement[] {
	return [...doc.querySelectorAll('[data-slot="chain-row"]')] as HTMLElement[];
}

/** A live mixed checkout: the session has an OPEN link (#11) and a MERGED one
 *  (#12) by snapshot, plus one link still UNSYNCED (#13, no snapshot and no
 *  checkout row); the checkout adds CLOSED #21, DRAFT #22, MERGED #23 and a
 *  CONFLICTING #24 (`state: "open"`, `mergeability: "conflicting"` — mapped
 *  through the real `reviewPillState`). Counts: all 7, open 3 (open +
 *  conflicting + unsynced), draft 1, merged 2, closed 1. */
async function mountMixed(): Promise<Document> {
	factHandles.push(
		registerStandardFact({ name: "reviews", scope: "session", key: id => `session/${id}/reviews` }),
	);
	const store = fakeStore({
		"session/s-1/reviews": [
			linkOf(11, summaryOf({ ref: { ...REF, number: 11 } })),
			linkOf(12, summaryOf({ ref: { ...REF, number: 12 }, state: "merged" })),
			linkOf(13, null),
		],
		"workspace/ws-1/reviews": [
			summaryOf({ ref: { ...REF, number: 21 }, state: "closed" }),
			summaryOf({ ref: { ...REF, number: 22 }, isDraft: true }),
			summaryOf({ ref: { ...REF, number: 23 }, state: "merged" }),
			summaryOf({ ref: { ...REF, number: 24 }, mergeability: "conflicting" }),
		],
	});
	return render(
		<HostStoreProvider store={store}>
			<PrViewer sessionId="s-1" workspace={WORKSPACE} workspaceDriver={null} store={store} />
		</HostStoreProvider>,
	);
}

// ── the predicate ───────────────────────────────────────────────────────────

describe("reviewMatchesFilter", () => {
	test("each filter passes exactly the states that read as that state", () => {
		for (const filter of Object.keys(PASSES) as readonly ReviewStateFilter[]) {
			for (const [name, summary] of Object.entries(FIXTURES)) {
				expect(reviewMatchesFilter(summary, filter), `${filter} × ${name}`).toBe(PASSES[filter]!.includes(name));
			}
		}
	});
});

// ── the chip bar ────────────────────────────────────────────────────────────

describe("PrViewer's state filter chips", () => {
	test("the bar renders one chip per state, each carrying its in-memory count", async () => {
		const doc = await mountMixed();
		const group = filterGroup(doc);

		const labels = chips(group).map(el => (el.textContent ?? "").replace(/\s+/g, " ").trim());
		expect(labels).toEqual(["All 7", "Open 3", "Draft 1", "Merged 2", "Closed 1"]);
	});

	test("the active chip marks itself with aria-pressed and data-active; All is semibold at rest", async () => {
		const doc = await mountMixed();
		const group = filterGroup(doc);

		const all = chip(group, "All");
		expect(all.getAttribute("aria-pressed")).toBe("true");
		expect(all.getAttribute("data-active")).toBe("true");
		expect(all.getAttribute("class")).toContain("font-semibold");
		for (const rest of chips(group).filter(el => el !== all)) {
			expect(rest.getAttribute("aria-pressed")).toBe("false");
			expect(rest.getAttribute("class")).not.toContain("font-semibold");
		}
	});

	test("clicking Merged narrows BOTH groups in place, keeps the headings, and tints only the active chip", async () => {
		const doc = await mountMixed();
		const group = filterGroup(doc);

		await act(async () => chip(group, "Merged").dispatchEvent(new Event("click", { bubbles: true })));

		const visible = rows(doc);
		expect(visible).toHaveLength(2);
		const text = visible.map(row => row.textContent ?? "").join(" ");
		expect(text).toContain("#12"); // the session's merged link
		expect(text).toContain("#23"); // the checkout's merged review
		expect(text).not.toContain("#11"); // open
		expect(text).not.toContain("#13"); // unsynced
		expect(text).not.toContain("#21"); // closed
		expect(text).not.toContain("#22"); // draft
		expect(text).not.toContain("#24"); // conflicting

		// The groups still apply WITHIN the filtered view: both headings persist.
		expect(doc.body.textContent).toContain("Linked to this session");
		expect(doc.body.textContent).toContain("Also in this checkout");

		// The active chip wears its state's tint and marks itself; the rest stay
		// plain and All drops its semibold neutral mark.
		const merged = chip(group, "Merged");
		expect(merged.getAttribute("aria-pressed")).toBe("true");
		expect(merged.getAttribute("data-active")).toBe("true");
		expect(merged.getAttribute("class")).toContain(REVIEW_PILL_TINT.merged);
		for (const rest of chips(group).filter(el => el !== merged)) {
			expect(rest.getAttribute("data-active")).toBe("false");
			expect(rest.getAttribute("class")).not.toContain(REVIEW_PILL_TINT.merged);
		}
		expect(chip(group, "All").getAttribute("class")).not.toContain("font-semibold");

		// The counts stay TOTAL: the chips describe the whole list, not the
		// narrowed view — the one lie that would make "Open 3" useless.
		const labels = chips(group).map(el => (el.textContent ?? "").replace(/\s+/g, " ").trim());
		expect(labels).toEqual(["All 7", "Open 3", "Draft 1", "Merged 2", "Closed 1"]);
	});

	test("clicking Open keeps the conflicting review and the unsynced link in view", async () => {
		const doc = await mountMixed();
		const group = filterGroup(doc);

		await act(async () => chip(group, "Open").dispatchEvent(new Event("click", { bubbles: true })));

		const visible = rows(doc);
		expect(visible).toHaveLength(3);
		const text = visible.map(row => row.textContent ?? "").join(" ");
		expect(text).toContain("#11"); // open
		expect(text).toContain("#13"); // unsynced — the row's own open fallback
		expect(text).toContain("#24"); // conflicting — refines open
		expect(text).not.toContain("#12");
		expect(text).not.toContain("#21");
		expect(text).not.toContain("#22");
		expect(text).not.toContain("#23");
		expect(doc.body.textContent).toContain("Linked to this session");
		expect(doc.body.textContent).toContain("Also in this checkout");
	});

	test("a filter with no matches says so instead of blanking the panel", async () => {
		const doc = await render(
			<PrViewer
				sessionId={null}
				workspace={WORKSPACE}
				workspaceDriver={null}
				store={fakeStore({ "workspace/ws-1/reviews": [summaryOf({ ref: { ...REF, number: 31 } })] })}
			/>,
		);

		const group = filterGroup(doc);
		await act(async () => chip(group, "Closed").dispatchEvent(new Event("click", { bubbles: true })));

		expect(rows(doc)).toHaveLength(0);
		const empty = doc.querySelectorAll('[data-slot="pr-viewer-filter-empty"]');
		expect(empty).toHaveLength(1);
		expect((empty[0] as HTMLElement).getAttribute("data-filter")).toBe("closed");
		expect((empty[0] as HTMLElement).textContent).toContain("No closed reviews in this checkout");
	});
});
