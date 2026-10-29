import { realpath, stat } from "node:fs/promises";
import { isAbsolute, basename, relative, resolve, sep } from "node:path";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface LocalFile {
	readonly path: string;
	readonly name: string;
	readonly size: number;
}

function inside(root: string, target: string): string | null {
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

export async function resolveUploadable(root: string, requested: string): Promise<LocalFile> {
	const wanted = resolve(root, requested);
	let real: string;
	let realRoot: string;
	try {
		[real, realRoot] = await Promise.all([realpath(wanted), realpath(root)]);
	} catch {
		throw new Error(`There is no file at ${requested}.`);
	}
	const rel = inside(realRoot, real);
	if (rel === null) {
		throw new Error(`${requested} is outside the session's folder, so it is not uploaded.`);
	}
	if (rel.split(sep).some(part => part.startsWith("."))) {
		throw new Error(`${requested} is in a hidden file or folder, so it is not uploaded.`);
	}
	const info = await stat(real);
	if (!info.isFile()) throw new Error(`${requested} is not a file.`);
	if (info.size === 0) throw new Error(`${requested} is empty.`);
	if (info.size > MAX_UPLOAD_BYTES) {
		throw new Error(`${requested} is ${info.size} bytes; the limit is ${MAX_UPLOAD_BYTES}.`);
	}
	return { path: real, name: basename(real), size: info.size };
}
