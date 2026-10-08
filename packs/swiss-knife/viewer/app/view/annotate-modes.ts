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
 * Which modes the annotation bar offers for a kind; the first is the one the pane is in (`shownMode`). Empty: there
 * is nothing to annotate.
 *
 * A kind is listed only when its renderer puts what the human sees where a layer can reach it: a picture in a box
 * sized to its drawn pixels, or text in a `viewer-text-root` element (Word's is an open shadow root: the kit reads
 * it). A page is the exception that proves it, and it works through TWO frames (docs/design/88 section 2). The
 * reading frame is `sandbox=""`: it runs nothing and the View cannot read it. `elements` is offered because every
 * readable page also gets, by default, a second frame over it (Pick is armed from the first frame; only a page past
 * `PICK_FRAME_LIMIT` waits for the Pick tool), `sandbox="allow-scripts"` and nothing else, whose document opens with
 * a policy that admits only the hash of the picker script: that script reports layout and the View draws every
 * outline itself. A recording offers `timeline`. Every kind is named, so a new one cannot be added without deciding.
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

const NOTHING_TO_MARK: Readonly<Record<string, true>> = { error: true, unavailable: true };

/**
 * The mode the layer is up in. There is nothing to switch on: the one annotation bar is part of the pane, so an
 * annotatable kind is in its primary mode (`annotationModes(kind)[0]`) for as long as there is something to mark,
 * from the pane's first frame (the bar and the list then never appear later and shove the document, nor flicker
 * out and in while a theme change or a changed file reloads it). A document that did not open has nothing to mark,
 * so no kind gets marking help, a list or a send button under its error card; a second try that opens the file
 * brings the layer back. Derived, so a second `ready` cannot toggle it off.
 */
export function shownMode(kind: ViewerKind, phase: string): AnnotateMode | null {
	return Object.hasOwn(NOTHING_TO_MARK, phase) ? null : (MODES[kind][0] ?? null);
}
