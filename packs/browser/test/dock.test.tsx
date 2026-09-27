/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser dock panel tells a
 *  person they are signed in where they are not (or names the wrong account),
 *  or its Sign in opens the live Browser View on the wrong profile or the
 *  wrong site, or fires with no session to open it in, or starts a sign-in on
 *  a profile name the server will refuse.
 *
 *  The panel's data is this pack's own connection report, so every fixture is
 *  built by the server's own `buildConnectionReport` (connection.ts): the two
 *  shapes cannot drift. The component is mounted live on a linkedom document
 *  (the marketplace's pack convention: `react`, `react-dom` and `linkedom` come
 *  from the Dimension monorepo the pack is mounted into) against a fake host
 *  Store that serves one fact and records every intent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { buildConnectionReport, type ConnectionObservations } from "../src/connection";
import { BrowserAccounts, type BrowserStoreShape } from "../src/dock/browser-accounts";
import { CONNECTION_KEY, observedAgo, profileRows } from "../src/dock/report";

const T = 1_790_000_000_000;

/** Two profiles, a signed-out site, an account-less site, a site the panel has no login page for, and the human's own Chrome. */
const OBSERVED: ConnectionObservations = {
	work: {
		"x.com": { signedIn: true, account: "@acme", observedAt: T },
		"linkedin.com": { signedIn: false, observedAt: T - 60_000 },
	},
	alt: {
		"reddit.com": { signedIn: true, observedAt: T - 1 },
		"example.org": { signedIn: false, observedAt: T - 2 },
	},
	relay: { "x.com": { signedIn: true, account: "@me", observedAt: T } },
};

/** The host's `PluginConnectionFact` as it would publish this pack's report. */
const FACT = { connected: true, reported: buildConnectionReport(OBSERVED) };

// ---------------------------------------------------------------------------
// The report, as the panel reads it
// ---------------------------------------------------------------------------

describe("profileRows", () => {
	test("a real connection report becomes profiles → sites with signedIn, account and observedAt, both sorted by name", () => {
		expect(profileRows(FACT)).toEqual([
			{
				name: "alt",
				sites: [
					{ host: "example.org", signedIn: false, observedAt: T - 2 },
					{ host: "reddit.com", signedIn: true, observedAt: T - 1 },
				],
			},
			{
				name: "work",
				sites: [
					{ host: "linkedin.com", signedIn: false, observedAt: T - 60_000 },
					{ host: "x.com", signedIn: true, account: "@acme", observedAt: T },
				],
			},
		]);
	});

	test("no fact, a fact without a report, and a report with no profiles are all the empty state", () => {
		expect(profileRows(undefined)).toEqual([]);
		expect(profileRows({})).toEqual([]);
		expect(profileRows({ reported: buildConnectionReport({}) })).toEqual([]);
	});

	test("a malformed profile or site in the fact is skipped, never rendered or thrown on; its well-formed neighbours survive", () => {
		const reported = buildConnectionReport(OBSERVED);
		const damaged = {
			reported: {
				profiles: {
					...reported.profiles,
					work: { sites: { ...reported.profiles.work?.sites, "bsky.app": { signedIn: "yes", observedAt: T }, "reddit.com": { signedIn: true, observedAt: "now" } } },
					broken: { sites: null },
					listed: { sites: [{ signedIn: true, observedAt: T }] },
				},
			},
		};
		expect(profileRows(damaged)).toEqual(profileRows(FACT));
		expect(profileRows({ reported: { profiles: [] } })).toEqual([]);
		expect(profileRows("connected")).toEqual([]);
	});
});

describe("observedAgo", () => {
	const cases: ReadonlyArray<{ readonly name: string; readonly ageMs: number; readonly text: string }> = [
		{ name: "a clock a little behind the observation", ageMs: -5_000, text: "just now" },
		{ name: "under a minute", ageMs: 59_000, text: "just now" },
		{ name: "one minute", ageMs: 60_000, text: "1m ago" },
		{ name: "59 minutes", ageMs: 59 * 60_000, text: "59m ago" },
		{ name: "one hour", ageMs: 60 * 60_000, text: "1h ago" },
		{ name: "23 hours", ageMs: 23 * 3_600_000, text: "23h ago" },
		{ name: "one day", ageMs: 24 * 3_600_000, text: "1d ago" },
		{ name: "ten days", ageMs: 240 * 3_600_000, text: "10d ago" },
	];
	for (const { name, ageMs, text } of cases) {
		test(`${name} reads "${text}"`, () => {
			expect(observedAgo(T, T + ageMs)).toBe(text);
		});
	}
});

// ---------------------------------------------------------------------------
// The panel, mounted
// ---------------------------------------------------------------------------

