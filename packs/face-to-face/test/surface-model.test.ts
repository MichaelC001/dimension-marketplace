// The surface's rules, with no DOM: what each voice state and each Live call state means on screen, and the two ways out.
import { describe, expect, test } from "bun:test";
import {
	clock,
	describeLive,
	describeSurface,
	hintFor,
	isLeaveKey,
	leaveSurface,
	type LiveFacts,
	liveHolds,
	sameArkitOrder,
	type VoiceFacts,
} from "../src/surface/surface-model";

const facts = (over: Partial<VoiceFacts> = {}): VoiceFacts => ({
	supported: true,
	phase: "idle",
	error: undefined,
	notice: undefined,
	refusal: undefined,
	micLive: false,
	muted: false,
	micLabel: undefined,
	micSilent: false,
	partial: "",
	...over,
});

describe("describeSurface: the kit's phase, drawn honestly", () => {
	test("idle with a speech lane is dormant: the one control that can start the mic is offered", () => {
		const v = describeSurface(facts(), false);
		expect(v.phase).toBe("dormant");
		expect(v.tap).toBe("talk");
		expect(v.label).toBe("");
		expect(v.canMute).toBe(false);
		expect(v.faceState).toBe("idle");
	});

	test("an engine that has not answered yet is 'checking' (nothing claimed), and only after the grace is 'unavailable'", () => {
		const early = describeSurface(facts({ supported: false }), false);
		expect(early.phase).toBe("checking");
		expect(early.problem).toBeNull();
		expect(early.tap).toBeNull();
		const late = describeSurface(facts({ supported: false }), true);
		expect(late.phase).toBe("unavailable");
		expect(late.problem?.detail).toContain("speech provider");
		expect(late.tap).toBeNull();
	});

	test("each open phase drives the face state, the label, and the mute control", () => {
		for (const [phase, label] of [
			["connecting", "Connecting"],
			["listening", "Listening"],
			["thinking", "Thinking"],
			["speaking", "Speaking"],
		] as const) {
			const v = describeSurface(facts({ phase }), false);
			expect(v.label).toBe(label);
			expect(v.tap).toBeNull();
			expect(v.canMute).toBe(phase !== "connecting");
			expect(v.faceState).toBe(phase === "connecting" ? "idle" : phase);
		}
	});

	test("muted: while listening the face relaxes and says Muted; while the agent thinks or speaks nothing changes", () => {
		const listening = describeSurface(facts({ phase: "listening", muted: true, partial: "leftover words" }), false);
		expect(listening.label).toBe("Muted");
		expect(listening.faceState).toBe("idle");
		expect(listening.userCaption).toBe("");
		for (const phase of ["thinking", "speaking"] as const) {
			const v = describeSurface(facts({ phase, muted: true }), false);
			expect(v.label).toBe(phase === "thinking" ? "Thinking" : "Speaking");
			expect(v.faceState).toBe(phase);
			expect(v.canMute).toBe(true);
		}
	});

	test("the person's live words show only while they are listened to", () => {
		expect(describeSurface(facts({ phase: "listening", partial: "  what is on today " }), false).userCaption).toBe("what is on today");
		expect(describeSurface(facts({ phase: "thinking", partial: "what is on today" }), false).userCaption).toBe("");
		expect(describeSurface(facts({ phase: "speaking", partial: "what is on today" }), false).userCaption).toBe("");
	});

	test("the engine's notice shows while a conversation runs, and never on top of an error or an unavailable card", () => {
		const notice = "Downloading the voice model (42%)…";
		expect(describeSurface(facts({ phase: "connecting", notice }), false).status).toBe(notice);
		expect(describeSurface(facts({ notice }), false).status).toBe(notice);
		expect(describeSurface(facts({ phase: "error", error: "boom", notice }), false).status).toBeUndefined();
		expect(describeSurface(facts({ supported: false, notice }), true).status).toBeUndefined();
	});

	test("an error keeps the engine's words verbatim, offers a retry, and adds a hint only when the words name the cause", () => {
		const keyed = describeSurface(facts({ phase: "error", error: "ElevenLabs answered 401: invalid API key" }), false);
		expect(keyed.tap).toBe("retry");
		expect(keyed.problem?.detail).toBe("ElevenLabs answered 401: invalid API key");
		expect(keyed.problem?.hint).toContain("API key");

		const mic = describeSurface(facts({ phase: "error", error: "NotAllowedError: Permission denied" }), false);
		expect(mic.problem?.hint).toContain("microphone access");

		const odd = describeSurface(facts({ phase: "error", error: "something unforeseen" }), false);
		expect(odd.problem?.detail).toBe("something unforeseen");
		expect(odd.problem?.hint).toBeUndefined();

		const blank = describeSurface(facts({ phase: "error", error: "  " }), false);
		expect(blank.problem?.detail).toBe("The voice conversation stopped.");
	});

	test("hintFor names a fix only for a message that says what broke", () => {
		expect(hintFor("Unauthorized")).toContain("API key");
		expect(hintFor("the socket closed")).toContain("engine is still running");
		expect(hintFor("")).toBeUndefined();
	});
});

