// What the Browser adds to the shared annotation kit's message.
//
// The kit (`@dimension/mcp-app-kit/annotate`) owns the marks, the burned-in picture, the crops and the limits. It
// cannot know that the picture is a web page, which page, how far it was scrolled, or which button sits under a
// circle. Those are this pack's facts, and the kit's own hooks are where they go: `enrich` runs once when the human
// presses send and answers a one-line fact for the picture and one per mark; `attach` is where the long form (every
// element under every mark) is kept so the message can name where to read it.
//
// Everything a page wrote (its title, its address, the words on its elements) is untrusted: it is squashed to one
// visible line before it joins a sentence the agent reads, the same rule the kit applies to the human's own notes.
import {
	type AttachHook,
	type EnrichHook,
	type EnrichResult,
	type Fact,
	MAX_ANNOTATION_SUMMARY,
	MAX_MARK_SUMMARY,
	type Mark,
	markBounds,
	type Size,
	toPixelRect,
} from "@dimension/mcp-app-kit/annotate";
import type { BrowserAnnotationContext, BrowserRegion, Viewport } from "../../src/contracts";

/** What the kit's detail document calls itself: the agent opening it knows it is about a web page. */
export const PAGE_DETAIL_KIND = "browser-page";

/** The most a mark can be narrower than: a pin or a sliver reads a square this wide around it. */
const MIN_REGION_PX = 24;
/** Characters of the page's address in the picture's name, and of its title in the one-line fact. */
const NAME_CHARS = 200;
const TITLE_CHARS = 80;
/** The name of a picture of a page that has no address yet. */
const UNNAMED = "browser page";

/** The calls this module makes of the browser: the two app-only tools, as the View's client offers them. */
export interface PageAnnotationClient {
	annotate(
		browserId: string,
		frameId: string,
		regions: readonly BrowserRegion[],
		signal?: AbortSignal,
	): Promise<BrowserAnnotationContext>;
	annotationFile(json: string): Promise<string>;
}

/**
 * Whitespace, controls, the zero-width and direction marks, the line and paragraph separators, the bidi overrides
 * and the Unicode tag block (which spells ASCII in characters nothing draws): squashed to one space. The kit's
 * `quoted` applies the same set to the human's words; it is not exported, so a page's words are held to it here.
 */
const HIDDEN_OR_BREAKING = /[\s\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]+/gu;

function squash(text: string): string {
	return text.replace(HIDDEN_OR_BREAKING, " ").trim();
}

