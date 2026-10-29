#!/usr/bin/env node
// youtube-thumbnail helper: measure a rendered still, fit it under the upload limit, and build the
// phone-size sheet the readability check is read from. Zero dependencies besides ffmpeg on PATH
// (or FFMPEG=<path>); runs on node >= 22 and on bun. It writes only the files you name.
//
//   node thumbnail-pack.mjs inspect <image...>
//   node thumbnail-pack.mjs encode  <in.png> <out.jpg> [--max-bytes 2000000]
//   node thumbnail-pack.mjs phone   <out.png> <image...>
//   node thumbnail-pack.mjs zones   <out.png> <image>
//   node thumbnail-pack.mjs contrast <foreground> <background>
//
// Exit code: 0 ok, 1 a check failed, 2 bad usage or ffmpeg missing.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = { width: 1280, height: 720, maxBytes: 2 * 1024 * 1024, targetBytes: 2_000_000 };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Format, size and alpha of a PNG or JPEG from its header bytes alone. */
export function readImageHeader(bytes) {
	if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
		if (bytes.length < 33 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return { error: "a PNG without an IHDR chunk" };
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const colorType = bytes[25];
		let hasAlpha = colorType === 4 || colorType === 6;
		for (let offset = 8; offset + 8 <= bytes.length && !hasAlpha; ) {
			const length = view.getUint32(offset);
			const kind = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
			if (kind === "tRNS") hasAlpha = true;
			if (kind === "IDAT") break;
			offset += 12 + length;
		}
		return { format: "png", width: view.getUint32(16), height: view.getUint32(20), hasAlpha };
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) return { error: "a JPEG with a broken segment" };
			const marker = bytes[offset + 1];
			if (marker === 0xff) {
				offset += 1;
				continue;
			}
			const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
			const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isFrame) return { format: "jpg", height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8], hasAlpha: false };
			offset += 2 + length;
		}
		return { error: "a JPEG with no frame header" };
	}
	return { error: "not a PNG or a JPEG" };
}

/** What youtube-package records for one variant, plus the problems that stop it being uploaded. */
export function inspectImage(path) {
	const bytes = new Uint8Array(readFileSync(path));
	const header = readImageHeader(bytes);
	const problems = [];
	if (header.error) return { path, ok: false, problems: [header.error] };
	if (header.width !== LIMITS.width || header.height !== LIMITS.height) problems.push(`${header.width}x${header.height}; a thumbnail is ${LIMITS.width}x${LIMITS.height} (if any thumbnail in an A/B test is below 720p, YouTube downscales every one to 480p)`);
	if (bytes.length > LIMITS.maxBytes) problems.push(`${bytes.length} bytes; the limit every upload route accepts is ${LIMITS.maxBytes} (2 MB)`);
	else if (bytes.length > LIMITS.targetBytes) problems.push(`${bytes.length} bytes is under 2 MB but inside the margin; encode a little smaller`);
	if (header.hasAlpha) problems.push("the image has transparency; flatten it onto a solid background so no pixel reads as black");
	return { path, ok: problems.length === 0, format: header.format, width: header.width, height: header.height, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), problems };
}

function ffmpeg(args) {
	const result = spawnSync(process.env.FFMPEG || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { encoding: "utf8", timeout: 120_000, windowsHide: true });
	if (result.error) return { ok: false, message: `ffmpeg could not start (${result.error.message}); install it or set FFMPEG=<path>` };
	return result.status === 0 ? { ok: true } : { ok: false, message: (result.stderr || `ffmpeg exited ${result.status}`).trim().split("\n").slice(-3).join(" | ") };
}

const QUALITY_LADDER = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 31];

/** JPEG under the byte budget at the best quality that fits (ffmpeg -q:v: 2 is best, 31 worst). */
export function encodeJpeg(input, output, maxBytes = LIMITS.targetBytes) {
	for (const quality of QUALITY_LADDER) {
		const run = ffmpeg(["-i", input, "-vf", `scale=${LIMITS.width}:${LIMITS.height}:flags=lanczos:force_original_aspect_ratio=disable,format=yuvj420p`, "-frames:v", "1", "-q:v", String(quality), output]);
		if (!run.ok) return { ok: false, message: run.message };
		if (statSync(output).size <= maxBytes) return { ...inspectImage(output), ok: true, quality };
	}
	return { ok: false, message: `no quality up to the lowest fit ${maxBytes} bytes; simplify the image (fewer gradients, less texture)` };
}

/**
 * One PNG of every variant at the sizes people meet them, with the length badge drawn at the size YouTube
 * draws it (20 px tall however small the thumbnail), so what it covers is visible. Row one: 168x94, the
 * list size on a phone and beside a video. Row two: 336x188.
 */
