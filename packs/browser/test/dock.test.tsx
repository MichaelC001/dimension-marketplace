/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser dock tab's "Open a
 *  page" bar opens a browser that forgets the person's logins (or, when they
 *  asked for Private, one that saves them), opens on an address the browser
 *  cannot load, or fires with no session to open it in. The tab offers nothing
 *  else: the Browser's own profile menu owns profiles and sign-ins.
 *
 *  The component is mounted live on a linkedom document (`dom-harness.ts`)
 *  against a fake host Store that records every intent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { BrowserAccounts, type BrowserStoreShape, CONNECTION_KEY } from "../src/dock/browser-accounts";
import { mount, unmountAll } from "./dom-harness";

afterEach(unmountAll);

interface Act {
	readonly intent: string;
	readonly payload: unknown;
}

type Reported = Record<string, { readonly label: string }>;

function fakeStore(profiles: Reported = {}): { readonly store: BrowserStoreShape; readonly acts: readonly Act[]; readonly report: (next: Reported) => void } {
	const acts: Act[] = [];
	const listeners = new Set<() => void>();
	let fact: unknown = { connected: true, reported: { profiles: Object.fromEntries(Object.entries(profiles).map(([name, meta]) => [name, { sites: {}, colour: "blue", ...meta }])) } };
	const store: BrowserStoreShape = {
		act(intent: string, payload?: unknown) {
			acts.push({ intent, payload });
		},
		watch(key: string) {
			return {
				getSnapshot: () => (key === CONNECTION_KEY ? fact : undefined),
				subscribe: (listener: () => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
		},
	};
	const report = (next: Reported): void => {
		fact = { connected: true, reported: { profiles: Object.fromEntries(Object.entries(next).map(([name, meta]) => [name, { sites: {}, colour: "blue", ...meta }])) } };
		for (const listener of listeners) listener();
	};
	return { store, acts, report };
}

async function mountPanel(sessionId: string | null, store: BrowserStoreShape) {
	const dom = await mount(<BrowserAccounts sessionId={sessionId} store={store} />);
	return {
		...dom,
		openForm: () => {
			const form = dom.find('[data-slot="browser-accounts-open"]')[0] as Element;
			const profile = form.querySelector('[data-slot="select"]') as Element;
			return {
				form,
				address: form.querySelector('[data-slot="input"]') as Element,
				profile,
				choices: () => [...profile.querySelectorAll("option")].map(option => ({ value: option.getAttribute("value"), label: option.textContent })),
				problem: () => form.querySelector('[data-slot="browser-accounts-problem"]')?.textContent ?? null,
			};
		},
	};
}

const openBrowser = (args: Record<string, string>): Act => ({ intent: "openArtifactoryView", payload: { tool: "browser_view", args } });

describe("the Browser dock tab's Open a page bar", () => {
	test("a typed address opens the live browser on the person's saved logins, the address made loadable", async () => {
		const { store, acts } = fakeStore();
		const panel = await mountPanel("session-1", store);
		const open = panel.openForm();

		await panel.type(open.address, "  example.com/docs ");
		await panel.submit(open.form);

		expect(acts).toEqual([openBrowser({ url: "https://example.com/docs", profile: "default" })]);
	});

	test("Private opens with no profile at all, so nothing is saved", async () => {
		const { store, acts } = fakeStore();
		const panel = await mountPanel("session-1", store);
		const open = panel.openForm();

		await panel.choose(open.profile, "");
		await panel.type(open.address, "example.com");
		await panel.submit(open.form);

		expect(acts).toStrictEqual([openBrowser({ url: "https://example.com/" })]);
	});

	test("every saved profile the Browser reports is offered by its label, and the page opens in the one chosen", async () => {
		const { store, acts } = fakeStore({ default: { label: "Default" }, "traction-x-acme": { label: "Acme on X" } });
		const panel = await mountPanel("session-1", store);
		const open = panel.openForm();

		expect(open.choices()).toEqual([
			{ value: "default", label: "Default" },
			{ value: "traction-x-acme", label: "Acme on X" },
			{ value: "", label: "Private — nothing is saved" },
		]);
		await panel.choose(open.profile, "traction-x-acme");
		await panel.type(open.address, "x.com/i/flow/login");
		await panel.submit(open.form);

		expect(acts).toEqual([openBrowser({ url: "https://x.com/i/flow/login", profile: "traction-x-acme" })]);
	});

	test("the saved logins are offered before the Browser has reported any profile, and a profile it reports later appears without reopening the tab", async () => {
		const { store, report } = fakeStore();
		const panel = await mountPanel("session-1", store);

		expect(panel.openForm().choices()).toEqual([
			{ value: "default", label: "default" },
			{ value: "", label: "Private — nothing is saved" },
		]);
		await panel.act(() => report({ work: { label: "Work" } }));

		expect(panel.openForm().choices()).toEqual([
			{ value: "default", label: "default" },
			{ value: "work", label: "Work" },
			{ value: "", label: "Private — nothing is saved" },
		]);
	});

	test("an empty bar opens a blank browser on the saved logins; a bar that is not an address opens nothing and says why", async () => {
		const { store, acts } = fakeStore();
		const panel = await mountPanel("session-1", store);
		const open = panel.openForm();

		await panel.submit(open.form);
		expect(acts).toEqual([openBrowser({ profile: "default" })]);

		await panel.type(open.address, "two words");
		await panel.submit(open.form);
		expect(acts).toHaveLength(1);
		expect(open.problem()).toBeTruthy();
		expect(open.address.getAttribute("aria-invalid")).toBe("true");
	});

	test("with no session Open is disabled and nothing is acted, and the tab says what to do", async () => {
		const { store, acts } = fakeStore();
		const panel = await mountPanel(null, store);
		const open = panel.openForm();

		await panel.type(open.address, "example.com");
		await panel.submit(open.form);

		expect(acts).toEqual([]);
		expect(open.form.querySelector("button")?.hasAttribute("disabled")).toBe(true);
		expect(panel.find('[data-slot="browser-accounts-hint"]')).toHaveLength(1);
	});
});
