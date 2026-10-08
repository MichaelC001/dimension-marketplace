import { afterEach, describe, expect, test } from "bun:test";
import type { ListenEvent, ListenSession } from "@dimension/sdk/provider";
import { ElevenLabsError } from "../src/failure.js";
import { openScribe, type ScribeListenOptions } from "../src/listen.js";
import { FakeNetwork, type FakeSocket, KEY, pcmBytes, settle, withTimeout } from "./support.js";

const SECRET = "SECRET-PROVIDER-TEXT";
const STARTED = { message_type: "session_started", session_id: "s1", config: {} };
const BYTES_PER_MS = 32;

const sessions: ListenSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.close();
});

class Transcript {
	readonly events: ListenEvent[] = [];
	error: unknown;
	done = false;

	constructor(session: ListenSession) {
		void (async () => {
			try {
				for await (const event of session.events) this.events.push(event);
			} catch (error) {
				this.error = error;
			}
			this.done = true;
		})();
	}

	get types(): string[] {
		return this.events.map(event => event.t);
	}

	get texts(): string[] {
		return this.events.flatMap(event => (event.t === "partial" || event.t === "final" ? [event.text] : []));
	}
}

interface Rig {
	readonly network: FakeNetwork;
	readonly controller: AbortController;
	readonly clock: { now: number };
	opened: Promise<ListenSession>;
	socket(index?: number): FakeSocket;
}

function begin(options: Partial<ScribeListenOptions> = {}): Rig {
	const network = new FakeNetwork();
	const controller = new AbortController();
	const clock = { now: 1_000 };
	const rig: Rig = {
		network,
		controller,
		clock,
		opened: openScribe({
			apiKey: KEY,
			model: "scribe_v2_realtime",
			endSilenceMs: 700,
			connect: network.connect,
			signal: controller.signal,
			now: () => clock.now,
			timing: { openTimeoutMs: 40, muteCommitWaitMs: 40, retryGapMs: 1_000, idleCloseMs: 10_000 },
			...options,
		}),
		socket: (index = 0) => {
			const socket = network.sockets[index];
			if (!socket) throw new Error(`no socket #${index}`);
			return socket;
		},
	};
	rig.opened.catch(() => undefined);
	return rig;
}

async function start(options: Partial<ScribeListenOptions> = {}) {
	const rig = begin(options);
	const socket = rig.socket();
	socket.open();
	socket.receive(STARTED);
	const session = await withTimeout(rig.opened, "the session to open");
	sessions.push(session);
	return { ...rig, session, first: socket, transcript: new Transcript(session) };
}

function audioFrames(
	socket: FakeSocket,
): { commit: boolean; bytes: Uint8Array; sampleRate: number; messageType: string }[] {
	return socket.frames
		.filter(frame => frame.audio_base_64 !== undefined)
		.map(frame => ({
			commit: frame.commit === true,
			bytes: new Uint8Array(Buffer.from(String(frame.audio_base_64), "base64")),
			sampleRate: Number(frame.sample_rate),
			messageType: String(frame.message_type),
		}));
}

async function until(done: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await settle();
	}
}

function sentBytes(socket: FakeSocket): number {
	return audioFrames(socket).reduce((total, frame) => total + frame.bytes.byteLength, 0);
}

