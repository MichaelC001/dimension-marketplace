import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathKey } from "../../src/library/paths";
import { createFence } from "../src/fence";

let base: string;
let root: string;
let outside: string;
let lent: Record<string, true>;

const index = { isLent: (path: string) => Object.hasOwn(lent, pathKey(path)) };

beforeAll(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "fence-index-")));
	root = join(base, "root");
	outside = join(base, "outside");
	await mkdir(root, { recursive: true });
	await mkdir(join(outside, "folder"), { recursive: true });
	await mkdir(join(outside, ".ssh"), { recursive: true });
	await writeFile(join(outside, "made.mp4"), "video");
	await writeFile(join(outside, "other.mp4"), "video");
	await writeFile(join(outside, ".env"), "TOKEN=1");
	await writeFile(join(outside, ".ssh", "config"), "Host x");
	lent = {};
});

afterAll(() => rm(base, { recursive: true, force: true }));

describe("indexed files through the fence", () => {
	test("an indexed file outside the roots opens, exactly that file and only as a regular file", async () => {
		const fence = createFence({ home: base, env: { VIEWER_ROOTS: root }, indexed: index });
		const made = join(outside, "made.mp4");
		expect((await fence.check(made)).ok).toBe(false);

		lent[pathKey(made)] = true;
		expect(await fence.check(made)).toEqual({ ok: true, real: made });
		expect((await fence.check(join(outside, "other.mp4"))).ok).toBe(false);
		expect((await fence.check(outside)).ok).toBe(false);

		lent[pathKey(join(outside, "folder"))] = true;
		expect((await fence.check(join(outside, "folder"))).ok).toBe(false);
	});

	test("a secret is refused even when the index would lend it", async () => {
		const fence = createFence({ home: base, env: { VIEWER_ROOTS: root }, indexed: index });
		for (const secret of [join(outside, ".env"), join(outside, ".ssh", "config")]) {
			lent[pathKey(secret)] = true;
			const verdict = await fence.check(secret);
			expect(verdict.ok, secret).toBe(false);
			expect(verdict.ok ? "" : verdict.reason).toMatch(/refused to open/);
		}
	});

	test("a link to a lent file is judged by where it leads, and a link to a secret by what it is", async () => {
		const fence = createFence({ home: base, env: { VIEWER_ROOTS: root }, indexed: index });
		const link = join(root, "pointer.mp4");
		const secretLink = join(root, "pointer.txt");
		const linked = await symlink(join(outside, "made.mp4"), link, "file").then(
			() => true,
			() => false,
		);
		if (!linked) return;
		await symlink(join(outside, ".env"), secretLink, "file");
		expect(await fence.check(link)).toEqual({ ok: true, real: join(outside, "made.mp4") });
		const verdict = await fence.check(secretLink);
		expect(verdict.ok).toBe(false);
	});

	test("without an index nothing changes: the file stays outside", async () => {
		const fence = createFence({ home: base, env: { VIEWER_ROOTS: root } });
		expect((await fence.check(join(outside, "made.mp4"))).ok).toBe(false);
	});
});
