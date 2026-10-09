import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ElevenLabsError } from "../src/failure.js";
import { createElevenLabsProvider, createSpeechProvider } from "../src/index.js";
import {
	DIALOGUE_MODEL,
	Harness,
	KEY,
	makeRig,
	NdjsonStream,
	openSpeak,
	openTracked,
	SEGMENT_MODEL,
	settle,
	streamingResponder,
} from "./support.js";

const harness = new Harness();
afterEach(() => harness.dispose());

describe("status", () => {
	test("without a key: speaking and listening are not ready, told how to fix it", async () => {
		const rig = await makeRig(harness, { env: {} });
		const status = await rig.provider.status(rig.ctx);

		for (const half of [status.speak, status.listen]) {
			expect(half).toMatchObject({ ready: false, reason: "needs-key" });
			expect(half?.ready === false ? half.detail : undefined).toContain("ELEVENLABS_API_KEY");
		}
	});

	test("speak and listen are ready on a present key without calling out; the key comes from the environment or the connect file", async () => {
		const withEnv = await makeRig(harness);
		const withFile = await makeRig(harness, { env: {}, keyFile: JSON.stringify({ access: "k" }) });

		for (const rig of [withEnv, withFile]) {
			const status = await rig.provider.status(rig.ctx);
			expect(status.speak).toEqual({ ready: true });
			expect(status.listen).toEqual({ ready: true });
			// The only request status ever makes is the Agents scope check that `converse` needs.
			expect(rig.http.requests.every(request => request.url.includes("/v1/convai/"))).toBe(true);
			expect(rig.network.sockets).toHaveLength(0);
		}
	});

	// A parse error quotes the file, and the file holds the key: it must never surface.
	test.each([
		{ name: "truncated JSON that contains the key", content: '{"access":"sk-LEAKED-key' },
		{ name: "not JSON", content: "sk-LEAKED-key" },
		{ name: "empty access", content: '{"access":""}' },
		{ name: "blank access", content: '{"access":"   "}' },
		{ name: "access of the wrong type", content: '{"access":123}' },
		{ name: "no access field", content: '{"key":"sk-LEAKED-key"}' },
		{ name: "an array", content: "[]" },
		{ name: "null", content: "null" },
	])("an unusable key file means needs-key, without throwing or quoting the file: $name", async ({ content }) => {
		const rig = await makeRig(harness, { env: {}, keyFile: content });
		const status = await rig.provider.status(rig.ctx);
		expect(status.speak).toMatchObject({ ready: false, reason: "needs-key" });
		expect(JSON.stringify(status)).not.toContain("LEAKED");

		const error = await openSpeak(rig).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("LEAKED");
		expect(rig.network.sockets).toHaveLength(0);
	});
});

describe("which key a session uses", () => {
	test.each([
		{ name: "the environment beats the file", env: "env-key", file: "file-key", used: "env-key" },
		{ name: "a blank environment value falls through to the file", env: "   ", file: "file-key", used: "file-key" },
		{ name: "the file's key is trimmed", env: undefined, file: " file-key \n", used: "file-key" },
		{ name: "the environment key is trimmed", env: " env-key\t", file: undefined, used: "env-key" },
	])("$name", async ({ env, file, used }) => {
		const rig = await makeRig(harness, {
			env: { ELEVENLABS_API_KEY: env },
			...(file === undefined ? {} : { keyFile: JSON.stringify({ access: file }) }),
		});
		await openTracked(harness, rig);
		expect(rig.network.sockets[0]?.headers["xi-api-key"]).toBe(used);
	});

	test("the connect form writes where the provider reads, in the shape it reads", async () => {
		const manifest = JSON.parse(await Bun.file(join(import.meta.dir, "..", "plugin.json")).text());
		const declared = manifest.extensions["ai.insodimension.dimension"];
		const template = await Bun.file(join(import.meta.dir, "..", declared.connect.configTemplate)).text();

		const rig = await makeRig(harness, { env: {} });
		const target = join(rig.home, declared.connect.configTarget.replace(/^~[\\/]/, ""));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, template.replaceAll("${apiKey}", "sk-from-the-form"));

		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
		await openTracked(harness, rig);
		expect(rig.network.sockets[0]?.headers["xi-api-key"]).toBe("sk-from-the-form");
	});

	test("the engine's no-argument factory yields the provider id the manifest declares", async () => {
		const manifest = JSON.parse(await Bun.file(join(import.meta.dir, "..", "plugin.json")).text());
		const declared = manifest.extensions["ai.insodimension.dimension"].providers.speech;
		expect(createSpeechProvider().id).toBe(declared[0].id);
		expect(createSpeechProvider().id).toBe("elevenlabs");
	});
});

