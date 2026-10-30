import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibrary } from "../../src/library";
import { removeTree, TINY_PNG } from "../../test/fixtures";
import { TAB_META_KEY, VIEWER_VIEW_URI } from "../src/contract";
import { createViewerServer } from "../src/server";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(16)]);

let base: string;
let allowed: string;
let outside: string;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
	return client.callTool({ name, arguments: args });
}

function structured(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
	if (result.isError === true) throw new Error(JSON.stringify(result.content));
	const content: unknown = result.structuredContent;
	if (typeof content !== "object" || content === null) throw new Error("no structured content");
	return Object.fromEntries(Object.entries(content));
}

function itemOf(result: Awaited<ReturnType<typeof call>>): { id: string; state: string; path: string } {
	const item = structured(result).item;
	if (typeof item !== "object" || item === null || !("id" in item) || !("state" in item) || !("path" in item)) throw new Error("no item");
	return { id: String(item.id), state: String(item.state), path: String(item.path) };
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
	const [block] = Array.isArray(result.content) ? result.content : [];
	return typeof block === "object" && block !== null && "text" in block ? String(block.text) : "";
}

beforeAll(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "viewer-library-")));
	allowed = join(base, "allowed");
	outside = join(base, "outside");
	const view = join(base, "view");
	await mkdir(allowed, { recursive: true });
	await mkdir(outside, { recursive: true });
	await mkdir(view, { recursive: true });
	await writeFile(join(view, "index.html"), "<!doctype html><title>viewer</title>");
	await writeFile(join(outside, "clip.mp4"), MP4);
	await writeFile(join(outside, "hero.png"), TINY_PNG);
	await writeFile(join(outside, ".env"), "TOKEN=SECRET_VALUE_123");
	const server = await createViewerServer({ viewDir: view, home: base, env: { VIEWER_ROOTS: allowed } });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
	await client.close();
	await removeTree(base);
});

describe("the tools the host and the View see", () => {
	test("open_library is the dock launcher target with the View attached; every other library tool is app-only", async () => {
		const { tools } = await client.listTools();
		const open = tools.find(tool => tool.name === "open_library");
		expect(open?._meta).toMatchObject({ ui: { resourceUri: VIEWER_VIEW_URI } });
		const libraryTools = tools.filter(tool => tool.name.startsWith("library_"));
		expect(libraryTools.map(tool => tool.name).sort()).toEqual([
			"library_check",
			"library_discard",
			"library_discard_default",
			"library_facets",
			"library_open",
			"library_query",
			"library_restore",
			"library_revision",
			"library_set_thumb",
			"library_stamp",
			"library_thumbs",
			"library_update",
		]);
		for (const tool of libraryTools) expect(tool._meta, tool.name).toMatchObject({ ui: { visibility: ["app"] } });
	});

	test("open_library answers with the library mode and the tab key the host folds into the tab identity", async () => {
		const bare = await call("open_library");
		expect(structured(bare)).toEqual({ mode: "library" });
		expect(bare._meta).toEqual({ [TAB_META_KEY]: { key: "library" } });
		expect(structured(await call("open_library", { workspace: allowed, query: "clip" }))).toEqual({ mode: "library", workspace: allowed, query: "clip" });
	});
});