export function phoneSheet(output, images) {
	const row = (width, height, badgeWidth, margin, gap) =>
		images
			.map((_, index) => `[${index}:v]scale=${width}:${height}:flags=area,drawbox=x=iw-${margin}-${badgeWidth}:y=ih-${margin}-20:w=${badgeWidth}:h=20:color=black@0.8:t=fill,pad=${width + gap * 2}:${height + gap * 2}:${gap}:${gap}:color=0x202020[r${width}_${index}]`)
			.join(";");
	const stack = width => (images.length === 1 ? `[r${width}_0]copy[h${width}]` : images.map((_, index) => `[r${width}_${index}]`).join("") + `hstack=inputs=${images.length}[h${width}]`);
	const wide = 336 + 16;
	const graph = `${row(168, 94, 36, 4, 8)};${stack(168)};${row(336, 188, 40, 8, 8)};${stack(336)};[h168]pad=${wide * images.length}:ih:0:0:color=0x202020[a];[a][h336]vstack=inputs=2[sheet]`;
	const run = ffmpeg([...images.flatMap(image => ["-i", image]), "-filter_complex", graph, "-map", "[sheet]", "-frames:v", "1", output]);
	return run.ok ? { ok: true, path: output } : { ok: false, message: run.message };
}

/**
 * Where YouTube draws over a thumbnail, in a 1280x720 frame, as ThumbnailPeak measured it on 2026-10-21 (a third
 * party, not YouTube; the layout changes): the length badge in the bottom-right (350x200 covers every view
 * except the playlist panel), the "New" label top-left beside a video (220x155), the watched bar along the bottom (44).
 */
export const ZONES = [
	{ name: "length badge", x: 930, y: 520, w: 350, h: 200 },
	{ name: "New label", x: 0, y: 0, w: 220, h: 155 },
	{ name: "watched bar", x: 0, y: 676, w: 1280, h: 44 },
];

/** A copy of the image with the zones shaded, so a word or a face inside one is visible. Read it; nothing is measured. */
export function zoneOverlay(output, image) {
	const shade = ZONES.map(zone => `drawbox=x=${zone.x}:y=${zone.y}:w=${zone.w}:h=${zone.h}:color=red@0.4:t=fill,drawbox=x=${zone.x}:y=${zone.y}:w=${zone.w}:h=${zone.h}:color=red@0.95:t=3`).join(",");
	const run = ffmpeg(["-i", image, "-vf", `scale=${LIMITS.width}:${LIMITS.height}:flags=lanczos,${shade}`, "-frames:v", "1", output]);
	return run.ok ? { ok: true, path: output, zones: ZONES } : { ok: false, message: run.message };
}

function channel(value) {
	const unit = value / 255;
	return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

export function parseColor(text) {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
	if (!match) return undefined;
	const hex = match[1].length === 3 ? [...match[1]].map(digit => digit + digit).join("") : match[1];
	return [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
}

/** WCAG 2.x contrast ratio between two colors, 1 to 21. */
export function contrastRatio(foreground, background) {
	const luminance = ([red, green, blue]) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
	const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (light + 0.05) / (dark + 0.05);
}

function main(argv) {
	const [command, ...rest] = argv;
	if (command === "inspect" && rest.length > 0) {
		const results = rest.map(inspectImage);
		console.log(JSON.stringify(results, null, 2));
		return results.every(result => result.ok) ? 0 : 1;
	}
	if (command === "encode" && rest.length >= 2) {
		const max = rest.indexOf("--max-bytes");
		const result = encodeJpeg(rest[0], rest[1], max === -1 ? undefined : Number(rest[max + 1]));
		console.log(JSON.stringify(result, null, 2));
		return result.ok && result.problems.length === 0 ? 0 : result.ok ? 1 : 2;
	}
	if (command === "phone" && rest.length >= 2) {
		const result = phoneSheet(rest[0], rest.slice(1));
		console.log(JSON.stringify(result, null, 2));
		return result.ok ? 0 : 2;
	}
	if (command === "zones" && rest.length === 2) {
		const result = zoneOverlay(rest[0], rest[1]);
		console.log(JSON.stringify(result, null, 2));
		return result.ok ? 0 : 2;
	}
	if (command === "contrast" && rest.length === 2) {
		const [foreground, background] = rest.map(parseColor);
		if (!foreground || !background) {
			console.error("colors are #rgb or #rrggbb");
			return 2;
		}
		const ratio = contrastRatio(foreground, background);
		console.log(JSON.stringify({ ratio: Number(ratio.toFixed(2)), text: ratio >= 4.5 ? "pass" : "fail (needs 4.5 for words)", shapes: ratio >= 3 ? "pass" : "fail (needs 3 for a subject against its background)" }, null, 2));
		return ratio >= 4.5 ? 0 : 1;
	}
	console.error("usage: thumbnail-pack.mjs inspect <image...> | encode <in> <out.jpg> [--max-bytes n] | phone <out.png> <image...> | zones <out.png> <image> | contrast <fg> <bg>");
	return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
