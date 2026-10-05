// Pure surface logic: what the voice conversation's state means on screen, and the two navigation rules
// (Back and Esc). No React, no DOM, no audio: the component draws what this returns.
import type { FaceState } from "../face/animator";
import { micSilentNotice } from "./mic-model";
import type { FaceVoice } from "./voice";
import type { FaceLive } from "./live";

/** The surface's own vocabulary: the kit's phases plus the two honest states before a conversation can start. */
export type SurfacePhase =
	| "checking"
	| "unavailable"
	| "dormant"
	| "connecting"
	| "listening"
	| "thinking"
	| "speaking"
	| "error";

type OpenPhase = "listening" | "thinking" | "speaking";

function isOpen(phase: SurfacePhase): phase is OpenPhase {
	return phase === "listening" || phase === "thinking" || phase === "speaking";
}

export type VoiceFacts = Pick<
	FaceVoice,
	"supported" | "phase" | "error" | "notice" | "refusal" | "micLive" | "muted" | "micSilent" | "micLabel" | "partial"
>;

export interface Problem {
	title: string;
	/** The engine's own words, verbatim. */
	detail: string;
	/** What to do about it, only when the words say what it is. */
	hint?: string;
}

export interface SurfaceView {
	phase: SurfacePhase;
	/** Which conversation this view describes: the voice pipeline (Tap to talk) or a Live call (Talk live). */
	mode: "voice" | "live";
	faceState: FaceState;
	/** The word beside the waveform mark while a conversation is open. */
	label: string;
	/** The only control that can start the microphone. */
	tap: "talk" | "retry" | null;
	/** Mute is a control of an open conversation. */
	canMute: boolean;
	/** A non-fatal word from the engine ("Downloading the voice model (42%)…"), or the reason the person's words were not sent. */
	status: string | undefined;
	/** The status says the person's last words were NOT sent (they are still on screen, and ride with the next thing said). */
	unsent: boolean;
	/** The microphone is open and delivering only silence: the label and the status say so instead of "Listening". */
	micSilent: boolean;
	/** The microphone is open and the person is being heard (the top bar says "Mic on"). */
	micLive: boolean;
	/** The person's words so far, shown while they are talking. */
	userCaption: string;
	/** Live only: the newest line of the call, either speaker; null in voice mode, where the words ride `voice.words`. */
	caption: LiveCaption | null;
	problem: Problem | null;
}

/** `engine` says a speech lane exists only after its probe answers; a surface that never gets one must say so. */
const UNAVAILABLE: Problem = {
	title: "Voice is not ready",
	detail: "Face to face needs an engine with a speech provider connected, and audio in this window.",
	hint: "Connect a speech provider in Capabilities (ElevenLabs needs an API key; an on-device voice may download a model first), then open this again.",
};

const HINTS: readonly [RegExp, string][] = [
	[/api key|apikey|unauthori[sz]ed|\b40[13]\b|invalid key/i, "Connect the provider's API key in Capabilities, then try again."],
	[/microphone|permission|denied|notallowed|not allowed/i, "Allow microphone access for this app in your system settings, then try again."],
	[/download|model|loading/i, "A speech model is loading or downloading. Wait for it to finish, then try again."],
	[/connection|disconnect|lost|closed|socket|unreachable/i, "Check that the engine is still running, then try again."],
];

export function hintFor(message: string): string | undefined {
	return HINTS.find(([pattern]) => pattern.test(message))?.[1];
}

function problemOf(v: VoiceFacts): Problem {
	const detail = v.error?.trim() || "The voice conversation stopped.";
	const hint = hintFor(detail);
	return { title: "Voice stopped", detail, ...(hint ? { hint } : {}) };
}

function surfacePhase(v: VoiceFacts, probeGraceOver: boolean): SurfacePhase {
	if (v.phase !== "idle") return v.phase;
	if (v.supported) return "dormant";
	return probeGraceOver ? "unavailable" : "checking";
}

const LABELS: Partial<Record<SurfacePhase, string>> = {
	checking: "Getting ready",
	connecting: "Connecting",
	listening: "Listening",
	thinking: "Thinking",
	speaking: "Speaking",
};

/** `probeGraceOver`: the engine has had time to answer whether it can speak; until then "not supported" means "not known yet". */
export function describeSurface(v: VoiceFacts, probeGraceOver: boolean): SurfaceView {
	const phase = surfacePhase(v, probeGraceOver);
	const open = isOpen(phase);
	// Mute releases the microphone, so it only changes what "listening" means; a reply being thought or spoken goes on.
	const muted = phase === "listening" && v.muted;
	// A microphone that hears nothing is not "listening": the surface says so, and the face stops leaning in.
	const deaf = phase === "listening" && !muted && v.micSilent;
	const unsent = open && v.refusal !== undefined;
	const faceState: FaceState = open && !muted && !deaf ? phase : "idle";
	return {
		mode: "voice",
		phase,
		faceState,
		label: muted ? "Muted" : deaf ? "No sound" : (LABELS[phase] ?? ""),
		tap: phase === "dormant" ? "talk" : phase === "error" ? "retry" : null,
		canMute: open,
		// Words that went nowhere are the one thing the person must not miss while the conversation runs.
		status: unsent ? v.refusal : deaf ? micSilentNotice(v.micLabel) : phase === "error" || phase === "unavailable" ? undefined : v.notice,
		unsent,
		micSilent: deaf,
		userCaption: phase === "listening" && !muted ? v.partial.trim() : "",
		micLive: v.micLive,
		caption: null,
		problem: phase === "error" ? problemOf(v) : phase === "unavailable" ? UNAVAILABLE : null,
	};
}

