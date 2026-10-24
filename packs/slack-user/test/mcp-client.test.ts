import { expect, test } from "bun:test";
import { createMcpClient, McpRequestError } from "../mcp-client";
import { isRecord } from "../type-guards";

interface Recorded {
	readonly headers: Headers;
	readonly body: Record<string, unknown>;
}

type Handler = (message: Record<string, unknown>, recorded: Recorded, count: number) => Response | Promise<Response>;

const SESSION_ID = "session-1";

const SEARCH_TOOL = {
	name: "slack_search_public",
	description: "Search public channels",
	inputSchema: { type: "object" },
	annotations: { readOnlyHint: true },
};
const SEND_TOOL = { name: "slack_send_message", description: "Send a message", inputSchema: { type: "object" } };

function rpcResult(id: unknown, result: unknown, init: ResponseInit = {}): Response {
	return Response.json({ jsonrpc: "2.0", id, result }, init);
}

function fakeSlack(handle: Handler) {
	const requests: Recorded[] = [];
	const fetcher = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const parsed: unknown = JSON.parse(String(init?.body));
		const recorded: Recorded = {
			headers: new Headers(init?.headers),
			body: isRecord(parsed) ? parsed : {},
		};
		requests.push(recorded);
		return handle(recorded.body, recorded, requests.length);
	}) as typeof fetch;
	return { fetcher, requests };
}

const standardServer: Handler = message => {
	switch (message.method) {
		case "initialize":
			return rpcResult(
				message.id,
				{ protocolVersion: "2025-03-26", capabilities: {} },
				{ headers: { "Mcp-Session-Id": SESSION_ID } },
			);
		case "notifications/initialized":
			return new Response(null, { status: 202 });
		case "tools/list":
			return rpcResult(message.id, { tools: [SEARCH_TOOL, SEND_TOOL] });
		case "tools/call":
			return rpcResult(message.id, { content: [{ type: "text", text: "sent" }] });
		default:
			return new Response("unexpected method", { status: 500 });
	}
};

function serverWith(method: string, answer: Handler): Handler {
	return (message, recorded, count) =>
		message.method === method ? answer(message, recorded, count) : standardServer(message, recorded, count);
}

function clientFor(fetcher: typeof fetch, renewals: string[] = []) {
	return createMcpClient({
		fetch: fetcher,
		accessToken: async () => "tok-1",
		renewRejected: async rejected => {
			renewals.push(rejected);
			return "tok-2";
		},
	});
}

test("a session is opened before the first request and every later request carries its id and the negotiated protocol version", async () => {
	const { fetcher, requests } = fakeSlack(standardServer);

	await clientFor(fetcher).listTools();

	expect(requests.map(request => request.body.method)).toEqual([
		"initialize",
		"notifications/initialized",
		"tools/list",
	]);
	const list = requests[2];
	expect(list?.headers.get("mcp-session-id")).toBe(SESSION_ID);
	expect(list?.headers.get("mcp-protocol-version")).toBe("2025-03-26");
	expect(list?.headers.get("authorization")).toBe("Bearer tok-1");
	expect(requests[0]?.headers.get("mcp-session-id")).toBeNull();
});

test("callers racing a cold client open exactly one session", async () => {
	const { fetcher, requests } = fakeSlack(standardServer);
	const client = clientFor(fetcher);

	await Promise.all([client.listTools(), client.callTool("slack_send_message", {}), client.listTools()]);

	expect(requests.filter(request => request.body.method === "initialize")).toHaveLength(1);
});

test("a tool list is followed across pages and keeps Slack's read-only annotation", async () => {
	const paged = serverWith("tools/list", message => {
		const hasCursor = isRecord(message.params) && message.params.cursor === "page-2";
		return hasCursor
			? rpcResult(message.id, { tools: [SEND_TOOL] })
			: rpcResult(message.id, { tools: [SEARCH_TOOL], nextCursor: "page-2" });
	});
	const { fetcher } = fakeSlack(paged);

	const tools = await clientFor(fetcher).listTools();

	expect(tools.map(tool => tool.name)).toEqual(["slack_search_public", "slack_send_message"]);
	expect(tools.map(tool => tool.annotations.readOnlyHint)).toEqual([true, undefined]);
});

