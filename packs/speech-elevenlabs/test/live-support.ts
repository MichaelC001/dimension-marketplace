// Fakes for the live (converse) tests: an in-process ElevenLabs Agents HTTP API (tools, agents, signed
// URLs, the scope probe), a fake agent socket, builders for the frames the agent sends, and a rig
// that opens a call the way the engine does. No network, no real home, no real time beyond a few ms.
import type { ConverseEvent, ConverseOpenOptions, ConverseSession, SpeechProvider, SpeechProviderContext } from "@dimension/sdk/provider";
import { agentBody, DEFAULT_CONVERSE_VOICE, toolBody } from "../src/convai.js";
import type { ConvaiSocket } from "../src/converse.js";
import { createElevenLabsProvider } from "../src/index.js";
import { FakeHttp, type Harness, jsonResponse, KEY, makeRig, type RecordedRequest, settle, withTimeout } from "./support.js";

export const INSTRUCTIONS = "You are Aether, the live voice. Delegate repository work.";
export const SIGNED_URL = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_1&conversation_signature=SIG-SECRET";

// ---- the Agents HTTP API -----------------------------------------------------------------------

export type Scope = "full" | "none" | "forbidden" | "invalid-key" | "busy" | "broken";

export const PROVIDER_TEXT = "SECRET-PROVIDER-TEXT";

/** The parts of an agent body the tests read. */
export interface AgentPayload {
	readonly name: string;
	readonly conversation_config: {
		readonly agent: { readonly first_message: string; readonly prompt: { readonly tool_ids: string[]; readonly llm: string } };
		readonly tts: { readonly model_id: string };
		readonly turn: { readonly silence_end_call_timeout: number; readonly turn_timeout: number };
		readonly conversation: { readonly max_duration_seconds: number; readonly client_events: string[] };
	};
	readonly platform_settings: {
		readonly auth: { readonly enable_auth: boolean };
		readonly overrides: { readonly conversation_config_override: unknown };
	};
}

export interface ToolPayload {
	readonly tool_config: { readonly type: string; readonly name: string; readonly expects_response: boolean };
}

/** A stateful stand-in for the parts of `api.elevenlabs.io/v1/convai` the pack uses. */
export class FakeAgentsApi {
	scope: Scope = "full";
	/** The account refuses to create an agent (a quota, a transient 5xx): the tool step before it still succeeds. */
	refuseAgentCreate = false;
	/** Every signed-URL request is refused with this status, whatever the agent id (a wrong agent, a revoked one). */
	signedUrlRefusal: number | undefined;
	ignoresOwnerFilter = false;
	readonly tools = new Map<string, Record<string, unknown>>();
	readonly agents = new Map<string, Record<string, unknown>>();
	readonly created = new Map<string, number>();
	readonly archived = new Set<string>();
	readonly foreign = new Set<string>();
	#next = 1;
	#clock = 1_000;

