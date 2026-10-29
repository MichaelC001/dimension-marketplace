import { describe, expect, test } from "bun:test";
import { contrastRatio, readImageHeader } from "../skills/youtube-thumbnail/scripts/thumbnail-pack.mjs";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JFIF = [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];

function pngChunk(type: string, data: number[]) {
	const length = [(data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff];
	return [...length, ...Array.from(type, letter => letter.charCodeAt(0)), ...data, 0, 0, 0, 0];
}

function png(colorType: number, chunks: number[][] = []) {
	const width = [0, 0, 0x05, 0x00];
	const height = [0, 0, 0x02, 0xd0];
	const header = pngChunk("IHDR", [...width, ...height, 8, colorType, 0, 0, 0]);
	return Uint8Array.from([...PNG_SIGNATURE, ...header, ...chunks.flat()]);
}

function jpegSegment(marker: number, payload: number[]) {
	return [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
}

function jpegFrame(marker: number) {
	return jpegSegment(marker, [8, 0x02, 0xd0, 0x05, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}

const jpeg = (...segments: number[][]) => Uint8Array.from([0xff, 0xd8, ...segments.flat(), 0xff, 0xd9]);

describe("readImageHeader on a PNG", () => {
	test.each([
		{ name: "greyscale", colorType: 0, chunks: [], hasAlpha: false },
		{ name: "RGB", colorType: 2, chunks: [], hasAlpha: false },
		{ name: "palette", colorType: 3, chunks: [], hasAlpha: false },
		{ name: "greyscale with alpha", colorType: 4, chunks: [], hasAlpha: true },
		{ name: "RGBA", colorType: 6, chunks: [], hasAlpha: true },
		{ name: "RGB with a tRNS colour key before the image data", colorType: 2, chunks: [pngChunk("tRNS", [0, 0, 0, 0, 0, 0]), pngChunk("IDAT", [0x78])], hasAlpha: true },
		{ name: "palette with tRNS reached past another chunk", colorType: 3, chunks: [pngChunk("gAMA", [0, 0, 0xb1, 0x8f]), pngChunk("tRNS", [0xff, 0x80]), pngChunk("IDAT", [0x78])], hasAlpha: true },
		{ name: "RGB with other chunks and no tRNS", colorType: 2, chunks: [pngChunk("gAMA", [0, 0, 0xb1, 0x8f]), pngChunk("IDAT", [0x78])], hasAlpha: false },
	])("reads $name as 1280x720 with hasAlpha $hasAlpha", ({ colorType, chunks, hasAlpha }) => {
		expect(readImageHeader(png(colorType, chunks))).toEqual({ format: "png", width: 1280, height: 720, hasAlpha });
	});
});

describe("readImageHeader on a JPEG", () => {
	test.each([
		{ name: "a baseline frame after an APP0 segment", segments: [jpegSegment(0xe0, JFIF), jpegFrame(0xc0)] },
		{ name: "a progressive frame after an APP0 and a Huffman table, which shares the 0xC0-0xCF range", segments: [jpegSegment(0xe0, JFIF), jpegSegment(0xc4, [0, 1, 2, 3]), jpegFrame(0xc2)] },
	])("reads $name as 1280x720 without alpha", ({ segments }) => {
		expect(readImageHeader(jpeg(...segments))).toEqual({ format: "jpg", width: 1280, height: 720, hasAlpha: false });
	});
});

describe("readImageHeader on bytes that are not a usable thumbnail", () => {
	test.each([
		{ name: "a PNG cut off after its signature", bytes: Uint8Array.from(PNG_SIGNATURE) },
		{ name: "a PNG whose first chunk is not IHDR", bytes: Uint8Array.from([...PNG_SIGNATURE, ...pngChunk("IDAT", new Array(13).fill(0))]) },
		{ name: "a JPEG with no frame header", bytes: jpeg(jpegSegment(0xe0, JFIF), jpegSegment(0xdb, new Array(65).fill(1))) },
		{ name: "a GIF", bytes: new TextEncoder().encode("GIF89a followed by the rest of a gif file") },
	])("returns an error and no size for $name", ({ bytes }) => {
		const header = readImageHeader(bytes);

		expect(header.error).toBeString();
		expect(header.width).toBeUndefined();
		expect(header.format).toBeUndefined();
	});
});

describe("contrastRatio", () => {
	test.each([
		{ name: "black on white", foreground: [0, 0, 0], background: [255, 255, 255], ratio: 21 },
		{ name: "white on black, the same ratio whichever colour is the text", foreground: [255, 255, 255], background: [0, 0, 0], ratio: 21 },
		{ name: "white on white", foreground: [255, 255, 255], background: [255, 255, 255], ratio: 1 },
		{ name: "#767676 on white, the lightest grey that reaches 4.5", foreground: [118, 118, 118], background: [255, 255, 255], ratio: 4.54 },
		{ name: "#777777 on white, just under 4.5", foreground: [119, 119, 119], background: [255, 255, 255], ratio: 4.48 },
	])("$name is $ratio", ({ foreground, background, ratio }) => {
		expect(contrastRatio(foreground, background)).toBeCloseTo(ratio, 2);
	});
});
