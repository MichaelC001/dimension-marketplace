// What the human drew, painted into the pixels the agent receives.
//
// The server crops the RETAINED frame and hands back a PNG plus the region it
// actually used (its origin is floored and its size clamped to the frame). The
// circles and strokes exist only in this View, so if nothing paints them the
// agent is handed a bare rectangle and told someone circled something in it.
// This module closes that gap: it decodes the returned crop, replays the marks
// onto it in the SAME visual treatment the overlay uses (the computed `.bx-mark`
// stroke), and re-encodes a PNG under the host's byte and pixel limits.
//
// Coordinates: marks are stored in viewport pixels, the crop starts at the
// CLAMPED origin, and the crop's pixels may not be 1:1 with viewport pixels (a
// scaled capture). Both are handled by measuring the decoded image against the
// clamped region rather than assuming either.
import { MAX_ANNOTATION_BYTES } from "../../src/contracts";
import type { BrowserAnnotation } from "../../src/contracts";
import { ellipseOf, type Mark } from "./geometry";

/** Decoded-pixel ceiling for anything we rasterize or hand to the host. */
export const MAX_ANNOTATION_PIXELS = 16_777_216;

/** A crop that carries the drawing, ready for an `image` content block. */
export interface PaintedAnnotation {
	readonly mimeType: "image/png";
	readonly data: string;
	readonly width: number;
	readonly height: number;
	readonly bytes: number;
	/** How many marks were painted into those pixels. */
	readonly painted: number;
}

/** A refusal with a sentence a human can act on. Never a silent downgrade: if
 *  the marks cannot be painted, nothing is sent and the drawing is kept. */
export class AnnotationPaintError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnnotationPaintError";
	}
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Composite `marks` onto the annotation's crop.
 *
 * With no marks the server's bytes are passed through untouched — a region-only
 * annotation must ship exactly what was cropped, not a browser re-encode.
 */
export async function paintAnnotation(
	annotation: BrowserAnnotation,
	marks: readonly Mark[],
): Promise<PaintedAnnotation> {
	const source = base64ToBytes(annotation.data);
	const header = readIhdr(source);
	const pixels = header.width * header.height;
	if (pixels > MAX_ANNOTATION_PIXELS) {
		throw new AnnotationPaintError(
			`the crop is ${header.width}×${header.height} (${pixels} pixels), above the ${MAX_ANNOTATION_PIXELS} pixel limit — select a smaller region. Your drawing and note are kept.`,
		);
	}

	const image =
		marks.length === 0
			? { data: annotation.data, bytes: source.length, width: header.width, height: header.height }
			: await composite(annotation, marks, header);

	if (image.bytes > MAX_ANNOTATION_BYTES) {
		throw new AnnotationPaintError(
			`the crop is ${image.bytes} bytes, above the ${MAX_ANNOTATION_BYTES} byte context limit — select a smaller region. Your drawing and note are kept.`,
		);
	}
	return { mimeType: "image/png", ...image, painted: marks.length };
}

interface RasterImage {
	readonly data: string;
	readonly bytes: number;
	readonly width: number;
	readonly height: number;
}

