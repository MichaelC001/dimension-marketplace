// Reading a file in ranges. A document can be hundreds of megabytes; the View
// streams it in chunks instead of one JSON blob, and this is the only place the
// server touches file bytes. It opens the file and reads exactly the range
// asked (`fs.open` + positioned reads) — never `readFile`, so a 400 MB PDF costs
// one chunk of memory per call, not the file.
import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { type FileChunk, MAX_CHUNK_BYTES } from "./contract";

export interface RangeRead {
	readonly bytes: Buffer;
	/** The file's size at the time of the read. */
	readonly size: number;
	readonly mtimeMs: number;
}

/** The two filesystem calls a range read makes, so a test can put a FIFO or a race behind them. */
export interface RangeFs {
	stat(path: string): Promise<Pick<Stats, "isFile">>;
	open(path: string, flags: number): Promise<RangeHandle>;
}

/** What a range read uses of an open file. `fs.promises.FileHandle` is one. */
export interface RangeHandle {
	stat(): Promise<Pick<Stats, "isFile" | "size" | "mtimeMs">>;
	read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
	close(): Promise<void>;
}

const nativeFs: RangeFs = { stat, open };

/** Read-only, and on POSIX never blocking: opening a FIFO for reading waits for a
 *  writer unless `O_NONBLOCK` is set. It does nothing to a regular file. Windows
 *  has no such flag (nor a FIFO in the filesystem namespace). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * Read up to `length` bytes at `offset`. A read that starts at or past the end
 * is not an error: it returns no bytes (the caller sees `eof`). Only a regular
 * file is read; a directory, pipe or device is refused before it is opened,
 * because opening a FIFO for reading blocks until a writer appears and would
 * stall the whole server. The type is checked again on the open handle, which
 * closes the window in which a regular file is swapped for a FIFO or a directory
 * between the two calls. It does NOT pin WHICH file was opened: a writer in the
 * same directory can still swap a link in between the fence's `realpath` and the
 * open, and the open follows it. Accepted: a process that can write there has
 * the power of a shell, and the bytes go to the user's View, not to the model.
 */
export async function readRange(path: string, offset: number, length: number, fs: RangeFs = nativeFs): Promise<RangeRead> {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
	if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHUNK_BYTES) {
		throw new RangeError(`length must be an integer from 0 to ${MAX_CHUNK_BYTES}, got ${length}`);
	}
	if (!(await fs.stat(path)).isFile()) throw new Error("not a regular file");
	const handle = await fs.open(path, OPEN_FLAGS);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("not a regular file");
		const want = Math.min(length, Math.max(0, stats.size - offset));
		const bytes = Buffer.allocUnsafe(want);
		let filled = 0;
		while (filled < want) {
			const { bytesRead } = await handle.read(bytes, filled, want - filled, offset + filled);
			if (bytesRead === 0) break; // The file shrank under us: return what was there.
			filled += bytesRead;
		}
		return { bytes: filled === want ? bytes : bytes.subarray(0, filled), size: stats.size, mtimeMs: stats.mtimeMs };
	} finally {
		await handle.close();
	}
}

/** One base64 chunk for `read_file_chunk`. `length` in the answer is what was returned. */
export async function readChunk(path: string, offset: number, length: number): Promise<FileChunk> {
	const { bytes, size } = await readRange(path, offset, length);
	return {
		base64: bytes.toString("base64"),
		offset,
		length: bytes.length,
		size,
		eof: offset + bytes.length >= size,
	};
}
