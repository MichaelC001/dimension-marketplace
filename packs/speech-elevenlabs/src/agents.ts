// The ElevenLabs Agents REST side of Live (doc 92 §8): adopt the account's own ONE shared agent and ONE
// client tool by name (or create them on first use), keep them in step with the body this code wants, and
// mint the short-lived signed URL a call connects with. The ids (never a secret) live in
// `<engine home>/speech/elevenlabs-agents.json` beside a hash of each body, so an edited body PATCHes the
// remote and a deleted remote is replaced by the account's other one or, failing that, recreated.
//
// The agent is generic on purpose: the persona, the first message and the voice arrive PER CALL as
// overrides (`convai.ts`), so nothing about a session is ever written to the account.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SpeechReadiness } from "@dimension/sdk/provider";
import { AGENT_NAME, agentBody, DEFAULT_CONVERSE_VOICE, TOOL_NAME, toolBody } from "./convai.js";
import { AGENTS_PERMISSION_DETAIL, ElevenLabsError, httpFailure, reachFetch } from "./failure.js";
import { API_HOST, isRecord } from "./protocol.js";

const RECORD_FILE = join("speech", "elevenlabs-agents.json");
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TTL_MS = 5 * 60_000;
/** A failed probe (offline, a blip) is retried soon rather than pinning "unavailable" for minutes. */
const PROBE_FAILURE_TTL_MS = 30_000;
const LIST_PAGE_SIZE = 100;
const LIST_PAGE_LIMIT = 10;

interface AgentRecord {
	readonly version: 1;
	readonly agentId: string;
	readonly toolId: string;
	readonly toolHash: string;
	readonly agentHash: string;
}

function hashOf(body: unknown): string {
	return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): AgentRecord | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const { agentId, toolId, toolHash, agentHash } = value;
	if (typeof agentId !== "string" || typeof toolId !== "string") return undefined;
	if (typeof toolHash !== "string" || typeof agentHash !== "string") return undefined;
	return { version: 1, agentId, toolId, toolHash, agentHash };
}

type Json = Record<string, unknown>;

interface Adopted {
	readonly agentId: string;
	readonly toolId: string;
	readonly agent: Json;
	readonly tool: Json;
}

interface EnsureArgs extends MintArgs {
	readonly verify?: boolean;
}

interface Provisioned {
	readonly agentId: string;
	readonly toolId: string;
	readonly settled: boolean;
}

export function covers(held: unknown, wanted: unknown): boolean {
	if (Array.isArray(wanted)) {
		return Array.isArray(held) && held.length === wanted.length && wanted.every((item, at) => covers(held[at], item));
	}
	if (isRecord(wanted))
		return isRecord(held) && Object.entries(wanted).every(([key, value]) => covers(held[key], value));
	return Object.is(held, wanted);
}

