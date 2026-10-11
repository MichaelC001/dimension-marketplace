import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createBrowserServer } from "../src/server";
import {
	BROWSER_TEST_TIMEOUT_MS,
	createRoot,
	describeWithChrome,
	type Fixture,
	newRuntime,
	startFixture,
	teardown,
	waitUntil,
} from "./fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}
const textOf = (result: ToolResult): string => result.content.map((block) => block.text ?? "").join("");

interface Who {
	caller: "model" | "app";
	session?: string;
}
const CHAT_A: Who = { caller: "model", session: "chat-a" };
const CHAT_B: Who = { caller: "model", session: "chat-b" };
const PERSON_IN_A: Who = { caller: "app", session: "chat-a" };

const StateSchema = z
	.object({
		browserId: z.string(),
		url: z.string(),
		activeTabId: z.string(),
		tabs: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), active: z.boolean() })),
	})
	.passthrough();
type VState = z.infer<typeof StateSchema>;

function stateOf(result: ToolResult): VState {
	if (result.isError) throw new Error(`the call failed: ${textOf(result)}`);
	return StateSchema.parse(result.structuredContent);
}

function refusal(result: ToolResult): string {
	if (!result.isError) throw new Error(`expected a refusal, got: ${textOf(result).slice(0, 200)}`);
	return textOf(result);
}

const stateTab = (state: VState, tabId: string): { id: string; title: string; url: string; active: boolean } => {
	const tab = state.tabs.find((candidate) => candidate.id === tabId);
	if (tab === undefined) throw new Error(`tab ${tabId} is missing from state.tabs`);
	return tab;
};

interface Rig {
	call(name: string, args: Record<string, unknown>, who?: Who): Promise<ToolResult>;
	fixture: Fixture;
}

async function rig(): Promise<Rig> {
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "tab-ownership-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Rig["call"] = async (name, args, who) =>
		(await client.callTool({
			name,
			arguments: args,
			...(who === undefined
				? {}
				: { _meta: { [CALLER]: who.caller, ...(who.session === undefined ? {} : { [SESSION]: { sessionId: who.session } }) } }),
		})) as ToolResult;
	return { call, fixture: startFixture() };
}

const acting = async (r: Rig, who: Who, browserId: string, actions: Array<Record<string, unknown>>): Promise<void> => {
	const done = await r.call("browser_act", { browserId, actions }, who);
	if (done.isError) throw new Error(`a step every chat may run failed: ${textOf(done)}`);
};

const ownTab = async (r: Rig, who: Who, browserId: string, notThisId: string, url: string): Promise<string> => {
	const state = stateOf(await r.call("browser_state", { browserId }, who));
	const tab = state.tabs.find((candidate) => candidate.id !== notThisId && candidate.url === url);
	if (tab === undefined) throw new Error(`the tab at ${url} is missing from state.tabs`);
	return tab.id;
};

async function openShared(r: Rig, url: string): Promise<{ browserId: string; tabA: { id: string; title: string; url: string } }> {
	const opened = stateOf(await r.call("browser_open", { profile: "shared-a" }, CHAT_A));
	expect(opened.tabs).toHaveLength(1);
	const launchTabId = opened.tabs[0]?.id;
	if (launchTabId === undefined) throw new Error("the browser opened with no tabs");
	await acting(r, CHAT_A, opened.browserId, [{ kind: "navigate", url }]);
	const after = stateOf(await r.call("browser_state", { browserId: opened.browserId }, CHAT_A));
	const tabA = stateTab(after, launchTabId);
	expect(tabA.url).toBe(url);
	return { browserId: opened.browserId, tabA };
}

async function joinShared(r: Rig, browserId: string, args: Record<string, unknown> = {}): Promise<VState> {
	const joined = stateOf(await r.call("browser_open", { profile: "shared-a", ...args }, CHAT_B));
	expect(joined.browserId).toBe(browserId);
	return joined;
}

