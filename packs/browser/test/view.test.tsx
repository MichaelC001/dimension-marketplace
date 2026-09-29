/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser View's start page
 *  speaks engineer again (profiles, engines, Chromium, relay, the runtime's raw
 *  refusals) to a person who only wanted to open a page; Open ignores the
 *  address they typed; a person's own browser stops keeping their logins, or a
 *  Private one saves them, or "my own Chrome" opens the wrong kind of browser;
 *  a browser that ended normally is shown as an alarm, or one that could not be
 *  opened is shown as nothing; or a saved set of logins shows up in the picker
 *  before there is one to pick.
 *
 *  The View is mounted live on a linkedom document (`dom-harness.ts`) against a
 *  fake MCP App host whose `callServerTool` records every browser tool call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserState } from "../src/contracts";
import { BrowserApp } from "../app/view/browser-app";
import { mountFromToolResult, type ToolMount } from "../app/view/browser-client";
import { StartPage, type StartPageProps } from "../app/view/start-page";
import { type Dom, mount, unmountAll } from "./dom-harness";

afterEach(unmountAll);

const JARGON = /profile|engine|relay|chromium/i;

const noop = () => {};
const startProps = (over: Partial<StartPageProps> = {}): StartPageProps => ({
	profiles: [],
	profilesError: null,
	profile: "default",
	isPrivate: false,
	ownChrome: false,
	opening: false,
	error: null,
	closed: false,
	onProfile: noop,
	onPrivate: noop,
	onOwnChrome: noop,
	onOpen: noop,
	...over,
});

const button = (dom: Dom, label: string): Element => {
	const found = dom.find("button").find(el => el.textContent?.trim().startsWith(label));
	if (!found) throw new Error(`no "${label}" button`);
	return found;
};
const optionBox = (dom: Dom, label: string): Element => {
	const row = dom.find("label").find(el => el.textContent?.includes(label));
	const box = row?.querySelector('input[type="checkbox"]');
	if (!box) throw new Error(`no "${label}" checkbox`);
	return box;
};
const openOptions = (dom: Dom) => dom.click(button(dom, "Options"));

describe("the start page", () => {
	test("offers one Open, with no engineer words folded or unfolded", async () => {
		const dom = await mount(<StartPage {...startProps({ profiles: ["default", "work"] })} />);
		const folded = dom.text();
		await openOptions(dom);

		expect(dom.find("button").filter(el => el.textContent?.trim().startsWith("Open"))).toHaveLength(1);
		expect(folded).not.toMatch(JARGON);
		expect(dom.text()).not.toMatch(JARGON);
	});

	test("the options are folded until asked for, fold again, and each box reports its own change", async () => {
		const seen: string[] = [];
		const dom = await mount(<StartPage {...startProps({ onPrivate: on => seen.push(`private:${on}`), onOwnChrome: on => seen.push(`chrome:${on}`) })} />);
		expect(dom.find('input[type="checkbox"]')).toHaveLength(0);

		await openOptions(dom);
		expect(dom.find('input[type="checkbox"]')).toHaveLength(2);
		await dom.check(optionBox(dom, "Private"), true);
		await dom.check(optionBox(dom, "own Chrome"), true);
		await dom.click(button(dom, "Options"));

		expect(seen).toEqual(["private:true", "chrome:true"]);
		expect(dom.find('input[type="checkbox"]')).toHaveLength(0);
	});

	test("the saved-logins picker appears only once a second saved set exists, and picking one is reported", async () => {
		for (const profiles of [null, [], ["default"]] as const) {
			const dom = await mount(<StartPage {...startProps({ profiles })} />);
			await openOptions(dom);
			expect(dom.find('[role="radiogroup"]')).toHaveLength(0);
			// Making the first extra set is always on offer.
			await dom.click(button(dom, "Add another login set"));
			expect(dom.find('input[aria-label="Name for the new set of logins"]')).toHaveLength(1);
		}

		const picked: string[] = [];
		const dom = await mount(<StartPage {...startProps({ profiles: ["default", "work"], onProfile: name => picked.push(name) })} />);
		await openOptions(dom);
		const radios = dom.find('[role="radio"]');
		expect(radios.map(el => el.lastChild?.textContent)).toEqual(["Default", "work"]);
		await dom.click(radios[1] as Element);
		expect(picked).toEqual(["work"]);
	});

	test("a new set of logins is named through the shared name rules: a bad or reserved name is refused with a reason, a good one is picked as its slug", async () => {
		const picked: string[] = [];
		const dom = await mount(<StartPage {...startProps({ onProfile: name => picked.push(name) })} />);
		await openOptions(dom);
		await dom.click(button(dom, "Add another login set"));
		const field = dom.find('input[aria-label="Name for the new set of logins"]')[0] as Element;
		const form = field.closest("form") as Element;

		await dom.type(field, "Bad Name!");
		await dom.submit(form);
		const badChars = form.querySelector("p")?.textContent;
		await dom.type(field, "relay");
		await dom.submit(form);
		const reserved = form.querySelector("p")?.textContent;
		expect(picked).toEqual([]);
		expect(badChars).toBeTruthy();
		expect(reserved).toBeTruthy();
		expect(reserved).not.toBe(badChars);

		await dom.type(field, "  Work ");
		await dom.submit(form);
		expect(picked).toEqual(["work"]);
	});

	test("Private locks the saved-logins picker and own Chrome locks Private; the folded row says which is on", async () => {
		const privately = await mount(<StartPage {...startProps({ profiles: ["default", "work"], profile: "work", isPrivate: true })} />);
		expect(privately.text()).toContain("Private");
		await openOptions(privately);
		expect(privately.find('[role="radio"]').map(el => el.hasAttribute("disabled"))).toEqual([true, true]);

		const own = await mount(<StartPage {...startProps({ ownChrome: true })} />);
		expect(own.text()).toContain("Your Chrome");
		await openOptions(own);
		expect(optionBox(own, "Private").hasAttribute("disabled")).toBe(true);
	});
});