/** One visible line of at most `max` characters, ending in an ellipsis when it was cut. */
function clip(text: string, max: number): string {
	const line = squash(text);
	if (line.length <= max) return line;
	let end = max - 1;
	// Never leave half of a surrogate pair at the cut.
	const last = line.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${line.slice(0, end)}…`;
}

/** The name the agent knows the picture by: the page's address. */
export function captureName(url: string): string {
	const name = clip(url, NAME_CHARS);
	return name.length > 0 ? name : UNNAMED;
}

/**
 * The part of the page a mark covers, in page pixels. The frame is one picture pixel per page pixel; `natural` and
 * `viewport` are compared anyway so a frame of any size lands on the same place. A pin has no size and a thin
 * stroke very little, so both read a square of {@link MIN_REGION_PX} around them, kept on the page.
 */
export function markRegion(mark: Mark, natural: Size, viewport: Viewport): BrowserRegion {
	const rect = toPixelRect(markBounds(mark.shape), natural);
	const scaleX = viewport.width / natural.width;
	const scaleY = viewport.height / natural.height;
	const side = (start: number, length: number, limit: number): [number, number] => {
		const size = Math.min(limit, Math.max(MIN_REGION_PX, length));
		const origin = Math.min(limit - size, Math.max(0, start - (size - length) / 2));
		return [Math.round(origin), Math.round(size)];
	};
	const [x, width] = side(rect.x * scaleX, rect.width * scaleX, viewport.width);
	const [y, height] = side(rect.y * scaleY, rect.height * scaleY, viewport.height);
	return { x, y, width, height };
}

/** The picture as a whole: which page it is, where it was scrolled, when it was taken. */
export function pageFact(context: BrowserAnnotationContext): Fact {
	const { scroll, viewport } = context;
	const title = clip(context.title, TITLE_CHARS);
	const summary = [
		`Live web page${title.length > 0 ? ` ${JSON.stringify(title)}` : ""} at ${clip(context.url, NAME_CHARS)}.`,
		`Scrolled to x=${scroll.x} y=${scroll.y} of a ${scroll.width}×${scroll.height} page; viewport ${viewport.width}×${viewport.height} px.`,
		`Picture taken ${context.capturedAt}, elements read ${context.readAt}.`,
		"Read this page with browser_state (no browserId needed).",
	].join(" ");
	return {
		summary: clip(summary, MAX_ANNOTATION_SUMMARY),
		detail: {
			url: squash(context.url),
			title: squash(context.title),
			capturedAt: context.capturedAt,
			readAt: context.readAt,
			viewport,
			scroll,
		},
	};
}

/** `tag#id [x,y wxh] label` as the page reader writes it. */
const ELEMENT_LINE = /^(\S+) \[-?\d+,-?\d+ \d+x\d+\] ?(.*)$/;
/** The marker the reader ends a list with when it was cut. */
const CUT_MARKER = /^… \[truncated\]/;
/** Room kept at the end of a summary for "; +NN more". */
const MORE_ROOM = 12;

/** One element as a short phrase: `tag#id "words"`. Its box stays in the detail. */
function phrase(line: string): string {
	const found = ELEMENT_LINE.exec(line);
	if (found === null) return line;
	const [, tag, words] = found;
	return words === undefined || words.length === 0 ? (tag ?? line) : `${tag} ${JSON.stringify(words)}`;
}

/** What is under one mark: the first few elements in a line, and every one in the detail. */
export function markFact(entry: BrowserAnnotationContext["regions"][number]): Fact {
	const lines = entry.elements
		.split("\n")
		.map(squash)
		.filter(line => line.length > 0);
	const cut = lines.some(line => CUT_MARKER.test(line));
	const elements = lines.filter(line => !CUT_MARKER.test(line));
	const detail = { region: entry.region, elements: lines };
	if (elements.length === 0) return { summary: "Nothing the page draws is under it (an empty area).", detail };

	const lead = "Under it: ";
	const budget = MAX_MARK_SUMMARY - lead.length - MORE_ROOM;
	const shown: string[] = [];
	let used = 0;
	for (const element of elements) {
		const next = phrase(element);
		const room = used + (shown.length === 0 ? 0 : 2) + next.length;
		if (shown.length > 0 && room > budget) break;
		shown.push(shown.length === 0 ? clip(next, budget) : next);
		used = room;
	}
	const left = elements.length - shown.length;
	const more = left > 0 ? `; +${left}${cut ? "+" : ""} more` : cut ? "; and more" : "";
	return { summary: `${lead}${shown.join("; ")}${more}`, detail };
}

/** The kit's enrichment for these marks from what the page answered: the picture's fact and one per mark, in order. */
export function enrichment(marks: readonly Mark[], context: BrowserAnnotationContext): EnrichResult {
	return {
		annotation: pageFact(context),
		marks: marks.flatMap((mark, index) => {
			const entry = context.regions[index];
			return entry === undefined ? [] : [{ id: mark.id, ...markFact(entry) }];
		}),
	};
}

/**
 * The `enrich` hook for a picture of `frame`: ONE read of the page for every mark, in the order the human numbers
 * them. A page that has moved on, or a read that fails, rejects: the kit then sends the marks without these facts
 * and tells the human why, rather than the Browser pretending the page still matches the picture.
 */
export function pageEnrich(
	client: PageAnnotationClient,
	browserId: string,
	frame: { readonly frameId: string; readonly viewport: Viewport },
): EnrichHook {
	return async ({ marks, natural, signal }) => {
		const regions = marks.map(mark => markRegion(mark, natural, frame.viewport));
		return enrichment(marks, await client.annotate(browserId, frame.frameId, regions, signal));
	};
}

/** The `attach` hook: the kit's detail document is kept by this pack's own server, which answers where. */
export function pageAttach(client: PageAnnotationClient): AttachHook {
	return async ({ json }) => ({ ref: await client.annotationFile(json) });
}
