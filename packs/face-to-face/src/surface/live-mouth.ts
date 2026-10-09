// What the face is told on each frame of a Live call.
//
// The voice conversation hands the animator a word schedule and a playhead into the audio it is playing. A Live
// call has neither: nothing times its voice to words, and nothing runs the audio-to-face model on it (the voice is
// the realtime provider's own audio, played by the browser). The animator
// only shapes the mouth while it has a playhead, so during the voice's turns this one simply RUNS (seconds since
// the voice began speaking) beside the voice's own loudness; with no words to play against, the animator's
// "voice with no viseme data yet" path keeps the lips moving with the sound and the jaw follows the level.
import type { AnimatorInput } from "../face/animator";
import type { FaceLive } from "./live";
import type { SurfaceView } from "./surface-model";

export class LiveMouth {
	#since: number | null = null;

	/** Fill `input` for this frame (and return it). `nowMs` is a monotonic clock in milliseconds. */
	feed(
		input: AnimatorInput,
		view: Pick<SurfaceView, "phase" | "faceState">,
		levels: Pick<FaceLive, "getInputLevel" | "getOutputLevel">,
		nowMs: number,
	): AnimatorInput {
		const speaking = view.phase === "speaking";
		if (!speaking) this.#since = null;
		else this.#since ??= nowMs;
		input.state = view.faceState;
		input.playhead = this.#since === null ? null : (nowMs - this.#since) / 1000;
		input.audioRms = speaking ? levels.getOutputLevel() : 0;
		input.micRms = view.phase === "listening" ? levels.getInputLevel() : 0;
		return input;
	}
}
