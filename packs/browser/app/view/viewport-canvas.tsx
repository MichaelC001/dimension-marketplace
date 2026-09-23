// The picture, and everything drawn on top of it.
//
// The image is laid out at `width:100%; height:auto`, so its client rect IS the
// image box and a pointer maps to viewport pixels by fraction of that rect
// (`geometry.ts`). The SVG overlay uses `viewBox="0 0 width height"` with
// `preserveAspectRatio="none"`, so drawings are stored and shipped in those
// fixed intrinsic coordinates and never drift when the seat is resized.
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { BrowserFrame, BrowserRegion, Viewport } from "../../src/contracts";
import { Button, Field, Input } from "@fraym/ui/elements"
import { boundsOf, ellipseOf, type Mark, type Point, regionFromDrag, toPixelPoint, toViewportPoint, unionRegion } from "./geometry";

export type CanvasTool = "interact" | "region" | "circle" | "freehand";

/** A freehand stroke is a drawing aid, not a recording: past this many samples
 *  the newest point replaces the last one instead of growing the polyline, so a
 *  long slow stroke cannot grow the component's state without bound. */
const MAX_FREEHAND_POINTS = 1024;

/** And the sketch as a whole is bounded too: past this many marks the oldest
 *  is dropped, so a long annotating session cannot grow this component's state
 *  — or the PNG it will be painted into — without limit. */
const MAX_MARKS = 64;

/** Arrow-key caret steps, fine and coarse (Shift). */
const CARET_STEP = 1;
const CARET_STEP_COARSE = 25;

export interface SketchState {
	/** The crop rectangle, or null when nothing is marked. */
	readonly region: BrowserRegion | null;
	/** The marks themselves, in viewport pixels. They widen the crop AND are
	 *  painted into the PNG the panel sends, so the agent sees the actual
	 *  circles and strokes — not just the rectangle around them. */
	readonly marks: readonly Mark[];
}

export interface ViewportCanvasProps {
	readonly frame: BrowserFrame | null;
	readonly viewport: Viewport;
	readonly tool: CanvasTool;
	readonly url: string;
	readonly title: string;
	/** Frozen while annotating: the loop is paused, so say so on the picture. */
	readonly frozen: boolean;
	readonly disabled: boolean;
	/** A click the human made on the page — the app runs it as browser_act. */
	readonly onPoint: (point: Point) => void;
	readonly onSketchChange: (sketch: SketchState) => void;
	/** Bumping this token clears every drawing (after a send, or a browser switch). */
	readonly clearToken: number;
}

/** One drawn mark: a freehand polyline, or the ellipse inscribed in the drag's
 *  bounding box. The same two shapes `annotation-image` paints into the crop —
 *  both read their geometry from `geometry.ts`, so screen and PNG agree. */
function SketchMark({ kind, points }: { readonly kind: "freehand" | "circle"; readonly points: readonly Point[] }) {
	if (kind === "freehand") {
		return <polyline className="bx-mark" points={points.map(point => `${point.x},${point.y}`).join(" ")} />;
	}
	const ellipse = ellipseOf(points);
	if (ellipse === null) return null;
	return <ellipse className="bx-mark" cx={ellipse.cx} cy={ellipse.cy} rx={ellipse.rx} ry={ellipse.ry} />;
}

interface Drag {
	readonly kind: CanvasTool;
	readonly from: Point;
	readonly points: readonly Point[];
}

