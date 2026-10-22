// The View's coordinate arithmetic, kept free of React so it can be reasoned
// about (and exercised) on its own.
//
// One space rules everything: `state.viewport` CSS pixels, the page's real
// layout viewport. The frame PNG is that viewport times the pixel ratio, and a
// mark's page read maps by the natural-to-viewport ratio (`page-annotation.ts`):
// clicks and scroll targets are CSS pixels whatever size the seat renders it at.
import type { Viewport } from "../../src/contracts";

export interface Point {
	readonly x: number;
	readonly y: number;
}

/** The part of a DOM rect this math needs — passed in so the function is pure. */
export interface Box {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

/** Pointer position → viewport pixels: the fraction of the rendered image box,
 *  scaled by the intrinsic viewport size, clamped to the viewport's inclusive
 *  boundary and rounded to a whole pixel. Correct for any display scale,
 *  including fractional zoom.
 *
 *  The clamp is edge-INCLUSIVE on purpose: `x === viewport.width` is the right
 *  edge of the last pixel. A CLICK is a different thing — it must address a
 *  real pixel — so click coordinates go through `toPixelPoint` as well. */
export function toViewportPoint(box: Box, clientX: number, clientY: number, viewport: Viewport): Point {
	if (box.width === 0 || box.height === 0) return { x: 0, y: 0 };
	const x = ((clientX - box.left) / box.width) * viewport.width;
	const y = ((clientY - box.top) / box.height) * viewport.height;
	return {
		x: Math.max(0, Math.min(viewport.width, Math.round(x))),
		y: Math.max(0, Math.min(viewport.height, Math.round(y))),
	};
}

/** A point that must name a rendered pixel — a click, or the keyboard caret.
 *  A `width × height` viewport addresses `0 .. width-1`, so the boundary
 *  coordinate `width` is off-page: clamp it back to the last real pixel rather
 *  than send a click the engine lands somewhere outside the picture. */
export function toPixelPoint(point: Point, viewport: Viewport): Point {
	return {
		x: Math.max(0, Math.min(Math.max(0, viewport.width - 1), Math.round(point.x))),
		y: Math.max(0, Math.min(Math.max(0, viewport.height - 1), Math.round(point.y))),
	};
}
