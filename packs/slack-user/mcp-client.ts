import { isRecord } from "./type-guards";

const MCP_ENDPOINT = "https://mcp.slack.com/mcp";
const PROTOCOL_VERSION = "2025-06-18";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_LIST_PAGES = 20;
const ERROR_BODY_CHARS = 300;
const CLIENT_NAME = "dimension-slack-user";
const CLIENT_VERSION = "1";

export interface McpToolAnnotations {
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly title?: string;
}

export interface McpTool {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema?: Record<string, unknown>;
	readonly annotations: McpToolAnnotations;
}

export interface McpToolResult {
	readonly text: string;
	readonly isError: boolean;
}

interface McpSession {
	readonly id: string | null;
	readonly protocolVersion: string;
}

export interface McpClientOptions {
	readonly endpoint?: string;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	readonly accessToken: () => Promise<string>;
	readonly renewRejected: (rejectedAccess: string) => Promise<string>;
}

export interface McpClient {
	listTools(signal?: AbortSignal): Promise<readonly McpTool[]>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
}

export class McpRequestError extends Error {
	readonly status: number | null;
	readonly code: number | null;

	constructor(message: string, status: number | null = null, code: number | null = null) {
		super(message);
		this.name = "McpRequestError";
		this.status = status;
		this.code = code;
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function sseMessages(text: string): unknown[] {
	const messages: unknown[] = [];
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter(line => line.startsWith("data:"))
			.map(line => line.slice("data:".length).replace(/^ /, ""))
			.join("\n");
		if (data) messages.push(parseJson(data));
	}
	return messages;
}

async function resultOf(response: Response, id: number): Promise<unknown> {
	const text = await response.text();
	const contentType = response.headers.get("content-type") ?? "";
	const parsed = contentType.includes("text/event-stream") ? sseMessages(text) : [parseJson(text)];
	const answer = parsed.flat().find(message => isRecord(message) && message.id === id);
	if (!isRecord(answer)) {
		throw new McpRequestError(`Slack's MCP server sent no answer to request ${id}`, response.status);
	}
	if (isRecord(answer.error)) {
		const { message, code } = answer.error;
		throw new McpRequestError(
			typeof message === "string" ? message : "Slack's MCP server reported an error",
			response.status,
			typeof code === "number" ? code : null,
		);
	}
	return answer.result;
}

async function failureOf(response: Response): Promise<McpRequestError> {
	const body = (await response.text().catch(() => "")).slice(0, ERROR_BODY_CHARS);
	const retryAfter = response.headers.get("retry-after");
	const detail =
		response.status === 429 && retryAfter ? `rate limited, retry after ${retryAfter}s` : body || response.statusText;
	return new McpRequestError(`Slack's MCP server answered ${response.status}: ${detail}`, response.status);
}

function toTool(raw: unknown): McpTool[] {
	if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return [];
	const hints = isRecord(raw.annotations) ? raw.annotations : {};
	return [
		{
			name: raw.name,
			...(typeof raw.title === "string" && { title: raw.title }),
			...(typeof raw.description === "string" && { description: raw.description }),
			...(isRecord(raw.inputSchema) && { inputSchema: raw.inputSchema }),
			annotations: {
				...(typeof hints.readOnlyHint === "boolean" && { readOnlyHint: hints.readOnlyHint }),
				...(typeof hints.destructiveHint === "boolean" && { destructiveHint: hints.destructiveHint }),
				...(typeof hints.title === "string" && { title: hints.title }),
			},
		},
	];
}

function renderContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) => {
			if (!isRecord(block)) return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "image") {
				return `[image ${typeof block.mimeType === "string" ? block.mimeType : "data"} omitted]`;
			}
			if (block.type === "resource" && isRecord(block.resource)) {
				const { text, uri } = block.resource;
				return typeof text === "string" ? text : `[resource ${typeof uri === "string" ? uri : "without uri"}]`;
			}
			if (block.type === "resource_link" && typeof block.uri === "string") return `[link ${block.uri}]`;
			return JSON.stringify(block);
		})
		.filter(Boolean)
		.join("\n");
}

export function createMcpClient(options: McpClientOptions): McpClient {
	const endpoint = options.endpoint ?? MCP_ENDPOINT;
	const http = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	let session: McpSession | null = null;
	let opening: Promise<McpSession> | null = null;
	let sequence = 0;

	async function transport(body: object, current: McpSession | null, signal?: AbortSignal): Promise<Response> {
		const send = (token: string): Promise<Response> => {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			};
			if (current) {
				headers["MCP-Protocol-Version"] = current.protocolVersion;
				if (current.id) headers["Mcp-Session-Id"] = current.id;
			}
			const timeout = AbortSignal.timeout(timeoutMs);
			return http(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		};
		const token = await options.accessToken();
		const response = await send(token);
		if (response.status !== 401) return response;
		await response.body?.cancel();
		return send(await options.renewRejected(token));
	}

	async function openSession(): Promise<McpSession> {
		const id = ++sequence;
		const response = await transport(
			{
				jsonrpc: "2.0",
				id,
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
				},
			},
			null,
		);
		if (!response.ok) throw await failureOf(response);
		const result = await resultOf(response, id);
		const opened: McpSession = {
			id: response.headers.get("mcp-session-id"),
			protocolVersion:
				isRecord(result) && typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION,
		};
		const acknowledgement = await transport({ jsonrpc: "2.0", method: "notifications/initialized" }, opened);
		if (!acknowledgement.ok) throw await failureOf(acknowledgement);
		await acknowledgement.body?.cancel();
		return opened;
	}

	function ensureSession(): Promise<McpSession> {
		if (session) return Promise.resolve(session);
		opening ??= openSession()
			.then(opened => {
				session = opened;
				return opened;
			})
			.finally(() => {
				opening = null;
			});
		return opening;
	}

	async function request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
		for (let attempt = 0; ; attempt++) {
			const current = await ensureSession();
			const id = ++sequence;
			const response = await transport({ jsonrpc: "2.0", id, method, params }, current, signal);
			if (response.status === 404 && current.id && attempt === 0) {
				session = null;
				await response.body?.cancel();
				continue;
			}
			if (!response.ok) throw await failureOf(response);
			return resultOf(response, id);
		}
	}

	async function listTools(signal?: AbortSignal): Promise<readonly McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const result = await request("tools/list", cursor ? { cursor } : {}, signal);
			if (!isRecord(result) || !Array.isArray(result.tools)) {
				throw new McpRequestError("Slack's MCP server returned an unreadable tool list");
			}
			tools.push(...result.tools.flatMap(toTool));
			cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
			if (!cursor) break;
		}
		return tools;
	}

	async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
		const result = await request("tools/call", { name, arguments: args }, signal);
		if (!isRecord(result)) {
			throw new McpRequestError(`Slack's MCP server returned an unreadable result for ${name}`);
		}
		const rendered = renderContent(result.content);
		const text = rendered || (result.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent));
		return { text, isError: result.isError === true };
	}

	return { listTools, callTool };
}