/** What the Live hook says that the surface draws. `phase` is what the call SHOWS (it reads `muted` over everything while the microphone is off); `enginePhase` is what it is DOING underneath, which is what the face must follow. */
export type LiveFacts = Pick<FaceLive, "phase" | "enginePhase" | "transcript" | "muted" | "seconds" | "error" | "voice">;

export interface LiveCaption {
	readonly role: "user" | "assistant";
	readonly text: string;
	/** Role-local and monotonic: a streaming update repeats the turn with `final: false`. */
	readonly turn: number;
	readonly final: boolean;
}

/** A Live call holds the surface from its first moment until it is over; `off` is the only phase with no call. */
export function liveHolds(live: Pick<LiveFacts, "phase">): boolean {
	return live.phase !== "off";
}

/** The engine's call phases on the surface's own vocabulary. `working` is the agent doing the work the voice handed it. */
const LIVE_PHASES: Record<LiveFacts["enginePhase"], SurfacePhase> = {
	off: "dormant",
	connecting: "connecting",
	listening: "listening",
	working: "thinking",
	speaking: "speaking",
	error: "error",
};

/** `m:ss`, the way a call timer reads. */
export function clock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** `working` is the agent doing the work the voice handed it: the call says so rather than "Thinking". */
function liveLabel(callPhase: LiveFacts["enginePhase"], muted: boolean): string {
	if (muted) return "Muted";
	if (callPhase === "working") return "Working";
	return LABELS[LIVE_PHASES[callPhase]] ?? "";
}

/** Who the microphone is talking to, said while the call is up: the one thing the person should always be able to read. */
function liveStatus(l: LiveFacts, phase: SurfacePhase): string | undefined {
	if (phase === "error" || phase === "dormant") return undefined;
	return ["Live", l.voice, isOpen(phase) ? clock(l.seconds) : null].filter(Boolean).join(" · ");
}

function liveCaption(transcript: LiveFacts["transcript"]): LiveCaption | null {
	if (!transcript) return null;
	const text = transcript.text.trim();
	return text ? { role: transcript.role, text, turn: transcript.turn, final: transcript.final } : null;
}

function liveProblem(error: LiveFacts["error"]): Problem {
	const detail = error?.trim() || "The live call stopped.";
	const hint = hintFor(detail);
	return { title: "Live call stopped", detail, ...(hint ? { hint } : {}) };
}

/** What a Live call means on screen: the same face states and controls as the voice conversation, with the call's own words. */
export function describeLive(l: LiveFacts): SurfaceView {
	const phase = LIVE_PHASES[l.enginePhase];
	const open = isOpen(phase);
	// Muting switches the microphone off whatever the call is doing, but the FACE relaxes only while it is listening: the voice
	// answering or the agent working goes on and the face goes on showing it (the kit's `phase` would say "muted" for all of it).
	const micOff = l.muted || l.phase === "muted";
	const muted = phase === "listening" && micOff;
	return {
		mode: "live",
		phase,
		faceState: open && !muted ? phase : "idle",
		label: liveLabel(l.enginePhase, muted),
		tap: phase === "error" ? "retry" : null,
		canMute: open,
		status: liveStatus(l, phase),
		unsent: false,
		micSilent: false,
		micLive: open && !micOff,
		userCaption: "",
		caption: liveCaption(l.transcript),
		problem: phase === "error" ? liveProblem(l.error) : null,
	};
}

export type Intent = { readonly t: "mount"; readonly surface: string };

/** Leave for the thread: end every open conversation (releasing the microphone) and navigate. All of it, whatever the phase. */
export function leaveSurface(open: readonly { stop(): unknown }[], onIntent: (intent: Intent) => void): void {
	for (const conversation of open) void conversation.stop();
	onIntent({ t: "mount", surface: "session" });
}

/** Whether two lists of blendshape names are the same names in the same order (the kit's `faceAt()` order vs this rig's). */
export function sameArkitOrder(granted: readonly string[], ours: readonly string[]): boolean {
	return granted.length === ours.length && granted.every((name, i) => name === ours[i]);
}

/** Esc leaves, unless something else already used it or the person is typing. */
export function isLeaveKey(e: { key: string; defaultPrevented: boolean; target?: unknown }): boolean {
	if (e.key !== "Escape" || e.defaultPrevented) return false;
	const el = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
	const tag = el?.tagName?.toUpperCase();
	return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true);
}
