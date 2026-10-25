import type { App } from "@modelcontextprotocol/ext-apps";
import { createToolCaller } from "@dimension/mcp-app-kit/tools";
import { mediaSourceSchema } from "../../../src/contract";
import type { LibraryItem, ThumbMime } from "../../../../src/library/types";
import { loadDocumentHead } from "../document-bytes";
import { drawFrame, once } from "../media-frame";
import { trackMediaWork } from "../media-lifecycle";
import { KIND_LOOK } from "./kinds";

export const THUMB_LONG_EDGE = 320;
export const THUMB_MAX_BYTES = 128 * 1024;
export const PDF_THUMB_MAX_SOURCE_BYTES = 48 * 1024 * 1024;
const QUALITIES = [0.82, 0.7, 0.55, 0.4] as const;
const ENCODINGS: readonly ThumbMime[] = ["image/webp", "image/jpeg"];
const WAIT_MS = 10_000;

export interface EncodedThumb {
	readonly data: string;
	readonly mime: ThumbMime;
}

export function base64Bytes(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.floor((base64.length * 3) / 4) - padding;
}

export function pickEncoding(attempts: readonly { readonly mime: ThumbMime; readonly dataUrl: string }[], maxBytes: number): EncodedThumb | null {
	for (const attempt of attempts) {
		const prefix = `data:${attempt.mime};base64,`;
		if (!attempt.dataUrl.startsWith(prefix)) continue;
		const data = attempt.dataUrl.slice(prefix.length);
		if (data.length > 0 && base64Bytes(data) <= maxBytes) return { data, mime: attempt.mime };
	}
	return null;
}

export function encodeThumb(canvas: HTMLCanvasElement): EncodedThumb {
	for (const mime of ENCODINGS) {
		for (const quality of QUALITIES) {
			const dataUrl = canvas.toDataURL(mime, quality);
			if (!dataUrl.startsWith(`data:${mime};`)) break;
			const picked = pickEncoding([{ mime, dataUrl }], THUMB_MAX_BYTES);
			if (picked !== null) return picked;
		}
	}
	throw new Error("the thumbnail could not be encoded small enough");
}

export function posterCandidate(item: LibraryItem): boolean {
	if (item.hasThumb || item.state !== "live" || !KIND_LOOK[item.kind].poster) return false;
	return item.kind === "video" || (item.size > 0 && item.size <= PDF_THUMB_MAX_SOURCE_BYTES);
}

async function videoPoster(app: App, item: LibraryItem, signal: AbortSignal): Promise<HTMLCanvasElement> {
	const tools = createToolCaller(app);
	const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
	const video = document.createElement("video");
	try {
		const source = mediaSourceSchema.parse(await tools.whole("open_media", { path: item.path, size: item.size, mtimeMs: item.mtimeMs, token }, { signal }));
		video.muted = true;
		video.preload = "auto";
		video.crossOrigin = "anonymous";
		video.playsInline = true;
		const opened = once(video, "loadeddata", "opening the video", signal, WAIT_MS);
		video.src = source.url;
		await opened;
		const duration = Number.isFinite(video.duration) ? video.duration : 0;
		const at = Math.min(1, duration * 0.1);
		if (at > 0) {
			const landed = once(video, "seeked", "seeking", signal, WAIT_MS);
			video.currentTime = at;
			await landed;
		}
		return drawFrame(video, THUMB_LONG_EDGE);
	} finally {
		video.removeAttribute("src");
		video.load();
		void trackMediaWork(app, tools.raw("close_media", { token })).catch(() => undefined);
	}
}

async function pdfPoster(app: App, item: LibraryItem, signal: AbortSignal): Promise<HTMLCanvasElement> {
	const bytes = await loadDocumentHead(
		app,
		{ key: `library:${item.id}`, path: item.path, filename: item.name, kind: "pdf", size: item.size, mtimeMs: item.mtimeMs, revision: 0, annotateRequests: 0 },
		item.size,
		signal,
	);
	signal.throwIfAborted();
	const { drawFirstPage } = await import("../renderers/pdf");
	return drawFirstPage(bytes, THUMB_LONG_EDGE, signal);
}

export async function drawPoster(app: App, item: LibraryItem, signal: AbortSignal): Promise<EncodedThumb> {
	const canvas = item.kind === "video" ? await videoPoster(app, item, signal) : await pdfPoster(app, item, signal);
	try {
		signal.throwIfAborted();
		return encodeThumb(canvas);
	} finally {
		canvas.width = 0;
		canvas.height = 0;
	}
}
