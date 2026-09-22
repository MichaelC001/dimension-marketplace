// The restyled review LIST row (dimension#896). One review reads as ONE card
// block: a fixed state-glyph box in the gutter, `#N · state` beside it, the
// title truncated to a single line beneath it.
//
// WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the list is the surface a
// person scans review after review. If the row stops being a card
// (`data-variant`), the reviews stop reading as blocks and the list dissolves
// into loose text. If the octicon moves back INSIDE the number pill, the pill
// grows an icon-sized notch and the gutter's fixed x — the whole point of the
// restyle — is gone while the pill still LOOKS roughly right. If the title
// wraps to two lines (`line-clamp-2`), rows stop aligning on their branch
// line and a long title shoves every row's height around.
//
// Seam: the rendered DOM of the row component itself — `ReviewRow` is pure
// (props in, tree out), so no store is mounted. The list GROUPS (the two
// `gap-2` columns in `pr-viewer.tsx`) are proven on a live `PrViewer` mount,
// because a structural grep of the source would pass while the wrapper is
// deleted; a row's parent element is the cheapest seam that reddens.
import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { HostStoreProvider, REVIEW_PILL_LABEL, REVIEW_PILL_TINT, registerStandardFact } from "@fraym/ui";
import type { ReviewRef, ReviewSummary, SessionReviewLink } from "../src/model";
import { PrViewer } from "../src/pr-viewer";
import { ReviewRow } from "../src/review-row";
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

/** A link with no sync yet: the row must still draw, naming itself honestly. */
function linkOf(number: number): SessionReviewLink {
	return {
		ref: { ...REF, number },
		url: `https://example.test/acme/widgets/pull/${number}`,
		source: "created",
		snapshot: null,
		stack: null,
	};
}

type RowProps = Parameters<typeof ReviewRow>[0];

function rowProps(overrides: Partial<RowProps> = {}): RowProps {
	return {
		summary: summaryOf(),
		link: undefined,
		depth: 0,
		stack: null,
		sharedBase: "main",
		sharedOwner: null,
		onSelect: () => {},
		menu: null,
		...overrides,
	};
}

// ── mount ───────────────────────────────────────────────────────────────────

const roots: Root[] = [];
const factHandles: (() => void)[] = [];

/** A live mount: render, query. `ReviewRow` is pure, so `flushSync` is the
 *  whole story; `PrViewer`'s hooks subscribe to plain observables, no timers.
 *  Globals are assigned per mount and deliberately NOT restored — the kit's
 *  own suites reassign `globalThis.window` per suite (`test-globals.ts`
 *  delegates off whichever window is current), so restoring `undefined` here
 *  would cut React's queued scheduler tick off mid-flight instead. */
function render(node: ReactNode): Document {
	const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Event: window.Event,
	});
	const container = window.document.getElementById("root") as HTMLElement;
	const root = createRoot(container);
	roots.push(root);
	flushSync(() => root.render(node));
	return window.document;
}

afterEach(() => {
	for (const root of roots.splice(0)) flushSync(() => root.unmount());
	for (const unregister of factHandles.splice(0)) unregister();
});
// ── row queries ─────────────────────────────────────────────────────────────

function chainRow(doc: Document): HTMLElement {
	const found = doc.querySelector('[data-slot="chain-row"]');
	if (!found) throw new Error("ReviewRow rendered no [data-slot=\"chain-row\"]");
	return found as HTMLElement;
}

/** The fixed state-glyph box: exactly ONE `size-5` box per row, carrying the
 *  octicon. Two would mean the glyph is drawn twice; zero, that the gutter
 *  lost its status column. */
function glyphBox(row: HTMLElement): HTMLElement {
	const boxes = [...row.querySelectorAll("*")].filter(el => (el.getAttribute("class") ?? "").split(/\s+/).includes("size-5"));
	if (boxes.length !== 1) throw new Error(`expected one state-glyph box (size-5), found ${boxes.length}`);
	return boxes[0] as HTMLElement;
}