describeWithChrome("per-tab ownership between two chats sharing one saved-profile browser", () => {
	test(
		"a chat cannot activate a tab another chat opened",
		async () => {
			const r = await rig();
			const { browserId, tabA } = await openShared(r, r.fixture.url("/page2"));
			await joinShared(r, browserId);
			await acting(r, CHAT_B, browserId, [{ kind: "tab", op: "new" }]);
			const held = stateOf(await r.call("browser_state", { browserId }, CHAT_B));
			expect(held.tabs).toHaveLength(2);
			const tabB = held.tabs.map((tab) => tab.id).find((id) => id !== tabA.id);
			if (tabB === undefined) throw new Error("the second tab is missing from state.tabs");
			expect(held.activeTabId).toBe(tabB);

			const refused = refusal(await r.call("browser_act", { browserId, actions: [{ kind: "tab", op: "activate", tabId: tabA.id }] }, CHAT_B));
			expect(refused).toContain("not_your_tab");
			expect(refused).toContain("each chat");
			expect(refused).not.toContain(tabA.url);
			if (tabA.title.length > 0) expect(refused).not.toContain(tabA.title);
			const after = stateOf(await r.call("browser_state", { browserId }, CHAT_B));
			expect(after.activeTabId).toBe(tabB);
			expect(stateTab(after, tabB).active).toBe(true);

			expect((await r.call("browser_act", { browserId, actions: [{ kind: "tab", op: "activate", tabId: tabB }] }, CHAT_B)).isError).toBeFalsy();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a chat cannot close a tab another chat opened; the other chat's tab and its work survive",
		async () => {
			const r = await rig();
			const urlA = r.fixture.url("/page2");
			const urlA2 = r.fixture.url("/with-icon");
			const { browserId, tabA } = await openShared(r, urlA);
			await joinShared(r, browserId);
			await acting(r, CHAT_B, browserId, [{ kind: "tab", op: "new" }]);
			const tabB = await ownTab(r, CHAT_B, browserId, tabA.id, "about:blank");
			expect(tabB).toBeTruthy();

			const refused = refusal(await r.call("browser_act", { browserId, actions: [{ kind: "tab", op: "close", tabId: tabA.id }] }, CHAT_B));
			expect(refused).toContain("not_your_tab");
			expect(refused).not.toContain(tabA.url);
			if (tabA.title.length > 0) expect(refused).not.toContain(tabA.title);

			const after = stateOf(await r.call("browser_state", { browserId }, CHAT_A));
			expect(after.tabs.map((tab) => tab.id)).toContain(tabA.id);

			await acting(r, CHAT_A, browserId, [{ kind: "navigate", url: urlA2 }]);
			const settled = stateOf(await r.call("browser_state", { browserId }, CHAT_A));
			expect(stateTab(settled, tabA.id).url).toBe(urlA2);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a joiner's browser_open with a url never navigates another chat's tab",
		async () => {
			const r = await rig();
			const urlA = r.fixture.url("/page2");
			const urlB = r.fixture.url("/with-icon");
			const { browserId, tabA } = await openShared(r, urlA);

			const joined = await joinShared(r, browserId, { url: urlB });
			expect(joined.tabs.some((tab) => tab.id !== tabA.id && tab.url === urlB)).toBe(true);
			expect(joined.activeTabId).not.toBe(tabA.id);

			const asA = stateOf(await r.call("browser_state", { browserId }, CHAT_A));
			expect(stateTab(asA, tabA.id).url).toBe(urlA);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a chat's steps land on its own tab, never the tab another chat worked last",
		async () => {
			const r = await rig();
			const urlA = r.fixture.url("/page2");
			const urlB = r.fixture.url("/opener");
			const urlB2 = r.fixture.url("/signup");
			const urlA2 = r.fixture.url("/app");
			const { browserId, tabA } = await openShared(r, urlA);
			await joinShared(r, browserId);
			await acting(r, CHAT_B, browserId, [{ kind: "tab", op: "new", url: urlB }]);
			const tabB = await ownTab(r, CHAT_B, browserId, tabA.id, urlB);
			await acting(r, CHAT_B, browserId, [{ kind: "navigate", url: urlB2 }]);

			const held = stateOf(await r.call("browser_state", { browserId }, CHAT_B));
			expect(held.activeTabId).toBe(tabB);

			await acting(r, CHAT_A, browserId, [{ kind: "navigate", url: urlA2 }]);
			const after = stateOf(await r.call("browser_state", { browserId }, CHAT_A));
			expect(stateTab(after, tabA.id).url).toBe(urlA2);
			expect(stateTab(after, tabB).url).toBe(urlB2);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the person's View still drives any tab in the browser",
		async () => {
			const r = await rig();
			const { browserId, tabA } = await openShared(r, r.fixture.url("/page2"));
			await joinShared(r, browserId);
			await acting(r, CHAT_B, browserId, [{ kind: "tab", op: "new", url: r.fixture.url("/opener") }]);
			const tabB = await ownTab(r, CHAT_B, browserId, tabA.id, r.fixture.url("/opener"));

			const activated = await r.call("browser_act", { browserId, actions: [{ kind: "tab", op: "activate", tabId: tabB }] }, PERSON_IN_A);
			expect(activated.isError).toBeFalsy();
			const driven = stateOf(await r.call("browser_state", { browserId }, PERSON_IN_A));
			expect(driven.activeTabId).toBe(tabB);

			const closed = await r.call("browser_act", { browserId, actions: [{ kind: "tab", op: "close", tabId: tabB }] }, PERSON_IN_A);
			expect(closed.isError).toBeFalsy();
			const after = stateOf(await r.call("browser_state", { browserId }, PERSON_IN_A));
			expect(after.tabs.map((tab) => tab.id)).not.toContain(tabB);
			expect(after.activeTabId).toBe(tabA.id);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a chat with no tab of its own is refused page steps until it opens one",
		async () => {
			const r = await rig();
			const { browserId } = await openShared(r, r.fixture.url("/"));
			await joinShared(r, browserId);

			const refused = refusal(await r.call("browser_act", { browserId, actions: [{ kind: "type", selector: "#user", text: "intruded" }] }, CHAT_B));
			expect(refused).toContain("no_tab_of_yours");
			expect(refused).toContain("tab new");

			await acting(r, CHAT_A, browserId, [{ kind: "click", selector: "#go" }]);
			const landed = await waitUntil("the form submission", () => r.fixture.submissions(), (list) => list.length > 0);
			expect(landed.some((entry) => Object.values(entry).includes("intruded"))).toBe(false);
			const last = landed.at(-1);
			if (last === undefined) throw new Error("the submission vanished");
			expect(last.user).toBe("");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
