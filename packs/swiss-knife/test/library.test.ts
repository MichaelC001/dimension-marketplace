import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLibrary, type LibraryOptions } from "../src/library/library";
import { pathKey } from "../src/library/paths";
import type { Library, LibraryQuery, ShareRow } from "../src/library/types";
import { TINY_PNG, makeTempDir } from "./fixtures";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const DAY = 24 * 60 * 60 * 1000;

let root: string;
let clock: number;
let libraries: Library[];
let revoked: ShareRow[];
let trashed: string[];

async function openLibrary(overrides: Partial<LibraryOptions> = {}): Promise<Library> {
	const library = await createLibrary({
		home: join(root, "home"),
		now: () => clock,
		revokeRemote: async share => {
			revoked.push(share);
		},
		trash: async path => {
			trashed.push(path);
		},
		...overrides,
	});
	libraries.push(library);
	return library;
}

async function put(name: string, content: string | Buffer = name, ageMs = 60_000): Promise<string> {
	const path = join(root, "files", name);
	await mkdir(join(root, "files"), { recursive: true });
	await writeFile(path, content);
	const at = new Date(clock - ageMs);
	await utimes(path, at, at);
	return path;
}

function shareFor(artifactId: string, id = `share-${artifactId}`): ShareRow {
	return {
		id,
		artifactId,
		host: "p2p",
		remoteId: `remote-${id}`,
		baseUrl: "https://relay.example/p/tunnel",
		key: "k".repeat(43),
		ownerToken: "owner",
		audience: { kind: "link" },
		version: 1,
		allowComments: true,
		createdAt: clock,
	};
}

function allIds(library: Library, query: LibraryQuery = {}): string[] {
	return library.query({ ...query, limit: 200 }).items.map(item => item.id);
}

function pagedIds(library: Library, query: LibraryQuery, limit: number): string[] {
	const ids: string[] = [];
	let cursor: string | undefined;
	for (let pages = 0; pages < 100; pages++) {
		const page = library.query({ ...query, limit, ...(cursor === undefined ? {} : { cursor }) });
		ids.push(...page.items.map(item => item.id));
		if (page.next === undefined) return ids;
		cursor = page.next;
	}
	throw new Error("paging did not end");
}

beforeEach(async () => {
	root = await makeTempDir();
	clock = Date.now();
	libraries = [];
	revoked = [];
	trashed = [];
});

afterEach(async () => {
	for (const library of libraries) library.close();
	await rm(root, { recursive: true, force: true });
});