/** Draw the crop, then the marks, then re-encode. */
async function composite(
	annotation: BrowserAnnotation,
	marks: readonly Mark[],
	header: { width: number; height: number },
): Promise<RasterImage> {
	const decoded = await decodeImage(annotation.data);
	if (decoded.naturalWidth !== header.width || decoded.naturalHeight !== header.height) {
		throw new AnnotationPaintError("the crop decoded to different geometry than its PNG header declares; nothing was sent.");
	}

	const canvas = document.createElement("canvas");
	canvas.width = header.width;
	canvas.height = header.height;
	const ctx = canvas.getContext("2d");
	if (ctx === null) {
		throw new AnnotationPaintError("this host has no 2D canvas, so the drawing cannot be painted into the crop; nothing was sent.");
	}
	ctx.drawImage(decoded, 0, 0);

	// The crop's pixels per viewport pixel. Normally 1 (captures are taken at
	// deviceScaleFactor 1), but measured rather than assumed, so a scaled capture
	// still lands the marks on the pixels the human drew over.
	const { region } = annotation;
	const scaleX = canvas.width / Math.max(1, region.width);
	const scaleY = canvas.height / Math.max(1, region.height);
	const cropX = (x: number) => (x - region.x) * scaleX;
	const cropY = (y: number) => (y - region.y) * scaleY;

	const treatment = markTreatment();
	ctx.strokeStyle = treatment.stroke;
	ctx.lineWidth = Math.max(1, treatment.width * Math.max(scaleX, scaleY));
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	for (const mark of marks) {
		if (mark.kind === "circle") {
			const ellipse = ellipseOf(mark.points);
			if (ellipse === null) continue;
			ctx.beginPath();
			ctx.ellipse(
				cropX(ellipse.cx),
				cropY(ellipse.cy),
				Math.max(1, ellipse.rx * scaleX),
				Math.max(1, ellipse.ry * scaleY),
				0,
				0,
				Math.PI * 2,
			);
			ctx.stroke();
			continue;
		}
		// Every sampled point, not the bounding box: a freehand stroke means the
		// shape the human traced.
		if (mark.points.length < 2) continue;
		ctx.beginPath();
		ctx.moveTo(cropX(mark.points[0].x), cropY(mark.points[0].y));
		for (let index = 1; index < mark.points.length; index += 1) {
			ctx.lineTo(cropX(mark.points[index].x), cropY(mark.points[index].y));
		}
		ctx.stroke();
	}

	const bytes = new Uint8Array(await (await toPngBlob(canvas)).arrayBuffer());
	return { data: bytesToBase64(bytes), bytes: bytes.length, width: canvas.width, height: canvas.height };
}

/** The overlay's own stroke, read from the live stylesheet, so the painted mark
 *  and the mark on screen are the same colour and weight. */
function markTreatment(): { stroke: string; width: number } {
	const probe = document.createElement("span");
	probe.className = "bx-mark";
	probe.style.position = "absolute";
	probe.style.visibility = "hidden";
	document.body.appendChild(probe);
	try {
		const computed = getComputedStyle(probe);
		const width = Number.parseFloat(computed.strokeWidth);
		return {
			// Canvas needs a concrete colour; the accent token is the overlay's own stroke.
			stroke: computed.stroke.length > 0 && computed.stroke !== "none" ? computed.stroke : getComputedStyle(document.documentElement).getPropertyValue("--fr-accent").trim() || "#7a60c1",
			width: Number.isFinite(width) && width > 0 ? width : 3,
		};
	} finally {
		probe.remove();
	}
}

function decodeImage(data: string): Promise<HTMLImageElement> {
	const { promise, resolve, reject } = Promise.withResolvers<HTMLImageElement>();
	const image = new Image();
	image.onload = () => resolve(image);
	image.onerror = () => reject(new AnnotationPaintError("the returned crop could not be decoded; nothing was sent."));
	image.src = `data:image/png;base64,${data}`;
	return promise;
}

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	const { promise, resolve, reject } = Promise.withResolvers<Blob>();
	canvas.toBlob(blob => {
		if (blob === null) reject(new AnnotationPaintError("the painted crop could not be encoded as a PNG; nothing was sent."));
		else resolve(blob);
	}, "image/png");
	return promise;
}

/** Geometry straight from IHDR: the pixel ceiling has to be enforced BEFORE a
 *  decoder inflates the image to tell us how big it is. */
function readIhdr(bytes: Uint8Array): { width: number; height: number } {
	if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
		throw new AnnotationPaintError("the returned crop is not a PNG; nothing was sent.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (width === 0 || height === 0) {
		throw new AnnotationPaintError("the returned crop declares a zero dimension; nothing was sent.");
	}
	return { width, height };
}

function base64ToBytes(data: string): Uint8Array {
	let binary: string;
	try {
		binary = atob(data);
	} catch {
		throw new AnnotationPaintError("the returned crop is not valid base64; nothing was sent.");
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	// Chunked: `String.fromCharCode(...megabytes)` overflows the argument stack.
	const CHUNK = 0x8000;
	let binary = "";
	for (let index = 0; index < bytes.length; index += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
	}
	return btoa(binary);
}
