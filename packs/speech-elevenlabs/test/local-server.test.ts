import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	ListenEvent,
	ListenSession,
	SpeakEvent,
	SpeakSession,
	SpeechProvider,
	SpeechProviderContext,
} from "@dimension/sdk/provider";
import { ElevenLabsError } from "../src/failure.js";
import { createElevenLabsProvider } from "../src/index.js";
import { deadPort, FakeElevenLabs, redirectTo, send } from "./local-server.js";
import {
	collect,
	Harness,
	KEY,
	ofType,
	pcmBytes,
	segmentLine,
	SEGMENT_MODEL,
	DIALOGUE_MODEL,
	VOICE,
	withTimeout,
} from "./support.js";

const SECRET = "SECRET-PROVIDER-TEXT";

const harness = new Harness();
let server: FakeElevenLabs;
const sessions: { close(): void }[] = [];

beforeEach(() => {
	server = new FakeElevenLabs();
});

afterEach(async () => {
	for (const session of sessions.splice(0)) session.close();
	server.stop();
	await harness.dispose();
});

async function connected(
	wire: { fetch: typeof fetch; connect: FakeElevenLabs["connect"] } = server,
): Promise<{ provider: SpeechProvider; ctx: SpeechProviderContext }> {
	const home = await harness.home();
	return {
		provider: createElevenLabsProvider({ fetch: wire.fetch, connect: wire.connect, userHome: home }),
		ctx: {
			home,
			cwd: home,
			env: { ELEVENLABS_API_KEY: KEY },
			settings: { get: () => undefined },
			credentials: { withAccess: () => Promise.reject(new Error("none")) },
		},
	};
}

async function speak(
	model: string,
	wire?: { fetch: typeof fetch; connect: FakeElevenLabs["connect"] },
): Promise<SpeakSession> {
	const { provider, ctx } = await connected(wire);
	const session = await provider.openSpeak!(
		ctx,
		{ model, voice: VOICE },
		{ signal: new AbortController().signal, audioTags: false },
	);
	sessions.push(session);
	return session;
}

async function openListen(
	options: { signal?: AbortSignal; wire?: { fetch: typeof fetch; connect: FakeElevenLabs["connect"] } } = {},
): Promise<ListenSession> {
	const { provider, ctx } = await connected(options.wire);
	const session = await provider.openListen!(
		ctx,
		{ model: "scribe_v2_realtime" },
		{ signal: options.signal ?? new AbortController().signal, endSilenceMs: 700 },
	);
	sessions.push(session);
	return session;
}

function failureOf(work: Promise<unknown>): Promise<ElevenLabsError> {
	return withTimeout(
		work.then(
			() => {
				throw new Error("expected a failure");
			},
			(error: unknown) => error as ElevenLabsError,
		),
		"the failure",
		4_000,
	);
}

