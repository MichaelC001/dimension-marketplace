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
import { BrowserAccounts, type BrowserStoreShape } from "../src/dock/browser-accounts";
import { mount, unmountAll } from "./dom-harness";

afterEach(unmountAll);

interface Act {
	readonly intent: string;
	readonly payload: unknown;
}

/** A host Store logging every intent. */
function fakeStore(): { readonly store: BrowserStoreShape; readonly acts: readonly Act[] } {
	const acts: Act[] = [];
	const store: BrowserStoreShape = {
		act(intent: string, payload?: unknown) {
			acts.push({ intent, payload });
		},
	};
	return { store, acts };
}

async function mountPanel(sessionId: string | null, store: BrowserStoreShape) {
	const dom = await mount(<BrowserAccounts sessionId={sessionId} store={store} />);
	return {
		...dom,
		/** The "Open a page" form, its address field and its Private box. */
		openForm: () => {
			const form = dom.find('[data-slot="browser-accounts-open"]')[0] as Element;
			return {
				form,
				address: form.querySelector('[data-slot="input"]') as Element,
				private: form.querySelector('input[type="checkbox"]') as Element,
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

		await panel.check(open.private, true);
		await panel.type(open.address, "example.com");
		await panel.submit(open.form);

		// Strict: a `profile` key present with any value, even undefined, is not "no profile".
		expect(acts).toStrictEqual([openBrowser({ url: "https://example.com/" })]);
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
