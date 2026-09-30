// `present`: show the human a file (doc 86 §3.1, §4).
//
// The tool's whole job is to turn paths into a `Presentation` the thread draws
// as a card, and to say so in as few words as the model needs: one line per
// file in `content`, everything else in `details` (UI-only, never model context).
// Nothing here opens, annotates or reads a file's meaning; it resolves, refuses,
// classifies, and (for a picture) thumbnails.
//
// Bounds, because the model names the paths and the work happens before anyone
// has asked for it: at most `MAX_PRESENTED_ITEMS` paths are looked at; a file is
// read for its first `HEAD_BYTES`, and an image is read whole only up to
// `MAX_THUMB_SOURCE_BYTES`, one at a time; the thumbnails of a result share one
// `MAX_RESULT_THUMB_BYTES` budget. A path the tool refuses never costs a read.

import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	classifyFile,
	MAX_PRESENTED_ITEMS,
	type Presentation,
	type PresentedItem,
	type PresentedKind,
} from "@dimension/sdk/presentation";
import { denyReason, textRefusal } from "./deny";
import { imageFacts, MAX_THUMB_BYTES, MAX_THUMB_SOURCE_BYTES, type Thumbnail } from "./thumbnail";

/** Bytes of a file's start read to classify it. */
const HEAD_BYTES = 512;
/** Encoded thumbnail bytes one result may carry in all. */
const MAX_RESULT_THUMB_BYTES = 600 * 1024;
/** Characters of a requested path quoted back in a refusal. */
const MAX_ECHO = 200;
const SVG = "image/svg+xml";

/** The word a kind goes by in the result line. Exhaustive: a new kind fails the build here. */
const KIND_LABEL: Readonly<Record<PresentedKind, string>> = {
	image: "image",
	pdf: "PDF",
	docx: "Word",
	pptx: "PowerPoint",
	xlsx: "Excel",
	markdown: "Markdown",
	html: "HTML",
	text: "text",
	code: "code",
	audio: "audio",
	video: "video",
	archive: "archive",
	binary: "file",
};

/** One entry of `details.images`: the pixel lane every image-producing tool uses. */
export interface ThumbImage {
	readonly data: string;
	readonly mimeType: string;
}

export interface PresentDetails {
	readonly presentation: Presentation;
	readonly images?: readonly ThumbImage[];
}

export interface PresentResult {
	/** One line per item, and nothing else. Never pixels, never base64. */
	readonly text: string;
	readonly details: PresentDetails;
}

export interface PresentOptions {
	/** The session's working directory: where a relative path is resolved. */
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/** The platform whose path spellings are refused from text alone. Default: this one. A test seam. */
	readonly platform?: NodeJS.Platform;
}

/** What one call of `presentPaths` shares across its paths. */
interface Run {
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	/** Real paths already presented: a file named twice is one card. */
	readonly seen: Set<string>;
}

type Refused = { readonly refused: string };
interface Presented {
	readonly item: PresentedItem;
	readonly thumb?: Thumbnail;
}

/** `text` on one line, control characters flattened (a file name may carry a newline), cut to `max`. */
function oneLine(text: string, max: number): string {
	const flat = text.replace(/[\u0000-\u001f\u007f]/g, " ");
	return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export function formatSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let unit = 0;
	let value = bytes;
	// Step up on the ROUNDED value, so 1 048 575 bytes reads "1 MB", never "1024 KB".
	while (unit < units.length - 1 && Math.round(value) >= 1024) {
		value /= 1024;
		unit++;
	}
	const shown = unit > 0 && value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
	return `${shown} ${units[unit]}`;
}

/**
 * Why an entry is not a file this tool may read, or `undefined`. Only a regular
 * file passes: opening a FIFO would block on it and a device never ends.
 */
export function nonFileReason(info: Pick<Stats, "isDirectory" | "isFile">): string | undefined {
	if (info.isDirectory()) return "it is a directory, not a file";
	return info.isFile() ? undefined : "it is not a regular file";
}

function unresolvedReason(error: unknown): string {
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code === "ENOENT" || code === "ENOTDIR") return "no such file";
	if (code === "EACCES" || code === "EPERM") return "permission denied";
	return `it cannot be resolved${code ? ` (${code})` : ""}`;
}

