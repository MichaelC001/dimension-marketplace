import { LibraryError } from "./errors";

export const MAX_TAGS = 24;
export const MAX_TAG_CHARS = 48;
export const MAX_FACET_TAGS = 200;

const ASCII_UPPER = /[A-Z]/g;
export const HAS_TAGS = "a.tags != '[]'";
const CARRIES_TAG = "EXISTS (SELECT 1 FROM json_each(a.tags) WHERE lower(value) = ?)";

export function foldAsciiCase(tag: string): string {
	return tag.trim().replace(ASCII_UPPER, letter => letter.toLowerCase());
}

export interface TagPredicates {
	readonly clauses: readonly string[];
	readonly params: readonly string[];
}

export function tagPredicates(tags: readonly string[] | undefined): TagPredicates {
	const wanted = new Set<string>();
	for (const tag of tags ?? []) {
		const folded = foldAsciiCase(tag);
		if (folded !== "") wanted.add(folded);
	}
	if (wanted.size === 0) return { clauses: [], params: [] };
	if (wanted.size > MAX_TAGS) throw new LibraryError(`filter by at most ${MAX_TAGS} tags`);
	return { clauses: [HAS_TAGS, ...Array.from(wanted, () => CARRIES_TAG)], params: [...wanted] };
}
