// The Jev router pack (doc 80 §4.1): the System One request it builds, the
// thresholds that turn Jev's probabilities into `{ lead, contributors, scores }`,
// and the one HTTP call it makes. Every case runs on an injected fetch and key:
// no network, no real credential.

import { describe, expect, test } from "bun:test";
import type { RouterRequest } from "@dimension/sdk/provider";
import { buildJevRequest, createJevRouter, JEV_MODEL, mapJevAnswers, TYPESAFE_ENDPOINT } from "../index.ts";

function requestFor(...ids: string[]): RouterRequest {
	return {
		room: { id: "r1", title: "Support" },
		post: { author: { kind: "human", id: "owner" }, text: "who handles billing?" },
		recent: [{ author: { kind: "human", id: "bob" }, text: "earlier" }],
		candidates: ids.map(id => ({ id, card: `${id} card` })),
	};
}

interface Question {
	type: string;
	instructions: { readonly candidate?: { readonly id: string } } | string;
	criteria: Record<string, string>;
}

function questionsOf(request: RouterRequest): { questions: Record<string, Question>; none: string } {
	const { body, none } = buildJevRequest(request);
	return { questions: body.questions as Record<string, Question>, none };
}

describe("buildJevRequest", () => {
	test("one noul per candidate, each naming its own candidate; one `lead` choice over every candidate plus nobody", () => {
		const request = requestFor("a1", "none", "a3");
		const { questions, none } = questionsOf(request);
		const nouls = Object.values(questions).filter(question => question.type === "noul");
		expect(nouls.map(question => typeof question.instructions === "object" && question.instructions.candidate?.id)).toEqual([
			"a1",
			"none",
			"a3",
		]);
		expect(questions.lead?.type).toBe("choice");
		expect(Object.keys(questions.lead?.criteria ?? {}).sort()).toEqual(["a1", "a3", "none", none].sort());
		// A candidate literally named "none" is still a candidate, not "nobody".
		expect(none).not.toBe("none");
		expect(questions.lead?.criteria.none).toBe("none card");
	});

	test("the nobody key never collides with a candidate id", () => {
		for (const ids of [["a1"], ["none"], ["none", "nobody"], ["none", "nobody", "no-agent"]]) {
			expect(ids).not.toContain(buildJevRequest(requestFor(...ids)).none);
		}
	});
});

const THRESHOLDS = { lead: 0.5, respond: 0.7 };

/** A System One response: a noul per candidate index, and the lead choice. */
function response(nouls: number[], lead: { choice: string; confidence: number }) {
	const answers: Record<string, unknown> = { lead: { type: "choice", ...lead } };
	nouls.forEach((noul, index) => {
		answers[`respond_${index}`] = { type: "noul", noul };
	});
	return { model: JEV_MODEL, answers };
}

describe("mapJevAnswers", () => {
	const request = requestFor("a1", "a2", "a3", "a4");
	const rows: { name: string; nouls: number[]; lead: { choice: string; confidence: number }; leads: string | null; contributors: string[] }[] = [
		{
			name: "confidence exactly at the lead threshold leads; contributors are ≥ respond, highest first, lead excluded",
			nouls: [0.7, 0.69, 0.95, 0.99],
			lead: { choice: "a4", confidence: 0.5 },
			leads: "a4",
			contributors: ["a3", "a1"],
		},
		{
			name: "confidence just under the lead threshold gives no lead; the would-be lead may contribute",
			nouls: [0.1, 0.8, 0.1, 0.9],
			lead: { choice: "a4", confidence: 0.49 },
			leads: null,
			contributors: ["a4", "a2"],
		},
		{
			name: "choosing nobody gives no lead",
			nouls: [0.1, 0.1, 0.1, 0.1],
			lead: { choice: "none", confidence: 0.99 },
			leads: null,
			contributors: [],
		},
		{
			name: "a choice that is not a candidate gives no lead",
			nouls: [0.9, 0.1, 0.1, 0.1],
			lead: { choice: "ghost", confidence: 0.99 },
			leads: null,
			contributors: ["a1"],
		},
	];
	for (const row of rows) {
		test(row.name, () => {
			const answer = mapJevAnswers(request, response(row.nouls, row.lead), "none", THRESHOLDS);
			expect([answer.lead, answer.contributors]).toEqual([row.leads, row.contributors]);
		});
	}

	test("scores map each candidate id to its noul", () => {
		const answer = mapJevAnswers(request, response([0.1, 0.2, 0.3, 0.4], { choice: "none", confidence: 1 }), "none", THRESHOLDS);
		expect(answer.scores).toEqual({ a1: 0.1, a2: 0.2, a3: 0.3, a4: 0.4 });
	});

	test("a candidate literally named `none` can be chosen to lead: it is not the nobody key", () => {
		const withNone = requestFor("none", "a2");
		const { none } = buildJevRequest(withNone);
		const answer = mapJevAnswers(withNone, response([0.1, 0.1], { choice: "none", confidence: 0.9 }), none, THRESHOLDS);
		expect(answer.lead).toBe("none");
	});
});

describe("createJevRouter", () => {
	function fakeFetch(reply: () => Response) {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return reply();
		}) as typeof globalThis.fetch;
		return { calls, fetch };
	}

	test("posts Bearer-authenticated JSON for jev-latest to the System One endpoint, with the host's signal", async () => {
		const fake = fakeFetch(() => Response.json(response([0.9, 0.2], { choice: "a1", confidence: 0.8 })));
		const router = createJevRouter({ apiKey: async () => "test-key", fetch: fake.fetch });
		const signal = new AbortController().signal;
		const answer = await router.route(requestFor("a1", "a2"), { signal });
		const call = fake.calls[0];
		expect(fake.calls).toHaveLength(1);
		expect(call?.url).toBe(TYPESAFE_ENDPOINT);
		expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer test-key");
		expect(JSON.parse(String(call?.init.body)).model).toBe(JEV_MODEL);
		expect(call?.init.signal).toBe(signal);
		expect([answer.lead, answer.contributors]).toEqual(["a1", []]);
	});

	test("a non-2xx answer throws, naming the status", async () => {
		const fake = fakeFetch(() => new Response("overloaded", { status: 529 }));
		const router = createJevRouter({ apiKey: async () => "test-key", fetch: fake.fetch });
		await expect(router.route(requestFor("a1"), { signal: new AbortController().signal })).rejects.toThrow("529");
	});
});
