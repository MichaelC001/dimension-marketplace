// Which annotate mode the View offers for each kind of file, and the model each mode speaks to the host.
//
// Deliberately free of React and CSS (type imports only): the pane seats the layers from this table, and the
// manifest test holds `plugin.json`'s `annotates` to it, so the promise the pack makes the host and the thing the
// View does are one fact and not two lists that can drift.
import type { ArtifactAnnotationModel } from "@dimension/sdk/artifactory";
import type { ViewerKind } from "../../src/contract";
import type { AnnotateMode } from "./pane-shared";

/**
 * The model each of the View's modes implements, in the platform's words (`plugin.json`'s `annotates`, and what the
 * host's `annotationModelFor` asks for). The two vocabularies differ on purpose: the View names a mode for what the
 * human does (`comments`, `elements`), the platform names a model for what the agent receives (`text`, `element`).
 */
export const MODEL_FOR_MODE: Readonly<Record<AnnotateMode, ArtifactAnnotationModel>> = {
	marks: "marks",
	comments: "text",
	elements: "element",
	timeline: "timeline",
};

/**
 * Which modes the toolbar offers for a kind. Empty hides the toggle.
 *
 * A kind is listed only when its renderer puts what the human sees where a layer can reach it: a picture in a box
 * sized to its drawn pixels, or text in a `viewer-text-root` element (Word's is an open shadow root: the kit reads
 * it). A page is the exception that proves it, and it works through TWO frames (docs/design/88 section 2). The
 * reading frame is `sandbox=""`: it runs nothing and the View cannot read it. `elements` is offered because Pick
 * mode adds a second frame over it, `sandbox="allow-scripts"` and nothing else, whose document opens with a policy
 * that admits only the hash of the picker script: that script reports layout and the View draws every outline
 * itself. A recording offers `timeline`. Every kind is named, so a new one cannot be added without deciding.
 */
const MODES: Readonly<Record<ViewerKind, readonly AnnotateMode[]>> = {
	image: ["marks"],
	html: ["elements"],
	audio: ["timeline"],
	video: ["timeline"],
	markdown: ["comments"],
	text: ["comments"],
	pdf: ["comments"],
	docx: ["comments"],
	pptx: ["comments"],
	xlsx: ["comments"],
	binary: [],
};

export function annotationModes(kind: ViewerKind): readonly AnnotateMode[] {
	return MODES[kind];
}

/** The pane's phases that leave nothing on screen to mark: the file would not open, or is too large to. */
const NOTHING_TO_MARK = new Set(["error", "unavailable", "too-large"]);

/**
 * The mode the layer is shown in. A document that did not open has nothing to mark, so no kind gets marking help,
 * a list or a send button under its error card; the human's chosen mode is kept by the pane and comes back if a
 * second try opens the file.
 */
export function shownMode(mode: AnnotateMode | null, phase: string): AnnotateMode | null {
	return NOTHING_TO_MARK.has(phase) ? null : mode;
}
