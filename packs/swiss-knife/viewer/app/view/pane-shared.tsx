// The pieces every annotation mode seats the same way: the mode names, the props the
// pane hands a layer, the slot lookup, and the list column. They live here, not in
// `pane-extras.tsx`, so each mode (a picture's marks, a document's comments, a page's
// picked elements, a recording's timeline marks) can be its own file without importing
// the dispatcher back (a cycle) or copying the seating rules.
import type { App } from "@modelcontextprotocol/ext-apps";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DocTab } from "./tabs";

/** The annotation modes: marks on a picture, comments on text, picked elements on a page, notes on a recording's
 *  timeline. A kind is in exactly one (`annotate-modes.ts`); the bar names the tools, never the mode. */
export type AnnotateMode = "marks" | "comments" | "elements" | "timeline";

export interface PaneExtrasProps {
	readonly app: App;
	readonly tab: DocTab;
	/** This document's tab is the one showing. */
	readonly active: boolean;
	/** The renderer has mounted: `frame` now holds the rendered document. */
	readonly ready: boolean;
	/** The `position: relative` frame around the rendered document (`data-slot="viewer-stage-frame"`). */
	readonly frame: HTMLElement | null;
	/** The mode the layer is up in: the kind's primary mode while there is something to mark, `null` while it did not open. */
	readonly mode: AnnotateMode | null;
}

/** The element a renderer marked with `selector`, looked up again whenever it re-mounts. */
export function useSlot(frame: HTMLElement | null, ready: boolean, selector: string): HTMLElement | null {
	const [element, setElement] = useState<HTMLElement | null>(null);
	useEffect(() => {
		setElement(ready && frame !== null ? frame.querySelector<HTMLElement>(selector) : null);
	}, [frame, ready, selector]);
	return element;
}

/** The revision a marked-up file is keyed to: the same identity the tab uses to reload. */
export const revisionOf = (tab: DocTab): string => `${tab.mtimeMs}:${tab.size}`;

/**
 * Below this View width the list goes UNDER the document. The artifact column is ~640 px
 * wide; a 300 px list beside a fit-to-width page (PDF, Word, a slide) leaves it a third of
 * its size, with text a few pixels tall that nobody can read or select. Measured, not guessed.
 */
const SIDE_PANEL_MIN_VIEW_WIDTH = 900;

/** Whether this View is wide enough to seat the list beside the document. */
function useWideView(): boolean {
	const query = `(min-width: ${SIDE_PANEL_MIN_VIEW_WIDTH}px)`;
	const [wide, setWide] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const list = window.matchMedia(query);
		const update = () => setWide(list.matches);
		update();
		list.addEventListener("change", update);
		return () => list.removeEventListener("change", update);
	}, [query]);
	return wide;
}

/** The pane around a document's frame: a flex column of the toolbar, the mode strip, the document row and the sheet. */
function paneOf(frame: HTMLElement | null): HTMLElement | null {
	return frame?.closest<HTMLElement>('[data-slot="viewer-pane"]') ?? null;
}

/** The list of what the human has marked, and the send: beside the document when there is room, under it when there is not. */
export function Column({ frame, children }: { readonly frame: HTMLElement | null; readonly children: ReactNode }) {
	const wide = useWideView();
	if (wide) {
		return (
			<aside data-slot="annotate-panel" data-placement="side" className="flex w-[300px] min-h-0 shrink-0 flex-col">
				{children}
			</aside>
		);
	}
	const pane = paneOf(frame);
	if (pane === null) return null;
	// A sheet under the document, up to half the pane (never more, so the document always keeps the other half; 420 px at
	// most). Its head, body and foot are the same height whether there is one note or ten, the body (the hint, or the list)
	// a fixed one that the rows scroll inside: a sheet that grew with each note moved the picture, the page or the media
	// stage up and down as notes came and went. The kit's panel fills a box it is given (the side column's); here nothing
	// gives it one, so `viewer.css` sets the sheet's body height and lets the rest take the size of what it holds (the
	// kit's CSS is unlayered, so a utility class here would lose).
	return createPortal(
		<aside data-slot="annotate-panel" data-placement="bottom" className="flex max-h-[min(50%,420px)] shrink-0 flex-col">
			{children}
		</aside>,
		pane,
	);
}

/**
 * THE annotation bar (`AnnotationToolbar`: the same bar on every kind, only its tools differ), docked between the
 * viewer's toolbar and the document. It is in the flow: it takes its own row and covers nothing, where a pill
 * floating over a short frame hid the very thing the human was pointing at. The toolbar keeps the slot
 * (`viewer-mode-strip`); a kind with nothing to annotate leaves it empty, and it takes no room.
 */
export function Strip({ frame, children }: { readonly frame: HTMLElement | null; readonly children: ReactNode }) {
	const slot = paneOf(frame)?.querySelector<HTMLElement>('[data-slot="viewer-mode-strip"]') ?? null;
	return slot === null ? null : createPortal(children, slot);
}

