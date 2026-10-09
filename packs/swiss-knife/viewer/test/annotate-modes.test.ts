// Which mode the pane shows. There is one annotation bar for every kind and it is always on: an annotatable kind is in
// its primary mode from the pane's first frame, with nothing to switch. A document that did not open has nothing on
// screen to mark, so it must not carry marking help, a list or a send button under its error card, whatever its kind
// (a live proof found them under a failed recording; the same rule had been missing for pictures and text).
import { describe, expect, test } from "bun:test";
import { VIEWER_KINDS, type ViewerKind } from "../src/contract";
import { annotationModes, shownMode } from "../app/view/annotate-modes";
import type { AnnotateMode } from "../app/view/pane-shared";

/** What a person annotates in each kind: the table a reader of the pane would draw. Typed over every kind, so a new
 *  kind cannot be added without deciding here too. */
const EXPECTED: Readonly<Record<ViewerKind, AnnotateMode | null>> = {
	image: "marks",
	html: "elements",
	audio: "timeline",
	video: "timeline",
	markdown: "comments",
	text: "comments",
	pdf: "comments",
	docx: "comments",
	pptx: "comments",
	xlsx: "comments",
	binary: null,
};

/** The pane's phases while there is (or is about to be) something to mark. */
const LIVE_PHASES = ["loading", "ready"] as const;
/** The pane's phases that leave nothing on screen to mark. */
const DEAD_PHASES = ["error", "unavailable"] as const;

describe("shownMode", () => {
	for (const phase of LIVE_PHASES) {
		test(`every kind is in its primary mode while the document is '${phase}'`, () => {
			for (const kind of VIEWER_KINDS) {
				expect(shownMode(kind, phase), kind).toBe(annotationModes(kind)[0] ?? null);
				expect(shownMode(kind, phase), kind).toBe(EXPECTED[kind]);
			}
		});
	}

	for (const phase of DEAD_PHASES) {
		test(`a document in the '${phase}' phase shows no mode, for every kind`, () => {
			for (const kind of VIEWER_KINDS) expect(shownMode(kind, phase), kind).toBeNull();
		});
	}

	test("the mode is derived, not toggled: a repeated or interleaved phase gives the mode a fresh call would", () => {
		const sequence = ["loading", "ready", "ready", "error", "ready", "loading", "unavailable", "ready"];
		for (const kind of VIEWER_KINDS) {
			const seen = sequence.map(phase => shownMode(kind, phase));
			const fresh = sequence.map(phase => (DEAD_PHASES as readonly string[]).includes(phase) ? null : EXPECTED[kind]);
			expect(seen, kind).toEqual(fresh);
		}
	});

	// A phase name the table does not know is a live pane, not a gate. Names that exist on every object (`toString`,
	// `__proto__`, ...) are the ones a naive `phase in gate` lookup would wrongly treat as a gated phase.
	for (const phase of ["idle", "", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
		test(`an unknown phase ${JSON.stringify(phase)} behaves like a live phase, for every kind`, () => {
			for (const kind of VIEWER_KINDS) expect(shownMode(kind, phase), kind).toBe(EXPECTED[kind]);
		});
	}
});

describe("the modes table the pane seats its layers from", () => {
	// manifest.test.ts holds plugin.json's `annotates` to the FIRST mode of each kind; a second one would pass that
	// check yet be unreachable (the pane only ever shows the first), so each kind has exactly its one or none.
	test("an annotatable kind offers exactly one mode and a file card offers none", () => {
		for (const kind of VIEWER_KINDS) {
			const expected = EXPECTED[kind];
			expect(annotationModes(kind), kind).toEqual(expected === null ? [] : [expected]);
		}
	});
});