describe("openSpeak", () => {
	test("without a key it rejects naming the key, and reaches for nothing", async () => {
		const rig = await makeRig(harness, { env: {} });
		await expect(openSpeak(rig)).rejects.toThrow(/API key/);
		expect(rig.network.sockets).toHaveLength(0);
		expect(rig.http.requests).toHaveLength(0);
	});

	test("an already-aborted signal rejects before anything is opened", async () => {
		const rig = await makeRig(harness);
		await expect(openSpeak(rig, { signal: AbortSignal.abort() })).rejects.toThrow();
		expect(rig.network.sockets).toHaveLength(0);
	});

	test("a connection factory that throws fails the open, not a later push", async () => {
		const rig = await makeRig(harness);
		const failing = createElevenLabsProvider({
			fetch: rig.http.fetch,
			userHome: rig.home,
			connect: () => {
				throw new Error("no route to host");
			},
		});
		await expect(
			failing.openSpeak!(rig.ctx, { model: DIALOGUE_MODEL, voice: "v" }, { signal: new AbortController().signal, audioTags: true }),
		).rejects.toThrow("no route to host");
	});

	test("Eleven v3/v4 models speak over the socket; every other model over per-segment requests", async () => {
		const streams: NdjsonStream[] = [];
		const rig = await makeRig(harness, { respond: streamingResponder(streams) });

		await openTracked(harness, rig, { model: "eleven_v4" });
		expect(rig.network.sockets).toHaveLength(1);
		expect(rig.http.requests).toHaveLength(0);

		const flash = await openTracked(harness, rig, { model: SEGMENT_MODEL });
		expect(rig.network.sockets).toHaveLength(1);
		flash.push("Hello there.");
		expect(rig.http.requests).toHaveLength(1);
	});
});

describe("audio tags", () => {
	/** The text the voice was actually handed for one pushed segment, whichever route the model takes. */
	async function spokenText(model: string, audioTags: boolean): Promise<string> {
		const streams: NdjsonStream[] = [];
		const rig = await makeRig(harness, { respond: streamingResponder(streams) });
		const session = await openTracked(harness, rig, { model, audioTags });
		session.push("[warmly] Hello there.");
		const socket = rig.network.sockets[0];
		if (socket) {
			socket.open();
			return (socket.frames[1]?.inputs as { text: string }[])[0]!.text.trim();
		}
		return JSON.parse(rig.http.requests[0]!.body!).text;
	}

	test.each([
		{ model: DIALOGUE_MODEL, audioTags: true, sent: "[warmly] Hello there." },
		{ model: "eleven_v4", audioTags: true, sent: "[warmly] Hello there." },
		{ model: DIALOGUE_MODEL, audioTags: false, sent: "Hello there." },
		// The engine allows tags, but this model cannot perform them.
		{ model: SEGMENT_MODEL, audioTags: true, sent: "Hello there." },
		{ model: SEGMENT_MODEL, audioTags: false, sent: "Hello there." },
	])("$model with audioTags=$audioTags speaks: $sent", async ({ model, audioTags, sent }) => {
		expect(await spokenText(model, audioTags)).toBe(sent);
	});

	test("the key is only ever a header, on either route", async () => {
		const streams: NdjsonStream[] = [];
		const rig = await makeRig(harness, { respond: streamingResponder(streams) });
		const socketSession = await openTracked(harness, rig);
		const httpSession = await openTracked(harness, rig, { model: SEGMENT_MODEL });
		socketSession.push("Hi.");
		httpSession.push("Hi.");

		expect(rig.network.sockets[0]?.url).not.toContain(KEY);
		expect(rig.network.sockets[0]?.headers["xi-api-key"]).toBe(KEY);
		const request = rig.http.requests[0]!;
		expect(request.url).not.toContain(KEY);
		expect(request.body).not.toContain(KEY);
		expect(request.headers.get("xi-api-key")).toBe(KEY);
	});
});

