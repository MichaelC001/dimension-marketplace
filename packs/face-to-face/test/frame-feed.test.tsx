// What the face is told each frame: the wiring between a conversation and the animator, which the DOM tests cannot see
// (they never mount the WebGL face, so nothing calls the per-frame callbacks). A surface that fed a Live call's frames
// through the voice conversation's path, or the other way round, would draw a still face mid-sentence and no other test
// would notice. Mounted through the real hook, with the clock under the test's control.
import { afterEach, expect, spyOn, test } from "bun:test";
import { type Latest, useFrameFeed } from "../src/surface/face-surface";
import type { FaceLive } from "../src/surface/live";
import { describeLive, describeSurface } from "../src/surface/surface-model";
import type { FaceVoice } from "../src/surface/voice";
import { mountPage, unmountAll } from "./surface-dom";

afterEach(unmountAll);

const voice = {
	supported: true,
	phase: "speaking",
	error: undefined,
	notice: undefined,
	refusal: undefined,
	micLive: true,
	muted: false,
	micSilent: false,
	micLabel: undefined,
	partial: "",
	words: [],
	faceModel: true,
	audioClock: () => 3.25,
	faceAt: () => null,
	levels: { getAgent: () => 0.4, getMic: () => 0.1, getSilence: () => 0 },
} as unknown as FaceVoice;

const live = (phase: FaceLive["phase"], over: Partial<FaceLive> = {}): FaceLive =>
	({
		available: true,
		voice: null,
		phase,
		// the kit shows "muted" over the engine's phase; unless a case says what the engine is doing, it is doing what the call shows
		enginePhase: phase === "muted" ? "listening" : phase,
		transcript: null,
		muted: false,
		seconds: 0,
		error: null,
		getInputLevel: () => 0.2,
		getOutputLevel: () => 0.7,
		start: async () => undefined,
		stop: () => undefined,
		toggleMute: () => undefined,
		...over,
	}) as FaceLive;

type Feed = ReturnType<typeof useFrameFeed>;

function Harness({ latest, inLive, into }: { latest: { current: Latest }; inLive: boolean; into: { current?: Feed } }) {
	into.current = useFrameFeed(latest, voice, inLive);
	return null;
}

async function feed(latest: Latest, inLive: boolean) {
	const into: { current?: Feed } = {};
	const ref = { current: latest };
	await mountPage(<Harness latest={ref} inLive={inLive} into={into} />);
	if (!into.current) throw new Error("the hook did not run");
	return into.current;
}

test("a Live call's frames come from the call: a playhead that runs while the voice speaks, and the call's own levels", async () => {
	const clock = spyOn(performance, "now");
	try {
		const call = live("speaking");
		const frames = await feed({ voice, live: call, view: describeLive(call) }, true);
		clock.mockReturnValue(10_000);
		const first = { ...frames.getInput() };
		clock.mockReturnValue(10_500);
		const later = { ...frames.getInput() };
		expect(first).toMatchObject({ state: "speaking", playhead: 0, audioRms: 0.7, micRms: 0 });
		expect(later.playhead).toBe(0.5);
		// the voice conversation's clock and levels play no part in a call
		expect(later.audioRms).not.toBe(0.4);
		expect(frames.getWaveLevel()).toBe(0.7);
	} finally {
		clock.mockRestore();
	}
});

test("while the person talks to a call, the mouth rests and the mic level drives the listening face", async () => {
	const call = live("listening");
	const frames = await feed({ voice, live: call, view: describeLive(call) }, true);
	expect({ ...frames.getInput() }).toMatchObject({ state: "listening", playhead: null, audioRms: 0, micRms: 0.2 });
	expect(frames.getWaveLevel()).toBe(0.2);
});

test("the voice conversation's frames still come from the voice: its audio clock and levels", async () => {
	const off = live("off");
	const frames = await feed({ voice, live: off, view: describeSurface(voice, true) }, false);
	expect({ ...frames.getInput() }).toMatchObject({ state: "speaking", playhead: 3.25, audioRms: 0.4, micRms: 0 });
	expect(frames.getWaveLevel()).toBe(0.4);
	expect(frames.getSilence()).toBe(0);
});

test("the audio-to-face model moves the mouth in the voice conversation and never in a call, whose voice nothing runs the model on", async () => {
	const off = live("off");
	const inVoice = await feed({ voice, live: off, view: describeSurface(voice, true) }, false);
	expect(inVoice.poseSource).not.toBe("procedural");
	const call = live("speaking");
	const inCall = await feed({ voice, live: call, view: describeLive(call) }, true);
	expect(inCall.poseSource).toBe("procedural");
});

test("a person who muted still sees the mouth follow the voice: the kit shows 'muted' over the whole call, the frames follow the engine", async () => {
	const clock = spyOn(performance, "now");
	try {
		const call = live("muted", { enginePhase: "speaking", muted: true });
		const frames = await feed({ voice, live: call, view: describeLive(call) }, true);
		clock.mockReturnValue(5_000);
		frames.getInput();
		clock.mockReturnValue(5_250);
		expect({ ...frames.getInput() }).toMatchObject({ state: "speaking", playhead: 0.25, audioRms: 0.7 });
		expect(frames.getWaveLevel()).toBe(0.7);
	} finally {
		clock.mockRestore();
	}
});