describe("stamping", () => {
	test("one file is one row: a re-stamp refreshes facts and recency and keeps the first source", async () => {
		const library = await openLibrary();
		const file = await put("report.md", "# one");
		const first = await library.stamp({ path: file, source: "present", workspace: join(root, "ws") });
		expect(first).toMatchObject({ name: "report.md", kind: "markdown", size: 5, state: "live", source: "present", hasThumb: false, shares: [] });

		clock += 5_000;
		await writeFile(file, "# version two");
		const second = await library.stamp({ path: file, source: "stamp", title: "  Quarterly report  ", tags: ["Finance", "finance", " q3 "] });
		expect(second.id).toBe(first.id);
		expect(second).toMatchObject({ size: 13, title: "Quarterly report", tags: ["Finance", "q3"], source: "present", workspace: join(root, "ws") });
		expect(second.presentedAt).toBe(clock);
		expect(library.query({}).total).toBe(1);
	});

	test("a file that went missing shows as missing and a re-present revives it", async () => {
		const library = await openLibrary();
		const file = await put("clip.mp4", MP4);
		const { id } = await library.stamp({ path: file, source: "present" });
		await rm(file);
		expect(await library.check([id])).toEqual([expect.objectContaining({ id, state: "missing" })]);
		expect(library.query({}).items[0]?.state).toBe("missing");
		expect(library.isLent(file)).toBe(true);

		await put("clip.mp4", MP4);
		expect((await library.stamp({ path: file, source: "present" })).state).toBe("live");
	});

	test("a discarded file stays out when re-presented unchanged, and returns when it was made again or a human adds it", async () => {
		const library = await openLibrary();
		const file = await put("deck.pptx", "deck");
		const { id } = await library.stamp({ path: file, source: "present" });
		clock += 10_000;
		await library.discard(id, { trash: false });

		clock += 10_000;
		expect((await library.stamp({ path: file, source: "present" })).state).toBe("discarded");
		expect(library.isLent(file)).toBe(false);
		expect(library.query({}).total).toBe(0);

		clock += 10_000;
		await utimes(file, new Date(clock), new Date(clock));
		expect((await library.stamp({ path: file, source: "present" })).state).toBe("live");

		await library.discard(id, { trash: false });
		clock += 10_000;
		expect((await library.stamp({ path: file, source: "human" })).state).toBe("live");
	});

	test("secrets and non-files are refused and never indexed", async () => {
		const library = await openLibrary();
		const env = await put(".env", "TOKEN=1");
		await mkdir(join(root, ".ssh"), { recursive: true });
		await writeFile(join(root, ".ssh", "notes.txt"), "x");
		await put("id_rsa", "key");
		const refused: readonly [string, RegExp][] = [
			[env, /environment file/],
			[join(root, ".ssh", "notes.txt"), /credentials folder/],
			[join(root, "files", "id_rsa"), /private key/],
			[join(root, "files"), /not a regular file/],
			[join(root, "files", "absent.txt"), /no such file/],
			["relative.txt", /not an absolute path/],
		];
		for (const [path, reason] of refused) {
			await expect(library.stamp({ path, source: "stamp" })).rejects.toThrow(reason);
		}
		expect(library.query({}).total).toBe(0);
	});

	test("a link into a secret is refused for what it resolves to", async () => {
		const library = await openLibrary();
		const secret = await put(".env", "TOKEN=1");
		const link = join(root, "files", "harmless.txt");
		const linked = await symlink(secret, link).then(
			() => true,
			() => false,
		);
		if (!linked) return;
		await expect(library.stamp({ path: link, source: "stamp" })).rejects.toThrow(/protected location|environment file/);
		expect(library.query({}).total).toBe(0);
	});

	test("path keys fold case on Windows and macOS and slashes on Windows only", () => {
		expect(pathKey("C:\\Users\\Me\\Clip.MP4", "win32")).toBe("c:/users/me/clip.mp4");
		expect(pathKey("/Users/Me/Clip.MP4", "darwin")).toBe("/users/me/clip.mp4");
		expect(pathKey("/home/me/Clip.MP4", "linux")).toBe("/home/me/Clip.MP4");
		expect(pathKey("/home/me/a\\b", "linux")).toBe("/home/me/a\\b");
	});
});

