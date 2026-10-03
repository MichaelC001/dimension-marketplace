// The annotation modes, pane props, renderer slot lookup, toolbar and footer seats.
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

/** The pane around the document frame and annotation footer. */
function paneOf(frame: HTMLElement | null): HTMLElement | null {
	return frame?.closest<HTMLElement>('[data-slot="viewer-pane"]') ?? null;
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

/** The send row beneath the content, in the pane's flex flow. */
export function Footer({ frame, children }: { readonly frame: HTMLElement | null; readonly children: ReactNode }) {
	const pane = paneOf(frame);
	return pane === null ? null : createPortal(children, pane);
}