describe("an indexed artifact is one lent file", () => {
	test("a file outside the roots opens only while it is in the library", async () => {
		const clip = join(outside, "clip.mp4");
		const refused = await call("view_file", { path: clip });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("outside the folders the viewer may open");

		const added = itemOf(await call("library_stamp", { path: clip }));
		expect(added).toMatchObject({ state: "live", path: clip });
		const opened = await call("view_file", { path: clip });
		expect(opened.isError).not.toBe(true);
		expect(structured(opened)).toMatchObject({ path: clip, kind: "video" });
		expect((await call("read_file_chunk", { path: clip, offset: 0, length: 8 })).isError).not.toBe(true);

		await call("library_discard", { id: added.id, trash: false });
		const afterDiscard = await call("view_file", { path: clip });
		expect(afterDiscard.isError).toBe(true);
		expect((await call("read_file_chunk", { path: clip, offset: 0, length: 8 })).isError).toBe(true);

		await call("library_restore", { id: added.id });
		expect((await call("view_file", { path: clip })).isError).not.toBe(true);
	});

	test("a secret is refused for adding, and a neighbouring file stays unlent", async () => {
		const refused = await call("library_stamp", { path: join(outside, ".env") });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("environment file");
		expect(textOf(refused)).not.toContain("SECRET_VALUE_123");
		const sibling = await call("view_file", { path: join(outside, "hero.png") });
		expect(sibling.isError).toBe(true);
	});

	test("library_open is exactly view_file's answer and records the open", async () => {
		const hero = join(outside, "hero.png");
		const added = itemOf(await call("library_stamp", { path: hero }));
		const viaFile = await call("view_file", { path: hero });
		const viaLibrary = await call("library_open", { id: added.id });
		expect(viaLibrary.isError).not.toBe(true);
		expect(viaLibrary.structuredContent).toEqual(viaFile.structuredContent);
		expect(viaLibrary.content).toEqual(viaFile.content);
		expect(viaLibrary._meta).toEqual(viaFile._meta);

		const queried = structured(await call("library_query", { q: "hero" }));
		expect(queried.total).toBe(1);
		expect(JSON.stringify(queried.items)).toContain('"openedAt"');
		expect((await call("library_open", { id: "nope" })).isError).toBe(true);
	});
});

describe("thumbnails over the loopback origin", () => {
	test("a saved thumbnail is served under the capability with a day of private caching, and nowhere else", async () => {
		const added = itemOf(await call("library_stamp", { path: join(outside, "hero.png") }));
		const { base: thumbBase } = structured(await call("library_thumbs"));
		if (typeof thumbBase !== "string") throw new Error("library_thumbs gave no base");
		expect((await fetch(`${thumbBase}/${added.id}`)).status).toBe(404);

		await call("library_set_thumb", { id: added.id, data: TINY_PNG.toString("base64"), mime: "image/png" });
		const served = await fetch(`${thumbBase}/${added.id}?v=123`);
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(served.headers.get("cache-control")).toBe("private, max-age=86400");
		expect(served.headers.get("access-control-allow-origin")).toBe("*");
		expect(Buffer.from(await served.arrayBuffer()).equals(TINY_PNG)).toBe(true);

		const stranger = thumbBase.replace(/[a-f0-9]{48}$/, "0".repeat(48));
		expect((await fetch(`${stranger}/${added.id}`)).status).toBe(404);
		expect((await fetch(`${thumbBase}/${"A".repeat(20)}`)).status).toBe(404);
		expect((await fetch(`${thumbBase}/${added.id}`, { method: "POST" })).status).toBe(405);

		await call("library_discard", { id: added.id, trash: false });
		expect((await fetch(`${thumbBase}/${added.id}`)).status).toBe(404);
	});

	test("a thumbnail that is not the image it claims is refused", async () => {
		const added = itemOf(await call("library_stamp", { path: join(outside, "clip.mp4") }));
		const refused = await call("library_set_thumb", { id: added.id, data: Buffer.from("not a png").toString("base64"), mime: "image/png" });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("not image/png");
	});
});

describe("the revision the open View polls", () => {
	test("it moves after a write through the tools and after a write on another connection, and holds still for reads", async () => {
		const revision = async (): Promise<string> => String(structured(await call("library_revision")).revision);
		const note = join(outside, "note.md");
		const other = join(outside, "other.md");
		await writeFile(note, "# note");
		await writeFile(other, "# other");
		const second = await createLibrary({ home: join(base, ".inso") });
		try {
			const start = await revision();
			expect(await revision()).toBe(start);
			await call("library_query", {});
			await call("library_facets", {});
			expect(await revision()).toBe(start);

			const added = itemOf(await call("library_stamp", { path: note }));
			const afterStamp = await revision();
			expect(afterStamp).not.toBe(start);

			await call("library_update", { id: added.id, starred: true });
			const afterUpdate = await revision();
			expect(afterUpdate).not.toBe(afterStamp);

			await second.stamp({ path: other, source: "human" });
			expect(await revision()).not.toBe(afterUpdate);
		} finally {
			second.close();
		}
	});
});
