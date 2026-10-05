// The viewer's entry stylesheet, judged where it matters. linkedom has no layout and no cascade, so "the View does not paint
// a dark box over a light host before its first themed render" cannot be seen by rendering; it is decided by which rules
// are allowed to declare a ground at all. They are read by SELECTOR (not by searching the text), so a rule that moves,
// merges or is overridden further down is judged by what it finally declares.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { THEME_READY_ATTRIBUTE } from "@dimension/mcp-app-kit/theme-ready";

interface Rule {
	readonly selectors: readonly string[];
	readonly declared: Record<string, string>;
	/** Inside an at-rule (@media, @layer, ...): it applies only under a condition no test here can know. */
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

/** Every rule in `text` (comments and at-lines already gone), in source order; the rules inside an at-rule come out marked `nested`. */
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

// `@import` / `@source` are statements, not rules, and are taken out FIRST: the glob in `@source "./**/*.{ts,tsx}"` holds a
// `/**/` that the comment strip would read as an empty comment, and braces that would unbalance the rule reader.
const RULES = readRules(
	readFileSync(new URL("../app/view/app.css", import.meta.url), "utf8")
		.replace(/^[ \t]*@(?:import|source)\b[^;]*;[ \t]*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, ""),
	false,
);

/** What the top-level rules naming exactly `selector` finally declare (a later rule wins). Rules under an at-rule are skipped. */
function declarationsOf(selector: string): Record<string, string> {
	const named = RULES.filter(rule => !rule.nested && rule.selectors.includes(selector));
	if (named.length === 0) throw new Error(`app.css has no top-level rule for ${selector}`);
	return Object.assign({}, ...named.map(rule => rule.declared));
}

/** The element a selector styles: its last compound, after any combinator. */
function subjectOf(selector: string): string {
	return selector.split(/[\s>+~]+/).at(-1) ?? selector;
}

/** The elements that are the document itself: the root, the body, the mount point, or everything. */
const DOCUMENT_SUBJECT = /^(?:html|body|#root|:root|\*)(?![\w-])/;

const ATTRIBUTE = `[${THEME_READY_ATTRIBUTE}]`;
const THEMED_HTML = `html${ATTRIBUTE}`;
const OPENING = '[data-slot="artifact-opening"]';

/** Whether a selector applies only once the root carries the marker. `:not(...)` does not count: that is the unmarked document. */
function requiresMarker(selector: string): boolean {
	return selector.startsWith(THEMED_HTML) || selector.startsWith(`:root${ATTRIBUTE}`);
}

/** Whether a declaration block lays a ground down (anything but nothing or transparent). */
function paintsGround(declared: Record<string, string>): boolean {
	return ["background", "background-color", "background-image"].some(name => {
		const value = declared[name];
		return value !== undefined && value !== "transparent" && value !== "none";
	});
}

describe("a View's ground waits for its theme", () => {
	test("no rule paints a ground on the document unless the root carries the marker", () => {
		// Until the shell has laid the host's tokens `--fr-bg` is still the kit's default, dark, and the host's opening surface
		// is already fading over this iframe. An opaque ground on html, body or #root that does not wait for the marker shows
		// as a dark frame over a light host for as long as the first themed render takes. Every rule that grounds the document
		// must be one that needs `html[marker]`, in any form: a `:not(marker)` rule is the unmarked document and does not count.
		const grounded = RULES.filter(rule => paintsGround(rule.declared))
			.flatMap(rule => rule.selectors)
			.filter(selector => DOCUMENT_SUBJECT.test(subjectOf(selector)));
		expect(grounded.length).toBeGreaterThan(0);
		expect(grounded.filter(selector => !requiresMarker(selector))).toEqual([]);
	});

	test("once marked, html, body and #root each paint --fr-bg, the host's own ground", () => {
		// The marker is the shell saying the host's tokens are laid, so `--fr-bg` is now the host's colour whether the View is
		// hosted or standalone, light or dark. The three layers each carry it: the one left out is the band that shows another
		// ground, the canvas past the body or the body behind a root shorter than the pane.
		const selectors = [THEMED_HTML, `${THEMED_HTML} body`, `${THEMED_HTML} #root`];
		const painted = Object.fromEntries(selectors.map(selector => [selector, declarationsOf(selector).background]));
		expect(painted).toEqual(Object.fromEntries(selectors.map(selector => [selector, "var(--fr-bg)"])));
	});

	test("only the ground waits: the text colour of html, body and #root is not behind the marker", () => {
		// The gate is one declaration, a box, not the document's whole base rule. Folding `color` in with it would leave the
		// unmarked document (the shell's fallback, an error that never marked) with the user agent's text colour instead of
		// the kit's token.
		const colours = Object.fromEntries(["html", "body", "#root"].map(selector => [selector, declarationsOf(selector).color]));
		expect(colours).toEqual({ html: "var(--fr-text)", body: "var(--fr-text)", "#root": "var(--fr-text)" });
	});

	test("the shell's fallback surface gives its opaque ground up until the marker, and nothing makes it opaque again", () => {
		// The fallback the View shows from its first paint is the same opaque `bg-fr-bg` ground, born unthemed, so it would
		// show the dark default over a light host for as long as the iframe's own ground does. The rule is a top-level one, read
		// as such: inside an at-rule or `@layer` it would lose to the layered utility class it has to override. And no other
		// rule may lay a ground on that surface for a document without the marker; under the marker the shell's own ground is right.
		const unmarked = `html:not(${ATTRIBUTE}) ${OPENING}`;
		const opaque = RULES.filter(rule => paintsGround(rule.declared))
			.flatMap(rule => rule.selectors)
			.filter(selector => subjectOf(selector).includes(OPENING) && !requiresMarker(selector));
		expect({ ground: declarationsOf(unmarked).background, opaque }).toEqual({ ground: "transparent", opaque: [] });
	});

	test("the stylesheet names the marker exactly as the kit stamps it, and no look-alike", () => {
		// The kit sets one attribute on <html> and the stylesheet waits for one; a rename on either side alone, or a typo
		// one letter apart, would leave the ground waiting for a marker that never comes (a View with no ground at all) or
		// painting without waiting. `data-theme` in particular is the host's palette itself, stamped by the settings provider:
		// gating on it would ground a light View and leave a dark one bare. Every attribute here that talks of the theme or of
		// readiness must be that one name.
		const attributes = RULES.flatMap(rule => rule.selectors).flatMap(selector => [...selector.matchAll(/\[\s*([^\s\]=~|^$*]+)/g)].map(match => match[1] ?? ""));
		expect([...new Set(attributes.filter(name => /theme|ready/.test(name)))]).toEqual([THEME_READY_ATTRIBUTE]);
	});
});
