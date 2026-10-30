import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLibrary } from "../src/library/library";
import { isOwnWrite } from "../src/library/revision";
import type { CommentRow, Library, ShareRow } from "../src/library/types";
import { makeTempDir, TINY_PNG } from "./fixtures";

let root: string;
let clock: number;
let libraries: Library[];

async function openLibrary(): Promise<Library> {
	const library = await createLibrary({
		home: join(root, "home"),
		now: () => clock,
		revokeRemote: async () => undefined,
		trash: async () => undefined,
	});
	libraries.push(library);
	return library;
}

async function put(name: string): Promise<string> {
	const path = join(root, "files", name);
	await mkdir(join(root, "files"), { recursive: true });
	await writeFile(path, `# ${name}`);
	const at = new Date(clock - 60_000);
	await utimes(path, at, at);
	return path;
}

function shareFor(artifactId: string): ShareRow {
	return {
		id: `share-${artifactId}`,
		artifactId,
		host: "p2p",
		remoteId: `remote-${artifactId}`,
		baseUrl: "https://relay.example/p/tunnel",
		key: "k".repeat(43),
		ownerToken: "owner",
		audience: { kind: "link" },
		version: 1,
		versionAt: clock,
		allowComments: true,
		createdAt: clock,
	};
}

function commentOn(artifactId: string, id: string): CommentRow {
	return { id, shareId: `share-${artifactId}`, author: "Ana", body: `body ${id}`, version: 1, createdAt: clock };
}

beforeEach(async () => {
	root = await makeTempDir();
	clock = Date.now();
	libraries = [];
});

afterEach(async () => {
	for (const library of libraries) library.close();
	await rm(root, { recursive: true, force: true });
});

describe("the library's change marker", () => {
	test("a comment ingested on this connection moves it, and reading the library never does", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("deck.md"), source: "present" });
		library.shares.insert(shareFor(item.id));
		const beforeComment = library.revision();

		library.query({});
		library.facets({});
		library.get(item.id);
		library.comments.forArtifact(item.id);
		expect(library.revision()).toBe(beforeComment);

		expect(library.comments.upsert(commentOn(item.id, "c1"))).toBe(true);
		const afterComment = library.revision();
		expect(afterComment).not.toBe(beforeComment);

		expect(library.comments.upsert(commentOn(item.id, "c1"))).toBe(false);
		expect(library.revision()).toBe(afterComment);
	});

	test("a comment committed by another connection to the same library.db moves it, as another process's sync would", async () => {
		const viewer = await openLibrary();
		const item = await viewer.stamp({ path: await put("deck.md"), source: "present" });
		viewer.shares.insert(shareFor(item.id));
		const sync = await openLibrary();
		const before = viewer.revision();
		expect(viewer.revision()).toBe(before);

		expect(sync.comments.upsert(commentOn(item.id, "c1"))).toBe(true);

		expect(viewer.revision()).not.toBe(before);
		expect(viewer.get(item.id)?.shares[0]).toMatchObject({ comments: 1, unread: 1 });
	});

	test("what this connection remembered about the library is dropped when another connection adds a file", async () => {
		const viewer = await openLibrary();
		await viewer.stamp({ path: await put("first.md"), source: "present" });
		expect(viewer.query({}).total).toBe(1);
		expect(viewer.facets({}).kinds.markdown).toBe(1);

		const other = await openLibrary();
		await other.stamp({ path: await put("second.md"), source: "present" });

		expect(viewer.query({}).total).toBe(2);
		expect(viewer.facets({}).kinds.markdown).toBe(2);
	});
});

describe("the span a write is witnessed across", () => {
	test("it runs from the marker read before the write to the one read after, and is the caller's own", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("deck.md"), source: "present" });
		const before = library.revision();

		const { value, span } = library.witnessed(() => library.update(item.id, { starred: true }));

		expect(value.starred).toBe(true);
		expect(span.before).toBe(before);
		expect(span.after).toBe(library.revision());
		expect(span.after).not.toBe(before);
		expect(isOwnWrite(span, before)).toBe(true);
	});

	test("a commit by another connection while the write runs makes the span foreign, so it is not the caller's own", async () => {
		const viewer = await openLibrary();
		const item = await viewer.stamp({ path: await put("deck.md"), source: "present" });
		viewer.shares.insert(shareFor(item.id));
		const sync = await openLibrary();

		const { span } = viewer.witnessed(() => {
			viewer.update(item.id, { starred: true });
			sync.comments.upsert(commentOn(item.id, "c1"));
		});

		expect(span.after).not.toBe(span.before);
		expect(isOwnWrite(span, span.before)).toBe(false);
	});

	test("a write is not recognised against a marker that predates a comment this connection ingested, though no other connection wrote", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("deck.md"), source: "present" });
		library.shares.insert(shareFor(item.id));
		const last = library.revision();
		expect(library.comments.upsert(commentOn(item.id, "c1"))).toBe(true);

		const { span } = library.witnessed(() => library.update(item.id, { starred: true }));

		expect(span.before).not.toBe(last);
		expect(isOwnWrite(span, last)).toBe(false);
		expect(isOwnWrite(span, span.before)).toBe(true);
	});

	test("a thumbnail's span brackets its row update and is the caller's own", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("clip.png"), source: "present" });
		const before = library.revision();

		const span = await library.setThumb(item.id, TINY_PNG, "image/png");

		expect(span.before).toBe(before);
		expect(span.after).toBe(library.revision());
		expect(span.after).not.toBe(before);
		expect(isOwnWrite(span, before)).toBe(true);
		expect(library.get(item.id)?.hasThumb).toBe(true);
	});

	test("a discarded artifact is refused a thumbnail rather than given a span", async () => {
		const library = await openLibrary();
		const item = await library.stamp({ path: await put("clip.png"), source: "present" });
		await library.discard(item.id, { trash: false });

		await expect(library.setThumb(item.id, TINY_PNG, "image/png")).rejects.toThrow(/keeps no thumbnail/);
		expect(library.get(item.id)?.hasThumb).toBe(false);
	});
});
