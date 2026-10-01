// The matte guard: is this PNG a real cutout of its subject?
//
// The CLI mattes a flat image itself only when a BiRefNet model sits in the
// weights folder, and it decides "already cut out" from the PRESENCE of an alpha
// channel. Qwen-Image and other generators write RGBA whose alpha is opaque noise
// with nothing transparent in it; read as a cutout, the grey studio backdrop
// comes back as geometry (two enormous white sheets either side of a fox's head,
// lab 2026-09-22). So the contents decide, as in the lab's `image_to_3dlab/
// matte.py`: an image counts as cut out only when a meaningful share of its
// pixels is actually transparent. Producing the matte is a separate concern; this
// pack refuses an image that does not have one and says how to get one.
//
// Decoding is done here (node:zlib + the PNG filters) because a pack's entry may
// import only `node:` builtins. Only the alpha of each pixel is read.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { inflateSync } from "node:zlib";

/** The numbers that separate a cutout from an alpha channel that cuts nothing.
 *  They live in `models.json` (`cutout`), not here. */
export interface CutoutRule {
	/** Smallest share of pixels that must be transparent, 0..1. */
	readonly minTransparentShare: number;
	/** A pixel is transparent when its alpha (8-bit scale) is below this. */
	readonly transparentBelow: number;
}

export interface CutoutReport {
	readonly width: number;
	readonly height: number;
	/** Share of pixels with alpha below the rule's threshold, 0..1. */
	readonly transparentShare: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const COLOR_PALETTE = 3;
const COLOR_GREY_ALPHA = 4;
const COLOR_RGBA = 6;

/** Adam7 passes as [xStart, yStart, xStep, yStep]. */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
];

interface Header {
	readonly width: number;
	readonly height: number;
	readonly depth: number;
	readonly colorType: number;
	readonly interlaced: boolean;
}

interface Decoded {
	readonly header: Header;
	readonly idat: Buffer;
	/** Palette alpha (`tRNS`), only for palette images. */
	readonly paletteAlpha: Uint8Array | undefined;
}

