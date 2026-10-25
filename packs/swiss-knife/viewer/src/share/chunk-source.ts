import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { ASP_CHUNK_BYTES, chunkCount } from "@dimension/sdk/artifact-share";

export class FileChangedError extends Error {
	override readonly name = "FileChangedError";
	constructor() {
		super("the file changed while it was being read; share it again once it has settled");
	}
}

export interface Fingerprint {
	readonly size: number;
	readonly mtimeMs: number;
}

export interface ChunkSource extends Fingerprint {
	readonly chunks: number;
	chunk(index: number): Promise<Uint8Array>;
	verifyUnchanged(): Promise<void>;
	close(): Promise<void>;
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export async function openChunkSource(path: string): Promise<ChunkSource> {
	const handle: FileHandle = await open(path, OPEN_FLAGS);
	try {
		const first = await handle.stat();
		if (!first.isFile()) throw new Error("only a regular file can be shared");
		const fingerprint = { size: first.size, mtimeMs: first.mtimeMs };
		return {
			...fingerprint,
			chunks: chunkCount(first.size),
			async chunk(index) {
				const start = index * ASP_CHUNK_BYTES;
				const length = Math.max(0, Math.min(ASP_CHUNK_BYTES, first.size - start));
				const bytes = new Uint8Array(length);
				let filled = 0;
				while (filled < length) {
					const { bytesRead } = await handle.read(bytes, filled, length - filled, start + filled);
					if (bytesRead === 0) throw new FileChangedError();
					filled += bytesRead;
				}
				return bytes;
			},
			async verifyUnchanged() {
				const now = await handle.stat();
				if (now.size !== fingerprint.size || now.mtimeMs !== fingerprint.mtimeMs) throw new FileChangedError();
			},
			close: () => handle.close(),
		};
	} catch (error) {
		await handle.close();
		throw error;
	}
}
