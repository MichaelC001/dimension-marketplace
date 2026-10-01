// A PNG encoder for the tests: any colour type the matte guard must read, any
// filter, 8/16 bit, palette + tRNS, Adam7, built from a pixel function so the
// transparent share is known independently of the decoder under test.

import { deflateSync } from "node:zlib";

export type Pixel = readonly [r: number, g: number, b: number, a: number];
export type PixelAt = (x: number, y: number) => Pixel;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type: string, data: Uint8Array): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), 8 + data.length);
	return out;
}

const ADAM7: readonly (readonly [number, number, number, number])[] = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
];

export type Encoding =
	| { kind: "rgba"; depth: 8 | 16 }
	| { kind: "grey-alpha"; depth: 8 | 16 }
	| { kind: "palette"; depth: 4 | 8 }
	| { kind: "rgb"; depth: 8 };

export interface Options {
	readonly width: number;
	readonly height: number;
	readonly encoding: Encoding;
	readonly pixel: PixelAt;
	readonly interlaced?: boolean;
	/** The PNG filter of row `n` of a (sub)image; default: cycle through all five. */
	readonly filter?: (row: number) => number;
	/** A palette image whose tRNS lists only the first entry. */
	readonly shortTrns?: boolean;
}

const COLOR_TYPE = { rgba: 6, "grey-alpha": 4, palette: 3, rgb: 2 } as const;

/** Palette index of a pixel: 0 is the fully transparent entry. */
const paletteIndex = ([r, g, , a]: Pixel): number => (a < 16 ? 0 : 1 + ((r + g) % 7));

function sampleBytes({ encoding }: Options, [r, g, b, a]: Pixel): number[] {
	const wide = (value: number): number[] => (encoding.depth === 16 ? [value, (value * 3 + 1) & 255] : [value]);
	switch (encoding.kind) {
		case "rgba":
			return [...wide(r), ...wide(g), ...wide(b), ...wide(a)];
		case "grey-alpha":
			return [...wide(g), ...wide(a)];
		case "rgb":
			return [r, g, b];
		case "palette":
			return [];
	}
}

function packRow(options: Options, pixels: readonly Pixel[]): number[] {
	const { encoding } = options;
	if (encoding.kind !== "palette") return pixels.flatMap(pixel => sampleBytes(options, pixel));
	const indices = pixels.map(paletteIndex);
	if (encoding.depth === 8) return indices;
	const bytes: number[] = [];
	for (let at = 0; at < indices.length; at += 2) bytes.push(((indices[at] as number) << 4) | (indices[at + 1] ?? 0));
	return bytes;
}

function filterRow(type: number, row: readonly number[], above: readonly number[], bpp: number): number[] {
	const out: number[] = [type];
	for (let i = 0; i < row.length; i++) {
		const x = row[i] as number;
		const a = i >= bpp ? (row[i - bpp] as number) : 0;
		const b = above[i] ?? 0;
		const c = i >= bpp ? (above[i - bpp] ?? 0) : 0;
		let predicted = 0;
		if (type === 1) predicted = a;
		else if (type === 2) predicted = b;
		else if (type === 3) predicted = (a + b) >> 1;
		else if (type === 4) {
			const p = a + b - c;
			const pa = Math.abs(p - a);
			const pb = Math.abs(p - b);
			const pc = Math.abs(p - c);
			predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
		}
		out.push((x - predicted) & 0xff);
	}
	return out;
}

export function encodePng(options: Options): Buffer {
	const { width, height, encoding, pixel, interlaced = false } = options;
	const channels = encoding.kind === "rgba" ? 4 : encoding.kind === "grey-alpha" ? 2 : encoding.kind === "rgb" ? 3 : 1;
	const bpp = Math.max(1, (channels * encoding.depth) >> 3);
	const filter = options.filter ?? ((row: number) => row % 5);
	const passes = interlaced ? ADAM7 : ([[0, 0, 1, 1]] as const);
	const raw: number[] = [];
	for (const [xStart, yStart, xStep, yStep] of passes) {
		const passWidth = Math.ceil((width - xStart) / xStep);
		const passHeight = Math.ceil((height - yStart) / yStep);
		if (passWidth <= 0 || passHeight <= 0) continue;
		let above: number[] = [];
		for (let row = 0; row < passHeight; row++) {
			const pixels = Array.from({ length: passWidth }, (_, column) => pixel(xStart + column * xStep, yStart + row * yStep));
			const bytes = packRow(options, pixels);
			raw.push(...filterRow(filter(row), bytes, above, bpp));
			above = bytes;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = encoding.depth;
	header[9] = COLOR_TYPE[encoding.kind];
	header[12] = interlaced ? 1 : 0;
	const palette = Buffer.alloc(8 * 3);
	for (let entry = 0; entry < 8; entry++) palette.set([entry * 30, 255 - entry * 30, 64], entry * 3);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		...(encoding.kind === "palette"
			? [chunk("PLTE", palette), chunk("tRNS", Buffer.from(options.shortTrns ? [0] : [0, 255, 255, 255, 255, 255, 255, 255]))]
			: []),
		chunk("IDAT", deflateSync(Buffer.from(raw))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A subject in the middle of the frame, cut out of a transparent backdrop whose
 *  stray pixels have alpha 15 (the last value below the 16 threshold). */
export const labCutout: PixelAt = (x, y) => {
	const inside = (x - 70) ** 2 / 40 ** 2 + (y - 45) ** 2 / 35 ** 2 < 1;
	return [(x * 7) & 255, (y * 11) & 255, (x ^ y) & 255, inside ? 200 + ((x + y) % 56) : x % 5 === 0 ? 15 : 0];
};