export function ViewportCanvas({
	frame,
	viewport,
	tool,
	url,
	title,
	frozen,
	disabled,
	onPoint,
	onSketchChange,
	clearToken,
}: ViewportCanvasProps) {
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const [region, setRegion] = useState<BrowserRegion | null>(null);
	const [marks, setMarks] = useState<readonly Mark[]>([]);
	const [drag, setDrag] = useState<Drag | null>(null);
	// The keyboard caret: where a pointer-free click would land.
	const [caret, setCaret] = useState<Point | null>(null);
	// The numeric route to a crop, kept as text so a half-typed number is not
	// rounded under the human's fingers.
	const [draft, setDraft] = useState({ x: "0", y: "0", width: "200", height: "200" });

	// A send, a profile switch or an explicit clear wipes the sketch — a drawing
	// from another page must never be shipped with a new crop.
	useEffect(() => {
		setRegion(null);
		setMarks([]);
		setDrag(null);
		setCaret(null);
	}, [clearToken]);

	// A drawn region fills the numeric fields, so a keyboard user can refine a
	// crop someone started with the pointer.
	useEffect(() => {
		if (region === null) return;
		setDraft({
			x: String(region.x),
			y: String(region.y),
			width: String(region.width),
			height: String(region.height),
		});
	}, [region]);

	// What the panel will send: the drawn rectangle widened to contain every
	// freehand/circle mark (marks alone give their own bounding box), plus the
	// marks themselves so their actual strokes can be painted into the crop.
	useEffect(() => {
		onSketchChange({
			region: unionRegion(region, boundsOf(marks.flatMap(mark => mark.points))),
			marks,
		});
	}, [region, marks, onSketchChange]);

	const pointOf = (event: ReactPointerEvent, surface: HTMLElement): Point =>
		toViewportPoint(surface.getBoundingClientRect(), event.clientX, event.clientY, viewport);

	// Only a freehand stroke reads its point list; region and circle are defined
	// entirely by the drag's two corners (the circle is inscribed in that box),
	// so they keep exactly two points instead of one per pointermove.
	const extend = (current: Drag, point: Point): Drag => {
		if (current.kind !== "freehand") return { ...current, points: [current.from, point] };
		const points = current.points;
		const last = points[points.length - 1];
		if (last !== undefined && last.x === point.x && last.y === point.y) return current;
		if (points.length >= MAX_FREEHAND_POINTS) return { ...current, points: [...points.slice(0, -1), point] };
		return { ...current, points: [...points, point] };
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const surface = surfaceRef.current;
		if (!surface || disabled || frame === null) return;
		const point = pointOf(event, surface);
		if (tool === "interact") {
			onPoint(toPixelPoint(point, viewport));
			return;
		}
		surface.setPointerCapture(event.pointerId);
		setDrag({ kind: tool, from: point, points: [point] });
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const surface = surfaceRef.current;
		if (!surface || drag === null) return;
		const point = pointOf(event, surface);
		setDrag(current => (current === null ? null : extend(current, point)));
		if (drag.kind === "region") setRegion(regionFromDrag(drag.from, point));
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const surface = surfaceRef.current;
		if (surface?.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
		if (drag === null) return;
		if ((drag.kind === "freehand" || drag.kind === "circle") && drag.points.length > 1) {
			const kind = drag.kind;
			const points = drag.points;
			setMarks(current => [...current, { id: Date.now() + current.length, kind, points }].slice(-MAX_MARKS));
		}
		setDrag(null);
	};

	// The keyboard route onto the picture: arrows move a caret in viewport
	// pixels (Shift for a coarse step), Enter/Space places it and — in Interact
	// — clicks where a pointer would have. A region has no
	// pointer-free gesture, so it is entered as four numbers below the picture.
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (disabled || frame === null) return;
		const step = event.shiftKey ? CARET_STEP_COARSE : CARET_STEP;
		const base = caret ?? toPixelPoint({ x: viewport.width / 2, y: viewport.height / 2 }, viewport);
		let next: Point;
		switch (event.key) {
			case "ArrowLeft":
				next = { x: base.x - step, y: base.y };
				break;
			case "ArrowRight":
				next = { x: base.x + step, y: base.y };
				break;
			case "ArrowUp":
				next = { x: base.x, y: base.y - step };
				break;
			case "ArrowDown":
				next = { x: base.x, y: base.y + step };
				break;
			case "Home":
				next = { x: 0, y: base.y };
				break;
			case "End":
				next = { x: viewport.width, y: base.y };
				break;
			case "Enter":
			case " ":
				event.preventDefault();
				// The first press only places the caret: a keyboard user must be
				// able to see where the click will land before making it.
				if (caret === null) setCaret(base);
				else if (tool === "interact") onPoint(toPixelPoint(caret, viewport));
				return;
			default:
				return;
		}
		event.preventDefault();
		setCaret(toPixelPoint(next, viewport));
	};

	const applyNumericRegion = () => {
		const x = Number.parseInt(draft.x, 10);
		const y = Number.parseInt(draft.y, 10);
		const width = Number.parseInt(draft.width, 10);
		const height = Number.parseInt(draft.height, 10);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return;
		const from = toViewportPoint(
			{ left: 0, top: 0, width: viewport.width, height: viewport.height },
			x,
			y,
			viewport,
		);
		const to = toViewportPoint(
			{ left: 0, top: 0, width: viewport.width, height: viewport.height },
			x + Math.max(1, width),
			y + Math.max(1, height),
			viewport,
		);
		setRegion(regionFromDrag(from, to));
	};

	const liveMark = drag !== null && (drag.kind === "freehand" || drag.kind === "circle") ? drag : null;

	return (
		<div className="bx-canvas" data-frozen={frozen ? "true" : "false"}>
			{frame === null ? (
				<div className="bx-canvas-empty" role="status">
					No frame yet — the first capture appears here.
				</div>
			) : (
				<div
					className="bx-surface"
					ref={surfaceRef}
					role="application"
					tabIndex={0}
					aria-label={`Page picture — ${title.length > 0 ? title : "untitled"} at ${url}. Arrow keys move the caret, Shift for a coarse step, Enter places it and clicks in Interact.`}
					style={{ cursor: disabled ? "default" : tool === "interact" ? "pointer" : "crosshair" }}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onKeyDown={onKeyDown}
				>
					<img
						className="bx-frame"
						src={`data:${frame.mimeType};base64,${frame.data}`}
						width={viewport.width}
						height={viewport.height}
						alt={`Page screenshot — ${title.length > 0 ? title : "untitled"} at ${url}, captured ${frame.capturedAt}`}
						draggable={false}
					/>
					<svg
						className="bx-overlay"
						viewBox={`0 0 ${viewport.width} ${viewport.height}`}
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						{region !== null && (
							<rect className="bx-region" x={region.x} y={region.y} width={region.width} height={region.height} />
						)}
						{marks.map(mark => (
							<SketchMark key={mark.id} kind={mark.kind} points={mark.points} />
						))}
						{liveMark !== null && (
							<SketchMark kind={liveMark.kind === "circle" ? "circle" : "freehand"} points={liveMark.points} />
						)}
						{caret !== null && (
							<g className="bx-caret">
								<line x1={caret.x - 12} y1={caret.y} x2={caret.x + 12} y2={caret.y} />
								<line x1={caret.x} y1={caret.y - 12} x2={caret.x} y2={caret.y + 12} />
							</g>
						)}
					</svg>
				</div>
			)}
			{frame !== null && caret !== null && (
				<p className="bx-caret-note" role="status">
					Caret at {caret.x}, {caret.y} (viewport px)
					{tool === "interact"
						? " — press Enter to click there."
						: " — switch to Interact to click, or set a crop by number below."}
				</p>
			)}
			{frame !== null && tool !== "interact" && (
				<form
					className="bx-numeric"
					aria-label="Crop region by number"
					onSubmit={event => {
						event.preventDefault();
						applyNumericRegion();
					}}
				>
					<Field label="Crop x" className="bx-narrow">
						<Input type="number" inputMode="numeric" value={draft.x} disabled={disabled} onChange={event => setDraft(current => ({ ...current, x: event.target.value }))} />
					</Field>
					<Field label="Crop y" className="bx-narrow">
						<Input type="number" inputMode="numeric" value={draft.y} disabled={disabled} onChange={event => setDraft(current => ({ ...current, y: event.target.value }))} />
					</Field>
					<Field label="Width" className="bx-narrow">
						<Input type="number" inputMode="numeric" value={draft.width} disabled={disabled} onChange={event => setDraft(current => ({ ...current, width: event.target.value }))} />
					</Field>
					<Field label="Height" className="bx-narrow">
						<Input type="number" inputMode="numeric" value={draft.height} disabled={disabled} onChange={event => setDraft(current => ({ ...current, height: event.target.value }))} />
					</Field>
					<Button type="submit" size="sm" variant="outline" disabled={disabled}>
						Set crop
					</Button>
				</form>
			)}
			{frozen && frame !== null && (
				<p className="bx-frozen-note" role="status">
					Frame held still while you annotate — live updates resume when you pick Interact.
				</p>
			)}
		</div>
	);
}