function toolIdsOf(agent: Json): readonly string[] {
	const config = agent.conversation_config;
	const promptHolder = isRecord(config) && isRecord(config.agent) ? config.agent.prompt : undefined;
	const ids = isRecord(promptHolder) ? promptHolder.tool_ids : undefined;
	return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function isOurTool(row: Json): boolean {
	const config = row.tool_config;
	return typeof row.id === "string" && isRecord(config) && config.name === TOOL_NAME && config.type === "client";
}

function createdAt(row: Json): number {
	return typeof row.created_at_unix_secs === "number" ? row.created_at_unix_secs : Number.MAX_SAFE_INTEGER;
}

function oldestFirst(a: Json, b: Json): number {
	return createdAt(a) - createdAt(b) || String(a.agent_id).localeCompare(String(b.agent_id));
}

function isOwned(row: unknown): row is Json {
	return isRecord(row) && isRecord(row.access_info) && row.access_info.is_creator === true;
}

export interface MintArgs {
	readonly apiKey: string;
	/** The engine home: where the ids are kept. */
	readonly home: string;
	/** The agent's TTS model (`eleven_v4_turbo` / `eleven_v4`). */
	readonly ttsModel: string;
	readonly signal: AbortSignal;
}

export class Agents {
	readonly #fetch: typeof fetch;
	/** Provisioning for one home is serial: two calls must not both create an agent. */
	readonly #tails = new Map<string, Promise<unknown>>();
	readonly #probes = new Map<string, { readonly at: number; readonly result: Promise<SpeechReadiness>; ok: boolean }>();
	readonly #now: () => number;

	constructor(doFetch: typeof fetch, now: () => number = Date.now) {
		this.#fetch = doFetch;
		this.#now = now;
	}

	async #call(
		apiKey: string,
		method: string,
		path: string,
		body: unknown,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const res = await reachFetch(this.#fetch, `https://${API_HOST}${path}`, {
			method,
			headers: { "xi-api-key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const text = await res.text();
		let json: unknown;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			json = undefined;
		}
		if (!res.ok) throw httpFailure(res.status, text, "converse");
		return json;
	}

	// ---- the stored ids ---------------------------------------------------------------------------

	async #read(home: string): Promise<AgentRecord | undefined> {
		try {
			return asRecord(JSON.parse(await readFile(join(home, RECORD_FILE), "utf8")));
		} catch {
			return undefined;
		}
	}

	async #write(home: string, record: AgentRecord): Promise<void> {
		const path = join(home, RECORD_FILE);
		await mkdir(dirname(path), { recursive: true });
		const scratch = `${path}.${process.pid}.tmp`;
		await writeFile(scratch, `${JSON.stringify(record, null, "\t")}\n`);
		await rename(scratch, path);
	}

	#serial<T>(home: string, work: () => Promise<T>): Promise<T> {
		const run = (this.#tails.get(home) ?? Promise.resolve()).then(work);
		this.#tails.set(
			home,
			run.catch(() => undefined),
		);
		return run;
	}

	// ---- provisioning -------------------------------------------------------------------------------

	/**
	 * The agent id. A home with no ids adopts the account's own `dimension-live` agent by name (a wiped engine
	 * home, a second machine) and creates the tool and the agent only when the account holds none; whichever
	 * body differs from what this code wants is PATCHed. `verify` re-checks the remote even when the stored
	 * hashes match (after a call found the agent gone).
	 */
	ensure(args: EnsureArgs): Promise<Provisioned> {
		return this.#serial(args.home, async () => this.#provision(args, await this.#read(args.home)));
	}

	async #provision(args: EnsureArgs, stored: AgentRecord | undefined): Promise<Provisioned> {
		const { apiKey, home, ttsModel, signal, verify = false } = args;
		const wantedTool = toolBody();
		const toolHash = hashOf(wantedTool);

		let toolId = stored?.toolId || undefined;
		let agentId = stored?.agentId || undefined;
		let heldTool: Json | undefined;
		let heldAgent: Json | undefined;

		if (toolId && (stored?.toolHash !== toolHash || verify)) {
			const exists = await this.#settle(
				apiKey,
				`/v1/convai/tools/${toolId}`,
				wantedTool,
				stored?.toolHash === toolHash,
				signal,
			);
			if (!exists) toolId = undefined;
		}
		if (!agentId) {
			const adopted = await this.#adopt(apiKey, signal);
			if (adopted) {
				agentId = adopted.agentId;
				toolId = adopted.toolId;
				heldAgent = adopted.agent;
				heldTool = adopted.tool;
			}
		}
		if (!toolId) {
			const created = await this.#call(apiKey, "POST", "/v1/convai/tools", wantedTool, signal);
			toolId = isRecord(created) && typeof created.id === "string" ? created.id : undefined;
			if (!toolId) throw new Error("ElevenLabs created the delegate tool but returned no id");
			// Keep the new tool before the agent step can fail or be cancelled: the next call must find it, not POST another.
			await this.#write(home, {
				version: 1,
				agentId: agentId ?? "",
				agentHash: stored?.agentHash ?? "",
				toolId,
				toolHash,
			});
		} else if (heldTool && !covers(heldTool, wantedTool)) {
			await this.#call(apiKey, "PATCH", `/v1/convai/tools/${toolId}`, wantedTool, signal);
		}

		const wantedAgent = agentBody(toolId, ttsModel, DEFAULT_CONVERSE_VOICE);
		const agentHash = hashOf(wantedAgent);
		let settled = true;
		if (agentId && heldAgent) {
			if (!covers(heldAgent, wantedAgent))
				await this.#call(apiKey, "PATCH", `/v1/convai/agents/${agentId}`, wantedAgent, signal);
		} else if (agentId && (stored?.agentHash !== agentHash || verify)) {
			const exists = await this.#settle(
				apiKey,
				`/v1/convai/agents/${agentId}`,
				wantedAgent,
				stored?.agentHash === agentHash,
				signal,
			);
			if (!exists)
				return this.#provision(
					{ ...args, verify: false },
					{ version: 1, agentId: "", agentHash: "", toolId, toolHash },
				);
		} else if (agentId) {
			settled = false;
		}
		if (!agentId) {
			const created = await this.#call(apiKey, "POST", "/v1/convai/agents/create", wantedAgent, signal);
			agentId = isRecord(created) && typeof created.agent_id === "string" ? created.agent_id : undefined;
			if (!agentId) throw new Error("ElevenLabs created the live agent but returned no id");
		}

		const record: AgentRecord = { version: 1, agentId, toolId, toolHash, agentHash };
		if (
			stored?.agentId !== agentId ||
			stored.toolId !== toolId ||
			stored.toolHash !== toolHash ||
			stored.agentHash !== agentHash
		) {
			await this.#write(home, record);
		}
		return { agentId, toolId, settled };
	}

	async #settle(
		apiKey: string,
		path: string,
		wanted: Json,
		readFirst: boolean,
		signal: AbortSignal,
	): Promise<boolean> {
		try {
			if (readFirst && covers(await this.#call(apiKey, "GET", path, undefined, signal), wanted)) return true;
			// The PATCH doubles as the existence check: a deleted tool or agent is a 404.
			await this.#call(apiKey, "PATCH", path, wanted, signal);
			return true;
		} catch (error) {
			if (error instanceof ElevenLabsError && error.status === 404) return false;
			throw error;
		}
	}

	async #listNamed(apiKey: string, resource: "agents" | "tools", name: string, signal: AbortSignal): Promise<Json[]> {
		const rows: Json[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
			const query = new URLSearchParams({
				search: name,
				page_size: String(LIST_PAGE_SIZE),
				created_by_user_id: "@me",
			});
			if (cursor) query.set("cursor", cursor);
			const body = await this.#call(apiKey, "GET", `/v1/convai/${resource}?${query}`, undefined, signal);
			const batch = isRecord(body) ? body[resource] : undefined;
			if (Array.isArray(batch)) rows.push(...batch.filter(isOwned));
			cursor =
				isRecord(body) && body.has_more === true && typeof body.next_cursor === "string"
					? body.next_cursor
					: undefined;
			if (!cursor) break;
		}
		return rows;
	}

	async #adopt(apiKey: string, signal: AbortSignal): Promise<Adopted | undefined> {
		const tools = (await this.#listNamed(apiKey, "tools", TOOL_NAME, signal)).filter(isOurTool);
		if (tools.length === 0) return undefined;
		const agents = (await this.#listNamed(apiKey, "agents", AGENT_NAME, signal))
			.filter(row => typeof row.agent_id === "string" && row.name === AGENT_NAME && row.archived !== true)
			.sort(oldestFirst);
		for (const row of agents) {
			const agentId = String(row.agent_id);
			const agent = await this.#call(apiKey, "GET", `/v1/convai/agents/${agentId}`, undefined, signal);
			if (!isRecord(agent)) continue;
			const attached = toolIdsOf(agent);
			const tool = tools.find(candidate => attached.includes(String(candidate.id)));
			if (tool) return { agentId, toolId: String(tool.id), agent, tool };
		}
		return undefined;
	}

	/**
	 * The ids no longer match the account (a socket refused an override the agent should allow): forget
	 * the hashes so the next call re-sends the full body.
	 */
	forget(home: string): Promise<void> {
		return this.#serial(home, async () => {
			const stored = await this.#read(home);
			if (stored) await this.#write(home, { ...stored, toolHash: "", agentHash: "" });
		});
	}

	/**
	 * A fresh signed socket URL for the shared agent (15-minute start window; mint per connect, never
	 * cache). If the agent turns out to be gone (deleted remotely, or the key now belongs to another
	 * account) it is recreated once and the mint retried.
	 */
	async mintSignedUrl(args: MintArgs): Promise<string> {
		const provisioned = await this.ensure(args);
		try {
			return await this.#mint(args, provisioned);
		} catch (error) {
			if (!(error instanceof ElevenLabsError && error.status === 404)) throw error;
			return this.#mint(args, await this.ensure({ ...args, verify: true }));
		}
	}

	async #mint(args: MintArgs, { agentId, toolId, settled }: Provisioned): Promise<string> {
		if (settled) return this.#signedUrl(args, agentId);
		const [held, url] = await Promise.all([
			this.#call(args.apiKey, "GET", `/v1/convai/agents/${agentId}`, undefined, args.signal),
			this.#signedUrl(args, agentId),
		]);
		if (!covers(held, { conversation_config: { tts: { model_id: args.ttsModel } } })) {
			const wanted = agentBody(toolId, args.ttsModel, DEFAULT_CONVERSE_VOICE);
			await this.#call(args.apiKey, "PATCH", `/v1/convai/agents/${agentId}`, wanted, args.signal);
		}
		return url;
	}

	async #signedUrl({ apiKey, signal }: MintArgs, agentId: string): Promise<string> {
		const body = await this.#call(
			apiKey,
			"GET",
			`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
			undefined,
			signal,
		);
		const url = isRecord(body) ? body.signed_url : undefined;
		if (typeof url !== "string" || !url.startsWith("wss://")) throw new Error("ElevenLabs returned no signed URL for the live agent");
		return url;
	}

	// ---- readiness ------------------------------------------------------------------------------------

	/**
	 * Whether this key can use Agents: one cheap authorized read, cached per key. A key limited to Text to
	 * Speech answers 401/403 `missing_permissions`. (Only the read scope is probed; the write scope is
	 * proved by the first provisioning call, which names the permission if it is refused.)
	 */
	probe(apiKey: string): Promise<SpeechReadiness> {
		const id = hashOf(apiKey);
		const cached = this.#probes.get(id);
		if (cached && this.#now() - cached.at < (cached.ok ? PROBE_TTL_MS : PROBE_FAILURE_TTL_MS)) return cached.result;
		const entry = { at: this.#now(), ok: false, result: this.#probe(apiKey) };
		this.#probes.set(id, entry);
		void entry.result.then(result => {
			entry.ok = result.ready;
		});
		return entry.result;
	}

	async #probe(apiKey: string): Promise<SpeechReadiness> {
		try {
			await this.#call(apiKey, "GET", "/v1/convai/agents?page_size=1", undefined, undefined);
			return { ready: true };
		} catch (error) {
			if (error instanceof ElevenLabsError && (error.status === 401 || error.status === 403)) {
				const permissions = error.message.includes(AGENTS_PERMISSION_DETAIL);
				return { ready: false, reason: "needs-key", detail: permissions ? AGENTS_PERMISSION_DETAIL : error.message };
			}
			const why = error instanceof ElevenLabsError ? error.message : "could not reach ElevenLabs";
			return { ready: false, reason: "unavailable", detail: why };
		}
	}
}