	readonly http = new FakeHttp(request => this.#handle(request));

	get requests(): readonly RecordedRequest[] {
		return this.http.requests;
	}

	/** `METHOD /path` of every request, query stripped, in order. */
	get calls(): string[] {
		return this.requests.map(request => `${request.method} ${new URL(request.url).pathname}`);
	}

	/** The body the client sent in request `index`, as the agent payload it should be. */
	agentPayload(index: number): AgentPayload {
		return JSON.parse(this.requests[index]?.body ?? "null");
	}

	toolPayload(index: number): ToolPayload {
		return JSON.parse(this.requests[index]?.body ?? "null");
	}

	/** The agent as the account holds it now. */
	agentById(id: string): AgentPayload {
		return JSON.parse(JSON.stringify(this.agents.get(id) ?? null));
	}

	retuneVoice(id: string, modelId: string): void {
		const held = this.agentById(id);
		this.agents.set(id, {
			...held,
			conversation_config: { ...held.conversation_config, tts: { ...held.conversation_config.tts, model_id: modelId } },
		});
	}

	/** Someone deleted the agent (and optionally its tool) in the ElevenLabs dashboard. */
	deleteRemote(what: { agents?: boolean; tools?: boolean }): void {
		if (what.agents) this.agents.clear();
		if (what.tools) this.tools.clear();
	}

	/** A tool already on the account, as an earlier run (or another machine) left it. */
	seedTool(config: Record<string, unknown> = toolBody(), options: { foreign?: boolean } = {}): string {
		const id = `tool_${this.#next++}`;
		this.tools.set(id, config);
		if (options.foreign) this.foreign.add(id);
		return id;
	}

	/** An agent already on the account; by default it holds exactly the body this pack wants. */
	seedAgent(options: { toolId: string; name?: string; created?: number; archived?: boolean; foreign?: boolean; body?: Record<string, unknown> }): string {
		const id = `agent_${this.#next++}`;
		const body = options.body ?? { ...agentBody(options.toolId, "eleven_v4_turbo", DEFAULT_CONVERSE_VOICE), name: options.name ?? "dimension-live" };
		this.agents.set(id, body);
		this.created.set(id, options.created ?? this.#clock++);
		if (options.archived) this.archived.add(id);
		if (options.foreign) this.foreign.add(id);
		return id;
	}

	#list(url: URL, field: "agents" | "tools"): Response {
		const search = url.searchParams.get("search") ?? "";
		const size = Number(url.searchParams.get("page_size") ?? "30");
		const start = Number(url.searchParams.get("cursor") ?? "0");
		const store = field === "agents" ? this.agents : this.tools;
		const ownedOnly = url.searchParams.get("created_by_user_id") === "@me" && !this.ignoresOwnerFilter;
		const matching = [...store.entries()].filter(([id, body]) => {
			const config = body.tool_config as { name?: string } | undefined;
			if (ownedOnly && this.foreign.has(id)) return false;
			return String(field === "agents" ? body.name : config?.name).includes(search);
		});
		const next = start + size;
		const rows = matching.slice(start, next).map(([id, body]) => {
			const accessInfo = { is_creator: !this.foreign.has(id) };
			return field === "agents"
				? { agent_id: id, name: body.name, created_at_unix_secs: this.created.get(id), archived: this.archived.has(id), access_info: accessInfo }
				: { id, ...body, access_info: accessInfo };
		});
		return jsonResponse({ [field]: rows, has_more: next < matching.length, next_cursor: next < matching.length ? String(next) : null });
	}

	#error(status: number, detail: Record<string, unknown>): Response {
		return jsonResponse({ detail }, status);
	}

	#handle(request: RecordedRequest): Response {
		const url = new URL(request.url);
		const path = url.pathname;
		const body = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : undefined;
		if (this.scope === "invalid-key") return this.#error(401, { status: "invalid_api_key", message: "Invalid API key" });
		if (this.scope === "busy") return this.#error(429, { status: "too_many_concurrent_requests", message: PROVIDER_TEXT });
		if (this.scope === "broken") return this.#error(503, { status: "unavailable", message: PROVIDER_TEXT });
		if (this.scope === "forbidden") return this.#error(403, { status: "forbidden", message: "Forbidden" });
		if (this.scope === "none") {
			return this.#error(401, { status: "missing_permissions", message: "The API key you used is missing the permission convai_read." });
		}
		if (request.headers.get("xi-api-key") !== KEY) {
			return this.#error(401, { status: "invalid_api_key", message: "Invalid API key" });
		}
		const method = request.method;
		if (method === "GET" && (path === "/v1/convai/agents" || path === "/v1/convai/tools")) {
			return this.#list(url, path.endsWith("agents") ? "agents" : "tools");
		}
		if (method === "POST" && path === "/v1/convai/tools") {
			const id = `tool_${this.#next++}`;
			this.tools.set(id, body ?? {});
			return jsonResponse({ id });
		}
		if (method === "POST" && path === "/v1/convai/agents/create") {
			if (this.refuseAgentCreate) {
				return this.#error(422, { status: "quota_exceeded", message: "The workspace has reached its agent limit" });
			}
			const id = `agent_${this.#next++}`;
			this.agents.set(id, body ?? {});
			this.created.set(id, this.#clock++);
			return jsonResponse({ agent_id: id });
		}
		const patch = /^\/v1\/convai\/(tools|agents)\/([^/]+)$/.exec(path);
		if (method === "PATCH" && patch) {
			const store = patch[1] === "tools" ? this.tools : this.agents;
			const id = patch[2] ?? "";
			if (!store.has(id)) return this.#error(404, { status: "document_not_found", message: `Document with id ${id} not found.` });
			store.set(id, body ?? {});
			return jsonResponse({ id });
		}
		const read = /^\/v1\/convai\/(tools|agents)\/([^/]+)$/.exec(path);
		if (method === "GET" && read) {
			const agents = read[1] === "agents";
			const id = read[2] ?? "";
			const held = (agents ? this.agents : this.tools).get(id);
			if (!held) return this.#error(404, { status: "document_not_found", message: `Document with id ${id} not found.` });
			return jsonResponse(agents ? { agent_id: id, ...held } : { id, ...held });
		}
		if (method === "GET" && path === "/v1/convai/conversation/get-signed-url") {
			if (this.signedUrlRefusal !== undefined) return this.#error(this.signedUrlRefusal, { status: "document_not_found", code: "agent_not_found", message: PROVIDER_TEXT });
			const id = url.searchParams.get("agent_id") ?? "";
			if (!this.agents.has(id)) return this.#error(404, { status: "document_not_found", code: "agent_not_found", message: `Agent with ID '${id}' not found.` });
			return jsonResponse({ signed_url: SIGNED_URL.replace("agent_1", id) });
		}
		throw new Error(`unexpected request: ${method} ${path}`);
	}
}

