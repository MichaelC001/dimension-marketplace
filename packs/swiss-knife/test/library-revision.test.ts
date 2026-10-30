import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLibrary } from "../src/library/library";
import type { CommentRow, Library, ShareRow } from "../src/library/types";
import { makeTempDir } from "./fixtures";

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