describe("search", () => {
	async function seed(library: Library): Promise<Record<string, string>> {
		const ids: Record<string, string> = {};
		const files: readonly [string, string | Buffer, string][] = [
			["16-locomotion-slice.mp4", MP4, "alpha"],
			["16-locomotion-intro.mp4", MP4, "alpha"],
			["Locomotion Spec.md", "# spec", "beta"],
			["quarterly-report.pdf", "%PDF-1.7", "beta"],
			["notes.txt", "notes", "alpha"],
			["ab.txt", "ab", "alpha"],
		];
		for (const [name, content, workspace] of files) {
			clock += 1_000;
			ids[name] = (await library.stamp({ path: await put(name, content), source: "present", workspace: join(root, workspace) })).id;
		}
		return ids;
	}

	test("a substring of 3 or more characters finds a name in the middle, case-insensitively", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		expect(new Set(allIds(library, { q: "locom" }))).toEqual(new Set([ids["16-locomotion-slice.mp4"], ids["16-locomotion-intro.mp4"], ids["Locomotion Spec.md"]]));
		expect(allIds(library, { q: "LOCOMOTION-SLICE" })).toEqual([ids["16-locomotion-slice.mp4"]]);
		expect(allIds(library, { q: "locomotion slice" })).toEqual([ids["16-locomotion-slice.mp4"]]);
		expect(allIds(library, { q: "nothing-like-this" })).toEqual([]);
	});

	test("a query shorter than 3 characters is a name prefix, and a quote in the query is only text", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		expect(allIds(library, { q: "ab" })).toEqual([ids["ab.txt"]]);
		expect(allIds(library, { q: "no" })).toEqual([ids["notes.txt"]]);
		expect(allIds(library, { q: "lo" })).toEqual([ids["Locomotion Spec.md"]]);
		expect(allIds(library, { q: 'spec" OR "notes' })).toEqual([]);
	});

	test("title, note, tags and the folder name are searchable once set", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		library.update(ids["notes.txt"] as string, { title: "Standup minutes", tags: ["retro"] });
		expect(allIds(library, { q: "standup" })).toEqual([ids["notes.txt"]]);
		expect(allIds(library, { q: "retro" })).toEqual([ids["notes.txt"]]);
		expect(allIds(library, { q: "files" }).length).toBe(6);
		library.update(ids["notes.txt"] as string, { title: null });
		expect(allIds(library, { q: "standup" })).toEqual([]);
	});

	test("kind, workspace, starred and shared narrow the list and the facets count what is shown", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		library.update(ids["notes.txt"] as string, { starred: true });
		library.shares.insert(shareFor(ids["quarterly-report.pdf"] as string));

		expect(allIds(library, { kinds: ["video"] }).length).toBe(2);
		expect(allIds(library, { workspace: join(root, "beta") }).length).toBe(2);
		expect(allIds(library, { starred: true })).toEqual([ids["notes.txt"]]);
		expect(allIds(library, { shared: true })).toEqual([ids["quarterly-report.pdf"]]);
		expect(allIds(library, { q: "locom", kinds: ["video"], workspace: join(root, "alpha") }).length).toBe(2);

		expect(library.facets({})).toMatchObject({ kinds: { video: 2, markdown: 1, pdf: 1, text: 2 }, starred: 1, shared: 1, discarded: 0 });
		expect(library.facets({ workspace: join(root, "beta") })).toMatchObject({ kinds: { markdown: 1, pdf: 1 }, starred: 0, shared: 1 });
		expect(library.facets({}).workspaces).toEqual([
			{ path: join(root, "alpha"), count: 4 },
			{ path: join(root, "beta"), count: 2 },
		]);
	});

	test("totals and facets are never stale: a write here or from another process shows on the next ask", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		const before = library.query({}).total;
		expect(library.facets({}).starred).toBe(0);

		library.update(ids["notes.txt"] as string, { starred: true });
		expect(library.facets({}).starred).toBe(1);
		await library.discard(ids["notes.txt"] as string, { trash: false });
		expect(library.query({}).total).toBe(before - 1);
		expect(library.facets({}).discarded).toBe(1);

		const other = await openLibrary();
		await other.stamp({ path: await put("late.txt"), source: "present" });
		expect(library.query({}).total).toBe(before);
		expect(library.facets({}).kinds.text).toBe(2);

		clock += 2 * 60_000;
		library.shares.insert(shareFor(ids["quarterly-report.pdf"] as string));
		expect(library.query({ shared: true }).total).toBe(1);
		expect(library.facets({}).shared).toBe(1);
	});

	test("a revoked or expired share does not make an artifact shared", async () => {
		const library = await openLibrary();
		const ids = await seed(library);
		const pdf = ids["quarterly-report.pdf"] as string;
		library.shares.insert(shareFor(pdf, "revoked"));
		library.shares.update("revoked", { revokedAt: clock });
		library.shares.insert({ ...shareFor(pdf, "expired"), expiresAt: clock - 1 });
		expect(allIds(library, { shared: true })).toEqual([]);
		expect(library.facets({}).shared).toBe(0);
	});

	test("keyset pages cover every row exactly once, in the same order as one big page, for every sort and with ties", async () => {
		const library = await openLibrary();
		const tied = clock;
		for (let index = 0; index < 23; index++) {
			clock = tied;
			const id = (await library.stamp({ path: await put(`item-${String(index).padStart(2, "0")}.txt`, "x".repeat(index % 4)), source: "present" })).id;
			if (index % 3 === 0) {
				clock = tied + index * 1_000;
				library.markOpened(id);
			}
		}
		clock = tied + 1_000_000;
		for (const sort of ["recent", "name", "size", "opened"] as const) {
			const whole = allIds(library, { sort });
			expect(whole.length).toBe(23);
			expect(new Set(whole).size).toBe(23);
			for (const limit of [1, 4, 7, 23]) expect(pagedIds(library, { sort }, limit)).toEqual(whole);
		}
		const searched = { q: "item-", sort: "relevance" } as const;
		const whole = allIds(library, searched);
		expect(whole.length).toBe(23);
		for (const limit of [3, 10]) expect(pagedIds(library, searched, limit)).toEqual(whole);
		expect(library.query({ sort: "opened", limit: 5 }).total).toBe(23);
	});

	test("a cursor from another query is refused", async () => {
		const library = await openLibrary();
		await library.stamp({ path: await put("a.txt"), source: "present" });
		await library.stamp({ path: await put("b.txt"), source: "present" });
		const cursor = library.query({ sort: "name", limit: 1 }).next;
		expect(cursor).toBeDefined();
		expect(() => library.query({ sort: "size", limit: 1, cursor: cursor as string })).toThrow(/cursor/);
		expect(() => library.query({ cursor: "not-a-cursor" })).toThrow(/cursor/);
	});
});