/** Fill `size` bytes from the start of an open file; fewer if it shrank underneath us. */
async function readWhole(handle: FileHandle, size: number): Promise<Uint8Array> {
	const buffer = Buffer.allocUnsafe(size);
	let filled = 0;
	while (filled < size) {
		const { bytesRead } = await handle.read(buffer, filled, size - filled, filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return buffer.subarray(0, filled);
}

/**
 * One requested path, to a presented item or a stated refusal. `undefined` when
 * an earlier path already resolved to the same file. `thumbBudget` is what is left
 * of this result's thumbnail bytes.
 */
async function presentOne(requested: unknown, run: Run, thumbBudget: number): Promise<Presented | Refused | undefined> {
	if (typeof requested !== "string") return { refused: "it is not a path" };
	const textual = textRefusal(requested, run.platform);
	if (textual !== undefined) return { refused: textual };

	// Deny before the disk: a secret path costs no filesystem call, so the answer
	// says nothing about whether it exists.
	const lexical = resolve(run.cwd, requested);
	const early = denyReason(lexical);
	if (early !== undefined) return { refused: early };

	let real: string;
	try {
		real = await realpath(lexical);
	} catch (error) {
		return { refused: unresolvedReason(error) };
	}
	// A link into a secret is refused for what it resolves to, in words that do not
	// say what that is: the requested name was harmless and the target is not ours to describe.
	if (denyReason(real) !== undefined)
		return { refused: "it resolves to a protected location (credentials, keys or engine state)" };
	if (run.seen.has(real)) return undefined;

	// `stat` before `open`: opening a FIFO or a device would block on it.
	let info: Stats;
	try {
		info = await stat(real);
	} catch (error) {
		return { refused: unresolvedReason(error) };
	}
	const notFile = nonFileReason(info);
	if (notFile !== undefined) return { refused: notFile };

	let handle: FileHandle;
	try {
		handle = await open(real, "r");
	} catch (error) {
		return { refused: unresolvedReason(error) };
	}
	try {
		// What was opened is what is described: a swap between `stat` and `open` is caught here.
		const opened = await handle.stat();
		const swapped = nonFileReason(opened);
		if (swapped !== undefined) return { refused: swapped };
		const head = Buffer.allocUnsafe(Math.min(HEAD_BYTES, opened.size));
		const { bytesRead } = await handle.read(head, 0, head.length, 0);
		const name = basename(real);
		const { kind, mime } = classifyFile(name, head.subarray(0, bytesRead));
		run.seen.add(real);

		const base: PresentedItem = { path: real, name, kind, mime, size: opened.size, mtimeMs: opened.mtimeMs };
		// An SVG is drawn by the kind's icon, not rasterised here.
		if (kind !== "image" || mime === SVG || opened.size > MAX_THUMB_SOURCE_BYTES) return { item: base };
		const facts = await imageFacts(await readWhole(handle, opened.size), Math.min(MAX_THUMB_BYTES, thumbBudget));
		if (facts === undefined) return { item: base };
		return { item: { ...base, width: facts.width, height: facts.height }, thumb: facts.thumb };
	} finally {
		await handle.close();
	}
}

/**
 * Present `input` (a path or several). Every path is judged on its own: a
 * refusal is a line in the answer and the other paths still present. Throws only
 * when NOTHING could be presented, so the model sees a failed call, not a success
 * with an empty card.
 */
export async function presentPaths(input: string | readonly string[], options: PresentOptions): Promise<PresentResult> {
	const all = typeof input === "string" ? [input] : input;
	const requested = all.slice(0, MAX_PRESENTED_ITEMS);
	const lines: string[] = [];
	const items: PresentedItem[] = [];
	const images: ThumbImage[] = [];
	const run: Run = { cwd: options.cwd, platform: options.platform ?? process.platform, seen: new Set() };
	let thumbBytes = 0;

	for (const path of requested) {
		options.signal?.throwIfAborted();
		const outcome = await presentOne(path, run, MAX_RESULT_THUMB_BYTES - thumbBytes);
		if (outcome === undefined) continue;
		if ("refused" in outcome) {
			const shown = oneLine(String(path), MAX_ECHO).trim() || "(empty path)";
			lines.push(`Could not present ${shown}: ${outcome.refused}.`);
			continue;
		}
		const { item, thumb } = outcome;
		if (thumb !== undefined) {
			thumbBytes += thumb.bytes;
			images.push({ data: thumb.data, mimeType: thumb.mimeType });
		}
		items.push(thumb === undefined ? item : { ...item, thumb: images.length - 1 });
		lines.push(`Presented ${oneLine(item.name, MAX_ECHO)} (${KIND_LABEL[item.kind]}, ${formatSize(item.size)}).`);
	}
	if (all.length > requested.length) {
		lines.push(`Only the first ${requested.length} of ${all.length} paths were presented.`);
	}
	if (items.length === 0) throw new Error(lines.join("\n") || "Nothing to present: pass the path of a file.");

	return {
		text: lines.join("\n"),
		details: { presentation: { items }, ...(images.length > 0 ? { images } : {}) },
	};
}
