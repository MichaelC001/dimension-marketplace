// A room ROUTER provider backed by TypeSafe's Jev (doc 80 §4.1).
//
// When a human posts in a room and addresses nobody, the engine asks the
// room's router who should answer. This pack answers with ONE request to
// TypeSafe's System One API: a yes/no (`noul`) per candidate — "should this
// agent respond?" — and one `choice` of who leads, with an explicit "nobody".
// Independent questions in one request run in parallel on TypeSafe's side.
//
// The host owns every rule around the answer (candidate filter, reply cap,
// timeout, default-responder fall-through); this module only turns Jev's
// probabilities into `{ lead, contributors, scores }` and returns Jev's raw
// answers as `detail`, which the host keeps on the routing receipt — the
// labelled set these thresholds get tuned on.
//
// Sending room text to TypeSafe is opt-in PER ROOM: a room uses this router
// only when its owner names `jev` in the room policy. The API key comes from
// this pack's connect form, written to CONFIG_TARGET by the host; the module
// never logs it, never stores it anywhere else.
//
// Runtime imports are `node:` builtins only, so the engine can import this
// file as-is. Types come from `@dimension/sdk/provider` and are erased.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RouterAnswer, RouterProvider, RouterRequest } from "@dimension/sdk/provider";

/** MUST match `connect.configTarget` in plugin.json. */
const CONFIG_TARGET = join(homedir(), ".config", "dimension-router-jev", "key.json");

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** Starting thresholds from doc 80 §4.1. [UNVALIDATED]: tune them on the
 *  receipts (`detail` holds every raw answer), not by intuition. */
export const LEAD_CONFIDENCE_MIN = 0.5;
export const RESPOND_PROBABILITY_MIN = 0.7;

/** A Choice holds at most 255 options (TypeSafe API reference); one is "nobody". */
const MAX_CANDIDATES = 254;

export interface JevRouterOptions {
	/** Where the API key comes from. Default: the connect form's config file. */
	readonly apiKey?: () => Promise<string>;
	/** Test seam. */
	readonly fetch?: typeof fetch;
	readonly leadConfidenceMin?: number;
	readonly respondProbabilityMin?: number;
}

/** Read the API key the connect form wrote. Every error names the problem and
 *  never the file's content. `path` is the test seam; production reads the
 *  connect form's configTarget. */
export async function readConnectKey(path: string = CONFIG_TARGET): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new Error("router-jev is not connected — add a TypeSafe API key on the pack's Connect page");
	}
	// A parse error quotes the offending token — which in a hand-edited file IS
	// the key — and the host records a router's error on the room's receipt. So
	// the parse error is replaced, never passed on.
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		throw new Error("router-jev's stored key is not valid JSON — reconnect the pack");
	}
	const access = isRecord(stored) ? stored.access : undefined;
	if (typeof access !== "string" || access.trim() === "") {
		throw new Error("router-jev's stored key is empty — reconnect the pack");
	}
	return access.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the System One request for one routed post (doc 80 §4.1). */
export function buildJevRequest(request: RouterRequest): {
	readonly body: Record<string, unknown>;
	readonly none: string;
} {
	const ids = request.candidates.map(candidate => candidate.id);
	// The "nobody" option must not collide with a real agent id — including the
	// generated fallbacks, which an agent could also be named.
	let none = "none";
	for (let i = 0; ids.includes(none); i++) none = ["nobody", "no-agent"][i] ?? `none-${i}`;
	const questions: Record<string, unknown> = {};
	// One question per candidate, keyed by index. Question ids are never sent to
	// the model, so each question's instructions name their candidate themselves.
	request.candidates.forEach((candidate, index) => {
		questions[`respond_${index}`] = {
			type: "noul",
			instructions: {
				candidate: { id: candidate.id, role: candidate.card },
				question:
					"Should `candidate` respond to `post` in this room, given `recent`? Answer yes only if the post is something this agent's role is for.",
			},
			criteria: {
				true: "The post is squarely in this agent's role; its reply would be useful.",
				false: "The post is not for this agent, or another role clearly fits better.",
			},
		};
	});
	const leadCriteria: Record<string, string> = {};
	for (const candidate of request.candidates) leadCriteria[candidate.id] = candidate.card;
	leadCriteria[none] = "No agent here fits the post; nobody should lead a reply.";
	questions.lead = {
		type: "choice",
		instructions: "Which agent should lead the reply to `post`, given the room and `recent`?",
		criteria: leadCriteria,
	};
	return {
		body: {
			model: JEV_MODEL,
			state: {
				room: request.room,
				post: request.post,
				recent: request.recent,
			},
			questions,
		},
		none,
	};
}

/** Map Jev's answers to the router contract. Everything uncertain reads as
 *  "nobody": the host then hands the post to the default responder. */
export function mapJevAnswers(
	request: RouterRequest,
	response: unknown,
	none: string,
	thresholds: { readonly lead: number; readonly respond: number },
): RouterAnswer {
	if (!isRecord(response) || !isRecord(response.answers)) throw new Error("TypeSafe response has no `answers` map");
	const answers = response.answers;
	const scores: Record<string, number> = {};
	request.candidates.forEach((candidate, index) => {
		const answer = answers[`respond_${index}`];
		if (isRecord(answer) && answer.type === "noul" && typeof answer.noul === "number" && Number.isFinite(answer.noul))
			scores[candidate.id] = answer.noul;
	});
	const lead = answers.lead;
	const choice = isRecord(lead) && lead.type === "choice" ? lead.choice : undefined;
	const confidence = isRecord(lead) ? lead.confidence : undefined;
	const leadId =
		typeof choice === "string" &&
		choice !== none &&
		request.candidates.some(candidate => candidate.id === choice) &&
		typeof confidence === "number" &&
		confidence >= thresholds.lead
			? choice
			: null;
	const contributors = Object.entries(scores)
		.filter(([id, score]) => id !== leadId && score >= thresholds.respond)
		.sort((a, b) => b[1] - a[1])
		.map(([id]) => id);
	return {
		lead: leadId,
		contributors,
		scores,
		detail: {
			model: response.model,
			usage: response.usage,
			none,
			thresholds,
			answers,
		},
	};
}

export function createJevRouter(options: JevRouterOptions = {}): RouterProvider {
	const apiKey = options.apiKey ?? (() => readConnectKey());
	const doFetch = options.fetch ?? fetch;
	const thresholds = {
		lead: options.leadConfidenceMin ?? LEAD_CONFIDENCE_MIN,
		respond: options.respondProbabilityMin ?? RESPOND_PROBABILITY_MIN,
	};
	return {
		id: "jev",
		async route(request, { signal }) {
			if (request.candidates.length > MAX_CANDIDATES) {
				throw new Error(`router-jev ranks at most ${MAX_CANDIDATES} candidates; this room has ${request.candidates.length}`);
			}
			const { body, none } = buildJevRequest(request);
			const response = await doFetch(TYPESAFE_ENDPOINT, {
				method: "POST",
				headers: { authorization: `Bearer ${await apiKey()}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal,
			});
			// No retry on 429/529: the host's timeout leaves no room for a backoff,
			// and the default responder already answers a post the router could not.
			if (!response.ok) {
				const text = (await response.text().catch(() => "")).slice(0, 200);
				throw new Error(`TypeSafe ${response.status}${text ? `: ${text}` : ""}`);
			}
			return mapJevAnswers(request, await response.json(), none, thresholds);
		},
	};
}

/** The factory the engine's provider lane imports (doc 75 §2). */
export function createRouterProvider(): RouterProvider {
	return createJevRouter();
}
