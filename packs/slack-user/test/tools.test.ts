import { expect, test } from "bun:test";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { type CredentialStore, SlackSignInError, type StoredCredential } from "../credential";
import { type McpClient, McpRequestError, type McpTool } from "../mcp-client";
import {
	approvalDetails,
	createSlackActTool,
	createSlackReadTool,
	createSlackToolsTool,
	createToolCatalog,
	type SlackCallTool,
} from "../tools";

const SEARCH: McpTool = {
	name: "slack_search_public",
	description: "Search public channels\nLong second line",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
	annotations: { readOnlyHint: true },
};
const SEND: McpTool = { name: "slack_send_message", description: "Send a message", annotations: {} };
const UNLABELLED_READ: McpTool = { name: "slack_read_channel", description: "Read a channel", annotations: {} };

const NO_CONTEXT = {} as Parameters<ToolDefinition["execute"]>[4];

interface Harness {
	readonly calls: { readonly name: string; readonly args: Record<string, unknown> }[];
	readonly listings: { count: number };
	readonly clock: { now: number };
	readonly deps: Parameters<typeof createSlackActTool>[0];
}

function harness(
	options: {
		readonly tools?: readonly McpTool[];
		readonly credential?: StoredCredential;
		readonly callTool?: McpClient["callTool"];
	} = {},
): Harness {
	const calls: Harness["calls"] = [];
	const listings = { count: 0 };
	const clock = { now: 0 };
	const client: McpClient = {
		async listTools() {
			listings.count += 1;
			return options.tools ?? [SEARCH, SEND, UNLABELLED_READ];
		},
		callTool:
			options.callTool ??
			(async (name, args) => {
				calls.push({ name, args });
				return { text: `ran ${name}`, isError: false };
			}),
	};
	const credential: StoredCredential = options.credential ?? { access: "xoxp-1", scopes: ["chat:write"] };
	const store: CredentialStore = {
		read: async () => credential,
		peek: () => credential,
		accessToken: async () => credential.access,
		renewRejected: async () => credential.access,
	};
	return {
		calls,
		listings,
		clock,
		deps: {
			client,
			store,
			catalog: createToolCatalog(client, () => clock.now),
			identity: { label: () => "ada in Acme", warm: async () => undefined },
		},
	};
}

function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
	return result.content[0]?.text ?? "";
}

function run(tool: SlackCallTool, params: Parameters<SlackCallTool["execute"]>[1]) {
	return tool.execute("c", params, undefined, undefined, NO_CONTEXT);
}

const policyInYolo = (tool: ToolDefinition<never>, args: unknown) =>
	resolveApproval(tool as Parameters<typeof resolveApproval>[0], args, "yolo").policy;

test("slack_read refuses a tool Slack does not mark read-only, without calling it", async () => {
	const { deps, calls } = harness();
	const read = createSlackReadTool(deps);

	await expect(run(read, { tool: "slack_send_message", arguments: {} })).rejects.toThrow(
		"cannot run through slack_read",
	);
	await expect(run(read, { tool: "slack_read_channel" })).rejects.toThrow("cannot run through slack_read");
	expect(calls).toEqual([]);
});

test("slack_read runs a read-only tool with the arguments it was given", async () => {
	const { deps, calls } = harness();

	const result = await run(createSlackReadTool(deps), {
		tool: "slack_search_public",
		arguments: { query: "launch" },
	});

	expect(textOf(result)).toBe("ran slack_search_public");
	expect(calls).toEqual([{ name: "slack_search_public", args: { query: "launch" } }]);
});

test("slack_act runs a write tool", async () => {
	const { deps, calls } = harness();

	await run(createSlackActTool(deps), {
		tool: "slack_send_message",
		arguments: { channel: "C1", text: "hi" },
	});

	expect(calls).toEqual([{ name: "slack_send_message", args: { channel: "C1", text: "hi" } }]);
});

test("sending as the user stops for a human click even in yolo mode while reading does not", () => {
	const { deps } = harness();

	expect(policyInYolo(createSlackActTool(deps), { tool: "slack_send_message", arguments: {} })).toBe("prompt");
	expect(policyInYolo(createSlackReadTool(deps), { tool: "slack_search_public" })).toBe("allow");
	expect(policyInYolo(createSlackToolsTool(deps), {})).toBe("allow");
});

