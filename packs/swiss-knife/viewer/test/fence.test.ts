import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredRoots, createFence, insideRoot, textRefusal } from "../src/fence";

describe("insideRoot", () => {
	test("is segment-wise: a sibling that shares a prefix is outside", () => {
		expect(insideRoot("/a/b/c.png", "/a/b", "linux")).toBe(true);
		expect(insideRoot("/a/b", "/a/b", "linux")).toBe(true);
		expect(insideRoot("/a/bc/c.png", "/a/b", "linux")).toBe(false);
		expect(insideRoot("/a/c.png", "/a/b", "linux")).toBe(false);
	});

	test("is case-insensitive on Windows and exact on Linux", () => {
		expect(insideRoot("C:\\Users\\Me\\Docs\\a.png", "c:\\users\\me", "win32")).toBe(true);
		expect(insideRoot("/A/b/c.png", "/a", "linux")).toBe(false);
	});

	test("a path on another drive is outside", () => {
		expect(insideRoot("D:\\Docs\\a.png", "C:\\Docs", "win32")).toBe(false);
	});
});

describe("configuredRoots", () => {
	test("reads VIEWER_ROOTS with the platform's delimiter and drops relative entries", () => {
		expect(configuredRoots({ VIEWER_ROOTS: "C:\\Work;relative\\dir;D:\\More" }, "C:\\Users\\Me", "win32")).toEqual(
			expect.arrayContaining(["C:\\Work", "D:\\More"]),
		);
		const posix = configuredRoots({ VIEWER_ROOTS: "/srv/docs:not/absolute:/tmp/x" }, "/home/me", "linux");
		expect(posix).toEqual(expect.arrayContaining(["/srv/docs", "/tmp/x", "/home/me/.inso/vault", "/home/me/.inso-dev/vault"]));
		expect(posix).not.toContain("not/absolute");
	});
});

describe("fence on Windows paths (platform injected, no disk)", () => {
	const fence = createFence({
		platform: "win32",
		home: "C:\\Users\\Me",
		env: { VIEWER_ROOTS: "C:\\Work\\Docs" },
		realpath: async path => path,
	});

	test("compares drive, folder and file case-insensitively", async () => {
		expect(await fence.check("c:\\work\\DOCS\\Report.PNG")).toEqual({ ok: true, real: "c:\\work\\DOCS\\Report.PNG" });
	});

	test("a `..` traversal that leaves the root is refused", async () => {
		const verdict = await fence.check("C:\\Work\\Docs\\..\\Secrets\\plan.txt");
		expect(verdict).toMatchObject({ ok: false });
		expect(verdict.ok ? "" : verdict.reason).toContain("VIEWER_ROOTS");
	});

	test("deny beats allow even inside an allowed root", async () => {
		expect(await fence.check("C:\\Work\\Docs\\.ENV")).toMatchObject({ ok: false });
	});

	test("device paths and alternate data streams are refused", async () => {
		expect(await fence.check("\\\\?\\C:\\Work\\Docs\\a.png")).toMatchObject({ ok: false });
		expect(await fence.check("C:\\Work\\Docs\\a.txt:hidden")).toMatchObject({ ok: false });
	});
});

describe("fence refuses network paths before any filesystem call (Windows, platform injected)", () => {
	const calls: string[] = [];
	const fence = createFence({
		platform: "win32",
		home: "C:\\Users\\Me",
		env: { VIEWER_ROOTS: "C:\\Work\\Docs" },
		realpath: async path => {
			calls.push(path);
			return path;
		},
	});

	const spellings = [
		["backslashes", "\\\\attacker\\share\\a.pdf"],
		["forward slashes", "//attacker/share/a.pdf"],
		["mixed separators", "/\\attacker\\share\\a.pdf"],
		["WebDAV over TLS", "\\\\attacker@SSL@443\\DavWWWRoot\\a.pdf"],
		["WebDAV on a port", "\\\\attacker@8080\\DavWWWRoot\\a.pdf"],
	] as const;

	test.each(spellings)("%s: refused as a network path, with no realpath call", async (_name, path) => {
		calls.length = 0;
		const verdict = await fence.check(path);
		expect(verdict).toMatchObject({ ok: false });
		expect(verdict.ok ? "" : verdict.reason).toMatch(/network/i);
		expect(calls).toEqual([]);
	});

	test("a local path in the same fence does resolve (the spy is watching)", async () => {
		calls.length = 0;
		expect(await fence.check("C:\\Work\\Docs\\a.pdf")).toMatchObject({ ok: true });
		expect(calls).toContain("C:\\Work\\Docs\\a.pdf");
	});
});

