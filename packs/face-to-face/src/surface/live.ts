// The ONE file that touches the kit's Live hook (doc 92 §4). Everything else in the pack talks to `FaceLive`, a
// structural slice of `LiveConversation`, so the surface's state logic runs against a fake in tests and the pack
// never depends on more of the hook than it draws and drives.
//
// Live is a REALTIME voice that talks with the person while the real session works behind it. It shares the
// Face's mouth and nothing else with the voice conversation: nothing times a call's voice to words or runs the
// audio-to-face model on it, so the mouth follows the voice's loudness instead (see `live-mouth.ts`).
import { type LiveConversation, useLiveConversation } from "@fraym/ui";

export type FaceLive = Pick<
	LiveConversation,
	| "available"
	| "voice"
	| "phase"
	| "enginePhase"
	| "transcript"
	| "muted"
	| "seconds"
	| "error"
	| "getInputLevel"
	| "getOutputLevel"
	| "start"
	| "stop"
	| "toggleMute"
>;

/** Live on the session this surface is seated in; inert (`available: false`) where the engine offers none. */
export function useFaceLive(): FaceLive {
	return useLiveConversation();
}
