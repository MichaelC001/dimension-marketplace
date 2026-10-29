import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	appendFile,
	type FileHandle,
	link,
	mkdir,
	mkdtemp,
	open,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MAX_UPLOAD_BYTES, readUploadable } from "../local-file";
import { canHardLink } from "./support/hard-link";

const BYTES = Uint8Array.from({ length: 1024 }, (_, index) => (index * 37 + 11) % 256);

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

async function put(path: string, content: Uint8Array | string = "hello"): Promise<void> {
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

const caseInsensitiveDisk = await (async () => {
	const probe = await mkdtemp(join(tmpdir(), "slack-local-file-probe-"));
	try {
		await writeFile(join(probe, "probe.txt"), "x");
		await stat(join(probe, "PROBE.TXT"));
		return true;
	} catch {
		return false;
	} finally {
		await rm(probe, { recursive: true, force: true });
	}
})();

const handlePrototype = await (async () => {
	const handle = await open(import.meta.path, "r");
	try {
		return Object.getPrototypeOf(handle) as FileHandle;
	} finally {
		await handle.close();
	}
})();

function afterTheSizeIsRead(change: () => Promise<void>): () => void {
	const realStat = handlePrototype.stat;
	const spy = spyOn(handlePrototype, "stat").mockImplementation((async function (
		this: FileHandle,
		options?: { bigint: true },
	) {
		const info = await realStat.call(this, options);
		await change();
		return info;
	}) as FileHandle["stat"]);
	return () => spy.mockRestore();
}

type Request = (folder: string) => string;

const INSIDE: readonly (readonly [string, string, Request])[] = [
	["a relative path", "report.md", () => "report.md"],
	["a relative path into subfolders", "docs/q3/report.md", () => "docs/q3/report.md"],
	["a path that wanders but stays inside", "docs/report.md", () => "docs/../docs/./report.md"],
	["an absolute path inside the folder", "report.md", folder => join(folder, "report.md")],
	["a name with dots that is not hidden", "report.v2..final.md", () => "report.v2..final.md"],
];

test.each(INSIDE)("%s to a file in the folder gives that file's name and exact bytes", async (_, file, request) => {
	await put(join(root, file), BYTES);

	const uploadable = await readUploadable(root, request(root), []);

	expect(uploadable.name).toBe(basename(file));
	expect(uploadable.bytes.equals(BYTES)).toBe(true);
});

test.each([
	["a relative path", () => "report.md"],
	["an absolute path through the link", (entrance: string) => join(entrance, "report.md")],
	["an absolute path through the real folder", () => join(root, "report.md")],
])("a session folder reached through a link still gives its files for %s", async (_, request) => {
	await put(join(root, "report.md"), BYTES);
	const entrance = join(base, "entrance");
	await symlink(root, entrance, "junction");

	const uploadable = await readUploadable(entrance, request(entrance), []);

	expect(uploadable.bytes.equals(BYTES)).toBe(true);
});

test("a session folder that itself sits under a hidden directory still gives its own files", async () => {
	const inHidden = join(base, ".worktrees", "session");
	await put(join(inHidden, "report.md"), BYTES);

	const uploadable = await readUploadable(inHidden, "report.md", []);

	expect(uploadable.name).toBe("report.md");
});

test("a file of exactly the size limit is accepted and one byte over is refused naming both sizes", async () => {
	await putSized(join(root, "limit.bin"), MAX_UPLOAD_BYTES);
	await putSized(join(root, "over.bin"), MAX_UPLOAD_BYTES + 1);

	expect((await readUploadable(root, "limit.bin", [])).bytes.byteLength).toBe(MAX_UPLOAD_BYTES);
	const refusal = readUploadable(root, "over.bin", []);
	await expect(refusal).rejects.toThrow(String(MAX_UPLOAD_BYTES + 1));
	await expect(refusal).rejects.toThrow(String(MAX_UPLOAD_BYTES));
});

test("an oversize file is refused on its size alone, without any of it being read", async () => {
	await putSized(join(root, "over.bin"), MAX_UPLOAD_BYTES + 1);
	const read = spyOn(handlePrototype, "read");

	try {
		await expect(readUploadable(root, "over.bin", [])).rejects.toThrow(`over.bin is ${MAX_UPLOAD_BYTES + 1} bytes`);
		expect(read).not.toHaveBeenCalled();
	} finally {
		read.mockRestore();
	}
});

test("a one byte file is accepted and an empty file is refused", async () => {
	await put(join(root, "one.txt"), "x");
	await put(join(root, "empty.txt"), "");

	expect((await readUploadable(root, "one.txt", [])).bytes.byteLength).toBe(1);
	await expect(readUploadable(root, "empty.txt", [])).rejects.toThrow("empty.txt is empty.");
});

test("a directory is refused", async () => {
	await mkdir(join(root, "docs"));

	await expect(readUploadable(root, "docs", [])).rejects.toThrow("docs is not a file.");
});

test.each([
	["a file that is not there", "nope.txt"],
	["a file in a folder that is not there", "nope/deeper/x.txt"],
])("%s is refused as missing", async (_, request) => {
	await expect(readUploadable(root, request, [])).rejects.toThrow(`There is no file at ${request}.`);
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

	await expect(readUploadable(root, request(root), [])).rejects.toThrow("outside the session's folder");
});

test.skipIf(!canLinkFiles)("a link to a file outside the folder is refused as outside the folder", async () => {
	await put(join(base, "outside.txt"));
	await symlink(join(base, "outside.txt"), join(root, "innocent.txt"), "file");

	await expect(readUploadable(root, "innocent.txt", [])).rejects.toThrow("outside the session's folder");
});

const HIDDEN: readonly (readonly [string, string, Request])[] = [
	["a dotfile", ".env", () => ".env"],
	["a file in a hidden folder", ".git/config", () => ".git/config"],
	["a hidden folder deeper down", "sub/.secret/x.md", () => "sub/.secret/x.md"],
	["a hidden file in a plain folder", "sub/.notes.md", () => "sub/.notes.md"],
	["a dotfile reached by an absolute path", ".env", folder => join(folder, ".env")],
	["a dotfile reached by wandering", ".env", () => "sub/../.env"],
];

test.each(HIDDEN)("%s is refused as hidden", async (_, file, request) => {
	await put(join(root, file));

	await expect(readUploadable(root, request(root), [])).rejects.toThrow("hidden file or folder");
});

test("a plain-looking path through a link into a hidden folder is refused as hidden", async () => {
	await put(join(root, ".vault", "token.txt"));
	await symlink(join(root, ".vault"), join(root, "visible"), "junction");

	await expect(readUploadable(root, "visible/token.txt", [])).rejects.toThrow("hidden file or folder");
});

test.each([
	["a relative path", () => "alias/a.md"],
	["an absolute path", (folder: string) => join(folder, "alias", "a.md")],
])("a link inside the folder to another place inside it is refused for %s, because the file reached is not the file named", async (_, request) => {
	await put(join(root, "docs", "a.md"));
	await symlink(join(root, "docs"), join(root, "alias"), "junction");

	await expect(readUploadable(root, request(root), [])).rejects.toThrow("goes through a link");
});

test.skipIf(!canLinkFiles)("a link to a file inside the folder is refused as a link", async () => {
	await put(join(root, "real.md"));
	await symlink(join(root, "real.md"), join(root, "shortcut.md"), "file");

	await expect(readUploadable(root, "shortcut.md", [])).rejects.toThrow("goes through a link");
	expect((await readUploadable(root, "real.md", [])).name).toBe("real.md");
});

test.skipIf(!caseInsensitiveDisk)("on a case-insensitive disk a request that differs from the real name only in letter case is accepted, not mistaken for a link", async () => {
	await put(join(root, "docs", "readme.md"), BYTES);

	const uploadable = await readUploadable(root, "DOCS/README.MD", []);

	expect(uploadable.name.toLowerCase()).toBe("readme.md");
	expect(uploadable.bytes.equals(BYTES)).toBe(true);
});

test.skipIf(process.platform !== "win32")("on Windows an absolute request spelled with the \\\\?\\ prefix cannot be checked for links, so it is refused, for a plain file and for a path through a link alike", async () => {
	await put(join(root, "report.md"), BYTES);
	await put(join(root, "docs", "a.md"));
	await symlink(join(root, "docs"), join(root, "alias"), "junction");

	for (const file of ["report.md", join("alias", "a.md")]) {
		await expect(readUploadable(root, `\\\\?\\${join(root, file)}`, [])).rejects.toThrow(
			"cannot be matched to the session's folder",
		);
	}
});

test("a saved token file is refused by name even though it sits in the folder, while its neighbour uploads", async () => {
	await put(join(root, "keys", "token.json"), '{"access":"xoxb-secret"}');
	await put(join(root, "keys", "notes.md"), "notes");
	const forbidden = [join(root, "keys", "token.json")];

	await expect(readUploadable(root, "keys/token.json", forbidden)).rejects.toThrow(
		"keys/token.json is a saved Slack token",
	);
	await expect(readUploadable(root, "keys/./token.json", forbidden)).rejects.toThrow("is a saved Slack token");
	expect((await readUploadable(root, "keys/notes.md", forbidden)).name).toBe("notes.md");
});

test("a saved token file is refused when the token's home is spelled through a link to the folder", async () => {
	const stowed = join(base, "stowed");
	await put(join(stowed, "dimension-slack", "token.json"), '{"access":"xoxb-secret"}');
	await symlink(stowed, join(base, "linked-config"), "junction");
	const forbidden = [join(base, "linked-config", "dimension-slack", "token.json")];

	await expect(readUploadable(stowed, "dimension-slack/token.json", forbidden)).rejects.toThrow(
		"is a saved Slack token",
	);
});

test.skipIf(!canHardLink)("a hard link in the folder to a saved token file is refused as a saved token, whatever it is named", async () => {
	const token = join(base, "config", "token.json");
	await put(token, '{"access":"xoxb-secret"}');
	await link(token, join(root, "quarterly-notes.json"));

	await expect(readUploadable(root, "quarterly-notes.json", [token])).rejects.toThrow(
		"quarterly-notes.json is a saved Slack token",
	);
});

test.each([
	["grows", (path: string) => appendFile(path, " and then some")],
	["shrinks", (path: string) => truncate(path, 3)],
])("a file that %s between its size being read and its bytes being read is refused, not uploaded cut short or padded", async (_, change) => {
	const path = join(root, "report.md");
	await put(path, BYTES);
	const restore = afterTheSizeIsRead(() => change(path));

	try {
		await expect(readUploadable(root, "report.md", [])).rejects.toThrow("report.md changed while it was being read.");
	} finally {
		restore();
	}
});

test("a token file that is not saved forbids nothing", async () => {
	await put(join(root, "report.md"), BYTES);
	const forbidden = [join(base, "never-saved", "token.json"), join(root, "missing.json")];

	const uploadable = await readUploadable(root, "report.md", forbidden);

	expect(uploadable.bytes.equals(BYTES)).toBe(true);
});

test("a path outside the folder is reported as outside, not as a saved token, even when it is a token file", async () => {
	await put(join(base, "token.json"), '{"access":"xoxb-secret"}');

	await expect(readUploadable(root, "../token.json", [join(base, "token.json")])).rejects.toThrow(
		"outside the session's folder",
	);
});