describe("describeSurface: a microphone that hears nothing is not 'Listening'", () => {
	const HEADSET = "Default - Headset Microphone (INZONE H9 II - Chat)";
	const dead = (over: Partial<VoiceFacts> = {}) => facts({ phase: "listening", micLive: true, micSilent: true, micLabel: HEADSET, ...over });

	test("while listening, the label, the face and the status all say so, naming the device", () => {
		const v = describeSurface(dead(), false);
		expect(v.label).toBe("No sound");
		expect(v.status).toBe("No sound from INZONE H9 II. Pick another microphone.");
		expect(v.faceState).toBe("idle");
		expect(v.micSilent).toBe(true);
		expect(v.phase).toBe("listening");
		// the conversation is still open: Mute and the microphone picker (which live beside it) stay reachable
		expect(v.canMute).toBe(true);
	});

	test("a dead microphone with no known name still gets the warning", () => {
		expect(describeSurface(dead({ micLabel: undefined }), false).status).toBe("No sound from your microphone. Pick another microphone.");
	});

	test("the warning wins over the engine's own notice", () => {
		const v = describeSurface(dead({ notice: "Downloading the voice model (42%)…" }), false);
		expect(v.status).toBe("No sound from INZONE H9 II. Pick another microphone.");
	});

	test("a microphone that delivers sound is 'Listening' with no warning", () => {
		const v = describeSurface(dead({ micSilent: false }), false);
		expect(v.label).toBe("Listening");
		expect(v.status).toBeUndefined();
		expect(v.faceState).toBe("listening");
		expect(v.micSilent).toBe(false);
	});

	test("only the person being listened to can be not heard: connecting, thinking and speaking keep their own words and the engine's notice", () => {
		const notice = "Switching voices…";
		for (const [phase, label] of [
			["connecting", "Connecting"],
			["thinking", "Thinking"],
			["speaking", "Speaking"],
		] as const) {
			const v = describeSurface(dead({ phase, notice }), false);
			expect(v.label).toBe(label);
			expect(v.status).toBe(notice);
			expect(v.faceState).toBe(phase === "connecting" ? "idle" : phase);
			expect(v.micSilent).toBe(false);
		}
	});

	test("a muted microphone is silent on purpose: it says Muted, not No sound, and does not warn", () => {
		const v = describeSurface(dead({ muted: true, micLive: false }), false);
		expect(v.label).toBe("Muted");
		expect(v.status).toBeUndefined();
		expect(v.micSilent).toBe(false);
		expect(v.faceState).toBe("idle");
	});

	test("with no conversation open, or after an error, a stale silent flag warns of nothing", () => {
		expect(describeSurface(dead({ phase: "idle" }), false).micSilent).toBe(false);
		expect(describeSurface(dead({ phase: "idle" }), false).status).toBeUndefined();
		const failed = describeSurface(dead({ phase: "error", error: "boom" }), false);
		expect(failed.micSilent).toBe(false);
		expect(failed.status).toBeUndefined();
		expect(failed.label).toBe("");
	});
});

