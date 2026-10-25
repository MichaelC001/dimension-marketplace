import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stat, unlink, writeFile } from "node:fs/promises";
import {
	ASP_CHUNK_BYTES,
	chunkCount,
	encodeBase64Url,
	generateContentKey,
	importContentKey,
	openChunk,
	openManifest,
	sealChunk,
	sealedSize,
} from "@dimension/sdk/artifact-share";
import type { LibraryItem, ShareRow } from "../../src/library/types";
import { P2pServer } from "../src/share/p2p-server";
import { P2pStore } from "../src/share/p2p-store";
import { makeWorld, randomFile, type World } from "./share-fixtures";

const SIZE = 2 * ASP_CHUNK_BYTES + 4097;
const SHARE_ID = "p2pshare0123456789abcd";

let world: World;
let item: LibraryItem;
let content: Uint8Array;
let keyBytes: Uint8Array;
let store: P2pStore;
let server: P2pServer;

function shareRow(overrides: Partial<ShareRow> = {}): ShareRow {
	return {
		id: SHARE_ID,
		artifactId: item.id,
		host: "p2p",
		remoteId: SHARE_ID,
		baseUrl: "https://relay.example/p/tunnel",
		key: encodeBase64Url(keyBytes),
		ownerToken: "tunnel-token",
		audience: { kind: "link" },
		version: 1,
		allowComments: true,
		createdAt: world.clock.now,
		...overrides,
	};
}

async function publish(row: ShareRow): Promise<void> {
	const info = await stat(item.path);
	await server.create(row, item, { size: info.size, mtimeMs: info.mtimeMs });
	world.library.shares.insert(row);
}

async function get(path: string, headers: Record<string, string> = {}, id = SHARE_ID): Promise<Response> {
	return server.handle({ method: "GET", path: `/api/v1/shares/${id}${path}`, headers: new Headers(headers) });
}

async function bytesOf(response: Response): Promise<Uint8Array> {
	return new Uint8Array(await response.arrayBuffer());
}

function newServer(): P2pServer {
	return new P2pServer({ library: world.library, fence: world.fence, store, now: () => world.clock.now });
}

beforeEach(async () => {
	world = await makeWorld();
	content = randomFile(SIZE);
	item = await world.addFile("talk.bin", content);
	keyBytes = generateContentKey();
	store = new P2pStore(world.home);
	server = newServer();
});

afterEach(async () => {
	await world.cleanup();
});

describe("serving a share from this computer", () => {
	test("chunks are sealed on demand, identical to sealing them ahead, and the link key opens every one", async () => {
		await publish(shareRow());
		const meta = (await (await get("")).json()) as { latest: number; versions: { chunks: number; sealedBytes: number }[]; allowComments: boolean };
		expect(meta).toMatchObject({ latest: 1, allowComments: true, versions: [{ chunks: 3, sealedBytes: sealedSize(SIZE) }] });
		const key = await importContentKey(keyBytes);
		const { manifest, prefix } = await openManifest(key, await bytesOf(await get("/v/1/manifest")), 1);
		expect(manifest).toMatchObject({ name: "talk.bin", size: SIZE, chunks: chunkCount(SIZE), version: 1 });
		const opened: Uint8Array[] = [];
		for (let index = 0; index < manifest.chunks; index++) {
			const response = await get(`/v/1/chunks/${index}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
			const served = await bytesOf(response);
			const plain = content.subarray(index * ASP_CHUNK_BYTES, (index + 1) * ASP_CHUNK_BYTES);
			expect(served).toEqual(await sealChunk(key, prefix, 1, index, index === manifest.chunks - 1, plain));
			opened.push(await openChunk(key, prefix, 1, index, index === manifest.chunks - 1, served));
		}
		expect(Buffer.compare(Buffer.concat(opened), content)).toBe(0);
		const ranged = await get("/v/1/chunks/0", { range: "bytes=0-15" });
		expect(ranged.status).toBe(206);
		expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-15\/\d+$/);
		expect((await bytesOf(ranged)).length).toBe(16);
		expect((await get("/v/1/chunks/3")).status).toBe(404);
		expect((await get("/v/2/manifest")).status).toBe(404);
	});

	test("a changed file becomes a new version with a new prefix, persisted: the old one is gone and a restart serves identical bytes", async () => {
		await publish(shareRow());
		const key = await importContentKey(keyBytes);
		const before = await openManifest(key, await bytesOf(await get("/v/1/manifest")), 1);
		const edited = randomFile(ASP_CHUNK_BYTES + 11);
		await writeFile(item.path, edited);
		expect((await get("/v/1/manifest")).status).toBe(404);
		expect(world.library.shares.get(SHARE_ID)?.version).toBe(2);
		const sealed = await bytesOf(await get("/v/2/manifest"));
		const after = await openManifest(key, sealed, 2);
		expect(after.manifest.size).toBe(edited.length);
		expect(after.prefix).not.toEqual(before.prefix);
		const chunk = await bytesOf(await get("/v/2/chunks/1"));
		expect(await openChunk(key, after.prefix, 2, 1, true, chunk)).toEqual(edited.subarray(ASP_CHUNK_BYTES));
		server = newServer();
		expect(await bytesOf(await get("/v/2/manifest"))).toEqual(sealed);
		expect(await bytesOf(await get("/v/2/chunks/1"))).toEqual(chunk);
		expect(world.library.shares.get(SHARE_ID)?.version).toBe(2);
	});

	test("a revoked, expired or discarded share, and one whose file is gone, stops answering at once", async () => {
		await publish(shareRow());
		expect((await get("/v/1/chunks/0")).status).toBe(200);
		world.library.shares.update(SHARE_ID, { revokedAt: world.clock.now });
		const revoked = await get("/v/1/chunks/0");
		expect(revoked.status).toBe(410);
		expect(await revoked.json()).toMatchObject({ error: "revoked" });
		const expiring = "p2pexpired012345678901";
		await server.create(shareRow({ id: expiring, remoteId: expiring }), item, { size: SIZE, mtimeMs: (await stat(item.path)).mtimeMs });
		world.library.shares.insert(shareRow({ id: expiring, remoteId: expiring, expiresAt: world.clock.now + 1000 }));
		expect((await get("/v/1/manifest", {}, expiring)).status).toBe(200);
		world.clock.now += 2000;
		expect(await (await get("/v/1/manifest", {}, expiring)).json()).toMatchObject({ error: "expired" });
		expect((await get("", {}, "nosuchshare0123456789")).status).toBe(404);
	});

	test("discarding the artifact and deleting the file are both refused", async () => {
		const other = await world.addFile("other.bin", randomFile(1024));
		const shared = "p2pdiscard012345678901";
		const info = await stat(other.path);
		const row = shareRow({ id: shared, remoteId: shared, artifactId: other.id });
		await server.create(row, other, { size: info.size, mtimeMs: info.mtimeMs });
		world.library.shares.insert(row);
		expect((await get("/v/1/chunks/0", {}, shared)).status).toBe(200);
		await world.library.discard(other.id, { trash: false });
		expect((await get("/v/1/chunks/0", {}, shared)).status).toBe(410);
		await publish(shareRow());
		await unlink(item.path);
		expect((await get("/v/1/chunks/0")).status).toBe(404);
	});
});
