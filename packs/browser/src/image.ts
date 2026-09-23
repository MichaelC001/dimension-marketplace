/**
 * PNG cropping for `annotate`. Operates on the STORED screenshot bytes (the
 * exact frame the caller annotated), never on a fresh capture, so the crop and
 * the frame the model saw are the same pixels.
 */
import { PNG } from "pngjs";
import type { BrowserRegion } from "./contracts";
import { MAX_ANNOTATION_BYTES } from "./contracts";
import { fail } from "./store";

/** Upper bound on decoded frame geometry; guards a malicious/huge PNG. */
export const MAX_FRAME_WIDTH = 3840;
export const MAX_FRAME_HEIGHT = 4320;
/** Upper bound on encoded PNG bytes we will hold or hand back. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface CropResult {
	png: Buffer;
	region: BrowserRegion;
}

/**
 * Validate + clamp `region` against the frame, then crop.
 *
 * Non-finite, negative, or zero-sized regions are REFUSED (not silently
 * repaired). A region that starts inside the frame but runs off its edge is
 * clamped to the frame; one that starts entirely outside is refused.
 */
export function cropRegion(frameBytes: Buffer, requested: BrowserRegion): CropResult {
	for (const [name, value] of Object.entries(requested)) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			fail("bad_region", `region.${name} must be a finite number`);
		}
	}
	const x = Math.floor(requested.x);
	const y = Math.floor(requested.y);
	const w = Math.floor(requested.width);
	const h = Math.floor(requested.height);
	if (w <= 0 || h <= 0) fail("bad_region", "region width and height must be > 0");
	if (x < 0 || y < 0) fail("bad_region", "region origin must be >= 0");

	// Bounds BEFORE decode. Inflating an attacker-sized image to find out how big
	// it is defeats the point of the limit, so the geometry is read straight from
	// the IHDR header and the encoded size is checked first.
	if (frameBytes.length > MAX_FRAME_BYTES) {
		fail("frame_too_large", `frame is ${frameBytes.length} bytes, above the ${MAX_FRAME_BYTES} byte limit`);
	}
	const header = readIhdr(frameBytes);
	if (header.width > MAX_FRAME_WIDTH || header.height > MAX_FRAME_HEIGHT) {
		fail("frame_too_large", `frame is ${header.width}x${header.height}, above the supported maximum`);
	}
	if (x >= header.width || y >= header.height) {
		fail("bad_region", `region origin (${x},${y}) is outside the ${header.width}x${header.height} frame`);
	}

	const source = PNG.sync.read(frameBytes);
	if (source.width !== header.width || source.height !== header.height) {
		fail("frame_invalid", "decoded PNG geometry does not match its header");
	}
	const width = Math.min(w, source.width - x);
	const height = Math.min(h, source.height - y);

	const cropped = new PNG({ width, height });
	// `PNG.sync.read` returns a plain bitmap object, not a PNG instance, so the
	// static form of bitblt is the one that works on it.
	PNG.bitblt(source as unknown as PNG, cropped, x, y, width, height, 0, 0);
	const png = PNG.sync.write(cropped);
	if (png.length > MAX_ANNOTATION_BYTES) {
		fail("frame_too_large", `cropped image exceeds the ${MAX_ANNOTATION_BYTES} byte context limit; select a smaller region`);
	}
	return { png, region: { x, y, width, height } };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read width/height from the IHDR chunk without decompressing image data. */
function readIhdr(bytes: Buffer): { width: number; height: number } {
	if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
		fail("frame_invalid", "frame is not a PNG");
	}
	if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") {
		fail("frame_invalid", "PNG does not start with an IHDR chunk");
	}
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	if (width === 0 || height === 0) fail("frame_invalid", "PNG header declares a zero dimension");
	return { width, height };
}