/** The pill whose text leads with the review's number. */
function numberPill(row: HTMLElement): HTMLElement {
	const pill = [...row.querySelectorAll('[data-slot="pill"]')].find(el => /^#\d+/.test(el.textContent ?? ""));
	if (!pill) throw new Error("ReviewRow rendered no number pill");
	return pill as HTMLElement;
}

/** The title line: the row's ONE `truncate` span that is also semibold. The
 *  branch pill truncates too, so the classes must pair up. */
function titleSpan(row: HTMLElement): HTMLElement {
	const span = [...row.querySelectorAll("span")]
		.filter(el => (el.getAttribute("class") ?? "").split(/\s+/).includes("truncate"))
		.find(el => (el.getAttribute("class") ?? "").split(/\s+/).includes("font-semibold"));
	if (!span) throw new Error("ReviewRow rendered no truncated title span");
	return span as HTMLElement;
}

// ── the row is one card ─────────────────────────────────────────────────────

describe("ReviewRow is one card row", () => {
	test("an open review renders a card row whose number pill is bare of any glyph", () => {
		const doc = render(<ReviewRow {...rowProps()} />);
		const row = chainRow(doc);

		expect(row.getAttribute("data-variant")).toBe("card");

		// The state glyph lives in the gutter box, NOT in the number pill: a
		// duplicated octicon is exactly the pre-restyle regression this pins.
		const glyph = glyphBox(row);
		expect(glyph.querySelector("svg")).not.toBeNull();
		const pill = numberPill(row);
		expect(pill.textContent).toMatch(/^#101/);
		expect(pill.textContent).toContain(REVIEW_PILL_LABEL.open);
		expect(pill.querySelector("svg")).toBeNull();
	});

	test("a merged review tints the gutter glyph with the state's own tint", () => {
		const doc = render(<ReviewRow {...rowProps({ summary: summaryOf({ state: "merged" }) })} />);
		const row = chainRow(doc);

		// Read off the ONE tint table the rail's pills read, not a literal: if
		// this row grew a second table, the same review could be green on the
		// rail and dark here.
		const glyph = glyphBox(row);
		expect(glyph.getAttribute("class")).toContain(REVIEW_PILL_TINT.merged);
		expect(numberPill(row).textContent).toContain(REVIEW_PILL_LABEL.merged);
	});
});

// ── the title is one truncated line ─────────────────────────────────────────

describe("ReviewRow's title truncates to one line", () => {
	test("it carries `truncate`, never `line-clamp-2`, and the full title as tooltip", () => {
		const doc = render(<ReviewRow {...rowProps()} />);
		const title = titleSpan(chainRow(doc));

		const classes = title.getAttribute("class") ?? "";
		expect(classes).toContain("truncate");
		expect(classes).not.toContain("line-clamp-2");
		expect(title.getAttribute("title")).toBe("Teach the rail to name a stack");
		expect(title.textContent).toBe("Teach the rail to name a stack");
	});

	test("a link with no summary yet says so, and shows the URL as its line", () => {
		const link = linkOf(202);
		const doc = render(<ReviewRow {...rowProps({ summary: null, link })} />);
		const row = chainRow(doc);

		expect(numberPill(row).textContent).toContain("Not synced yet");
		const title = titleSpan(row);
		expect(title.getAttribute("title")).toBe(link.url);
		expect(title.textContent).toBe(link.url);
	});
});

// ── the row selects ─────────────────────────────────────────────────────────

describe("ReviewRow's gesture", () => {
	test("clicking the row selects its review", () => {
		let selected = 0;
		const doc = render(<ReviewRow {...rowProps({ onSelect: () => (selected += 1) })} />);

		const button = [...doc.querySelectorAll("button")].find(el => (el.textContent ?? "").includes("#101"));
		if (!button) throw new Error("ReviewRow rendered no select button");
		button.dispatchEvent(new Event("click", { bubbles: true }));
		expect(selected).toBe(1);
	});
});

// ── the list groups the rows into one spaced column ─────────────────────────
//
// Both groups of `pr-viewer.tsx` — the session's linked reviews and the
// checkout's other reviews — wrap their rows in ONE `gap-2` flex column. The
// assertion is the row's own parent: a deleted (or de-spaced) wrapper drops
// the class off the element the row actually lands in, which a grep of the
// source could never catch.

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

function expectSpacedColumn(row: Element): void {
	const parent = row.parentElement;
	if (!parent) throw new Error("a chain row rendered with no parent");
	const classes = parent.getAttribute("class") ?? "";
	expect(classes).toContain("flex-col");
	expect(classes).toContain("gap-2");
}

describe("PrViewer's list groups", () => {
	test("the checkout's reviews sit in one gap-2 column", () => {
		const cell = `workspace/${WORKSPACE.workspaceId}/reviews`;
		const doc = render(
			<PrViewer
				sessionId={null}
				workspace={WORKSPACE}
				workspaceDriver={null}
				store={fakeStore({ [cell]: [summaryOf(), summaryOf({ ref: { ...REF, number: 102 } })] })}
			/>,
		);

		const rows = [...doc.querySelectorAll('[data-slot="chain-row"]')];
		if (rows.length !== 2) throw new Error(`expected the checkout's two reviews as rows, found ${rows.length}`);
		for (const row of rows) expectSpacedColumn(row);
	});

	test("the session's linked reviews sit in one gap-2 column", () => {
		// The session's links arrive as an ambient standard fact (channel 3):
		// register the binding the host would, under the mount's own store.
		factHandles.push(
			registerStandardFact({ name: "reviews", scope: "session", key: id => `session/${id}/reviews` }),
		);
		const store = fakeStore({ "session/s-1/reviews": [linkOf(103)] });
		const doc = render(
			<HostStoreProvider store={store}>
				<PrViewer sessionId="s-1" workspace={WORKSPACE} workspaceDriver={null} store={store} />
			</HostStoreProvider>,
		);

		const rows = [...doc.querySelectorAll('[data-slot="chain-row"]')];
		if (rows.length !== 1) throw new Error(`expected the session's one linked review as a row, found ${rows.length}`);
		for (const row of rows) expectSpacedColumn(row);
	});
});
