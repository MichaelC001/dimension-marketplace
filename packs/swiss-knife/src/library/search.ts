export type TextSearch =
	| { readonly kind: "match"; readonly expression: string }
	| { readonly kind: "prefix"; readonly from: string; readonly to: string };

export const MAX_SEARCH_CHARS = 200;
const TRIGRAM_CHARS = 3;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const HIGHEST_CODE_POINT = "\u{10ffff}";

export function parseSearch(text: string | undefined): TextSearch | undefined {
	const trimmed = (text ?? "").replace(CONTROL_CHARS, " ").trim().slice(0, MAX_SEARCH_CHARS);
	if (trimmed === "") return undefined;
	const terms = trimmed.split(/\s+/).filter(term => [...term].length >= TRIGRAM_CHARS);
	if (terms.length > 0) {
		return { kind: "match", expression: terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" ") };
	}
	return { kind: "prefix", from: trimmed, to: `${trimmed}${HIGHEST_CODE_POINT}` };
}
