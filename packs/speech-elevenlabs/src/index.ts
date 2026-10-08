// The `speech` provider for ElevenLabs (doc 90, doc 92): the engine's voice runtime asks it for a
// catalog, for readiness, a SpeakSession per spoken reply, a ListenSession per microphone (Scribe v2
// Realtime), and a ConverseSession per live call. All three halves are declared in plugin.json.
//
// Eleven v3/v4 are served by the Text-to-Dialogue socket, which streams audio with character
// alignment a few hundred milliseconds after the first text; every other model is spoken one
// segment per HTTP request. Either way the caller sees the same SpeakSession.
//
// A live call (`openConverse`) is a RELAY: the engine holds the ElevenLabs Agents socket and carries
// PCM both ways. The Agents side needs the key's `convai` permissions on top of Text to Speech.
//
// The API key comes from the pack's connect form (written to the user's config dir) or
// `ELEVENLABS_API_KEY`; this module never logs it and sends it only to ElevenLabs, in a header.
//
// Runtime imports are `node:` builtins only, so the engine can import this file as-is. Types
// come from `@dimension/sdk/provider` and are erased.
import { homedir } from "node:os";
import type { ConverseOpenOptions, ConverseSession, ListenSession, SpeakSession, SpeechProvider } from "@dimension/sdk/provider";
import { Agents } from "./agents.js";
import { AccountVoices, buildCatalog } from "./catalog.js";
import { CONVERSE_MODELS, DEFAULT_CONVERSE_MODEL, DEFAULT_CONVERSE_VOICE } from "./convai.js";
import { type ConvaiSocket, type ConvaiSocketFactory, openRelay } from "./converse.js";
import { DialogueSpeakSession, type SocketFactory, type SocketLike } from "./dialogue.js";
import { ElevenLabsError } from "./failure.js";
import { resolveApiKey } from "./key.js";
import { openScribe } from "./listen.js";
import { modelSupportsAudioTags, usesDialogueSocket } from "./protocol.js";
import { SCRIBE_MODEL } from "./scribe.js";
import { SegmentSpeakSession } from "./segments.js";

/** Bun's WebSocket takes request headers, which the DOM typings the workspace compiles against do not declare. */
const HeaderWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => SocketLike;

const openSocket: SocketFactory = (url, headers) => new HeaderWebSocket(url, { headers: { ...headers } });

/** The Agents socket is authorized by its signed URL alone. Bun's WebSocket structurally satisfies the slice a call uses. */
const AgentWebSocket = WebSocket as unknown as new (url: string) => ConvaiSocket;

const openAgentSocket: ConvaiSocketFactory = url => new AgentWebSocket(url);

/** Seams a test replaces; the engine's factory passes none. */
export interface ElevenLabsDeps {
	readonly fetch?: typeof fetch;
	readonly connect?: SocketFactory;
	/** Opens the Agents socket of a live call. */
	readonly connectAgent?: ConvaiSocketFactory;
	/** How long a live `final` waits for the agent to stop speaking before it is sent anyway. Default 8 s. */
	readonly finalHoldMs?: number;
	/** Where `~/.config/...` lives. Default: the OS home, read per call. */
	readonly userHome?: string;
}

export function createElevenLabsProvider(deps: ElevenLabsDeps = {}): SpeechProvider {
	const doFetch = deps.fetch ?? fetch;
	const connect = deps.connect ?? openSocket;
	const connectAgent = deps.connectAgent ?? openAgentSocket;
	const accountVoices = new AccountVoices(doFetch);
	const agents = new Agents(doFetch);
	const keyFor = (env: Readonly<Record<string, string | undefined>>) => resolveApiKey(env, deps.userHome ?? homedir());
	const requireKey = async (env: Readonly<Record<string, string | undefined>>) => {
		const apiKey = await keyFor(env);
		if (!apiKey) {
			throw new ElevenLabsError("ElevenLabs needs an API key: connect one on the speech-elevenlabs pack, or set ELEVENLABS_API_KEY.", {
				status: 401,
			});
		}
		return apiKey;
	};

	return {
		id: "elevenlabs",

		async catalog(ctx) {
			const apiKey = await keyFor(ctx.env);
			return buildCatalog(apiKey ? await accountVoices.get(apiKey) : []);
		},

		// Speaking and listening make no API call: a key that is present is believed until a session proves otherwise.
		// Live needs the key's Agents permissions, which only a (cached) call to the Agents API can tell.
		async status(ctx) {
			const apiKey = await keyFor(ctx.env);
			if (apiKey) return { speak: { ready: true }, listen: { ready: true }, converse: await agents.probe(apiKey) };
			const needsKey = {
				ready: false,
				reason: "needs-key",
				detail: "Connect an ElevenLabs API key on the speech-elevenlabs pack, or set ELEVENLABS_API_KEY.",
			} as const;
			return { speak: needsKey, listen: needsKey, converse: needsKey };
		},

		async openSpeak(ctx, entry, opts): Promise<SpeakSession> {
			const apiKey = await requireKey(ctx.env);
			opts.signal.throwIfAborted();
			const options = {
				apiKey,
				model: entry.model,
				voice: entry.voice,
				// The model decides: tags reach a voice only when the engine allows them AND the model can perform them.
				tags: opts.audioTags && modelSupportsAudioTags(entry.model),
				fetch: doFetch,
				signal: opts.signal,
			};
			return usesDialogueSocket(entry.model)
				? new DialogueSpeakSession({ ...options, connect })
				: new SegmentSpeakSession(options);
		},

		async openListen(ctx, entry, opts): Promise<ListenSession> {
			const apiKey = await requireKey(ctx.env);
			if (entry.model !== SCRIBE_MODEL) throw new Error(`ElevenLabs listens with ${SCRIBE_MODEL}, not "${entry.model}"`);
			return openScribe({
				apiKey,
				model: entry.model,
				language: entry.language?.trim() || undefined,
				endSilenceMs: opts.endSilenceMs,
				connect,
				signal: opts.signal,
			});
		},

		async openConverse(ctx, entry, opts: ConverseOpenOptions): Promise<ConverseSession> {
			const apiKey = await requireKey(ctx.env);
			const model = entry.model ?? DEFAULT_CONVERSE_MODEL;
			if (!CONVERSE_MODELS.some(known => known === model)) {
				throw new Error(`ElevenLabs live voice speaks with ${CONVERSE_MODELS.join(" or ")}, not "${model}"`);
			}
			opts.signal.throwIfAborted();
			const signedUrl = await agents.mintSignedUrl({ apiKey, home: ctx.home, ttsModel: model, signal: opts.signal });
			return openRelay({
				signedUrl,
				connect: connectAgent,
				instructions: opts.instructions,
				voice: entry.voice ?? DEFAULT_CONVERSE_VOICE,
				signal: opts.signal,
				finalHoldMs: deps.finalHoldMs,
				// The account's agent no longer matches what the engine sends: re-send its full body next call.
				onOverrideRefused: () => void agents.forget(ctx.home).catch(() => undefined),
			});
		},
	};
}

/** The factory the engine's provider lane imports (doc 75 §2; `providers.speech[].id` is "elevenlabs"). */
export function createSpeechProvider(): SpeechProvider {
	return createElevenLabsProvider();
}