describe("textRefusal", () => {
	// What the operating system would act on, named by the category it is refused as.
	const spellings = [
		["a `\\\\?\\` device path", "\\\\?\\C:\\Work\\a.png", /device/i],
		["a `\\\\.\\` device path", "\\\\.\\PhysicalDrive0", /device/i],
		["a forward-slash device path", "//?/C:/Work/a.png", /device/i],
		["an alternate data stream", "C:\\Work\\a.txt:hidden", /data stream/i],
		["a network path", "\\\\attacker\\share\\a.pdf", /network/i],
		["a forward-slash network path", "//attacker/share/a.pdf", /network/i],
	] as const;

	test.each(spellings)("on Windows, %s is refused as its own category", (_name, path, category) => {
		expect(textRefusal(path, "win32")).toMatch(category);
	});

	test("an ordinary Windows path is not refused", () => {
		for (const path of ["C:\\Work\\Docs\\a.png", "c:/work/docs/a.png", "D:\\", "C:\\Work\\a b (1).txt"]) {
			expect(textRefusal(path, "win32"), path).toBeUndefined();
		}
	});

	test("off Windows the same spellings are ordinary file names: a colon and a double slash mean nothing there", () => {
		for (const platform of ["linux", "darwin"] as const) {
			for (const [, path] of spellings) expect(textRefusal(path, platform), `${platform} ${path}`).toBeUndefined();
			expect(textRefusal("/home/me/notes:2024.txt", platform)).toBeUndefined();
		}
	});
});

describe("fence says one thing about a path outside the roots, whatever the cause (injected realpath)", () => {
	const fail = (code: string) => Object.assign(new Error(code), { code });
	const logs: string[] = [];
	const fence = createFence({
		platform: "win32",
		home: "C:\\Users\\Me",
		env: { VIEWER_ROOTS: "C:\\Work\\Docs" },
		log: detail => logs.push(detail),
		realpath: async path => {
			if (/missing/i.test(path)) throw fail("ENOENT");
			if (/locked/i.test(path)) throw fail("EACCES");
			if (/broken/i.test(path)) throw fail("ELOOP");
			return path;
		},
	});
	const reasonOf = async (path: string): Promise<string> => {
		const verdict = await fence.check(path);
		return verdict.ok ? "" : verdict.reason.replaceAll(path, "<path>");
	};

	test("missing, unreadable and unresolvable outside paths read the same as an existing one", async () => {
		const outside = await Promise.all(
			["C:\\Elsewhere\\missing.txt", "C:\\Elsewhere\\locked\\a.txt", "C:\\Elsewhere\\broken.txt", "C:\\Elsewhere\\present.txt"].map(reasonOf),
		);
		expect(new Set(outside).size).toBe(1);
		expect(outside[0]).toContain("outside the folders");
		expect(outside[0]).not.toMatch(/ENOENT|EACCES|ELOOP|permission|no such file|cannot be/i);
	});

	test("the cause is logged for the operator instead", async () => {
		logs.length = 0;
		await reasonOf("C:\\Elsewhere\\locked\\a.txt");
		expect(logs.join("\n")).toContain("EACCES");
		expect(logs.join("\n")).toContain("locked");
	});

	test("inside the roots the errors stay specific", async () => {
		expect(await reasonOf("C:\\Work\\Docs\\missing.txt")).toContain("no such file");
		expect(await reasonOf("C:\\Work\\Docs\\locked\\a.txt")).toContain("permission denied");
		expect(await reasonOf("C:\\Work\\Docs\\broken.txt")).toContain("ELOOP");
	});
});

