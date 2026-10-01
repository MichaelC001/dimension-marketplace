// Which mode the pane shows. A document that did not open has nothing on screen to mark, so it must not carry marking
// help, a list or a send button under its error card, whatever its kind (a live proof found them under a failed
// recording; the same rule had been missing for pictures and text since the seat was written).
import { describe, expect, test } from "bun:test";
import { VIEWER_KINDS } from "../src/contract";
import { annotationModes, shownMode } from "../app/view/annotate-modes";

describe("shownMode", () => {
	for (const phase of ["error", "unavailable", "too-large"]) {
		test(`a document in the '${phase}' phase shows no mode, for every kind`, () => {
			for (const kind of VIEWER_KINDS) {
				for (const mode of annotationModes(kind)) expect(shownMode(mode, phase)).toBeNull();
			}
		});
	}

	for (const phase of ["loading", "ready"]) {
		test(`the chosen mode is kept while the document is '${phase}'`, () => {
			for (const kind of VIEWER_KINDS) {
				for (const mode of annotationModes(kind)) expect(shownMode(mode, phase)).toBe(mode);
			}
		});
	}

	test("no mode chosen is still no mode, in any phase", () => {
		for (const phase of ["loading", "ready", "error", "unavailable", "too-large"]) expect(shownMode(null, phase)).toBeNull();
	});
});
