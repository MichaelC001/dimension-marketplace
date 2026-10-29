import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadableFile {
	readonly name: string;
	readonly bytes: Buffer;
}

function inside(root: string, target: string): string | null {
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

function sameLocation(a: string, b: string): boolean {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function realOrSelf(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

export async function readUploadable(root: string, requested: string, forbidden: readonly string[]): Promise<UploadableFile> {
	const lexical = resolve(root, requested);
	let real: string;
	let realRoot: string;
	try {
		[real, realRoot] = await Promise.all([realpath(lexical), realpath(root)]);
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
	const asked = inside(resolve(root), lexical) ?? inside(realRoot, lexical);
	if (asked === null || !sameLocation(asked, rel)) {
		throw new Error(`${requested} goes through a link, so it is not uploaded.`);
	}
	const secrets = await Promise.all(forbidden.map(realOrSelf));
	if (secrets.some(secret => sameLocation(secret, real))) {
		throw new Error(`${requested} is a saved Slack token, so it is not uploaded.`);
	}
	if (!(await stat(real)).isFile()) throw new Error(`${requested} is not a file.`);
	const handle = await open(real, "r");
	try {
		const { size } = await handle.stat();
		if (size === 0) throw new Error(`${requested} is empty.`);
		if (size > MAX_UPLOAD_BYTES) throw new Error(`${requested} is ${size} bytes; the limit is ${MAX_UPLOAD_BYTES}.`);
		const bytes = await handle.readFile();
		if (bytes.byteLength === 0) throw new Error(`${requested} is empty.`);
		if (bytes.byteLength > MAX_UPLOAD_BYTES) {
			throw new Error(`${requested} is ${bytes.byteLength} bytes; the limit is ${MAX_UPLOAD_BYTES}.`);
		}
		return { name: basename(real), bytes };
	} finally {
		await handle.close();
	}
}