describe("fence on a real disk", () => {
	let base: string;
	let root: string;
	let outside: string;
	const home = "/nonexistent-home"; // never consulted: only VIEWER_ROOTS matters here

	beforeAll(async () => {
		// `realpath` first: the temp dir may be spelled with 8.3 short names or a link.
		base = await realpath(await mkdtemp(join(tmpdir(), "viewer-fence-")));
		root = join(base, "root");
		outside = join(base, "outside");
		await mkdir(join(root, "sub"), { recursive: true });
		await mkdir(join(root, ".ssh"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(root, "sub", "note.txt"), "hello");
		await writeFile(join(root, ".env"), "TOKEN=SECRET_VALUE_123");
		await writeFile(join(root, ".ssh", "id_rsa"), "PRIVATE_KEY_MATERIAL");
		await writeFile(join(root, ".ssh", "notes.txt"), "PRIVATE_NOTES");
		await writeFile(join(outside, "secret.txt"), "OUTSIDE_SECRET");
		await mkdir(join(outside, ".ssh"), { recursive: true });
		await writeFile(join(outside, ".ssh", "notes.txt"), "OUTSIDE_PRIVATE_NOTES");
		await mkdir(join(outside, "real-folder"), { recursive: true });
		// A directory junction (Windows, no privilege needed) or symlink (elsewhere).
		await symlink(outside, join(root, "escape"), "junction"); // inside the root, leads out
		await symlink(join(root, ".ssh"), join(root, "keys"), "junction"); // inside the root, leads to a secret inside it
		await symlink(join(outside, ".ssh"), join(root, "spy"), "junction"); // inside the root, leads to a secret OUTSIDE it
		await symlink(join(outside, "real-folder"), join(outside, "alias"), "junction"); // wholly outside the root
	});

	afterAll(() => rm(base, { recursive: true, force: true }));

	const fence = () => createFence({ home, env: { VIEWER_ROOTS: root } });

	test("returns the real path of a file inside the root", async () => {
		expect(await fence().check(join(root, "sub", "note.txt"))).toEqual({ ok: true, real: join(root, "sub", "note.txt") });
	});

	test("refuses a file outside every root and names how to allow it", async () => {
		const verdict = await fence().check(join(outside, "secret.txt"));
		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.reason).toContain("VIEWER_ROOTS");
	});

	test("refuses `..` traversal out of the root", async () => {
		expect(await fence().check(join(root, "sub", "..", "..", "outside", "secret.txt"))).toMatchObject({ ok: false });
	});

	test("refuses an escape through a link inside the root, in the words of any outside path", async () => {
		const verdict = await fence().check(join(root, "escape", "secret.txt"));
		expect(verdict.ok).toBe(false);
		const reason = verdict.ok ? "" : verdict.reason;
		expect(reason).toContain("VIEWER_ROOTS");
		expect(reason).not.toContain("link");
	});

	test("refuses a link that leads to a secret inside the root, by what it resolves to", async () => {
		expect(await fence().check(join(root, "keys", "id_rsa"))).toMatchObject({ ok: false });
		// A harmless name, so only the RESOLVED path (`root/.ssh/notes.txt`) can give it away.
		const verdict = await fence().check(join(root, "keys", "notes.txt"));
		expect(verdict.ok ? "" : verdict.reason).toContain("credentials folder");
	});

	test("a refusal names the reason and never carries the file's content", async () => {
		for (const path of [join(root, ".env"), join(root, ".ssh", "id_rsa"), join(root, "escape", "secret.txt")]) {
			const verdict = await fence().check(path);
			expect(verdict.ok).toBe(false);
			const reason = verdict.ok ? "" : verdict.reason;
			expect(reason).not.toContain("SECRET_VALUE_123");
			expect(reason).not.toContain("PRIVATE_KEY_MATERIAL");
			expect(reason).not.toContain("OUTSIDE_SECRET");
		}
	});

	test("says the same about every path outside the roots, existing or not, linked or not", async () => {
		const causes: string[] = [];
		const guarded = createFence({ home, env: { VIEWER_ROOTS: root }, log: detail => causes.push(detail) });
		const outsidePaths = {
			"an existing file": join(outside, "secret.txt"),
			"a missing file": join(outside, "missing.txt"),
			"a file below a missing folder": join(outside, "no", "such", "folder", "x.txt"),
			"a path below a file": join(outside, "secret.txt", "child"),
			"through a link outside the root": join(outside, "alias", "x.txt"),
			"through a link in the root, to an existing file": join(root, "escape", "secret.txt"),
			"through a link in the root, to a missing file": join(root, "escape", "missing.txt"),
			"through a link in the root, to a secret outside it": join(root, "spy", "notes.txt"),
		};
		const reasons = new Map<string, string>();
		for (const [name, path] of Object.entries(outsidePaths)) {
			const verdict = await guarded.check(path);
			expect(verdict.ok, name).toBe(false);
			reasons.set(name, verdict.ok ? "" : verdict.reason.replaceAll(path, "<path>"));
		}
		expect(new Set(reasons.values()).size, [...reasons].map(([name, reason]) => `${name}: ${reason}`).join("\n")).toBe(1);
		const said = reasons.values().next().value?.replaceAll(root, "<root>") ?? "";
		expect(said).toContain("outside the folders");
		expect(said).not.toMatch(/link|permission|credentials|no such|cannot|ENOENT|ENOTDIR|EACCES|EPERM|OUTSIDE_/i);
		expect(causes).toHaveLength(Object.keys(outsidePaths).length); // every one was logged for the operator
	});

	test("a missing file inside the root says so", async () => {
		const verdict = await fence().check(join(root, "sub", "gone.txt"));
		expect(verdict.ok ? "" : verdict.reason).toContain("no such file");
	});

	test("refuses relative paths and NUL bytes", async () => {
		expect(await fence().check("sub/note.txt")).toMatchObject({ ok: false });
		expect(await fence().check(`${join(root, "sub", "note.txt")}\0.png`)).toMatchObject({ ok: false });
	});

	test.skipIf(process.platform !== "win32")("accepts a different spelling of the same path on Windows", async () => {
		expect(await fence().check(join(root, "SUB", "NOTE.TXT"))).toMatchObject({ ok: true });
	});
});
