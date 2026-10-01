// The `speech` provider for ElevenLabs (doc 86): the engine's voice runtime asks it for a
// catalog, for readiness, and for a SpeakSession per spoken reply. It speaks only (`listen` is
// declared false in plugin.json).
//
// Eleven v3/v4 are served by the Text-to-Dialogue socket, which streams audio with character
// alignment a few hundred milliseconds after the first text; every other model is spoken one
// segment per HTTP request. Either way the caller sees the same SpeakSession.
//
// The API key comes from the pack's connect form (written to the user's config dir) or
// `ELEVENLABS_API_KEY`; this module never logs it and sends it only to ElevenLabs, in a header.
//
// Runtime imports are `node:` builtins only, so the engine can import this file as-is. Types
// come from `@dimension/sdk/provider` and are erased.
import { homedir } from "node:os";
import type { SpeakSession, SpeechProvider } from "@dimension/sdk/provider";
import { AccountVoices, buildCatalog } from "./catalog.js";
import { DialogueSpeakSession, type SocketFactory, type SocketLike } from "./dialogue.js";
import { resolveApiKey } from "./key.js";
import { modelSupportsAudioTags, usesDialogueSocket } from "./protocol.js";
import { SegmentSpeakSession } from "./segments.js";

/** Bun's WebSocket takes request headers, which the DOM typings the workspace compiles against do not declare. */
const HeaderWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => SocketLike;

const openSocket: SocketFactory = (url, headers) => new HeaderWebSocket(url, { headers: { ...headers } });

/** Seams a test replaces; the engine's factory passes none. */
export interface ElevenLabsDeps {
	readonly fetch?: typeof fetch;
	readonly connect?: SocketFactory;
	/** Where `~/.config/...` lives. Default: the OS home, read per call. */
	readonly userHome?: string;
}

export function createElevenLabsProvider(deps: ElevenLabsDeps = {}): SpeechProvider {
	const doFetch = deps.fetch ?? fetch;
	const connect = deps.connect ?? openSocket;
	const accountVoices = new AccountVoices(doFetch);
	const keyFor = (env: Readonly<Record<string, string | undefined>>) => resolveApiKey(env, deps.userHome ?? homedir());

	return {
		id: "elevenlabs",

		async catalog(ctx) {
			const apiKey = await keyFor(ctx.env);
			return buildCatalog(apiKey ? await accountVoices.get(apiKey) : []);
		},

		// No API call: a key that is present is believed until a session proves otherwise.
		async status(ctx) {
			if (await keyFor(ctx.env)) return { speak: { ready: true } };
			return {
				speak: {
					ready: false,
					reason: "needs-key",
					detail: "Connect an ElevenLabs API key on the speech-elevenlabs pack, or set ELEVENLABS_API_KEY.",
				},
			};
		},

		async openSpeak(ctx, entry, opts): Promise<SpeakSession> {
			const apiKey = await keyFor(ctx.env);
			if (!apiKey) throw new Error("ElevenLabs needs an API key: connect one on the speech-elevenlabs pack, or set ELEVENLABS_API_KEY.");
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
	};
}

/** The factory the engine's provider lane imports (doc 75 §2; `providers.speech[].id` is "elevenlabs"). */
export function createSpeechProvider(): SpeechProvider {
	return createElevenLabsProvider();
}
