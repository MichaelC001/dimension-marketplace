// How a Live call moves the face: no word schedule, no audio-to-face model, only the voice's loudness. Defended
// against the REAL animator, because the property that matters is on the other side of the seam: the animator only
// shapes the mouth while it has a playhead, so a feeder that forgot one would leave the face frozen mid-sentence.
import { describe, expect, test } from "bun:test";
import { type AnimatorInput, FaceAnimator } from "../src/face/animator";
import { type ArkitName, arkitIndex } from "../src/face/shapes";
import { LiveMouth } from "../src/surface/live-mouth";

const DT = 1 / 60;
const W = (a: FaceAnimator, n: ArkitName) => a.frame.weights[arkitIndex(n)];
const openness = (a: FaceAnimator) => Math.max(W(a, "jawOpen"), (W(a, "mouthLowerDownLeft") + W(a, "mouthLowerDownRight")) / 2);
const blank = (): AnimatorInput => ({ state: "idle", playhead: null, audioRms: 0, micRms: 0 });
const levels = (input = 0, output = 0) => ({ getInputLevel: () => input, getOutputLevel: () => output });

/** Drive a face through `seconds` of one phase, the way the surface's frame loop would. */
function drive(face: FaceAnimator, mouth: LiveMouth, startMs: number, seconds: number, phase: "listening" | "working" | "speaking", lv: ReturnType<typeof levels>) {
	const input = blank();
	const faceState = phase === "working" ? "thinking" : phase;
	let peak = 0;
	for (let i = 0; i < Math.round(seconds / DT); i++) {
		face.step(DT, mouth.feed(input, { phase: phase === "working" ? "thinking" : phase, faceState }, lv, startMs + i * DT * 1000));
		peak = Math.max(peak, openness(face));
	}
	return peak;
}

describe("LiveMouth: the playhead runs while the voice speaks, and only then", () => {
	test("the first speaking frame is playhead 0 and it grows with the clock", () => {
		const mouth = new LiveMouth();
		const input = blank();
		const view = { phase: "speaking", faceState: "speaking" } as const;
		expect(mouth.feed(input, view, levels(0, 0.2), 5_000).playhead).toBe(0);
		expect(mouth.feed(input, view, levels(0, 0.2), 5_500).playhead).toBe(0.5);
		expect(input.audioRms).toBe(0.2);
		expect(input.state).toBe("speaking");
	});

	test("outside speaking there is no playhead and no voice level; the mic level rides only while listening", () => {
		const mouth = new LiveMouth();
		const input = blank();
		const listening = mouth.feed(input, { phase: "listening", faceState: "listening" }, levels(0.3, 0.9), 0);
		expect([listening.playhead, listening.audioRms, listening.micRms]).toEqual([null, 0, 0.3]);
		const working = mouth.feed(input, { phase: "thinking", faceState: "thinking" }, levels(0.3, 0.9), 100);
		expect([working.playhead, working.audioRms, working.micRms]).toEqual([null, 0, 0]);
	});

	test("each turn of the voice starts its own playhead at 0, not at the time since the call began", () => {
		const mouth = new LiveMouth();
		const input = blank();
		const speaking = { phase: "speaking", faceState: "speaking" } as const;
		mouth.feed(input, speaking, levels(0, 0.2), 1_000);
		expect(mouth.feed(input, speaking, levels(0, 0.2), 4_000).playhead).toBe(3);
		mouth.feed(input, { phase: "listening", faceState: "listening" }, levels(0.1, 0), 4_100);
		expect(mouth.feed(input, speaking, levels(0, 0.2), 9_000).playhead).toBe(0);
	});
});

describe("LiveMouth against the real animator: the mouth follows the voice's level", () => {
	test("a voice with sound moves the mouth for the whole turn, not just the first beat", () => {
		const face = new FaceAnimator(1);
		const mouth = new LiveMouth();
		// three seconds of speech: the second and third seconds must still be open, which is what a missing or stuck playhead would break
		drive(face, mouth, 0, 1, "speaking", levels(0, 0.15));
		const late = drive(face, mouth, 1_000, 2, "speaking", levels(0, 0.15));
		expect(late).toBeGreaterThan(0.1);
	});

	test("a voice with no sound does not pry the mouth open", () => {
		const face = new FaceAnimator(1);
		const mouth = new LiveMouth();
		expect(drive(face, mouth, 0, 1.5, "speaking", levels(0, 0))).toBeLessThan(0.05);
	});

	test("when the voice stops, the mouth closes", () => {
		const face = new FaceAnimator(1);
		const mouth = new LiveMouth();
		drive(face, mouth, 0, 1, "speaking", levels(0, 0.15));
		drive(face, mouth, 1_000, 1, "listening", levels(0.05, 0));
		expect(openness(face)).toBeLessThan(0.05);
	});
});