function readChunks(png: Buffer): Decoded {
	let header: Header | undefined;
	let paletteAlpha: Uint8Array | undefined;
	const idat: Buffer[] = [];
	let offset = PNG_SIGNATURE.length;
	while (offset + 12 <= png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("latin1", offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		offset += 12 + length;
		if (type === "IHDR") {
			header = {
				width: data.readUInt32BE(0),
				height: data.readUInt32BE(4),
				depth: data[8] ?? 0,
				colorType: data[9] ?? 0,
				interlaced: data[12] === 1,
			};
		} else if (type === "tRNS") {
			paletteAlpha = new Uint8Array(256).fill(255);
			paletteAlpha.set(data.subarray(0, 256));
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
	}
	if (!header || idat.length === 0) throw new Error("the PNG is truncated or corrupt");
	return { header, idat: Buffer.concat(idat), paletteAlpha };
}

function paeth(left: number, up: number, upLeft: number): number {
	const p = left + up - upLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upLeft);
	if (pa <= pb && pa <= pc) return left;
	return pb <= pc ? up : upLeft;
}

/** Undo one row's PNG filter in place. `prior` is where the previous, already
 *  unfiltered row's data starts, or -1 for the first row (all zeros above). */
function unfilterRow(raw: Buffer, row: number, prior: number, rowBytes: number, stride: number, filter: number): void {
	const end = row + rowBytes;
	switch (filter) {
		case 1:
			for (let at = row + stride; at < end; at++) raw[at] = ((raw[at] ?? 0) + (raw[at - stride] ?? 0)) & 0xff;
			break;
		case 2:
			if (prior < 0) break;
			for (let at = row; at < end; at++) raw[at] = ((raw[at] ?? 0) + (raw[prior + at - row] ?? 0)) & 0xff;
			break;
		case 3:
			for (let at = row; at < end; at++) {
				const left = at - row >= stride ? (raw[at - stride] ?? 0) : 0;
				const up = prior < 0 ? 0 : (raw[prior + at - row] ?? 0);
				raw[at] = ((raw[at] ?? 0) + ((left + up) >> 1)) & 0xff;
			}
			break;
		case 4:
			for (let at = row; at < end; at++) {
				const column = at - row;
				const left = column >= stride ? (raw[at - stride] ?? 0) : 0;
				const up = prior < 0 ? 0 : (raw[prior + column] ?? 0);
				const upLeft = prior < 0 || column < stride ? 0 : (raw[prior + column - stride] ?? 0);
				raw[at] = ((raw[at] ?? 0) + paeth(left, up, upLeft)) & 0xff;
			}
			break;
	}
}

/** Undo the PNG filter of one `width` x `height` sub-image whose first filter
 *  byte is at `start`, in place, and count its transparent pixels. Returns where
 *  the next sub-image starts. */
function scanImage(
	raw: Buffer,
	start: number,
	width: number,
	height: number,
	header: Header,
	paletteAlpha: Uint8Array | undefined,
	transparentBelow: number,
	counted: { transparent: number },
): number {
	const channels = header.colorType === COLOR_RGBA ? 4 : header.colorType === COLOR_GREY_ALPHA ? 2 : 1;
	const bitsPerPixel = channels * header.depth;
	const stride = Math.max(1, bitsPerPixel >> 3);
	const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
	// Alpha is the last channel; at 16 bits its high byte comes first.
	const alphaOffset = (channels - 1) * (header.depth >> 3);
	const mask = (1 << header.depth) - 1;
	const alphaOf = paletteAlpha ?? new Uint8Array(256).fill(255);
	let transparent = 0;

	let rowStart = start;
	for (let y = 0; y < height; y++) {
		const filter = raw[rowStart];
		const row = rowStart + 1;
		if (filter === undefined || filter > 4 || row + rowBytes > raw.length) {
			throw new Error("the PNG's image data is corrupt");
		}
		unfilterRow(raw, row, y > 0 ? row - rowBytes - 1 : -1, rowBytes, stride, filter);
		if (header.colorType === COLOR_PALETTE) {
			for (let px = 0; px < width; px++) {
				const bit = px * header.depth;
				const byte = raw[row + (bit >> 3)] ?? 0;
				const index = (byte >> (8 - header.depth - (bit & 7))) & mask;
				if ((alphaOf[index] ?? 255) < transparentBelow) transparent++;
			}
		} else {
			for (let px = 0; px < width; px++) {
				if ((raw[row + px * stride + alphaOffset] ?? 255) < transparentBelow) transparent++;
			}
		}
		rowStart = row + rowBytes;
	}
	counted.transparent += transparent;
	return rowStart;
}

/** Measure a PNG's transparency. Throws an actionable error when the file is not
 *  a PNG or carries no alpha at all. */
export function measureTransparency(png: Buffer, transparentBelow: number): CutoutReport {
	if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		throw new Error("it is not a PNG");
	}
	const { header, idat, paletteAlpha } = readChunks(png);
	const hasAlpha =
		header.colorType === COLOR_RGBA ||
		header.colorType === COLOR_GREY_ALPHA ||
		(header.colorType === COLOR_PALETTE && paletteAlpha !== undefined);
	if (!hasAlpha) throw new Error("it has no alpha channel");

	let raw: Buffer;
	try {
		raw = inflateSync(idat);
	} catch {
		throw new Error("the PNG's image data is corrupt");
	}
	const counted = { transparent: 0 };
	if (header.interlaced) {
		let offset = 0;
		for (const [xStart, yStart, xStep, yStep] of ADAM7) {
			const width = Math.ceil((header.width - xStart) / xStep);
			const height = Math.ceil((header.height - yStart) / yStep);
			if (width <= 0 || height <= 0) continue;
			offset = scanImage(raw, offset, width, height, header, paletteAlpha, transparentBelow, counted);
		}
	} else {
		scanImage(raw, 0, header.width, header.height, header, paletteAlpha, transparentBelow, counted);
	}
	return {
		width: header.width,
		height: header.height,
		transparentShare: counted.transparent / (header.width * header.height),
	};
}

/** Refuse an image that is not a real cutout; return what was measured. Every
 *  error names the file and what to do next. */
export async function requireCutout(path: string, rule: CutoutRule): Promise<CutoutReport> {
	const name = basename(path);
	let report: CutoutReport;
	try {
		report = measureTransparency(await readFile(path), rule.transparentBelow);
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		throw new Error(
			`gen-local-3d needs a transparent PNG cutout of the subject, and ${name} cannot be used: ${why}. ` +
				"Remove the background first (a background-removal pass that writes an RGBA PNG), then submit that PNG.",
		);
	}
	if (report.transparentShare < rule.minTransparentShare) {
		const percent = (report.transparentShare * 100).toFixed(1);
		const needed = (rule.minTransparentShare * 100).toFixed(0);
		throw new Error(
			`${name} is not a cutout: only ${percent}% of its pixels are transparent (a real cutout leaves at least ${needed}%). ` +
				"Its alpha channel cuts nothing out, so the background would be built as geometry. " +
				"Remove the background first (a background-removal pass that writes an RGBA PNG), then submit that PNG.",
		);
	}
	return report;
}