describe("describeSurface: words that went nowhere", () => {
	const REASON = "Couldn't send that: Session is not connected; nothing was sent.";
	const refused = (over: Partial<VoiceFacts> = {}) =>
		facts({ phase: "listening", micLive: true, refusal: REASON, partial: "book me a table", ...over });

	test("the reason is the status, the words stay as the caption, and the status is marked as a fault", () => {
		const v = describeSurface(refused(), false);
		expect(v.status).toBe(REASON);
		expect(v.unsent).toBe(true);
		expect(v.userCaption).toBe("book me a table");
	});

	test("it wins over the engine's own notice and over a quiet microphone: the person's words are the thing they must not miss", () => {
		const v = describeSurface(refused({ notice: "Downloading the voice model (42%)…", micSilent: true }), false);
		expect(v.status).toBe(REASON);
		expect(v.unsent).toBe(true);
	});

	test("it stays while the conversation runs — an earlier reply still thinking or speaking does not hide it", () => {
		for (const phase of ["thinking", "speaking"] as const) {
			const v = describeSurface(refused({ phase }), false);
			expect(v.status).toBe(REASON);
			expect(v.unsent).toBe(true);
		}
		expect(describeSurface(refused({ muted: true }), false).status).toBe(REASON);
	});

	test("no conversation, no sentence: never over an error or unavailable card, nor before the conversation has opened", () => {
		for (const over of [{ phase: "error", error: "boom" }, { phase: "idle" }, { phase: "connecting" }] as const) {
			const v = describeSurface(refused(over), false);
			expect(v.status).toBeUndefined();
			expect(v.unsent).toBe(false);
		}
		expect(describeSurface(refused({ supported: false, phase: "idle" }), true).status).toBeUndefined();
	});

	test("a send that went fine leaves nothing flagged", () => {
		const v = describeSurface(refused({ refusal: undefined, partial: "" }), false);
		expect(v.unsent).toBe(false);
		expect(v.status).toBeUndefined();
	});
});