// ---- the agent socket -----------------------------------------------------------------------------

export class FakeAgentSocket implements ConvaiSocket {
	readyState = 0;
	readonly sent: string[] = [];
	closedByClient = false;
	onopen: (() => void) | null = null;
	onmessage: ((message: { readonly data: unknown }) => void) | null = null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	constructor(readonly url: string) {}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code = 1000): void {
		if (this.readyState === 3) return;
		this.closedByClient = true;
		this.readyState = 3;
		queueMicrotask(() => this.onclose?.({ code, reason: "" }));
	}

	/** Every frame the client sent, parsed. */
	get frames(): Record<string, unknown>[] {
		return this.sent.map(text => JSON.parse(text) as Record<string, unknown>);
	}

	framesOfType(type: string): Record<string, unknown>[] {
		return this.frames.filter(frame => frame.type === type);
	}

	// Server side.
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(frame: object): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	/** The server ends the connection. */
	serverClose(code: number, reason = ""): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}

	/** Resolves once the client has sent a frame of this type (beyond `already` earlier ones). */
	async whenSent(type: string, already = 0): Promise<Record<string, unknown>> {
		return withTimeout(
			(async () => {
				for (;;) {
					const found = this.framesOfType(type)[already];
					if (found) return found;
					await settle();
				}
			})(),
			`a ${type} frame`,
		);
	}
}

// ---- frames the agent sends --------------------------------------------------------------------------

export const frames = {
	metadata: (format = "pcm_16000") => ({
		type: "conversation_initiation_metadata",
		conversation_initiation_metadata_event: { conversation_id: "conv_1", agent_output_audio_format: format, user_input_audio_format: format },
	}),
	audio: (bytes: Uint8Array, eventId = 1) => ({
		type: "audio",
		audio_event: { audio_base_64: Buffer.from(bytes).toString("base64"), event_id: eventId, alignment: { chars: [] } },
	}),
	user: (text: string) => ({ type: "user_transcript", user_transcription_event: { user_transcript: text, event_id: 1 } }),
	agent: (text: string, responseId = `resp-${text.length}`) => ({
		type: "agent_response",
		agent_response_event: { agent_response: text, event_id: 1, response_id: responseId },
	}),
	correction: (original: string, corrected: string, responseId: string) => ({
		type: "agent_response_correction",
		agent_response_correction_event: { original_agent_response: original, corrected_agent_response: corrected, response_id: responseId },
	}),
	tool: (callId: string, parameters: unknown, name = "delegate_to_agent") => ({
		type: "client_tool_call",
		client_tool_call: { tool_name: name, tool_call_id: callId, parameters, event_id: 1, expects_response: false },
	}),
	complete: () => ({ type: "agent_response_complete", agent_response_complete_event: { event_id: 1 } }),
	interruption: () => ({ type: "interruption", interruption_event: { event_id: 2 } }),
	ping: (eventId: number, pingMs: number | null) => ({ type: "ping", ping_event: { event_id: eventId, ping_ms: pingMs } }),
};