const DOM_GLOBALS = ["window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof DOM_GLOBALS)[number];
let priorDomGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
const roots: Root[] = [];

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

interface Act {
	readonly intent: string;
	readonly payload: unknown;
}

/** A host Store serving `fact` under this pack's connection key only, logging every intent. */
function fakeStore(fact: unknown): { readonly store: BrowserStoreShape; readonly acts: readonly Act[] } {
	const acts: Act[] = [];
	const store: BrowserStoreShape = {
		watch<T>(key: string) {
			return { getSnapshot: () => (key === CONNECTION_KEY ? (fact as T) : undefined), subscribe: () => () => {} };
		},
		act(intent: string, payload?: unknown) {
			acts.push({ intent, payload });
		},
	};
	return { store, acts };
}

interface Panel {
	/** The site line for `label` under profile `profile`. */
	readonly siteLine: (profile: string, label: string) => Element;
	readonly click: (element: Element) => Promise<void>;
	readonly type: (input: Element, value: string) => Promise<void>;
	readonly submit: (form: Element) => Promise<void>;
	readonly find: (selector: string) => Element[];
	readonly text: () => string;
}

async function mountPanel(sessionId: string | null, store: BrowserStoreShape): Promise<Panel> {
	const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
	priorDomGlobals ??= Object.fromEntries(DOM_GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as Record<
		DomGlobal,
		PropertyDescriptor | undefined
	>;
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
	await act(async () => root.render(<BrowserAccounts sessionId={sessionId} store={store} />));
	const find = (selector: string) => [...container.querySelectorAll(selector)];
	return {
		siteLine: (profile, label) => {
			const section = find('[data-slot="browser-accounts-profile"]').filter(el => el.querySelector("button")?.textContent === profile);
			const lines = section.flatMap(el => [...el.querySelectorAll('[data-slot="browser-accounts-site"]')]);
			const matches = lines.filter(line => line.querySelector("span span span")?.textContent === label);
			if (matches.length !== 1) throw new Error(`expected one ${label} line under ${profile}, found ${matches.length}`);
			return matches[0] as Element;
		},
		// React 19 delegates events at the root container, so a bubbling native event reaches the handler.
		click: async element => {
			await act(async () => {
				element.dispatchEvent(new window.Event("click", { bubbles: true }));
			});
		},
		// The kit's own typing path (fraym/packages/ui/test/plugins-page.create.test.tsx): react-dom
		// loaded without a DOM, so it picked its IE-era value-change polyfill, which arms on
		// `focusin` through `attachEvent` (no-ops here: linkedom has none) and notices a new value on
		// `keyup`. The value goes through the PROTOTYPE setter so React's node-level tracker is left
		// stale and reads it as changed. linkedom reports a type-less <input>'s `type` as null where a
		// browser says "text", and only a text input takes that path — so say it here.
		type: async (input, value) => {
			if (!input.hasAttribute("type")) input.setAttribute("type", "text");
			Object.assign(input, { attachEvent: () => {}, detachEvent: () => {} });
			const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
			if (!setter) throw new Error("input prototype exposes no value setter");
			await act(async () => {
				input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
			});
			setter.call(input, value);
			await act(async () => {
				input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
			});
			// Leaving the field armed hands a later test a dangling node in react-dom's module state.
			await act(async () => {
				input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
			});
		},
		submit: async form => {
			await act(async () => {
				form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
			});
		},
		find,
		text: () => container.textContent ?? "",
	};
}

const signInButton = (line: Element): Element => {
	const button = [...line.querySelectorAll("button")].find(el => el.textContent?.trim() === "Sign in");
	if (!button) throw new Error("no Sign in button on the line");
	return button;
};

const openView = (profile: string, url: string): Act => ({ intent: "openArtifactoryView", payload: { tool: "browser_open", args: { profile, url } } });

describe("the Browser panel", () => {
	test("each site line shows its report state, and its Sign in opens the live View on that profile at that site's login page", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);

		const x = panel.siteLine("work", "X");
		expect(x.getAttribute("data-signed-in")).toBe("true");
		expect(x.textContent).toContain("Signed in");
		expect(x.textContent).toContain("@acme");
		const linkedin = panel.siteLine("work", "LinkedIn");
		expect(linkedin.getAttribute("data-signed-in")).toBe("false");
		expect(linkedin.textContent).toContain("Signed out");
		// The human's own Chrome is never a profile here.
		expect(panel.text()).not.toContain("relay");

		await panel.click(signInButton(linkedin));
		await panel.click(signInButton(panel.siteLine("alt", "Reddit")));
		await panel.click(signInButton(panel.siteLine("alt", "example.org")));

		expect(acts).toEqual([
			openView("work", "https://www.linkedin.com/login"),
			openView("alt", "https://www.reddit.com/login"),
			// A site the panel has no login page for opens at the site itself.
			openView("alt", "https://example.org/"),
		]);
	});

	test("a New sign-in opens the View on the typed profile's slug at the chosen site's login page", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);
		const form = panel.find('[data-slot="browser-accounts-new"]')[0] as Element;
		const bluesky = [...form.querySelectorAll('[role="radio"]')].find(el => el.textContent === "Bluesky") as Element;

		await panel.click(bluesky);
		await panel.type(form.querySelector("input") as Element, "  Personal ");
		await panel.submit(form);

		expect(acts).toEqual([openView("personal", "https://bsky.app/")]);
	});

	test("a New sign-in on a name profileSlug refuses, or on the reserved relay, acts nothing and says why", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);
		const form = panel.find('[data-slot="browser-accounts-new"]')[0] as Element;
		const input = form.querySelector("input") as Element;

		await panel.type(input, "Bad Name!");
		await panel.submit(form);
		expect(acts).toEqual([]);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(form.textContent).toContain("Use 1–48 letters, digits, - or _");

		await panel.type(input, "relay");
		await panel.submit(form);
		expect(acts).toEqual([]);
		expect(form.textContent).toContain('"relay" is reserved');
	});

	test("with no session every Sign in is disabled and nothing is acted, even on a valid New sign-in submit", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel(null, store);
		const buttons = panel.find("button").filter(el => el.textContent?.trim() === "Sign in");

		// Four site lines plus the New sign-in submit.
		// Flags, not elements: a failing diff of linkedom nodes never finishes printing.
		expect(buttons.map(el => el.hasAttribute("disabled"))).toEqual([true, true, true, true, true]);
		for (const button of buttons) await panel.click(button);

		const form = panel.find('[data-slot="browser-accounts-new"]')[0] as Element;
		await panel.type(form.querySelector("input") as Element, "work");
		await panel.submit(form);

		expect(acts).toEqual([]);
		expect(panel.text()).toContain("Open a session to sign in");
	});
});
