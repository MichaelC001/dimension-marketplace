// What the pane offers under a recording it could not play (docs/design/88 section 3.1, "Codec honesty"). A failure a
// second try can fix is answered with "Try again". One it cannot - the file is damaged, in a codec the viewer does not
// have, or too big to play here - is answered with the way out, "Copy path", so the file can be opened in a media
// player: "Try again" there is a button that does nothing.
import type { ViewerKind } from "../../src/contract";
import { describeMediaError, OPEN_TIMEOUT_SENTENCE } from "./media-messages";

/** Audio and video: played, not shown. */
export const isRecording = (kind: ViewerKind): boolean => kind === "audio" || kind === "video";

/**
 * Where opening a recording failed. `load`: getting the viewer's code for it or reading its bytes (the file changed while
 * it was read, the read itself failed). `open`: the browser's player looking at bytes it has in hand.
 */
export type FailureStage = "load" | "open";

/** A recording that could not be played: too big to be read at all, or failed at a stage with a sentence for the human. */
export type RecordingFailure =
	| { readonly where: "too-large" }
	| { readonly where: FailureStage; readonly message: string };

export type FailureAction = "try-again" | "copy-path";

/**
 * The sentences of an `open` failure a second try can fix: the player never answered in time, or said its read of the
 * bytes failed. Taken from the same words the renderer says them with (`media-messages`), not retyped.
 */
const WORTH_ANOTHER_GO: readonly string[] = [OPEN_TIMEOUT_SENTENCE, describeMediaError("video", undefined, true, 2)];

export function failureAction(failure: RecordingFailure): FailureAction {
	if (failure.where === "too-large") return "copy-path";
	if (failure.where === "load") return "try-again";
	return WORTH_ANOTHER_GO.includes(failure.message) ? "try-again" : "copy-path";
}