// ---- the rig ---------------------------------------------------------------------------------------------

/** Everything a call emits, collected in the background, with waits that never outlive the test. */
export class EventLog {
	readonly events: ConverseEvent[] = [];
	#done = false;

	constructor(session: ConverseSession) {
		void (async () => {
			for await (const event of session.events) this.events.push(event);
			this.#done = true;
		})();
	}

	of<T extends ConverseEvent["t"]>(t: T): Extract<ConverseEvent, { t: T }>[] {
		return this.events.filter((event): event is Extract<ConverseEvent, { t: T }> => event.t === t);
	}

	get phases(): string[] {
		return this.of("phase").map(event => event.phase);
	}

	async settled(): Promise<ConverseEvent[]> {
		await withTimeout(
			(async () => {
				while (!this.#done) await settle();
			})(),
			"the event stream to complete",
		);
		return this.events;
	}
}

export interface LiveRig {
	readonly api: FakeAgentsApi;
	/** The provider under test. {@link restart} swaps in a fresh instance over the same home and account. */
	provider: SpeechProvider;
	readonly ctx: SpeechProviderContext;
	readonly home: string;
	readonly sockets: FakeAgentSocket[];
	/** A restarted engine: a new provider with no memory, the same home on disk, the same ElevenLabs account. */
	restart(): void;
	/** Resolves when the engine opens its Nth agent socket. */
	socket(index?: number): Promise<FakeAgentSocket>;
}

export async function makeLiveRig(
	harness: Harness,
	options: { readonly finalHoldMs?: number; readonly scope?: Scope } = {},
): Promise<LiveRig> {
	const base = await makeRig(harness);
	const api = new FakeAgentsApi();
	if (options.scope) api.scope = options.scope;
	const sockets: FakeAgentSocket[] = [];
	const build = () =>
		createElevenLabsProvider({
			fetch: api.http.fetch,
			connectAgent: url => {
				const socket = new FakeAgentSocket(url);
				sockets.push(socket);
				return socket;
			},
			finalHoldMs: options.finalHoldMs ?? 40,
			userHome: base.home,
		});
	const rig: LiveRig = {
		api,
		provider: build(),
		ctx: base.ctx,
		home: base.home,
		sockets,
		restart: () => {
			rig.provider = build();
		},
		socket: index =>
			withTimeout(
				(async () => {
					for (;;) {
						const found = sockets[index ?? 0];
						if (found) return found;
						await settle();
					}
				})(),
				"the agent socket to be opened",
			),
	};
	return rig;
}

const openCalls: ConverseSession[] = [];

/** Hang up whatever a test left open (`afterEach`). */
export function hangUpAll(): void {
	for (const session of openCalls.splice(0)) session.close();
}

export interface Call {
	readonly session: ConverseSession;
	readonly socket: FakeAgentSocket;
	readonly log: EventLog;
}

export function openConverse(
	rig: LiveRig,
	entry: { model?: string; voice?: string } = {},
	opts: Partial<ConverseOpenOptions> = {},
): Promise<ConverseSession> {
	const open = rig.provider.openConverse;
	if (!open) throw new Error("provider has no openConverse");
	return open.call(rig.provider, rig.ctx, entry, {
		signal: new AbortController().signal,
		instructions: INSTRUCTIONS,
		agentName: "Aether",
		sessionId: "session-1",
		...opts,
	});
}

/** Open a call and walk the handshake: socket up, metadata in. */
export async function startCall(
	rig: LiveRig,
	entry: { model?: string; voice?: string } = {},
	format = "pcm_16000",
): Promise<Call> {
	const index = rig.sockets.length;
	const pending = openConverse(rig, entry);
	const socket = await rig.socket(index);
	socket.open();
	socket.receive(frames.metadata(format));
	const session = await pending;
	openCalls.push(session);
	return { session, socket, log: new EventLog(session) };
}

export function pcm(length: number, seed = 1): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => (i * 7 + seed) % 251);
}
