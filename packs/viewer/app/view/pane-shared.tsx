// The pieces every annotation mode seats the same way: the mode names, the props the
// pane hands a layer, the slot lookup, and the list column. They live here, not in
// `pane-extras.tsx`, so each mode (a picture's marks, a document's comments, a page's
// picked elements, a recording's timeline marks) can be its own file without importing
// the dispatcher back (a cycle) or copying the seating rules.
import type { App } from "@modelcontextprotocol/ext-apps";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DocTab } from "./tabs";

/** The toolbar's markup modes: marks on a picture, comments on text, picked elements on a
 *  page, marks on a recording's timeline. */
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
	/** The mode the toolbar toggle is in, or `null` when off. */
	readonly mode: AnnotateMode | null;
	/** Leave or change the mode from inside the layer (Esc, a Done button). */
	readonly onMode: (mode: AnnotateMode | null) => void;
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
	// A sheet under the document. Empty, it is only as tall as the hint and the send need, so the document keeps
	// the room the human is aiming in. Once something is marked it is the list's turn: half the pane (never more,
	// so the document always keeps the other half), which is room for whole rows in the artifact column's ~745 px.
	return createPortal(
		<aside
			data-slot="annotate-panel"
			data-placement="bottom"
			className="flex h-[min(34%,240px)] min-h-[180px] shrink-0 flex-col has-[.dam-list]:h-[min(50%,440px)] [&_.dam-panel]:border-s-0 [&_.dam-panel]:border-t [&_.dam-panel]:border-fr-border"
		>
			{children}
		</aside>,
		pane,
	);
}

/**
 * A mode's own tools (the pick strip, the drawing tools), docked between the viewer's toolbar and the document. It
 * is in the flow: it takes its own row and covers nothing, where a pill floating over a short frame hid the very
 * thing the human was pointing at. The toolbar keeps the slot (`viewer-mode-strip`), empty until a mode fills it.
 */
export function Strip({ frame, children }: { readonly frame: HTMLElement | null; readonly children: ReactNode }) {
	const slot = paneOf(frame)?.querySelector<HTMLElement>('[data-slot="viewer-mode-strip"]') ?? null;
	return slot === null ? null : createPortal(children, slot);
}

