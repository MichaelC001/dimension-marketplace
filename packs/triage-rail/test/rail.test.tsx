/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the strip shouts about nothing
 *  (or stays silent about a session parked on you), or Sweep archives rows the
 *  user never confirmed — it must hand the host EXACTLY the confirmed
 *  candidates, and on a host without the bulk verb it must not exist at all
 *  (a dead control is worse than no control).
 *
 *  Model rules live in `model.test.ts`; this file defends the WIRING between
 *  the fold and the three channels, which no pure test can see. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement, type ReactNode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

// ── The granted parts, replaced by stand-ins ─────────────────────────────────

const passthrough = ({ children }: { readonly children?: ReactNode }) => createElement("span", null, children);
mock.module("@fraym/ui", () => ({
	ActivityDot: ({ state }: { readonly state: string }) => createElement("i", { "data-dot": state }),
	Button: ({ children, onClick, ...rest }: { readonly children?: ReactNode; readonly onClick?: () => void }) =>
		createElement("button", { type: "button", onClick, ...rest }, children),
	Icon: () => null,
	IconButton: ({ children, onClick, ...rest }: { readonly children?: ReactNode; readonly onClick?: () => void }) =>
		createElement("button", { type: "button", onClick, ...rest }, children),
	Input: (props: Record<string, unknown>) => createElement("input", props),
	Tooltip: passthrough,
	TooltipContent: () => null,
	TooltipProvider: passthrough,
	TooltipTrigger: passthrough,
	useObservable: (source: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown }) =>
		useSyncExternalStore(source.subscribe, source.getSnapshot),
}));

const TriageRail = (await import("../src/index")).default;

// ── DOM harness ──────────────────────────────────────────────────────────────

const globalNames = ["window", "document", "navigator", "HTMLElement", "Element", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof globalNames)[number];
let originalGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
let container: HTMLElement;
const roots: Root[] = [];

beforeEach(() => {
	const { window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
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
});

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	for (const name of globalNames) {
		const descriptor = originalGlobals?.[name];
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals = undefined;
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ago: number) => new Date(Date.now() - ago).toISOString();

interface Row {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly time: string;
	readonly updatedAt: string;
	readonly sessionRef?: { readonly workspaceId: string; readonly sessionId: string };
}

function row(id: string, status: string, ago: number, addressable = true): Row {
	return {
		id,
		title: `title ${id}`,
		status,
		time: "·",
		updatedAt: iso(ago),
		sessionRef: addressable ? { workspaceId: "w", sessionId: id } : undefined,
	};
}

function facts(rows: readonly Row[]) {
	return {
		identity: { version: "0.0.0", productLabel: "Test", userName: "tester", planLabel: "dev" },
		mode: { app: "code", rail: "expanded", activeSurface: "session" },
		sessions: [{ repo: "app", branch: "main", dot: "", items: rows }],
		projectLabel: "Projects",
		search: { open: false, value: "" },
	};
}

function actionsWith(extra: Record<string, unknown> = {}) {
	const calls: Record<string, unknown[][]> = {};
	const spy = (name: string) => (...args: unknown[]) => {
		(calls[name] ??= []).push(args);
	};
	return {
		calls,
		actions: {
			toggleCompact: spy("toggleCompact"),
			intent: spy("intent"),
			setSearch: spy("setSearch"),
			setSearchOpen: spy("setSearchOpen"),
			openUserMenu: spy("openUserMenu"),
			sessionContextMenu: spy("sessionContextMenu"),
			selectSession: spy("selectSession"),
			...extra,
		},
	};
}

async function mount(rows: readonly Row[], actions: Record<string, unknown>) {
	const snapshot = facts(rows);
	const rail = { subscribe: () => () => {}, getSnapshot: () => snapshot };
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(createElement(TriageRail, { rail, actions, capabilities: {} })));
}

const click = async (el: Element | null | undefined) => {
	if (!el) throw new Error("nothing to click");
	await act(async () => {
		el.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
	});
};

const titles = (scope: string) =>
	[...container.querySelectorAll(`${scope} .tr-row-title`)].map(el => el.textContent);

// ── Contracts ────────────────────────────────────────────────────────────────

describe("the needs-you strip", () => {
	test("lists every needs-you row oldest wait first, and is absent when nothing needs you", async () => {
		const { actions } = actionsWith();
		await mount(
			[row("quiet", "idle", HOUR), row("recent", "failed", HOUR), row("old", "needs-you", 3 * HOUR)],
			actions,
		);
		expect(titles('[data-slot="triage-needs-you"]')).toEqual(["title old", "title recent"]);
		// A strip is a view: the rows still sit in their buckets (a needs-you row is live ⇒ Now).
		expect(titles('[data-bucket="now"]')).toEqual(["title old"]);
		expect(titles('[data-bucket="today"]')).toEqual(["title quiet", "title recent"]);
	});

	test("an unread row is emphasised and counts as needing you", async () => {
		const { actions } = actionsWith();
		await mount([{ ...row("mail", "idle", HOUR), unread: true }, row("seen", "idle", HOUR)], actions);
		expect(titles('[data-slot="triage-needs-you"]')).toEqual(["title mail"]);
		const emphasised = [...container.querySelectorAll(".tr-row[data-unread] .tr-row-title")].map(el => el.textContent);
		expect(emphasised).toEqual(["title mail", "title mail"]);
	});

	test("is not rendered at all when nothing needs you", async () => {
		const { actions } = actionsWith();
		await mount([row("quiet", "idle", HOUR)], actions);
		expect(container.querySelector('[data-slot="triage-needs-you"]')).toBeNull();
	});
});

describe("Sweep", () => {
	const stale = [row("a", "idle", 9 * DAY), row("b", "attached", 30 * DAY), row("keep", "idle", 8 * DAY, false)];
	const sweepButton = () =>
		[...container.querySelectorAll('[data-bucket="earlier"] button')].find(b => b.textContent?.includes("Sweep"));
	const confirmButton = () =>
		[...container.querySelectorAll(".tr-sweep-card button")].find(b => /^Archive/.test(b.textContent ?? ""));

	test("with the bulk verb: nothing is archived until confirmed, then exactly the candidates go to the host", async () => {
		const { actions, calls } = actionsWith({ archiveSessions: (...args: unknown[]) => (calls.archiveSessions ??= []).push(args) });
		await mount(stale, actions);
		expect(sweepButton()?.textContent).toContain("Sweep · 2");
		await click(sweepButton());
		expect(calls.archiveSessions).toBeUndefined();
		await click(confirmButton());
		expect(calls.archiveSessions).toHaveLength(1);
		expect((calls.archiveSessions?.[0]?.[0] as readonly Row[]).map(r => r.id)).toEqual(["a", "b"]);
		expect(calls.sessionContextMenu).toBeUndefined();
	});

	test("without the bulk verb the affordance is hidden, even with candidates", async () => {
		const { actions } = actionsWith();
		await mount(stale, actions);
		expect(sweepButton()).toBeUndefined();
		expect(container.querySelector(".tr-sweep-card")).toBeNull();
	});

	test("is hidden when no row is old enough", async () => {
		const { actions } = actionsWith({ archiveSessions: () => {} });
		await mount([row("fresh", "idle", 2 * DAY)], actions);
		expect(sweepButton()).toBeUndefined();
	});
});