describe("discard and restore", () => {
	test("discard revokes live shares, drops the thumbnail and the row from every list, and restore brings it back", async () => {
		const library = await openLibrary();
		const file = await put("hero.png", TINY_PNG);
		const item = await library.stamp({ path: file, source: "present", thumb: { bytes: TINY_PNG, mime: "image/png" } });
		const thumb = library.thumbPath(item.id);
		expect(thumb).toBeDefined();
		expect((await stat(thumb as string)).isFile()).toBe(true);
		library.shares.insert(shareFor(item.id));

		clock += 1_000;
		const outcome = await library.discard(item.id, { trash: false });
		expect(outcome).toMatchObject({ trashed: false, revoked: 1, unrevoked: [], item: { state: "discarded", hasThumb: false } });
		expect(revoked.map(share => share.id)).toEqual([`share-${item.id}`]);
		expect(library.shares.get(`share-${item.id}`)?.revokedAt).toBe(clock);
		expect(library.thumbPath(item.id)).toBeUndefined();
		expect(await readdir(join(root, "home", "artifacts", "thumbs"))).toEqual([]);
		expect(allIds(library)).toEqual([]);
		expect(allIds(library, { q: "hero" })).toEqual([]);
		expect(allIds(library, { state: "discarded" })).toEqual([item.id]);
		expect(library.facets({})).toMatchObject({ discarded: 1 });
		expect(library.isLent(file)).toBe(false);
		expect((await stat(file)).isFile()).toBe(true);

		const restored = library.restore(item.id);
		expect(restored).toMatchObject({ state: "live" });
		expect(allIds(library, { q: "hero" })).toEqual([item.id]);
		expect(library.shares.get(`share-${item.id}`)?.revokedAt).toBeDefined();
	});

	test("a share the host would not revoke is still stopped here and reported", async () => {
		const library = await openLibrary({
			revokeRemote: async () => {
				throw new Error("the link could not be revoked: relay unreachable");
			},
		});
		const item = await library.stamp({ path: await put("page.html", "<p>x</p>"), source: "present" });
		library.shares.insert(shareFor(item.id));
		const outcome = await library.discard(item.id, { trash: false });
		expect(outcome.revoked).toBe(0);
		expect(outcome.unrevoked).toEqual([{ shareId: `share-${item.id}`, host: "p2p", reason: "the link could not be revoked: relay unreachable" }]);
		expect(library.shares.live()).toEqual([]);
	});

	test("trash moves the file out through the OS hook; a failed trash is reported and the file stays", async () => {
		const library = await openLibrary();
		const first = await put("one.txt");
		const second = await put("two.txt");
		const a = await library.stamp({ path: first, source: "present" });
		const b = await library.stamp({ path: second, source: "present" });

		expect(await library.discard(a.id, { trash: true })).toMatchObject({ trashed: true });
		expect(trashed).toEqual([first]);

		const failing = await openLibrary({
			trash: async () => {
				throw new Error("gio could not move the file to the trash");
			},
		});
		const outcome = await failing.discard(b.id, { trash: true });
		expect(outcome).toMatchObject({ trashed: false, trashError: "gio could not move the file to the trash", item: { state: "discarded" } });
		expect((await stat(second)).isFile()).toBe(true);
	});

	test("rows discarded more than 30 days ago are purged on the next open, with their shares", async () => {
		const library = await openLibrary();
		const old = await library.stamp({ path: await put("old.txt"), source: "present" });
		const recent = await library.stamp({ path: await put("recent.txt"), source: "present" });
		library.shares.insert(shareFor(old.id));
		await library.discard(old.id, { trash: false });
		clock += 20 * DAY;
		await library.discard(recent.id, { trash: false });
		library.close();

		clock += 11 * DAY;
		const reopened = await openLibrary();
		expect(reopened.get(old.id)).toBeUndefined();
		expect(reopened.shares.get(`share-${old.id}`)).toBeUndefined();
		expect(reopened.get(recent.id)?.state).toBe("discarded");
		expect(allIds(reopened, { q: "old" })).toEqual([]);
	});
});