test("the approval card carries the tool, the account, and every argument in full", () => {
	const text = "line one\nline two with the whole message";

	const card = approvalDetails(
		{ label: () => "ada in Acme", warm: async () => undefined },
		{
			tool: "slack_send_message",
			arguments: { channel: "C1", text, thread_ts: "1700000000.000100" },
		},
	);

	expect(card).toEqual([
		"Slack tool: slack_send_message",
		"As: ada in Acme",
		"channel: C1",
		`text: ${text}`,
		"thread_ts: 1700000000.000100",
	]);
});

test("the approval card says so when the account is not known yet, caps a huge value, and survives malformed arguments", () => {
	const unknown = { label: () => undefined, warm: async () => undefined };

	const huge = approvalDetails(unknown, { tool: "slack_send_message", arguments: { text: "x".repeat(5_000) } });
	expect(huge[1]).toBe("As: the connected Slack account");
	expect(huge[2]).toContain("[...1000 more chars]");

	expect(approvalDetails(unknown, null)).toEqual(["Slack tool: (missing)", "As: the connected Slack account"]);
	expect(approvalDetails(unknown, { tool: 5, arguments: "nope" })).toEqual([
		"Slack tool: (missing)",
		"As: the connected Slack account",
	]);
});

test("a read-only connection refuses a write tool before anything is sent, and one with no recorded scopes or a write scope proceeds", async () => {
	const readOnly = harness({ credential: { access: "a", scopes: ["channels:history", "search:read.public"] } });
	await expect(run(createSlackActTool(readOnly.deps), { tool: "slack_send_message", arguments: {} })).rejects.toThrow(
		"authorized read-only",
	);
	expect(readOnly.calls).toEqual([]);

	for (const credential of [{ access: "a" }, { access: "a", scopes: ["chat:write"] }]) {
		const connected = harness({ credential });
		await run(createSlackActTool(connected.deps), { tool: "slack_send_message", arguments: {} });
		expect(connected.calls).toHaveLength(1);
	}
});

test("an unknown tool name triggers one refresh of the tool list and then names the tools Slack does have", async () => {
	const { deps, listings } = harness();

	await expect(run(createSlackReadTool(deps), { tool: "slack_teleport" })).rejects.toThrow(
		'no tool named "slack_teleport". Its tools: slack_search_public, slack_send_message, slack_read_channel',
	);

	expect(listings.count).toBe(2);
});

test("the tool list is cached until it expires or a refresh is asked for", async () => {
	const { deps, listings, clock } = harness();
	const read = createSlackReadTool(deps);
	const search = { tool: "slack_search_public" };

	await run(read, search);
	await run(read, search);
	expect(listings.count).toBe(1);

	await createSlackToolsTool(deps).execute("c", { refresh: true }, undefined, undefined, NO_CONTEXT);
	expect(listings.count).toBe(2);

	clock.now += 301_000;
	await run(read, search);
	expect(listings.count).toBe(3);
});

test("slack_tools lists read tools before write tools with their kind, and describes one tool with its schema", async () => {
	const { deps } = harness();
	const tools = createSlackToolsTool(deps);

	const listing = textOf(await tools.execute("c", {}, undefined, undefined, NO_CONTEXT));
	expect(listing.split("\n").slice(1)).toEqual([
		"- [read] slack_search_public — Search public channels",
		"- [write] slack_read_channel — Read a channel",
		"- [write] slack_send_message — Send a message",
	]);

	const detail = textOf(await tools.execute("c", { tool: "slack_search_public" }, undefined, undefined, NO_CONTEXT));
	expect(detail).toContain("slack_search_public (read)");
	expect(detail).toContain('"properties":{"query":{"type":"string"}}');
});

test("Slack's refusals reach the agent as actionable errors", async () => {
	const unauthorized = harness({
		callTool: async () => {
			throw new McpRequestError("Slack's MCP server answered 401: expired", 401);
		},
	});
	const read = createSlackReadTool(unauthorized.deps);
	const attempt = () => run(read, { tool: "slack_search_public" });
	await expect(attempt()).rejects.toBeInstanceOf(SlackSignInError);
	await expect(attempt()).rejects.toThrow("Slack MCP Server is switched on");

	const forbidden = harness({
		callTool: async () => {
			throw new McpRequestError("Slack's MCP server answered 403: nope", 403);
		},
	});
	await expect(run(createSlackReadTool(forbidden.deps), { tool: "slack_search_public" })).rejects.toThrow(
		"may not have approved the Dimension app",
	);

	const failing = harness({ callTool: async () => ({ text: "channel_not_found", isError: true }) });
	await expect(run(createSlackActTool(failing.deps), { tool: "slack_send_message", arguments: {} })).rejects.toThrow(
		"Slack slack_send_message failed: channel_not_found",
	);
});
