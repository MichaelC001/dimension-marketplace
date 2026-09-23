// The View's coordinate arithmetic, kept free of React so it can be reasoned
// about (and exercised) on its own.
//
// One space rules everything: `state.viewport` CSS pixels. The runtime captures
// at deviceScaleFactor 1 with the viewport only, so the frame PNG's pixels are
// those same coordinates 1:1 — clicks, scroll targets and crop regions are all
// expressed in it, whatever size the seat renders the image at.
import type { BrowserRegion, Viewport } from "../../src/contracts";

export interface Point {
	readonly x: number;
	readonly y: number;
}

/** A drawn mark in viewport pixels: a freehand polyline, or the ellipse
 *  inscribed in a drag's bounding box. Immutable — the same values are drawn
 *  on screen and painted into the PNG that travels to the agent. */
export interface Mark {
	readonly id: number;
	readonly kind: "freehand" | "circle";
	readonly points: readonly Point[];
}

/** The ellipse a circle mark describes, from its two drag corners. Shared by
 *  the SVG overlay and the canvas compositor so both draw the same shape. */
export function ellipseOf(points: readonly Point[]): { cx: number; cy: number; rx: number; ry: number } | null {
	const box = boundsOf(points);
	if (box === null) return null;
	return {
		cx: box.x + box.width / 2,
		cy: box.y + box.height / 2,
		rx: Math.max(1, box.width / 2),
		ry: Math.max(1, box.height / 2),
	};
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
 *  edge of the last pixel, which is exactly what a crop drawn to the edge of
 *  the page needs (a region is `[x, x+width)`, so a full-width crop must be
 *  able to reach `width`). A CLICK is a different thing — it must address a
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

/** Bounding box of a stroke, as a region. Null for an empty stroke. */
export function boundsOf(points: readonly Point[]): BrowserRegion | null {
	if (points.length === 0) return null;
	let minX = points[0].x;
	let minY = points[0].y;
	let maxX = minX;
	let maxY = minY;
	for (const point of points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** The crop that will be sent: the drawn rectangle widened to contain every
 *  freehand/circle mark. Either side may be absent. */
export function unionRegion(a: BrowserRegion | null, b: BrowserRegion | null): BrowserRegion | null {
	if (a === null) return b;
	if (b === null) return a;
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	};
}

/** The rectangle a drag describes, at least one pixel on each side. */
export function regionFromDrag(from: Point, to: Point): BrowserRegion {
	return {
		x: Math.min(from.x, to.x),
		y: Math.min(from.y, to.y),
		width: Math.max(1, Math.abs(to.x - from.x)),
		height: Math.max(1, Math.abs(to.y - from.y)),
	};
}
