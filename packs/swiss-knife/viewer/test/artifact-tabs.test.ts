import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createElement } from "react";
import type { LibraryItem, ShareSummary } from "../../src/library/types";
import type * as PageModule from "../app/view/library/artifact-page";
import type { LibraryTools } from "../app/view/library/library-tools";
import { mapKitReact, standInRenderers } from "./kit-react";
import { installReact, type ReactEnv } from "./media-react";

mapKitReact();
standInRenderers();

const LABELS = ["View", "Comments", "Share", "Details"] as const;

let env: ReactEnv;
let page: typeof PageModule;

const share = (comments: number, unread: number): ShareSummary => ({
	id: "s1",
	host: "p2p",
	url: "https://relay.example/a/s1",
	audience: { kind: "link" },
	version: 1,
	versionAt: 1,
	allowComments: true,
	comments,
	unread,
});

const item = (shares: readonly ShareSummary[]): LibraryItem => ({
	id: "a1",
	path: "/work/clip.png",
	name: "clip.png",
	tags: [],
	kind: "image",
	mime: "image/png",
	size: 10,
	mtimeMs: 1,
	source: "present",
	starred: false,
	state: "live",
	createdAt: 1,
	presentedAt: 1,
	hasThumb: true,
	shares,
});

const tools = {
	open: (): Promise<CallToolResult> => new Promise<CallToolResult>(() => undefined),
	comments: async () => [],
} as unknown as LibraryTools;

const app = {} as unknown as App;

beforeAll(async () => {
	env = await installReact();
	page = await import("../app/view/library/artifact-page");
});

afterEach(() => env.cleanup());
afterAll(() => env.restore());

async function tabsOf(shares: readonly ShareSummary[]): Promise<Element[]> {
	const nothing = () => undefined;
	const { container } = await env.mount(
		createElement(page.ArtifactPage, {
			app,
			tools,
			item: item(shares),
			thumb: null,
			active: true,
			now: 10,
			theme: "dark",
			onBack: nothing,
			onPatch: nothing,
			onShare: nothing,
			onManage: nothing,
			onDiscard: nothing,
			onRestore: nothing,
			onShares: nothing,
			onShareChanged: nothing,
		}),
	);
	return [...container.querySelectorAll('[role="tablist"] [role="tab"]')];
}

function hiddenWithoutBreakpoint(from: Element, boundary: Element): boolean {
	for (let node: Element | null = from; node !== null; node = node === boundary ? null : node.parentElement) {
		if (node.classList.contains("hidden")) return true;
	}
	return false;
}

describe("the artifact page's tabs say what they are at every width", () => {
	test("each tab is named by its label: a title, and label text that is never hidden below the breakpoint", async () => {
		const tabs = await tabsOf([]);
		expect(tabs.map(tab => tab.getAttribute("title"))).toEqual([...LABELS]);

		for (const [index, label] of LABELS.entries()) {
			const tab = tabs[index];
			if (tab === undefined) throw new Error(`no tab for ${label}`);
			const text = [...tab.querySelectorAll("span")].find(span => span.textContent === label);
			if (text === undefined) throw new Error(`the ${label} tab carries no label text`);
			expect(hiddenWithoutBreakpoint(text, tab), label).toBe(false);
			expect(text.classList.contains("sr-only"), label).toBe(true);
			expect(text.classList.contains("sm:not-sr-only"), label).toBe(true);
		}
	});

	test("the Comments tab still carries its count and how many are new, beside its label", async () => {
		const tabs = await tabsOf([share(3, 2)]);
		const comments = tabs[1];
		expect(comments?.getAttribute("title")).toBe("Comments");
		expect(comments?.textContent).toContain("Comments");
		expect(comments?.textContent).toContain("3");
		expect(comments?.textContent).toContain("2 new");
	});
});
