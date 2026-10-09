import { describe, expect, test } from "bun:test";
import {
	ElevenLabsError,
	handshakeFailureMessage,
	httpFailure,
	plainMessage,
	reachFetch,
	type Capability,
} from "../src/failure.js";

const SECRET = "SECRET-PROVIDER-TEXT";

function body(status: string, message = SECRET): string {
	return JSON.stringify({ detail: { status, message } });
}

function expectPlain(message: string): void {
	expect(message).not.toMatch(/\d{3}/);
	expect(message).not.toMatch(/[{}]/);
	expect(message).not.toMatch(/https?:/i);
	expect(message).not.toContain(SECRET);
}

describe("httpFailure", () => {
	test.each<{ name: string; status: number; text: string; capability: Capability; says: RegExp }>([
		{
			name: "401 unknown key",
			status: 401,
			text: body("invalid_api_key"),
			capability: "speak",
			says: /^ElevenLabs rejected the API key$/,
		},
		{
			name: "401 without a body",
			status: 401,
			text: "",
			capability: "listen",
			says: /^ElevenLabs rejected the API key$/,
		},
		{
			name: "401 missing_permissions (speak)",
			status: 401,
			text: body("missing_permissions"),
			capability: "speak",
			says: /Text to Speech permission/,
		},
		{
			name: "401 missing_permissions (listen)",
			status: 401,
			text: body("missing_permissions"),
			capability: "listen",
			says: /Speech to Text permission/,
		},
		{
			name: "401 missing_permissions (converse)",
			status: 401,
			text: body("missing_permissions"),
			capability: "converse",
			says: /convai read \+ write/,
		},
		{
			name: "401 naming a permission in words only",
			status: 401,
			text: body("unauthorized", "missing the permission convai_read"),
			capability: "converse",
			says: /convai read \+ write/,
		},
		{ name: "403", status: 403, text: body("forbidden"), capability: "speak", says: /Text to Speech permission/ },
		{
			name: "404",
			status: 404,
			text: body("not_found"),
			capability: "speak",
			says: /did not accept the voice request \(check the model and the voice id\)/,
		},
		{
			name: "404 listening",
			status: 404,
			text: "",
			capability: "listen",
			says: /did not accept the listening request \(check the model and the language\)/,
		},
		{
			name: "422",
			status: 422,
			text: body("validation_error"),
			capability: "converse",
			says: /^ElevenLabs did not accept the Agents call$/,
		},
		{
			name: "429",
			status: 429,
			text: body("too_many_concurrent_requests"),
			capability: "speak",
			says: /busy, or the key has reached its limit/,
		},
		{
			name: "a quota refusal that arrives as a 401",
			status: 401,
			text: body("quota_exceeded"),
			capability: "speak",
			says: /busy, or the key has reached its limit/,
		},
		{ name: "500", status: 500, text: SECRET, capability: "speak", says: /problem on its side/ },
		{ name: "503", status: 503, text: body("unavailable"), capability: "converse", says: /problem on its side/ },
	])(
		"$name is one plain sentence, with the status on the error and none of the provider's words",
		({ status, text, capability, says }) => {
			const error = httpFailure(status, text, capability);
			expect(error).toBeInstanceOf(ElevenLabsError);
			expect(error.status).toBe(status);
			expect(error.unreachable).toBeUndefined();
			expect(error.message).toMatch(says);
			expectPlain(error.message);
		},
	);
});

describe("handshakeFailureMessage", () => {
	test.each([
		{ name: "401", status: 401, text: body("invalid_api_key"), says: "rejected the API key" },
		{ name: "403", status: 403, text: `{"detail":"${SECRET}"}`, says: "rejected the API key" },
		{
			name: "401 lacking a permission is not the key's fault",
			status: 401,
			text: body("missing_permissions"),
			says: "refused the voice connection",
		},
		{
			name: "200: the server accepted the request but refused the socket",
			status: 200,
			text: SECRET,
			says: "refused the voice connection",
		},
		{ name: "429", status: 429, text: SECRET, says: "busy, or the key has reached its limit" },
		{ name: "500", status: 500, text: SECRET, says: "problem on its side" },
	])("$name", ({ status, text, says }) => {
		const message = handshakeFailureMessage(status, text);
		expect(message).toContain(says);
		expect(message).not.toContain(SECRET);
		if (says === "refused the voice connection") expect(message).not.toContain("rejected the API key");
	});
});

describe("plainMessage", () => {
	test("the pack's own sentences pass; anything else is replaced by the fallback", () => {
		expect(plainMessage(new ElevenLabsError("ElevenLabs rejected the API key"), "fallback")).toBe(
			"ElevenLabs rejected the API key",
		);
		expect(plainMessage(new Error(SECRET), "fallback")).toBe("fallback");
		expect(plainMessage(SECRET, "fallback")).toBe("fallback");
	});
});

describe("reachFetch", () => {
	test("an HTTP answer of any status is returned, never thrown", async () => {
		const answer = new Response("nope", { status: 500 });
		expect(await reachFetch((async () => answer) as unknown as typeof fetch, "https://x.test/", {})).toBe(answer);
	});

	test("a request that never got an answer is unreachable, carries the runtime's network code, and none of its words", async () => {
		const refused = Object.assign(new Error(`Unable to connect ${SECRET}`), { code: "ConnectionRefused" });
		const error = await reachFetch(
			(() => Promise.reject(refused)) as unknown as typeof fetch,
			"https://x.test/",
			{},
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ElevenLabsError);
		const failure = error as ElevenLabsError;
		expect(failure.unreachable).toBe(true);
		expect(failure.code).toBe("ConnectionRefused");
		expect(failure.status).toBeUndefined();
		expect(failure.message).toBe("Could not reach ElevenLabs");
	});

	test("a runtime error with no code is still unreachable, and says so without inventing a code", async () => {
		const error = (await reachFetch(
			(() => Promise.reject(new Error(SECRET))) as unknown as typeof fetch,
			"https://x.test/",
			{},
		).catch((caught: unknown) => caught)) as ElevenLabsError;
		expect(error.unreachable).toBe(true);
		expect(error.code).toBeUndefined();
		expect(error.message).not.toContain(SECRET);
	});

	test("the caller's own abort is a cancellation, not an unreachable ElevenLabs", async () => {
		const controller = new AbortController();
		const reason = new Error("hung up");
		const hanging = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) =>
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
			)) as unknown as typeof fetch;
		const pending = reachFetch(hanging, "https://x.test/", { signal: controller.signal });
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});

	test("our own timeout is unreachable", async () => {
		const timedOut = new AbortController();
		timedOut.abort(new DOMException("The operation timed out.", "TimeoutError"));
		const rejecting = ((_url: string, init: RequestInit) =>
			Promise.reject(init.signal?.reason)) as unknown as typeof fetch;
		const error = (await reachFetch(rejecting, "https://x.test/", { signal: timedOut.signal }).catch(
			(caught: unknown) => caught,
		)) as ElevenLabsError;

		expect(error).toBeInstanceOf(ElevenLabsError);
		expect(error.unreachable).toBe(true);
	});
});