const LIVE: BrowserState = {
	browserId: "b1",
	profile: null,
	engine: "chromium",
	app: "chrome",
	url: "https://example.com/",
	title: "Example",
	revision: 1,
	viewport: { width: 1280, height: 800 },
	task: null,
	tabs: [],
	activeTabId: "",
	loading: false,
	canGoBack: false,
	canGoForward: false,
	publish: null,
	dialogs: [],
};

interface Call {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** A host that answers `browser_profiles`, records every call, and lets `answer` decide the rest. */
function fakeApp(answer: (call: Call) => CallToolResult): { readonly app: App; readonly calls: Call[] } {
	const calls: Call[] = [];
	// The View touches exactly these three App members; the rest of the host surface is not in play.
	const app = {
		callServerTool: async (request: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> => {
			const call = { name: request.name, args: request.arguments ?? {} };
			calls.push(call);
			return call.name === "browser_profiles" ? { content: [], structuredContent: { profiles: [] } } : answer(call);
		},
		getHostCapabilities: () => ({ updateModelContext: { text: {} } }),
		updateModelContext: async () => ({}),
	} as unknown as App;
	return { app, calls };
}

const opens = (calls: readonly Call[]) => calls.filter(call => call.name === "browser_open").map(call => call.args);

/** The runtime's two refusals of a saved set that is already held, verbatim: one holder in this server (`profile_in_use`), one across servers (`profile_locked`). */
const SET_TAKEN = {
	profile_in_use: `profile "default" is already open in this runtime; close that browser before opening it again`,
	profile_locked: `profile "default" is already in use (pid 4242 since 2026-09-29T08:00:00.000Z). Close that browser first (browser_close), or use another profile.`,
} as const;
const TAKEN_SENTENCE = "That browser is already open. Use it, or open a Private one.";

const addressField = (dom: Dom): Element => dom.find('input[aria-label="Address"]')[0] as Element;
const alerts = (dom: Dom) => dom.find('[role="alert"]').map(el => el.textContent);

describe("opening from the start page", () => {
	test("Open goes to the address that was typed, on the person's saved logins, and a refusal is shown, not swallowed", async () => {
		const { app, calls } = fakeApp(() => failure("could not open"));
		const dom = await mount(<BrowserApp app={app} toolState={null} />);
		await dom.settle();

		await dom.type(addressField(dom), "example.com");
		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(opens(calls)).toStrictEqual([{ engine: "chromium", profile: "default", url: "https://example.com/" }]);
		expect(alerts(dom)).toEqual(["could not open"]);
	});

	test("something that is not an address opens nothing and says why", async () => {
		const { app, calls } = fakeApp(() => failure("unexpected"));
		const dom = await mount(<BrowserApp app={app} toolState={null} />);
		await dom.settle();

		await dom.type(addressField(dom), "two words");
		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(opens(calls)).toEqual([]);
		expect(alerts(dom)).toHaveLength(1);
		expect(addressField(dom).getAttribute("aria-invalid")).toBe("true");
	});

	test("an empty address opens a blank browser on their logins, Private sends no profile, and their own Chrome is the Chrome kind", async () => {
		const { app, calls } = fakeApp(() => failure("could not open"));
		const dom = await mount(<BrowserApp app={app} toolState={null} />);
		await dom.settle();

		await dom.click(button(dom, "Open"));
		await dom.settle();
		await openOptions(dom);
		await dom.check(optionBox(dom, "Private"), true);
		await dom.click(button(dom, "Open"));
		await dom.settle();
		await dom.check(optionBox(dom, "Private"), false);
		await dom.check(optionBox(dom, "own Chrome"), true);
		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(opens(calls)).toStrictEqual([{ engine: "chromium", profile: "default" }, { engine: "chromium" }, { engine: "chrome-relay", profile: "relay" }]);
	});

	for (const [code, text] of Object.entries(SET_TAKEN)) {
		test(`a saved set another browser holds (${code}) is one plain sentence with a way out, and Private then opens`, async () => {
			const { app, calls } = fakeApp(call => {
				if (call.name !== "browser_open") return failure("connection reset");
				return call.args.profile === undefined ? { content: [], structuredContent: { ...LIVE, browserId: "b2" } } : failure(text);
			});
			const dom = await mount(<BrowserApp app={app} toolState={null} />);
			await dom.settle();

			await dom.click(button(dom, "Open"));
			await dom.settle();
			expect(alerts(dom)).toEqual([TAKEN_SENTENCE]);

			await openOptions(dom);
			await dom.check(optionBox(dom, "Private"), true);
			await dom.click(button(dom, "Open"));
			await dom.settle();

			expect(opens(calls)).toStrictEqual([{ engine: "chromium", profile: "default" }, { engine: "chromium" }]);
			expect(dom.find(".bx-browser")).toHaveLength(1);
			expect(dom.text()).not.toContain(TAKEN_SENTENCE);
		});
	}
});

describe("a browser the host's own tool call failed to open", () => {
	const mounted = (result: CallToolResult): ToolMount => {
		const read = mountFromToolResult(result);
		if (read === null) throw new Error("the result said nothing about a browser");
		return { ...read, seq: 1 };
	};

	test("is told on the start page — in plain words for a held set, verbatim otherwise — not dropped", async () => {
		for (const [text, shown] of [[SET_TAKEN.profile_in_use, TAKEN_SENTENCE], ["could not launch Chrome", "could not launch Chrome"]] as const) {
			const { app } = fakeApp(() => failure("unexpected"));
			const dom = await mount(<BrowserApp app={app} toolState={mounted(failure(text))} />);
			await dom.settle();

			expect(alerts(dom)).toEqual([shown]);
			expect(button(dom, "Open")).toBeTruthy();
		}
	});

	test("a result that opened a browser is a browser, and one that says nothing about a browser is nothing", () => {
		expect(mountFromToolResult({ content: [], structuredContent: { ...LIVE } })).toEqual({ state: LIVE });
		expect(mountFromToolResult({ content: [], structuredContent: { state: LIVE } })).toEqual({ state: LIVE });
		expect(mountFromToolResult({ content: [] })).toBeNull();
	});
});

describe("a browser that ends", () => {
	test("is a normal ending: the start page returns with one calm line, and nothing announces an error", async () => {
		const { app, calls } = fakeApp(call => (call.name === "browser_frame" ? failure("unknown or already closed browserId b1") : failure("unexpected")));
		const dom = await mount(<BrowserApp app={app} toolState={{ state: LIVE, seq: 1 }} />);
		await dom.settle();

		expect(dom.text()).toContain("This browser was closed.");
		expect(dom.find('input[aria-label="Address"]')).toHaveLength(1);
		expect(dom.find('[role="alert"]')).toHaveLength(0);
		expect(dom.text()).not.toMatch(/shut down|elsewhere/i);
		// The page is one click away again: the same Open the first visit had.
		expect(button(dom, "Open")).toBeTruthy();
		expect(calls.some(call => call.name === "browser_frame")).toBe(true);
	});

	test("the calm line belongs to the ended browser only: once the next one is open it is gone", async () => {
		const next = { ...LIVE, browserId: "b2" };
		const { app } = fakeApp(call => {
			if (call.name === "browser_open") return { content: [], structuredContent: { ...next } };
			// The first browser is gone; the second one merely stumbles.
			return failure(call.args.browserId === "b1" ? "unknown or already closed browserId b1" : "connection reset");
		});
		const dom = await mount(<BrowserApp app={app} toolState={{ state: LIVE, seq: 1 }} />);
		await dom.settle();
		expect(dom.text()).toContain("This browser was closed.");

		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(dom.find(".bx-browser")).toHaveLength(1);
		expect(dom.text()).not.toContain("This browser was closed.");
	});
});