describe("leaving the surface", () => {
	test("Back ends every open conversation (releasing the mic) AND navigates to the thread", () => {
		const log: string[] = [];
		leaveSurface(
			[{ stop: async () => void log.push("voice") }, { stop: () => void log.push("live") }],
			(intent) => log.push(`${intent.t}:${intent.surface}`),
		);
		expect(log.sort()).toEqual(["live", "mount:session", "voice"]);
	});

	test("Esc leaves, unless another handler used it or the person is typing", () => {
		const esc = { key: "Escape", defaultPrevented: false };
		expect(isLeaveKey(esc)).toBe(true);
		expect(isLeaveKey({ ...esc, target: { tagName: "BUTTON" } })).toBe(true);
		expect(isLeaveKey({ ...esc, defaultPrevented: true })).toBe(false);
		expect(isLeaveKey({ ...esc, target: { tagName: "input" } })).toBe(false);
		expect(isLeaveKey({ ...esc, target: { tagName: "TEXTAREA" } })).toBe(false);
		expect(isLeaveKey({ ...esc, target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
		expect(isLeaveKey({ key: "Enter", defaultPrevented: false })).toBe(false);
	});
});

// The kit shows "muted" over the engine's phase; unless a case says what the engine is doing underneath, it is doing what the call shows.
const call = (over: Partial<LiveFacts> = {}): LiveFacts => {
	const shown = over.phase ?? "listening";
	return {
		phase: "listening",
		enginePhase: shown === "muted" ? "listening" : shown,
		transcript: null,
		muted: false,
		seconds: 0,
		error: null,
		voice: null,
		...over,
	};
};

describe("clock: how a call timer reads", () => {
	test("m:ss with a zero-padded second, minutes unbounded", () => {
		expect(clock(0)).toBe("0:00");
		expect(clock(9)).toBe("0:09");
		expect(clock(65.9)).toBe("1:05");
		expect(clock(3600)).toBe("60:00");
	});
});

describe("describeLive: a realtime call, drawn honestly", () => {
	test("a call holds the surface in every phase but off, an error included, until it is dismissed", () => {
		expect(liveHolds({ phase: "off" })).toBe(false);
		for (const phase of ["connecting", "listening", "muted", "working", "speaking", "error"] as const) {
			expect(liveHolds({ phase })).toBe(true);
		}
	});

	test("each phase drives the face state and the label; the agent working is its own word, not 'Thinking'", () => {
		const connecting = describeLive(call({ phase: "connecting" }));
		expect(connecting.label).toBe("Connecting");
		expect(connecting.faceState).toBe("idle");
		expect(connecting.canMute).toBe(false);
		for (const [phase, label, face] of [
			["listening", "Listening", "listening"],
			["working", "Working", "thinking"],
			["speaking", "Speaking", "speaking"],
		] as const) {
			const v = describeLive(call({ phase }));
			expect(v.mode).toBe("live");
			expect(v.label).toBe(label);
			expect(v.faceState).toBe(face);
			expect(v.canMute).toBe(true);
			expect(v.micLive).toBe(true); // the microphone stays open while the agent works and the voice answers (barge-in)
			expect(v.tap).toBeNull();
		}
	});

	test("muted while listening: the face relaxes, the label says Muted and the microphone reads off (the flag, or the engine's own 'muted')", () => {
		for (const muted of [call({ muted: true }), call({ phase: "muted" })]) {
			const v = describeLive(muted);
			expect(v.label).toBe("Muted");
			expect(v.faceState).toBe("idle");
			expect(v.micLive).toBe(false);
			expect(v.canMute).toBe(true);
		}
	});

	test("muted while the voice answers or the agent works: the kit's phase says 'muted' for all of it, but the face follows the engine underneath", () => {
		const speaking = describeLive(call({ phase: "muted", muted: true, enginePhase: "speaking" }));
		expect(speaking).toMatchObject({ phase: "speaking", label: "Speaking", faceState: "speaking", micLive: false, canMute: true });
		const working = describeLive(call({ phase: "muted", muted: true, enginePhase: "working" }));
		expect(working).toMatchObject({ phase: "thinking", label: "Working", faceState: "thinking", micLive: false });
		// and unmuted, the same phases keep the microphone on
		expect(describeLive(call({ enginePhase: "speaking", phase: "speaking" })).micLive).toBe(true);
	});

	test("a call still connecting or failed shows that, whatever the mute flag says", () => {
		expect(describeLive(call({ phase: "connecting", muted: true })).label).toBe("Connecting");
		expect(describeLive(call({ phase: "error", muted: true, error: "x" })).phase).toBe("error");
	});

	test("the status line says who the microphone is talking to, with the clock only once the call is up", () => {
		expect(describeLive(call({ phase: "connecting", voice: "Sol via codex-live" })).status).toBe("Live · Sol via codex-live");
		expect(describeLive(call({ phase: "speaking", voice: "Sol via codex-live", seconds: 65 })).status).toBe("Live · Sol via codex-live · 1:05");
		expect(describeLive(call({ phase: "listening", voice: null, seconds: 7 })).status).toBe("Live · 0:07");
		expect(describeLive(call({ phase: "error", error: "no" })).status).toBeUndefined();
	});

	test("a failed call shows the engine's words verbatim, a hint only when they say what it is, and offers Try again", () => {
		const v = describeLive(call({ phase: "error", error: "Codex answered 401: invalid API key" }));
		expect(v.problem?.title).toBe("Live call stopped");
		expect(v.problem?.detail).toBe("Codex answered 401: invalid API key");
		expect(v.problem?.hint).toBe(hintFor("invalid API key"));
		expect(v.tap).toBe("retry");
		expect(v.faceState).toBe("idle");

		const unsaid = describeLive(call({ phase: "error", error: "  " }));
		expect(unsaid.problem?.detail).toBe("The live call stopped.");
		expect(unsaid.problem?.hint).toBeUndefined();
	});

	test("the newest line of the call is the caption, either speaker; a blank line is none", () => {
		const line = { role: "assistant", text: "  Mars is cold and dusty.  ", turn: 3, final: false } as const;
		expect(describeLive(call({ transcript: line })).caption).toEqual({ role: "assistant", text: "Mars is cold and dusty.", turn: 3, final: false });
		expect(describeLive(call({ transcript: { ...line, role: "user", final: true } })).caption?.role).toBe("user");
		expect(describeLive(call({ transcript: { ...line, text: "   " } })).caption).toBeNull();
		expect(describeLive(call()).caption).toBeNull();
	});

	test("the voice conversation's view says it is the voice conversation, with no Live caption", () => {
		const v = describeSurface(facts({ phase: "listening", micLive: true }), false);
		expect(v.mode).toBe("voice");
		expect(v.caption).toBeNull();
		expect(v.micLive).toBe(true);
	});
});

describe("sameArkitOrder: the guard between the kit's faceAt() order and the pack's rig", () => {
	test("identical lists agree; a swap, a rename or a missing name does not", () => {
		const names = ["a", "b", "c"];
		expect(sameArkitOrder(names, ["a", "b", "c"])).toBe(true);
		expect(sameArkitOrder(names, ["a", "c", "b"])).toBe(false);
		expect(sameArkitOrder(names, ["a", "b", "x"])).toBe(false);
		expect(sameArkitOrder(names, ["a", "b"])).toBe(false);
	});
});
