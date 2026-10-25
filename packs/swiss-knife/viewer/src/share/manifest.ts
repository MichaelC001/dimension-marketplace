import { readFile } from "node:fs/promises";
import { ASP_CHUNK_BYTES, ASP_MAX_POSTER_BYTES, type AspManifest, chunkCount } from "@dimension/sdk/artifact-share";
import type { Library, LibraryItem } from "../../../src/library/types";

const MAX_NAME_CHARS = 255;
const MAX_TITLE_CHARS = 500;

async function posterOf(library: Library, artifactId: string): Promise<string | undefined> {
	const path = library.thumbPath(artifactId);
	if (path === undefined) return undefined;
	try {
		const bytes = await readFile(path);
		return bytes.length > 0 && bytes.length <= ASP_MAX_POSTER_BYTES ? bytes.toString("base64") : undefined;
	} catch {
		return undefined;
	}
}

export async function buildManifest(library: Library, item: LibraryItem, version: number, size: number): Promise<AspManifest> {
	const poster = await posterOf(library, item.id);
	const title = item.title?.trim().slice(0, MAX_TITLE_CHARS);
	return {
		asp: 1,
		name: item.name.slice(0, MAX_NAME_CHARS),
		...(title === undefined || title === "" ? {} : { title }),
		kind: item.kind,
		mime: item.mime,
		size,
		chunkBytes: ASP_CHUNK_BYTES,
		chunks: chunkCount(size),
		version,
		createdAt: Date.now(),
		...(item.width !== undefined && item.width > 0 ? { width: Math.round(item.width) } : {}),
		...(item.height !== undefined && item.height > 0 ? { height: Math.round(item.height) } : {}),
		...(item.durationMs !== undefined && item.durationMs >= 0 ? { durationMs: Math.round(item.durationMs) } : {}),
		...(poster === undefined ? {} : { poster }),
	};
}
