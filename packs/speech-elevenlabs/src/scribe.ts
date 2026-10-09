import { ambiguousKeySentence, ElevenLabsError, sentenceFor } from "./failure.js";
import { API_HOST, isRecord } from "./protocol.js";

export const SCRIBE_MODEL = "scribe_v2_realtime";
export const LISTEN_SAMPLE_RATE = 16_000;
const LISTEN_AUDIO_FORMAT = "pcm_16000";
const MIN_VAD_SILENCE_SECS = 0.3;
const MAX_VAD_SILENCE_SECS = 3;

export interface ScribeStart {
	readonly model: string;
	readonly language?: string;
	readonly endSilenceMs: number;
}

export function scribeSocketUrl(start: ScribeStart): string {
	const query = new URLSearchParams({
		model_id: start.model,
		audio_format: LISTEN_AUDIO_FORMAT,
		commit_strategy: "vad",
		vad_silence_threshold_secs: String(
			Math.min(MAX_VAD_SILENCE_SECS, Math.max(MIN_VAD_SILENCE_SECS, start.endSilenceMs / 1000)),
		),
	});
	if (start.language) query.set("language_code", start.language);
	return `wss://${API_HOST}/v1/speech-to-text/realtime?${query}`;
}

export function audioFrame(pcm: Uint8Array): string {
	return `{"message_type":"input_audio_chunk","audio_base_64":"${Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64")}","commit":false,"sample_rate":${LISTEN_SAMPLE_RATE}}`;
}

export const COMMIT_FRAME = `{"message_type":"input_audio_chunk","audio_base_64":"","commit":true,"sample_rate":${LISTEN_SAMPLE_RATE}}`;

export type ScribeEvent =
	| { readonly kind: "started" }
	| { readonly kind: "partial"; readonly text: string }
	| { readonly kind: "committed"; readonly text: string }
	| { readonly kind: "released" }
	| { readonly kind: "failure"; readonly error: ElevenLabsError; readonly retry: boolean };

interface FailureRule {
	readonly status: number;
	readonly retry: boolean;
	readonly message: string;
}

const FAILURES: Readonly<Record<string, FailureRule>> = {
	auth_error: { status: 401, retry: false, message: ambiguousKeySentence("listen") },
	unaccepted_terms: {
		status: 403,
		retry: false,
		message: "ElevenLabs needs the Scribe terms accepted in your ElevenLabs dashboard",
	},
	quota_exceeded: { status: 429, retry: false, message: sentenceFor("limit", "listen") },
	rate_limited: { status: 429, retry: true, message: sentenceFor("limit", "listen") },
	session_time_limit_exceeded: { status: 429, retry: true, message: sentenceFor("limit", "listen") },
	queue_overflow: { status: 503, retry: true, message: sentenceFor("server", "listen") },
	resource_exhausted: { status: 503, retry: true, message: sentenceFor("server", "listen") },
	transcriber_error: { status: 500, retry: true, message: sentenceFor("server", "listen") },
	error: { status: 500, retry: true, message: sentenceFor("server", "listen") },
	input_error: { status: 400, retry: false, message: sentenceFor("rejected", "listen") },
	invalid_request: { status: 400, retry: false, message: sentenceFor("rejected", "listen") },
	chunk_size_exceeded: { status: 400, retry: false, message: sentenceFor("rejected", "listen") },
};

export function parseScribeEvent(raw: string): ScribeEvent | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(data) || typeof data.message_type !== "string") return null;
	const text = typeof data.text === "string" ? data.text : undefined;
	switch (data.message_type) {
		case "session_started":
			return { kind: "started" };
		case "partial_transcript":
			return text === undefined ? null : { kind: "partial", text };
		case "committed_transcript":
			return text === undefined ? null : { kind: "committed", text };
		case "insufficient_audio_activity":
		case "commit_throttled":
			return { kind: "released" };
		default: {
			if (!Object.hasOwn(FAILURES, data.message_type)) return null;
			const rule = FAILURES[data.message_type] as FailureRule;
			return {
				kind: "failure",
				error: new ElevenLabsError(rule.message, { status: rule.status }),
				retry: rule.retry,
			};
		}
	}
}