describe("the connection", () => {
	test("asks for raw 16 kHz PCM with VAD commits, and the key rides a header, never the URL", async () => {
		const rig = begin({ language: "en", endSilenceMs: 700 });
		const socket = rig.socket();
		const url = new URL(socket.url);

		expect(url.protocol).toBe("wss:");
		expect(url.host).toBe("api.elevenlabs.io");
		expect(url.pathname).toBe("/v1/speech-to-text/realtime");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			model_id: "scribe_v2_realtime",
			audio_format: "pcm_16000",
			commit_strategy: "vad",
			vad_silence_threshold_secs: "0.7",
			language_code: "en",
		});
		expect(socket.url).not.toContain(KEY);
		expect(socket.headers["xi-api-key"]).toBe(KEY);
		socket.drop();
		await rig.opened.catch(() => undefined);
	});

	test("no language means no language_code, so Scribe decides", async () => {
		const rig = begin();
		expect(new URL(rig.socket().url).searchParams.has("language_code")).toBe(false);
		rig.socket().drop();
		await rig.opened.catch(() => undefined);
	});

	test.each([
		{ endSilenceMs: 200, sent: "0.3" },
		{ endSilenceMs: 300, sent: "0.3" },
		{ endSilenceMs: 1_500, sent: "1.5" },
		{ endSilenceMs: 3_000, sent: "3" },
		{ endSilenceMs: 5_000, sent: "3" },
	])(
		"the profile's $endSilenceMs ms silence is sent as $sent s, inside the range Scribe accepts",
		async ({ endSilenceMs, sent }) => {
			const rig = begin({ endSilenceMs });
			expect(new URL(rig.socket().url).searchParams.get("vad_silence_threshold_secs")).toBe(sent);
			rig.socket().drop();
			await rig.opened.catch(() => undefined);
		},
	);

	test("the open resolves on session_started, not before", async () => {
		const rig = begin();
		let settled = false;
		void rig.opened.then(() => {
			settled = true;
		});
		rig.socket().open();
		await settle();
		expect(settled).toBe(false);

		rig.socket().receive(STARTED);
		sessions.push(await withTimeout(rig.opened, "the session to open"));
		expect(settled).toBe(true);
	});

	test("audio pushed while the socket is still coming up is held and sent in order once it is", async () => {
		const rig = begin();
		const session = await (async () => {
			const socket = rig.socket();
			socket.open();
			const pushed = pcmBytes(6_400);
			socket.receive(STARTED);
			const opened = await rig.opened;
			sessions.push(opened);
			opened.push(pushed);
			return { opened, pushed };
		})();

		const frames = audioFrames(rig.socket());
		expect(frames).toHaveLength(1);
		expect(Array.from(frames[0]!.bytes)).toEqual(Array.from(session.pushed));
	});

	test("an already-aborted signal opens nothing", async () => {
		const network = new FakeNetwork();
		await expect(
			openScribe({
				apiKey: KEY,
				model: "scribe_v2_realtime",
				endSilenceMs: 700,
				connect: network.connect,
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow();
		expect(network.sockets).toHaveLength(0);
	});

	test("aborting while the socket is coming up rejects the open with the abort's reason and closes the socket", async () => {
		const rig = begin();
		rig.socket().open();
		const reason = new Error("hung up");
		rig.controller.abort(reason);

		await expect(rig.opened).rejects.toBe(reason);
		expect(rig.socket().closed).toBe(true);
	});
});

describe("audio on the wire", () => {
	test("each frame is a PCM chunk of at least 100 ms: short pushes are joined, none is lost or reordered", async () => {
		const { session, first } = await start();
		const forty = 40 * BYTES_PER_MS;
		const pushes = [pcmBytes(forty), pcmBytes(forty).map(byte => 255 - byte), pcmBytes(forty), pcmBytes(forty)];
		for (const push of pushes) session.push(push);

		const frames = audioFrames(first);
		expect(frames.map(frame => frame.bytes.byteLength)).toEqual([3 * forty]);
		expect(Array.from(frames[0]!.bytes)).toEqual(Array.from(Buffer.concat(pushes.slice(0, 3))));
		for (const frame of frames) {
			expect(frame.messageType).toBe("input_audio_chunk");
			expect(frame.sampleRate).toBe(16_000);
			expect(frame.commit).toBe(false);
		}
	});

	test("a push that ends mid-sample waits for the rest of the sample", async () => {
		const { session, first } = await start();
		const whole = pcmBytes(6_400);
		session.push(whole.subarray(0, 3_201));
		session.push(whole.subarray(3_201));

		const sent = Buffer.concat(audioFrames(first).map(frame => frame.bytes));
		expect(sent.byteLength).toBe(6_400);
		expect(Array.from(sent)).toEqual(Array.from(whole));
	});

	test("a long push is cut into frames of at most one second", async () => {
		const { session, first } = await start();
		session.push(pcmBytes(2_500 * BYTES_PER_MS));

		expect(audioFrames(first).map(frame => frame.bytes.byteLength)).toEqual([
			1_000 * BYTES_PER_MS,
			1_000 * BYTES_PER_MS,
			500 * BYTES_PER_MS,
		]);
	});

	test("the caller's buffer is copied: reusing it does not change what was sent", async () => {
		const { session, first } = await start();
		const reused = pcmBytes(3_200);
		const original = Array.from(reused);
		session.push(reused);
		reused.fill(0);

		expect(Array.from(audioFrames(first)[0]!.bytes)).toEqual(original);
	});
});

describe("transcripts become listen events", () => {
	test("an utterance is speech-start, partials that replace one another, speech-end, then its final", async () => {
		const { first, transcript } = await start();
		first.receive({ message_type: "partial_transcript", text: "hel" });
		first.receive({ message_type: "partial_transcript", text: "hello wor" });
		first.receive({ message_type: "committed_transcript", text: "hello world" });
		await settle();

		expect(transcript.types).toEqual(["speech-start", "partial", "partial", "speech-end", "final"]);
		expect(transcript.texts).toEqual(["hel", "hello wor", "hello world"]);
	});

	test("a partial never follows its own final, and the next utterance starts afresh", async () => {
		const { first, transcript } = await start();
		first.receive({ message_type: "partial_transcript", text: "one" });
		first.receive({ message_type: "committed_transcript", text: "one" });
		first.receive({ message_type: "partial_transcript", text: "one" });
		first.receive({ message_type: "committed_transcript", text: "one again" });
		await settle();

		expect(transcript.types).toEqual([
			"speech-start",
			"partial",
			"speech-end",
			"final",
			"speech-start",
			"partial",
			"speech-end",
			"final",
		]);
	});

	test("an unchanged partial, an empty partial and surrounding spaces are not events", async () => {
		const { first, transcript } = await start();
		first.receive({ message_type: "partial_transcript", text: "" });
		first.receive({ message_type: "partial_transcript", text: "  hi  " });
		first.receive({ message_type: "partial_transcript", text: "hi" });
		first.receive({ message_type: "committed_transcript", text: " hi " });
		await settle();

		expect(transcript.events).toEqual([
			{ t: "speech-start" },
			{ t: "partial", text: "hi" },
			{ t: "speech-end" },
			{ t: "final", text: "hi" },
		]);
	});

	test("a commit that carried no words closes an open utterance without a final, and says nothing when none was open", async () => {
		const { first, transcript } = await start();
		first.receive({ message_type: "committed_transcript", text: "" });
		first.receive({ message_type: "partial_transcript", text: "uh" });
		first.receive({ message_type: "committed_transcript", text: "   " });
		await settle();

		expect(transcript.types).toEqual(["speech-start", "partial", "speech-end"]);
	});

	test("a commit with no partial before it is still a whole utterance", async () => {
		const { first, transcript } = await start();
		first.receive({ message_type: "committed_transcript", text: "short" });
		await settle();

		expect(transcript.types).toEqual(["speech-start", "speech-end", "final"]);
	});

	test.each([
		"committed_transcript_with_timestamps",
		"committed_transcript_entities",
		"edited_transcript",
		"warning",
		"session_started",
	])("%s adds no event: the committed transcript is the one final", async messageType => {
		const { first, transcript } = await start();
		first.receive({ message_type: "committed_transcript", text: "hi" });
		first.receive({ message_type: messageType, text: "hi", words: [], warning: SECRET });
		await settle();

		expect(transcript.types).toEqual(["speech-start", "speech-end", "final"]);
	});

	test("frames that are not JSON, not records or of an unknown type are ignored", async () => {
		const { first, transcript } = await start();
		first.receive("not json");
		first.receive("[]");
		first.receive({ text: "no type" });
		first.receive({ message_type: "something_new" });
		await settle();

		expect(transcript.events).toEqual([]);
		expect(transcript.done).toBe(false);
	});
});

describe("mute", () => {
	test("commits what was sent, stops feeding, and lets go of the connection once the commit lands", async () => {
		const { session, first, transcript } = await start();
		session.push(pcmBytes(6_400));
		session.mute(true);

		const commits = audioFrames(first).filter(frame => frame.commit);
		expect(commits).toHaveLength(1);
		expect(commits[0]?.bytes.byteLength).toBe(0);
		const before = first.sent.length;
		session.push(pcmBytes(6_400));
		expect(first.sent).toHaveLength(before);

		first.receive({ message_type: "committed_transcript", text: "said before muting" });
		await settle();
		expect(transcript.types).toEqual(["speech-start", "speech-end", "final"]);
		expect(first.closed).toBe(true);
	});

	test("the tail of a push too short to have been sent is sent before the commit", async () => {
		const { session, first } = await start();
		session.push(pcmBytes(1_000));
		session.mute(true);

		const frames = audioFrames(first);
		expect(frames.map(frame => [frame.bytes.byteLength, frame.commit])).toEqual([
			[1_000, false],
			[0, true],
		]);
	});

	test("with nothing sent since the last commit it sends no commit and releases at once", async () => {
		const { session, first, transcript } = await start();
		session.mute(true);

		expect(audioFrames(first)).toEqual([]);
		expect(first.closed).toBe(true);
		expect(transcript.done).toBe(false);
	});

	test("an utterance whose commit never comes ends without a final once the wait is over", async () => {
		const { session, first, transcript } = await start();
		first.receive({ message_type: "partial_transcript", text: "half a sentence" });
		session.push(pcmBytes(6_400));
		session.mute(true);
		await until(() => transcript.types.includes("speech-end"), "the wait for the commit to end");

		expect(transcript.types).toEqual(["speech-start", "partial", "speech-end"]);
		expect(first.closed).toBe(true);
	});

	test("unmuting reconnects on the next audio, and what was said while it connected is not lost", async () => {
		const { session, network, first } = await start();
		session.mute(true);
		session.mute(false);
		expect(network.sockets).toHaveLength(1);

		const spoken = pcmBytes(6_400);
		session.push(spoken);
		expect(network.sockets).toHaveLength(2);
		const second = network.sockets[1]!;
		expect(second.headers["xi-api-key"]).toBe(KEY);
		second.open();
		expect(audioFrames(second)).toEqual([]);

		second.receive(STARTED);
		expect(Array.from(Buffer.concat(audioFrames(second).map(frame => frame.bytes)))).toEqual(Array.from(spoken));
		expect(sentBytes(first)).toBe(0);
	});

	test("muting twice, or unmuting what was never muted, changes nothing", async () => {
		const { session, network } = await start();
		session.mute(false);
		session.mute(true);
		session.mute(true);
		session.mute(false);
		session.mute(false);

		expect(network.sockets).toHaveLength(1);
	});
});

describe("how failures arrive", () => {
	test.each([
		{ type: "auth_error", status: 401, says: /rejected the API key \(the key needs the Speech to Text permission\)/ },
		{ type: "unaccepted_terms", status: 403, says: /Scribe terms accepted in your ElevenLabs dashboard/ },
		{ type: "quota_exceeded", status: 429, says: /busy, or the key has reached its limit/ },
		{ type: "rate_limited", status: 429, says: /busy, or the key has reached its limit/ },
		{ type: "session_time_limit_exceeded", status: 429, says: /busy, or the key has reached its limit/ },
		{ type: "queue_overflow", status: 503, says: /problem on its side/ },
		{ type: "resource_exhausted", status: 503, says: /problem on its side/ },
		{ type: "transcriber_error", status: 500, says: /problem on its side/ },
		{ type: "error", status: 500, says: /problem on its side/ },
		{ type: "input_error", status: 400, says: /did not accept the listening request/ },
		{ type: "invalid_request", status: 400, says: /did not accept the listening request/ },
		{ type: "chunk_size_exceeded", status: 400, says: /did not accept the listening request/ },
	])(
		"$type while opening rejects the open with status $status and in the pack's words, not the provider's",
		async ({ type, status, says }) => {
			const rig = begin();
			rig.socket().open();
			rig.socket().receive({ message_type: type, error: SECRET });

			const error = (await rig.opened.catch((caught: unknown) => caught)) as ElevenLabsError;
			expect(error).toBeInstanceOf(ElevenLabsError);
			expect(error.status).toBe(status);
			expect(error.unreachable).toBeUndefined();
			expect(error.message).toMatch(says);
			expect(error.message).not.toContain(SECRET);
			expect(error.message).not.toMatch(/\d{3}|[{}]/);
			expect(rig.socket().closed).toBe(true);
		},
	);

	test("a socket that closes before session_started is unreachable", async () => {
		const rig = begin();
		rig.socket().drop();

		const error = (await rig.opened.catch((caught: unknown) => caught)) as ElevenLabsError;
		expect(error).toBeInstanceOf(ElevenLabsError);
		expect(error.unreachable).toBe(true);
		expect(error.status).toBeUndefined();
		expect(error.message).toBe("Could not reach ElevenLabs");
	});

	test("a socket that never answers is unreachable once the open times out, carrying ETIMEDOUT", async () => {
		const rig = begin();
		const error = (await withTimeout(
			rig.opened.catch((caught: unknown) => caught),
			"the open to time out",
		)) as ElevenLabsError;

		expect(error.unreachable).toBe(true);
		expect(error.code).toBe("ETIMEDOUT");
		expect(rig.socket().closed).toBe(true);
	});

	test("a connection factory that throws fails the open", async () => {
		await expect(
			openScribe({
				apiKey: KEY,
				model: "scribe_v2_realtime",
				endSilenceMs: 700,
				signal: new AbortController().signal,
				connect: () => {
					throw new Error("no route to host");
				},
			}),
		).rejects.toThrow("no route to host");
	});

	test("a failure that cannot be retried ends the session: its events reject with the same error, and later audio goes nowhere", async () => {
		const { session, first, network, transcript } = await start();
		first.receive({ message_type: "quota_exceeded", error: SECRET });
		await settle();

		expect(transcript.error).toBeInstanceOf(ElevenLabsError);
		expect((transcript.error as ElevenLabsError).status).toBe(429);
		expect((transcript.error as ElevenLabsError).message).not.toContain(SECRET);
		expect(transcript.done).toBe(true);
		session.push(pcmBytes(6_400));
		expect(network.sockets).toHaveLength(1);
	});

	test("a failure Scribe recovers from is survived: the next audio, after a pause, opens a fresh connection", async () => {
		const { session, first, network, clock, transcript } = await start();
		first.receive({ message_type: "transcriber_error", error: SECRET });
		await settle();
		expect(first.closed).toBe(true);
		expect(transcript.done).toBe(false);

		session.push(pcmBytes(6_400));
		expect(network.sockets).toHaveLength(1);

		clock.now += 1_000;
		session.push(pcmBytes(6_400));
		expect(network.sockets).toHaveLength(2);
	});

	test("three failures in a row with no speech between them end the session", async () => {
		const { session, first, network, clock, transcript } = await start();
		first.receive({ message_type: "error", error: SECRET });
		clock.now += 1_000;
		session.push(pcmBytes(6_400));
		const second = network.sockets[1]!;
		second.open();
		second.receive(STARTED);
		second.receive({ message_type: "error", error: SECRET });
		clock.now += 2_000;
		session.push(pcmBytes(6_400));
		const third = network.sockets[2]!;
		third.open();
		third.receive(STARTED);
		third.receive({ message_type: "error", error: SECRET });
		await settle();

		expect(transcript.error).toBeInstanceOf(ElevenLabsError);
		expect((transcript.error as ElevenLabsError).status).toBe(500);
	});

	test("words heard between failures reset the count", async () => {
		const { session, first, network, clock, transcript } = await start();
		first.receive({ message_type: "error", error: SECRET });
		clock.now += 1_000;
		session.push(pcmBytes(6_400));
		const second = network.sockets[1]!;
		second.open();
		second.receive(STARTED);
		second.receive({ message_type: "partial_transcript", text: "still here" });
		second.receive({ message_type: "error", error: SECRET });
		clock.now += 1_000;
		session.push(pcmBytes(6_400));
		const third = network.sockets[2]!;
		third.open();
		third.receive(STARTED);
		third.receive({ message_type: "error", error: SECRET });
		clock.now += 2_000;
		session.push(pcmBytes(6_400));
		await settle();

		expect(network.sockets).toHaveLength(4);
		expect(transcript.error).toBeUndefined();
	});

	test("a connection that drops while audio is flowing is retried after a pause; an utterance it cut ends without a final", async () => {
		const { session, first, network, clock, transcript } = await start();
		session.push(pcmBytes(6_400));
		first.receive({ message_type: "partial_transcript", text: "cut off" });
		first.drop();
		await settle();

		expect(transcript.types).toEqual(["speech-start", "partial", "speech-end"]);
		expect(transcript.done).toBe(false);
		session.push(pcmBytes(6_400));
		expect(network.sockets).toHaveLength(1);
		clock.now += 1_000;
		session.push(pcmBytes(6_400));
		expect(network.sockets).toHaveLength(2);
	});

	test.each(["insufficient_audio_activity", "commit_throttled"])(
		"%s is the server letting go, not a failure: no error, the next audio reconnects at once",
		async messageType => {
			const { session, first, network, transcript } = await start();
			first.receive({ message_type: messageType, error: SECRET });
			await settle();

			expect(first.closed).toBe(true);
			expect(transcript.error).toBeUndefined();
			session.push(pcmBytes(6_400));
			expect(network.sockets).toHaveLength(2);
		},
	);

	test("a connection that closes after a long silence is idle, not a failure", async () => {
		const { session, first, network, clock, transcript } = await start();
		clock.now += 20_000;
		first.drop();
		await settle();

		expect(transcript.error).toBeUndefined();
		session.push(pcmBytes(6_400));
		expect(network.sockets).toHaveLength(2);
	});
});

describe("closing", () => {
	test("close is idempotent, completes the events, and closes the socket", async () => {
		const { session, first, transcript } = await start();
		session.close();
		session.close();
		await settle();

		expect(first.closed).toBe(true);
		expect(transcript.done).toBe(true);
		expect(transcript.error).toBeUndefined();
	});

	test("nothing is sent or reconnected after close", async () => {
		const { session, first, network } = await start();
		session.close();
		session.push(pcmBytes(6_400));
		session.mute(true);

		expect(network.sockets).toHaveLength(1);
		expect(sentBytes(first)).toBe(0);
	});

	test("aborting the signal after the open closes the session", async () => {
		const { first, controller, transcript } = await start();
		controller.abort();
		await settle();

		expect(first.closed).toBe(true);
		expect(transcript.done).toBe(true);
	});

	test("a frame arriving after close is ignored", async () => {
		const { session, first, transcript } = await start();
		session.close();
		first.receive({ message_type: "committed_transcript", text: "late" });
		await settle();

		expect(transcript.events).toEqual([]);
	});
});
