/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent that opens a browser
 *  "just to test localhost" makes a Browser View pane pop up on the person's
 *  screen (and a live screencast start) every single time — or, the other way
 *  round, the person can no longer ask to watch a browser the agent holds.
 *
 *  The host mounts the View from a tool's STATIC `_meta.ui.resourceUri`, never
 *  from its result. So which tools carry one IS the contract: `browser_open` is
 *  headless; `browser_view` (show the human a browser, or open one they watch)
 *  and `browser_publish` (the human must Post) are the only mounting tools.
 *  These run over an in-memory MCP transport against a recording runtime.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { BrowserAction, BrowserOpenOptions, BrowserRuntimePort, BrowserState } from "../src/contracts";
import { BROWSER_VIEW_URI, createBrowserServer } from "../src/server";
import { createRoot, teardown } from "./fixture";

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
});

const stateOf = (browserId: string, url = "about:blank"): BrowserState => ({ browserId, url, tabs: [] }) as unknown as BrowserState;

const UiMeta = z.object({ resourceUri: z.string().optional(), visibility: z.array(z.string()).optional() });
const uiOf = (tool: { _meta?: Record<string, unknown> }) => UiMeta.parse(tool._meta?.ui ?? {});

interface Calls {
	opened: BrowserOpenOptions[];
	read: string[];
	navigated: string[];
}

/** Just enough runtime for the server to boot and answer open/view: every call recorded. */
function recordingRuntime(calls: Calls): BrowserRuntimePort {
	const runtime: Pick<BrowserRuntimePort, "open" | "state" | "act" | "connections" | "onConnectionsChanged" | "dispose"> = {
		open: async (options) => {
			calls.opened.push(options);
			return stateOf("o".repeat(32));
		},
		state: async (browserId) => {
			calls.read.push(browserId);
			return stateOf(browserId, "http://held.test/");
		},
		act: async (browserId, action: BrowserAction) => {
			calls.navigated.push(action.url ?? "");
			return { status: "completed", state: stateOf(browserId, action.url) };
		},
		connections: async () => ({}),
		onConnectionsChanged: () => () => {},
		dispose: async () => {},
	};
	return runtime as BrowserRuntimePort;
}

async function connect(): Promise<{ client: Client; calls: Calls }> {
	const rootDir = await createRoot();
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const calls: Calls = { opened: [], read: [], navigated: [] };
	const server = await createBrowserServer({ runtime: recordingRuntime(calls), viewDir, presets: [] });
	const client = new Client({ name: "view-mounting-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return { client, calls };
}

test("only browser_view and browser_publish mount the View: browser_open is headless", async () => {
	const { client } = await connect();
	const tools = (await client.listTools()).tools;
	const mounting = tools.filter((tool) => uiOf(tool).resourceUri !== undefined).map((tool) => tool.name).sort();
	expect(mounting).toEqual(["browser_publish", "browser_view"]);
	expect(uiOf(tools.find((tool) => tool.name === "browser_view") ?? { _meta: {} }).resourceUri).toBe(BROWSER_VIEW_URI);
	// The View's own start page still opens browsers through browser_open (as the app), so the model may too.
	expect(uiOf(tools.find((tool) => tool.name === "browser_open") ?? { _meta: {} }).visibility).toBeUndefined();
});

test("publishing and task agents are offered to Traction alone; every browsing tool names no audience", async () => {
	const { client } = await connect();
	const modelTools = (await client.listTools()).tools.filter((tool) => uiOf(tool).visibility === undefined);
	const audienceOf = (tool: { _meta?: Record<string, unknown> }) => tool._meta?.["ai.insodimension/spaces"];

	// A dev session is listed these nine and nothing else; a new tool must choose a side to get past this list.
	expect(modelTools.filter((tool) => audienceOf(tool) === undefined).map((tool) => tool.name).sort()).toEqual([
		"browser_act", "browser_close", "browser_inspect", "browser_open", "browser_read",
		"browser_screenshot", "browser_snapshot", "browser_state", "browser_view",
	]);
	const traction = modelTools.filter((tool) => audienceOf(tool) !== undefined);
	expect(traction.map((tool) => tool.name).sort()).toEqual([
		"browser_publish", "browser_publish_cancel", "browser_publish_confirm", "browser_publish_presets", "browser_publish_wait",
		"browser_task", "browser_task_cancel", "browser_task_wait",
	]);
	expect(traction.map(audienceOf)).toEqual(traction.map(() => ["traction"]));
});

test("browser_view with a browserId shows that browser and opens nothing; it never repoints a held browser", async () => {
	const { client, calls } = await connect();
	const held = "h".repeat(32);

	const shown = await client.callTool({ name: "browser_view", arguments: { browserId: held } });

	expect(shown.isError).toBeFalsy();
	expect(shown.structuredContent).toMatchObject({ browserId: held, url: "http://held.test/" });
	expect(calls).toMatchObject({ opened: [], read: [held], navigated: [] });
	// profile/engine/url describe a NEW browser: with a browserId they would be silently ignored, so they are refused.
	for (const stray of [{ profile: "work" }, { engine: "chromium" }, { url: "http://x.test/" }]) {
		const refused = await client.callTool({ name: "browser_view", arguments: { browserId: held, ...stray } });
		expect(refused.isError).toBe(true);
	}
	expect(calls).toMatchObject({ opened: [], read: [held], navigated: [] });
});

test("browser_view without a browserId opens the browser exactly as browser_open does and navigates to url", async () => {
	const { client, calls } = await connect();

	const opened = await client.callTool({ name: "browser_view", arguments: { profile: "work", url: "http://app.test/" } });

	expect(opened.isError).toBeFalsy();
	expect(calls.opened).toEqual([{ profile: "work" }]);
	expect(calls.navigated).toEqual(["http://app.test/"]);
	expect(opened.structuredContent).toMatchObject({ browserId: "o".repeat(32), url: "http://app.test/" });

	// Same rules as browser_open: a profile name the rule refuses never reaches the runtime.
	const refused = await client.callTool({ name: "browser_view", arguments: { profile: "Bad Name!" } });
	expect(refused.isError).toBe(true);
	expect(calls.opened).toHaveLength(1);
});