describe("listen against a real socket", () => {
	test("a spoken utterance arrives as speech-start, speech-end and its final, and the key is only a header", async () => {
		server.scribe = (socket, message) => {
			if (message === null) {
				send(socket, { message_type: "session_started", session_id: "s1", config: {} });
				return;
			}
			const frame = JSON.parse(message) as { commit: boolean };
			if (frame.commit) send(socket, { message_type: "committed_transcript", text: "hello there" });
		};
		const session = await openListen();
		const events: ListenEvent[] = [];
		const finished = Promise.withResolvers<void>();
		void (async () => {
			for await (const event of session.events) {
				events.push(event);
				if (event.t === "final") finished.resolve();
			}
		})();
		session.push(pcmBytes(6_400));
		session.mute(true);
		await withTimeout(finished.promise, "the final", 4_000);

		expect(events).toEqual([{ t: "speech-start" }, { t: "speech-end" }, { t: "final", text: "hello there" }]);
		expect(server.keys).toEqual([KEY]);
		const audio = server.received.map(frame => JSON.parse(frame) as Record<string, unknown>);
		expect(audio.map(frame => [frame.message_type, frame.commit, frame.sample_rate])).toEqual([
			["input_audio_chunk", false, 16_000],
			["input_audio_chunk", true, 16_000],
		]);
		expect(server.requests[0]?.path).toBe("/v1/speech-to-text/realtime");
		await server.until(() => server.closed.includes("scribe"), "the released connection to close");
	});

	test.each([
		{ type: "auth_error", status: 401 },
		{ type: "unaccepted_terms", status: 403 },
		{ type: "quota_exceeded", status: 429 },
		{ type: "rate_limited", status: 429 },
		{ type: "resource_exhausted", status: 503 },
		{ type: "transcriber_error", status: 500 },
		{ type: "invalid_request", status: 400 },
	])(
		"$type while opening rejects the open with status $status and none of the provider's words",
		async ({ type, status }) => {
			server.scribe = (socket, message) => {
				if (message !== null) return;
				send(socket, { message_type: type, error: SECRET });
				socket.close(1000);
			};
			const error = await failureOf(openListen());

			expect(error).toBeInstanceOf(ElevenLabsError);
			expect(error.status).toBe(status);
			expect(error.unreachable).toBeUndefined();
			expect(error.message).not.toContain(SECRET);
			expect(error.message).not.toContain(KEY);
		},
	);

	test("a server that refuses the upgrade is unreachable, not a status the person sees", async () => {
		server.scribeRefusal = () => new Response(SECRET, { status: 401 });
		const error = await failureOf(openListen());

		expect(error.unreachable).toBe(true);
		expect(error.message).toBe("Could not reach ElevenLabs");
	});

	test("nothing listening on the port is unreachable", async () => {
		const error = await failureOf(openListen({ wire: redirectTo(await deadPort()) }));

		expect(error.unreachable).toBe(true);
		expect(error.status).toBeUndefined();
		expect(error.message).toBe("Could not reach ElevenLabs");
	});

	test("a server that hangs up after the open does not end the session: the engine closes it", async () => {
		server.scribe = (socket, message) => {
			if (message === null) {
				send(socket, { message_type: "session_started", session_id: "s1", config: {} });
				socket.close(1011);
			}
		};
		const session = await openListen();
		await server.until(() => server.closed.length === 1, "the server to hang up");
		const ended = Promise.withResolvers<"ended" | "kept">();
		void (async () => {
			try {
				for await (const _event of session.events) continue;
				ended.resolve("ended");
			} catch {
				ended.resolve("ended");
			}
		})();
		session.close();

		expect(await withTimeout(ended.promise, "the events to complete")).toBe("ended");
	});

	test("aborting while the socket is still being opened rejects with the abort's reason and the server sees the socket go", async () => {
		const controller = new AbortController();
		const reason = new Error("hung up");
		const pending = openListen({ signal: controller.signal });
		await server.until(() => server.requests.length === 1, "the socket to reach the server");
		controller.abort(reason);

		await expect(withTimeout(pending, "the open to reject", 4_000)).rejects.toBe(reason);
		await server.until(() => server.closed.includes("scribe"), "the socket to close");
	});
});

describe("speaking per segment against a real HTTP server", () => {
	test("audio and caption words come back, the key is a header, and the body names the model", async () => {
		server.tts = () =>
			new Response(segmentLine(pcmBytes(4_800), "Hi.") + segmentLine(undefined, undefined), { status: 200 });
		const session = await speak(SEGMENT_MODEL);
		session.push("Hi.");
		session.flush();
		const events = await collect(session);

		expect(ofType(events, "audio").length).toBeGreaterThan(0);
		expect(events.at(-1)).toEqual({ t: "end" });
		expect(server.keys).toEqual([KEY]);
		expect(server.requests[0]?.path).toContain(`/v1/text-to-speech/${VOICE}/stream/with-timestamps`);
		expect(JSON.parse(server.requests[0]?.body ?? "{}")).toEqual({ text: "Hi.", model_id: SEGMENT_MODEL });
	});

	test.each([
		{
			name: "401 unknown key",
			status: 401,
			body: { detail: { status: "invalid_api_key", message: SECRET } },
			says: /rejected the API key/,
		},
		{
			name: "401 without the permission",
			status: 401,
			body: { detail: { status: "missing_permissions", message: SECRET } },
			says: /Text to Speech permission/,
		},
		{
			name: "403",
			status: 403,
			body: { detail: { status: "forbidden", message: SECRET } },
			says: /Text to Speech permission/,
		},
		{
			name: "404 voice not found",
			status: 404,
			body: { detail: { status: "voice_not_found", message: SECRET } },
			says: /check the model and the voice id/,
		},
		{
			name: "429",
			status: 429,
			body: { detail: { status: "too_many_concurrent_requests", message: SECRET } },
			says: /busy, or the key has reached its limit/,
		},
		{ name: "500", status: 500, body: SECRET, says: /problem on its side/ },
		{ name: "503", status: 503, body: { detail: SECRET }, says: /problem on its side/ },
	])("$name fails the reply in plain words and nothing queued behind it is sent", async ({ status, body, says }) => {
		server.tts = () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
		const session = await speak(SEGMENT_MODEL);
		session.push("Hi.");
		session.push("Again.");
		session.flush();
		const events = await collect(session);

		expect(events.map(event => event.t)).toEqual(["error", "end"]);
		const message = ofType(events, "error")[0]!.message;
		expect(message).toMatch(says);
		expect(message).not.toContain(SECRET);
		expect(message).not.toMatch(/\d{3}/);
		expect(server.requests.filter(request => request.path.startsWith("/v1/text-to-speech/"))).toHaveLength(1);
	});

	test("a server that goes away mid-answer fails the reply in the pack's words, after the audio that did arrive", async () => {
		server.tts = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start: controller => {
						controller.enqueue(new TextEncoder().encode(segmentLine(pcmBytes(4_800), "Hi.")));
					},
				}),
				{ status: 200 },
			);
		const session = await speak(SEGMENT_MODEL);
		session.push("Hi.");
		session.flush();
		const events = await withTimeout(
			(async () => {
				const seen: SpeakEvent[] = [];
				for await (const event of session.events) {
					seen.push(event);
					if (event.t === "audio") server.stop();
				}
				return seen;
			})(),
			"the reply to end",
			4_000,
		);

		expect(events.map(event => event.t)).toEqual(["audio", "error", "end"]);
		expect(ofType(events, "error")[0]!.message).toBe("ElevenLabs speech stopped unexpectedly");
	});

	test("cancelling mid-answer ends the reply at once and the server sees the request go", async () => {
		const aborted = Promise.withResolvers<void>();
		server.tts = request => {
			request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			return new Response(
				new ReadableStream<Uint8Array>({
					start: controller => {
						controller.enqueue(new TextEncoder().encode(segmentLine(pcmBytes(4_800), "Hi.")));
					},
				}),
				{ status: 200 },
			);
		};
		const session = await speak(SEGMENT_MODEL);
		session.push("Hi.");
		await server.until(() => server.requests.length === 1, "the request to arrive");
		session.cancel();

		expect(await collect(session)).toEqual([{ t: "end" }]);
		await withTimeout(aborted.promise, "the server to see the abort", 4_000);
	});

	test("nothing listening is unreachable, said without the runtime's words", async () => {
		const session = await speak(SEGMENT_MODEL, redirectTo(await deadPort()));
		session.push("Hi.");
		session.flush();
		const events = await collect(session);

		expect(events).toEqual([{ t: "error", message: "Could not reach ElevenLabs" }, { t: "end" }]);
	});
});