test("a response framed as server-sent events is read, skipping notifications that precede the answer", async () => {
	const framed = serverWith("tools/call", message => {
		const progress = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
		const answer = JSON.stringify({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				content: [
					{ type: "text", text: "line one" },
					{ type: "text", text: "line two" },
				],
			},
		});
		return new Response(`event: message\ndata: ${progress}\n\nevent: message\ndata: ${answer}\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	const { fetcher } = fakeSlack(framed);

	const result = await clientFor(fetcher).callTool("slack_send_message", { channel: "C1" });

	expect(result).toEqual({ text: "line one\nline two", isError: false });
});

test("a tool result flagged as an error and its non-text blocks are reported faithfully", async () => {
	const failing = serverWith("tools/call", message =>
		rpcResult(message.id, {
			isError: true,
			content: [
				{ type: "text", text: "channel_not_found" },
				{ type: "image", mimeType: "image/png", data: "AAAA" },
				{ type: "resource", resource: { uri: "slack://canvas/1", text: "# Canvas" } },
			],
		}),
	);
	const { fetcher } = fakeSlack(failing);

	const result = await clientFor(fetcher).callTool("slack_send_message", {});

	expect(result.isError).toBe(true);
	expect(result.text).toBe("channel_not_found\n[image image/png omitted]\n# Canvas");
});

test("a JSON-RPC error becomes a request error carrying Slack's message and code", async () => {
	const rejecting = serverWith("tools/call", message =>
		Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid params: channel" } }),
	);
	const { fetcher } = fakeSlack(rejecting);

	const call = clientFor(fetcher).callTool("slack_send_message", {});

	await expect(call).rejects.toBeInstanceOf(McpRequestError);
	await expect(call).rejects.toMatchObject({ message: "Invalid params: channel", code: -32602 });
});

test("a session the server has forgotten is reopened once and the request retried on the new session", async () => {
	let forgotten = false;
	let sessions = 0;
	const handler: Handler = (message, recorded, count) => {
		if (message.method === "initialize") {
			sessions += 1;
			return rpcResult(
				message.id,
				{ protocolVersion: "2025-06-18" },
				{ headers: { "Mcp-Session-Id": `session-${sessions}` } },
			);
		}
		if (message.method === "tools/list" && !forgotten) {
			forgotten = true;
			return new Response("session not found", { status: 404 });
		}
		return standardServer(message, recorded, count);
	};
	const { fetcher, requests } = fakeSlack(handler);

	const tools = await clientFor(fetcher).listTools();

	expect(tools).toHaveLength(2);
	expect(sessions).toBe(2);
	expect(requests.at(-1)?.headers.get("mcp-session-id")).toBe("session-2");
});

test("a 401 renews the token once and retries with the new bearer", async () => {
	const expiring: Handler = (message, recorded, count) =>
		message.method === "tools/list" && recorded.headers.get("authorization") === "Bearer tok-1"
			? new Response("expired", { status: 401 })
			: standardServer(message, recorded, count);
	const renewals: string[] = [];
	const { fetcher, requests } = fakeSlack(expiring);

	await clientFor(fetcher, renewals).listTools();

	expect(renewals).toEqual(["tok-1"]);
	expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer tok-2");
});

test("a 401 that survives renewal is surfaced with its status instead of looping", async () => {
	const refusing = serverWith("tools/list", () => new Response("still no", { status: 401 }));
	const renewals: string[] = [];
	const { fetcher } = fakeSlack(refusing);

	await expect(clientFor(fetcher, renewals).listTools()).rejects.toMatchObject({ status: 401 });

	expect(renewals).toHaveLength(1);
});

test("a rate limit names how long to wait", async () => {
	const limited = serverWith(
		"tools/call",
		() => new Response("slow down", { status: 429, headers: { "Retry-After": "17" } }),
	);
	const { fetcher } = fakeSlack(limited);

	await expect(clientFor(fetcher).callTool("slack_send_message", {})).rejects.toThrow("rate limited, retry after 17s");
});

test("a call the caller already cancelled is cancelled on the wire too, instead of running to the request timeout", async () => {
	const { fetcher, requests } = fakeSlack(standardServer);
	const honoringSignal = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
		init?.signal?.aborted
			? Promise.reject(new DOMException("aborted", "AbortError"))
			: fetcher(input, init)) as typeof fetch;
	const controller = new AbortController();
	controller.abort();

	await expect(clientFor(honoringSignal).callTool("slack_search_public", {}, controller.signal)).rejects.toMatchObject(
		{
			name: "AbortError",
		},
	);

	expect(requests.map(request => request.body.method)).toEqual(["initialize", "notifications/initialized"]);
});