describe("thumbnails", () => {
	test("a thumbnail must be the image it says and small; the cache keeps one file per artifact", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("clip.mp4", MP4), source: "present" });
		await expect(library.setThumb(item.id, Buffer.from("not an image"), "image/png")).rejects.toThrow(/not image\/png/);
		await expect(library.setThumb(item.id, new Uint8Array(0), "image/png")).rejects.toThrow(/bytes/);
		await library.setThumb(item.id, TINY_PNG, "image/png");
		const jpeg = Buffer.from(await new Bun.Image(TINY_PNG).jpeg().bytes());
		await library.setThumb(item.id, jpeg, "image/jpeg");
		expect(await readdir(join(root, "home", "artifacts", "thumbs"))).toEqual([`${item.id}.jpg`]);
		expect(library.thumbPath(item.id)).toBe(join(root, "home", "artifacts", "thumbs", `${item.id}.jpg`));
		expect(library.get(item.id)?.hasThumb).toBe(true);
	});
});

describe("shares and comments", () => {
	test("comments sync is idempotent, counts unread per share and marks read in one call", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("deck.pptx"), source: "present" });
		library.shares.insert(shareFor(item.id));
		const comment = (id: string, createdAt: number) => ({ id, shareId: `share-${item.id}`, author: "Ana", body: `body ${id}`, version: 1, createdAt, anchor: { kind: "time", startMs: 1500 } });
		expect(library.comments.upsert(comment("c1", 10))).toBe(true);
		expect(library.comments.upsert(comment("c1", 10))).toBe(false);
		expect(library.comments.upsert(comment("c2", 20))).toBe(true);

		expect(library.get(item.id)?.shares[0]).toMatchObject({ unread: 2, url: `https://relay.example/p/tunnel/a/remote-share-${item.id}`, audience: { kind: "link" } });
		const listed = library.comments.forArtifact(item.id);
		expect(listed.map(row => row.id)).toEqual(["c1", "c2"]);
		expect(listed[0]).toMatchObject({ anchor: { kind: "time", startMs: 1500 }, shareUrl: `https://relay.example/p/tunnel/a/remote-share-${item.id}` });

		library.comments.markRead(["c1"], 99);
		expect(library.comments.forArtifact(item.id, { unread: true }).map(row => row.id)).toEqual(["c2"]);
		expect(library.get(item.id)?.shares[0]?.unread).toBe(1);
	});
});