describe("speaking over the dialogue socket against a real server", () => {
	test.each([
		{
			name: "a rejected key",
			status: 401,
			body: { detail: { status: "invalid_api_key", message: SECRET } },
			says: /rejected the API key/,
		},
		{
			name: "a key limited to speech",
			status: 401,
			body: { detail: { status: "missing_permissions", message: SECRET } },
			says: /refused the voice connection/,
		},
		{ name: "429", status: 429, body: { detail: SECRET }, says: /busy, or the key has reached its limit/ },
		{ name: "500", status: 500, body: SECRET, says: /problem on its side/ },
	])("a socket the server refuses is explained by one probe of the account: $name", async ({ status, body, says }) => {
		server.dialogueRefusal = () => new Response("refused", { status: 403 });
		server.user = () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
		const session = await speak(DIALOGUE_MODEL);
		session.push("Hi.");
		const events = await collect(session);

		expect(events.map(event => event.t)).toEqual(["error", "end"]);
		const message = ofType(events, "error")[0]!.message;
		expect(message).toMatch(says);
		expect(message).not.toContain(SECRET);
		expect(server.requests.filter(request => request.path === "/v1/user").map(request => request.key)).toEqual([KEY]);
	});

	test("nothing listening is unreachable", async () => {
		const session = await speak(DIALOGUE_MODEL, redirectTo(await deadPort()));
		session.push("Hi.");
		const events = await collect(session);

		expect(events).toEqual([{ t: "error", message: "Could not reach ElevenLabs" }, { t: "end" }]);
	});

	test("an error frame from the server is told in plain words", async () => {
		server.dialogue = (socket, message) => {
			if (message?.includes("inputs")) send(socket, { error: "invalid_voice_id", message: SECRET, code: 1008 });
		};
		const session = await speak(DIALOGUE_MODEL);
		session.push("Hi.");
		const events = await collect(session);

		expect(events.map(event => event.t)).toEqual(["error", "end"]);
		const message = ofType(events, "error")[0]!.message;
		expect(message).toMatch(/did not accept the voice request/);
		expect(message).not.toContain(SECRET);
	});

	test("a server that hangs up mid-reply fails the reply after the audio it sent", async () => {
		server.dialogue = (socket, message) => {
			if (message === null || !message.includes("inputs")) return;
			send(socket, { audio: Buffer.from(pcmBytes(4_800)).toString("base64") });
			socket.close(1011);
		};
		const session = await speak(DIALOGUE_MODEL);
		session.push("Hi.");
		const events = await collect(session);

		expect(events.map(event => event.t)).toEqual(["audio", "error", "end"]);
		expect(ofType(events, "error")[0]!.message).toBe("ElevenLabs closed the voice connection");
	});

	test("cancelling mid-reply ends it at once and the server sees the socket go", async () => {
		const session = await speak(DIALOGUE_MODEL);
		session.push("Hi.");
		await server.until(() => server.received.length >= 2, "the text to reach the server");
		session.cancel();

		expect(await collect(session)).toEqual([{ t: "end" }]);
		await server.until(() => server.closed.includes("dialogue"), "the socket to close");
	});
});