describe("openListen", () => {
	const STARTED = { message_type: "session_started", session_id: "s1", config: {} };

	function openListen(rig: Awaited<ReturnType<typeof makeRig>>, entry: { model: string; language?: string }, signal = new AbortController().signal) {
		const open = rig.provider.openListen;
		if (!open) throw new Error("provider has no openListen");
		return open.call(rig.provider, rig.ctx, entry, { signal, endSilenceMs: 700 });
	}

	test("without a key it rejects naming the key, carrying status 401, and reaches for nothing", async () => {
		const rig = await makeRig(harness, { env: {} });
		const error = (await openListen(rig, { model: "scribe_v2_realtime" }).catch((caught: unknown) => caught)) as ElevenLabsError;

		expect(error).toBeInstanceOf(ElevenLabsError);
		expect(error.status).toBe(401);
		expect(error.message).toContain("ELEVENLABS_API_KEY");
		expect(rig.network.sockets).toHaveLength(0);
		expect(rig.http.requests).toHaveLength(0);
	});

	test("a model other than Scribe is refused before anything is opened", async () => {
		const rig = await makeRig(harness);
		await expect(openListen(rig, { model: "parakeet" })).rejects.toThrow(/scribe_v2_realtime/);
		expect(rig.network.sockets).toHaveLength(0);
	});

	test("an already-aborted signal rejects before anything is opened", async () => {
		const rig = await makeRig(harness);
		await expect(openListen(rig, { model: "scribe_v2_realtime" }, AbortSignal.abort())).rejects.toThrow();
		expect(rig.network.sockets).toHaveLength(0);
	});

	test("the profile's language reaches Scribe trimmed, a blank one does not, and the session is the engine's to close", async () => {
		const withLanguage = await makeRig(harness);
		const pending = openListen(withLanguage, { model: "scribe_v2_realtime", language: " de " });
		await settle();
		const socket = withLanguage.network.sockets[0]!;
		socket.open();
		socket.receive(STARTED);
		const session = await pending;
		expect(new URL(socket.url).searchParams.get("language_code")).toBe("de");
		expect(socket.headers["xi-api-key"]).toBe(KEY);
		session.close();
		expect(socket.closed).toBe(true);

		const blank = await makeRig(harness);
		const blankPending = openListen(blank, { model: "scribe_v2_realtime", language: "  " });
		await settle();
		expect(new URL(blank.network.sockets[0]!.url).searchParams.has("language_code")).toBe(false);
		blank.network.sockets[0]!.drop();
		await blankPending.catch(() => undefined);
	});
});

describe("what the manifest declares is what the provider implements", () => {
	test("speak, listen and converse are each declared exactly when the provider can open them", async () => {
		const manifest = JSON.parse(await Bun.file(join(import.meta.dir, "..", "plugin.json")).text());
		const [declared] = manifest.extensions["ai.insodimension.dimension"].providers.speech;
		const rig = await makeRig(harness);

		expect(declared).toEqual({ id: "elevenlabs", speak: true, listen: true, converse: true });
		expect(typeof rig.provider.openSpeak).toBe("function");
		expect(typeof rig.provider.openListen).toBe("function");
		expect(typeof rig.provider.openConverse).toBe("function");
		const catalog = await rig.provider.catalog(rig.ctx);
		expect(catalog.speak?.length).toBeGreaterThan(0);
		expect(catalog.listen?.length).toBeGreaterThan(0);
		expect(catalog.converse?.length).toBeGreaterThan(0);
	});
});
