import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MAX_UPLOAD_BYTES, resolveUploadable } from "../local-file";

let base: string;
let root: string;

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "slack-local-file-"));
	root = join(base, "session");
	await mkdir(root);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

async function put(path: string, content = "hello"): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

async function putSized(path: string, size: number): Promise<void> {
	await put(path, "");
	await truncate(path, size);
}

const canLinkFiles = await (async () => {
	const probe = await mkdtemp(join(tmpdir(), "slack-local-file-probe-"));
	try {
		await writeFile(join(probe, "target"), "x");
		await symlink(join(probe, "target"), join(probe, "link"), "file");
		return true;
	} catch {
		return false;
	} finally {
		await rm(probe, { recursive: true, force: true });
	}
})();

type Request = (folder: string) => string;

const INSIDE: readonly (readonly [string, string, Request])[] = [
	["a relative path", "report.md", () => "report.md"],
	["a relative path into subfolders", "docs/q3/report.md", () => "docs/q3/report.md"],
	["a path that wanders but stays inside", "docs/report.md", () => "docs/../docs/./report.md"],
	["an absolute path inside the folder", "report.md", (folder: string) => join(folder, "report.md")],
	["a name with dots that is not hidden", "report.v2..final.md", () => "report.v2..final.md"],
];

test.each(INSIDE)("%s to a file in the folder resolves to that file's real path, name and size", async (_, file, request) => {
	await put(join(root, file), "hello");

	const resolved = await resolveUploadable(root, request(root));

	expect(resolved).toEqual({ path: await realpath(join(root, file)), name: basename(file), size: 5 });
});

test("a path through a link inside the folder to another place inside it resolves to the real file, not the link", async () => {
	await put(join(root, "docs", "a.md"));
	await symlink(join(root, "docs"), join(root, "alias"), "junction");

	const resolved = await resolveUploadable(root, "alias/a.md");

	expect(resolved.path).toBe(await realpath(join(root, "docs", "a.md")));
});

test("a session folder reached through a link still resolves its own files", async () => {
	await put(join(root, "report.md"));
	const entrance = join(base, "entrance");
	await symlink(root, entrance, "junction");

	const resolved = await resolveUploadable(entrance, "report.md");

	expect(resolved.path).toBe(await realpath(join(root, "report.md")));
});

test("a session folder that itself sits under a hidden directory still uploads its own files", async () => {
	const inHidden = join(base, ".worktrees", "session");
	await put(join(inHidden, "report.md"));

	const resolved = await resolveUploadable(inHidden, "report.md");

	expect(resolved.name).toBe("report.md");
});

test("a file of exactly the size limit is accepted and one byte over is refused naming both sizes", async () => {
	await putSized(join(root, "limit.bin"), MAX_UPLOAD_BYTES);
	await putSized(join(root, "over.bin"), MAX_UPLOAD_BYTES + 1);

	expect((await resolveUploadable(root, "limit.bin")).size).toBe(MAX_UPLOAD_BYTES);
	const refusal = resolveUploadable(root, "over.bin");
	await expect(refusal).rejects.toThrow(String(MAX_UPLOAD_BYTES + 1));
	await expect(refusal).rejects.toThrow(String(MAX_UPLOAD_BYTES));
});

test("a one byte file is accepted and an empty file is refused", async () => {
	await put(join(root, "one.txt"), "x");
	await put(join(root, "empty.txt"), "");

	expect((await resolveUploadable(root, "one.txt")).size).toBe(1);
	await expect(resolveUploadable(root, "empty.txt")).rejects.toThrow("empty.txt is empty.");
});

test("a directory is refused", async () => {
	await mkdir(join(root, "docs"));

	await expect(resolveUploadable(root, "docs")).rejects.toThrow("docs is not a file.");
});

test.each([
	["a file that is not there", "nope.txt"],
	["a file in a folder that is not there", "nope/deeper/x.txt"],
])("%s is refused as missing", async (_, request) => {
	await expect(resolveUploadable(root, request)).rejects.toThrow(`There is no file at ${request}.`);
});

const OUTSIDE: readonly (readonly [string, Request])[] = [
	["a path that climbs out with ..", () => "../outside.txt"],
	["a path that climbs out after going in", () => "docs/../../outside.txt"],
	["an absolute path to a file beside the folder", () => join(base, "outside.txt")],
	["a sibling folder whose name starts with the session folder's name", () => "../session-evil/x.txt"],
	["a path through a link inside the folder to a folder outside it", () => "shortcut/outside.txt"],
];

test.each(OUTSIDE)("%s is refused as outside the folder even though the file exists", async (_, request) => {
	await put(join(base, "outside.txt"));
	await put(join(base, "session-evil", "x.txt"));
	await symlink(base, join(root, "shortcut"), "junction");

	await expect(resolveUploadable(root, request(root))).rejects.toThrow("outside the session's folder");
});

test.skipIf(!canLinkFiles)("a link to a file outside the folder is refused as outside the folder", async () => {
	await put(join(base, "outside.txt"));
	await symlink(join(base, "outside.txt"), join(root, "innocent.txt"), "file");

	await expect(resolveUploadable(root, "innocent.txt")).rejects.toThrow("outside the session's folder");
});

const HIDDEN: readonly (readonly [string, string, Request])[] = [
	["a dotfile", ".env", () => ".env"],
	["a file in a hidden folder", ".git/config", () => ".git/config"],
	["a hidden folder deeper down", "sub/.secret/x.md", () => "sub/.secret/x.md"],
	["a hidden file in a plain folder", "sub/.notes.md", () => "sub/.notes.md"],
	["a dotfile reached by an absolute path", ".env", (folder: string) => join(folder, ".env")],
	["a dotfile reached by wandering", ".env", () => "sub/../.env"],
];

test.each(HIDDEN)("%s is refused as hidden", async (_, file, request) => {
	await put(join(root, file));

	await expect(resolveUploadable(root, request(root))).rejects.toThrow("hidden file or folder");
});

test("a plain-looking path through a link into a hidden folder is refused as hidden", async () => {
	await put(join(root, ".vault", "token.txt"));
	await symlink(join(root, ".vault"), join(root, "visible"), "junction");

	await expect(resolveUploadable(root, "visible/token.txt")).rejects.toThrow("hidden file or folder");
});
