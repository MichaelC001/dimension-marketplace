import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

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

async function linkOnTheWay(base: string, named: string): Promise<boolean> {
	let at = base;
	for (const part of named.split(sep)) {
		at = join(at, part);
		if ((await lstat(at)).isSymbolicLink()) return true;
	}
	return false;
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
	const lexicalRoot = resolve(root);
	const viaLexical = inside(lexicalRoot, lexical);
	const named = viaLexical ?? inside(realRoot, lexical);
	if (named === null) {
		throw new Error(`${requested} cannot be matched to the session's folder; give a path inside it.`);
	}
	if (await linkOnTheWay(viaLexical === null ? realRoot : lexicalRoot, named)) {
		throw new Error(`${requested} goes through a link, so it is not uploaded.`);
	}
	if (!(await stat(real)).isFile()) throw new Error(`${requested} is not a file.`);
	const secrets = await Promise.all(forbidden.map(path => stat(path, { bigint: true }).catch(() => null)));
	const handle = await open(real, "r");
	try {
		const info = await handle.stat({ bigint: true });
		if (secrets.some(secret => secret !== null && secret.ino !== 0n && secret.ino === info.ino && secret.dev === info.dev)) {
			throw new Error(`${requested} is a saved Slack token, so it is not uploaded.`);
		}
		const size = Number(info.size);
		if (size === 0) throw new Error(`${requested} is empty.`);
		if (size > MAX_UPLOAD_BYTES) throw new Error(`${requested} is ${size} bytes; the limit is ${MAX_UPLOAD_BYTES}.`);
		const buffer = Buffer.allocUnsafe(size + 1);
		const { bytesRead } = await handle.read(buffer, 0, size + 1, 0);
		if (bytesRead !== size) throw new Error(`${requested} changed while it was being read.`);
		return { name: basename(real), bytes: buffer.subarray(0, size) };
	} finally {
		await handle.close();
	}
}
