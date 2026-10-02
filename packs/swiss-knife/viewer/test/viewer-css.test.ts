// The viewer's stylesheet, judged where it matters. linkedom has no layout, so "adding a note does not move the
// document above the sheet" cannot be seen by rendering; it is decided by a handful of declarations. They are read by
// SELECTOR (not by searching the text), so a rule that moves, merges or is overridden further down is judged by what
// it finally declares.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface Rule {
	readonly selectors: readonly string[];
	readonly declared: Record<string, string>;
	/** Inside an at-rule (@media, @supports, ...): it applies only under a condition no test here can know. */
	readonly nested: boolean;
}

/** `name: value` lines of a rule body, whitespace folded, a later line winning. */
function declarationsIn(body: string): Record<string, string> {
	const declared: Record<string, string> = {};
	for (const line of body.split(";")) {
		const colon = line.indexOf(":");
		if (colon > 0) declared[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/\s+/g, " ");
	}
	return declared;
}

/** Every rule in `text` (comments already gone), in source order; the rules inside an at-rule come out marked `nested`. */
function readRules(text: string, nested: boolean): Rule[] {
	const rules: Rule[] = [];
	let depth = 0;
	let from = 0;
	let open = 0;
	let head = "";
	for (let at = 0; at < text.length; at += 1) {
		const char = text[at];
		if (char === "{") {
			if (depth === 0) {
				head = text.slice(from, at).trim();
				open = at + 1;
			}
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				const body = text.slice(open, at);
				if (head.startsWith("@") && body.includes("{")) rules.push(...readRules(body, true));
				else {
					const selectors = head.split(",").map(name => name.trim().replace(/\s+/g, " "));
					rules.push({ selectors, declared: declarationsIn(body), nested });
				}
				from = at + 1;
			}
		}
	}
	return rules;
}

const RULES = readRules(readFileSync(new URL("../app/view/viewer.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), false);

/** What the top-level rules naming exactly `selector` finally declare (a later rule wins). Rules under an at-rule are skipped. */
function declarationsOf(selector: string): Record<string, string> {
	const named = RULES.filter(rule => !rule.nested && rule.selectors.includes(selector));
	if (named.length === 0) throw new Error(`viewer.css has no top-level rule for ${selector}`);
	return Object.assign({}, ...named.map(rule => rule.declared));
}

/** Words of a value, a `var(...)` / `calc(...)` staying one word. */
function wordsOf(value: string): string[] {
	return value.match(/[^\s(]+(?:\([^)]*\))?/g) ?? [];
}

/** `flex`'s three parts as CSS reads the shorthand (`none` is 0 0 auto, `auto` is 1 1 auto, a lone number has a basis of 0); a longhand in the same rule wins. */
function flexOf(declared: Record<string, string>): { grow?: string; shrink?: string; basis?: string } {
	const isNumber = (word: string) => /^[\d.]+$/.test(word);
	let parts: (string | undefined)[] = [undefined, undefined, undefined];
	if (declared.flex === "none") parts = ["0", "0", "auto"];
	else if (declared.flex === "auto") parts = ["1", "1", "auto"];
	else if (declared.flex !== undefined) {
		const [grow = "1", second, third] = wordsOf(declared.flex);
		if (third !== undefined) parts = [grow, second, third];
		else if (second === undefined) parts = isNumber(grow) ? [grow, "1", "0"] : ["1", "1", grow];
		else parts = isNumber(second) ? [grow, second, "0"] : [grow, "1", second];
	}
	return { grow: declared["flex-grow"] ?? parts[0], shrink: declared["flex-shrink"] ?? parts[1], basis: declared["flex-basis"] ?? parts[2] };
}

const BOTTOM = '[data-slot="annotate-panel"][data-placement="bottom"]';
const SHEET_LIST = `${BOTTOM} .dam-list`;
const SHEET_HINT = `${BOTTOM} .dam-empty`;

describe("the annotation sheet under a document", () => {
	test("the hint and the list reserve the same height, never grow past it, and give way only to a pane that caps the sheet", () => {
		// Grow 0: the body never takes more because it holds more. Shrink 1: a pane too short for the whole sheet takes the room from
		// the body (the same whatever it holds), not from the document alone. The basis is the one custom property in both, so the
		// empty hint and a list of notes are the same height and the sheet does not change size when the first note arrives.
		const reserved = { grow: "0", shrink: "1", basis: "var(--vw-sheet-body)" };
		expect({ hint: flexOf(declarationsOf(SHEET_HINT)), list: flexOf(declarationsOf(SHEET_LIST)) }).toEqual({ hint: reserved, list: reserved });
	});

	test("the reservation is a length of its own: a positive px value that holds the empty hint, and no more", () => {
		// A length the content cannot move: `auto`, 0 or a percentage would hand the sheet back to what it holds (a percentage of a
		// parent that is itself sized by its content). The band: the empty hint at the narrowest column (its title and four lines)
		// is about 130 px, so under 120 it would be cut and scroll with room to spare; much over 200 px a short pane would lose its
		// document to an empty hint. The value in the file is judged for being in this band, not for being one number.
		const reserved = declarationsOf(BOTTOM)["--vw-sheet-body"];
		expect(reserved).toMatch(/^\d+(\.\d+)?px$/);
		expect(Number.parseFloat(reserved as string)).toBeGreaterThanOrEqual(120);
		expect(Number.parseFloat(reserved as string)).toBeLessThanOrEqual(200);
	});

	test("both bodies are border-box, so the basis is the outer height in both states", () => {
		// The hint and the list carry different padding. Under content-box the basis would be the height inside the padding, and the
		// hint (the taller padding) would stand taller than the list: the sheet would change height when the first note arrives.
		expect({ hint: declarationsOf(SHEET_HINT)["box-sizing"], list: declarationsOf(SHEET_LIST)["box-sizing"] }).toEqual({
			hint: "border-box",
			list: "border-box",
		});
	});

	test("the empty hint scrolls inside the sheet and may shrink below its text, so a pane too short never makes it overflow", () => {
		// The kit's list scrolls on its own; the empty hint does not, and a flex item will not shrink below its content without
		// a minimum of 0. Either missing and a short pane would let the hint's text run out of the sheet over the document.
		const hint = declarationsOf(SHEET_HINT);
		const overflowY = hint["overflow-y"] ?? wordsOf(hint.overflow ?? "").at(-1);
		expect(["auto", "hidden", "scroll"]).toContain(overflowY as string);
		expect(hint["min-block-size"] ?? hint["min-height"]).toMatch(/^0(px)?$/);
	});

	test("nothing outside the bottom sheet declares or uses the reservation, so the side column is as the kit made it", () => {
		// The side column is a fixed width and the full height: it needs no reserved body, and a fixed basis there would pin
		// its list to a stub in the middle of a tall column. Every rule that names the property, to set it or to read it,
		// must be one whose every selector is under the bottom sheet.
		const users = RULES.filter(
			rule => Object.entries(rule.declared).some(([name, value]) => name === "--vw-sheet-body" || value.includes("--vw-sheet-body")),
		);
		expect(users.length).toBeGreaterThan(0);
		const outside = users.flatMap(rule => rule.selectors).filter(selector => !selector.startsWith(BOTTOM));
		expect(outside).toEqual([]);
	});
});
