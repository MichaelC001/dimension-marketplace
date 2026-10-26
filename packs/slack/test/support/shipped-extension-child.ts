import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type } from "arktype";
import { TOKEN_PATH } from "../../credential";
import slackExtension from "../../index";

const BOT_API = "https://slack.com/api/";
const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.user.access";
const MCP_ENDPOINT = "https://mcp.slack.com/mcp";
const RENEWED_ACCESS = "xoxe-renewed-access";
const RENEWED_REFRESH = "xoxe-renewed-refresh";

const SLACK_TOOLS = [
	{
		name: "slack_search_public",
		description: "Search public channels",
		inputSchema: { type: "object" },
		annotations: { readOnlyHint: true },
	},
	{ name: "slack_send_message", description: "Send a message", inputSchema: { type: "object" }, annotations: {} },
];

const CALLS: readonly (readonly [string, Record<string, unknown>])[] = [
	["slack_list_channels", {}],
	["slack_tools", {}],
	["slack_read_messages", { channel: "C0123" }],
	["slack_read", { tool: "slack_search_public", arguments: { query: "launch" } }],
	["slack_post_message", { channel: "C0123", text: "from the bot" }],
	["slack_act", { tool: "slack_send_message", arguments: { channel: "C0123", text: "from me" } }],
	["slack_read_thread", { channel: "C0123", threadTs: "1700000000.000100" }],
	["slack_reply_thread", { channel: "C0123", threadTs: "1700000000.000100", text: "bot reply" }],
	["slack_add_reaction", { channel: "C0123", messageTs: "1700000000.000100", emoji: "thumbsup" }],
	["slack_edit_message", { channel: "C0123", messageTs: "1700000000.000100", text: "bot edit" }],
	["slack_delete_message", { channel: "C0123", messageTs: "1700000000.000100" }],
	["slack_list_users", {}],
];

const rpcCall = type({ "id?": "number", method: "string", "params?": { "name?": "string" } });

interface RegisteredTool {
	readonly name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		context: object,
	): Promise<{ readonly content: readonly { readonly text?: string }[] }>;
}

interface SeenRequest {
	readonly endpoint: string;
	readonly authorization: string | null;
	readonly rpc: string | null;
	readonly body: string;
}

const home = process.env.SLACK_TEST_HOME;
const fromHome = home === undefined ? null : relative(home, TOKEN_PATH);
if (fromHome === null || fromHome.startsWith("..") || isAbsolute(fromHome)) {
	process.stderr.write(`refusing to run: the credential path ${TOKEN_PATH} is not under the test home ${home}\n`);
	process.exit(2);
}

const seen: SeenRequest[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	const endpoint = url.split("?")[0] ?? url;
	const body = String(init?.body ?? "");
	const authorization = new Headers(init?.headers).get("authorization");
	const call = endpoint === MCP_ENDPOINT ? rpcCall.assert(JSON.parse(body)) : null;
	seen.push({ endpoint, authorization, rpc: call?.method ?? null, body });
	if (endpoint === TOKEN_ENDPOINT) {
		return Response.json({
			ok: true,
			access_token: RENEWED_ACCESS,
			refresh_token: RENEWED_REFRESH,
			expires_in: 43_200,
		});
	}
	if (call) {
		if (call.method === "notifications/initialized") return new Response(null, { status: 202 });
		const result =
			call.method === "tools/list"
				? { tools: SLACK_TOOLS }
				: call.method === "tools/call"
					? { content: [{ type: "text", text: `ran ${call.params?.name}` }] }
					: { protocolVersion: "2025-06-18", capabilities: {} };
		return Response.json({ jsonrpc: "2.0", id: call.id, result });
	}
	if (endpoint === `${BOT_API}auth.test`) return Response.json({ ok: true, user: "ada", team: "Acme" });
	if (endpoint.startsWith(BOT_API)) return Response.json({ ok: true, channel: "C0123", ts: "1700000000.000900" });
	throw new Error(`unexpected request to ${url}`);
}) as typeof fetch;

const tools = new Map<string, RegisteredTool>();
slackExtension({
	registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
} as unknown as ExtensionAPI);

const outcomes: Record<string, { ok: boolean; text: string }> = {};
for (const [name, params] of CALLS) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`the extension did not register ${name}`);
	try {
		const result = await tool.execute("call", params, undefined, undefined, {});
		outcomes[name] = { ok: true, text: result.content[0]?.text ?? "" };
	} catch (error) {
		outcomes[name] = { ok: false, text: error instanceof Error ? error.message : String(error) };
	}
}

await Bun.write(Bun.stdout, JSON.stringify({ outcomes, requests: seen }));
process.exit(0);
