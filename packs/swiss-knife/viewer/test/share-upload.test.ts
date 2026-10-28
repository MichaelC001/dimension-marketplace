import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import {
	ASP_CHUNK_BYTES,
	decodeBase64Url,
	deriveCommentKey,
	importContentKey,
	openChunk,
	openComment,
	openManifest,
	parseShareLink,
	type SharePolicy,
} from "@dimension/sdk/artifact-share";
import type { LibraryItem } from "../../src/library/types";
import { type ShareRuntime, startShareRuntime } from "../src/share";
import { UPLOAD_CONCURRENCY } from "../src/share/upload";
import { FakeHost, makeWorld, randomFile, type World } from "./share-fixtures";

const SIZE = 5 * ASP_CHUNK_BYTES + 123;
const FIRST_SHARE = "fake000000000001";

let world: World;
let host: FakeHost;
let runtime: ShareRuntime;
let item: LibraryItem;
let content: Uint8Array;

async function configure(policy: Partial<SharePolicy>, oidc = false, parkUntil?: number): Promise<void> {
	host.stop();
	host = FakeHost.start({ uploadToken: "up-token", policy, oidc, ...(parkUntil === undefined ? {} : { parkUntil }) });
	await world.writeHosts({ hosts: [{ id: "h1", kind: "self", name: "Fake host", baseUrl: host.baseUrl, token: "up-token" }] });
}

async function openAll(shareId: string, version: number, key: Uint8Array): Promise<Uint8Array> {
	const share = host.shares.get(shareId);
	if (share === undefined) throw new Error("the host never saw the share");
	const stored = share.versions.get(version);
	if (stored?.manifest === undefined) throw new Error("the host has no manifest");
	const cryptoKey = await importContentKey(key);
	const { manifest, prefix } = await openManifest(cryptoKey, stored.manifest, version);
	const parts: Uint8Array[] = [];
	for (let index = 0; index < manifest.chunks; index++) {
		const sealed = stored.chunks.get(index);
		if (sealed === undefined) throw new Error(`chunk ${index} was never uploaded`);
		parts.push(await openChunk(cryptoKey, prefix, version, index, index === manifest.chunks - 1, sealed));
	}
	return Buffer.concat(parts);
}

beforeEach(async () => {
	world = await makeWorld();
	host = FakeHost.start({ uploadToken: "up-token" });
	await world.writeHosts({ hosts: [{ id: "h1", kind: "self", name: "Fake host", baseUrl: host.baseUrl, token: "up-token" }] });
	content = randomFile(SIZE);
	item = await world.addFile("clip.bin", content);
	runtime = startShareRuntime({
		library: world.library,
		fence: world.fence,
		home: world.home,
		retry: { attempts: 2, baseMs: 1, maxMs: 2 },
		log: () => undefined,
	});
});

afterEach(async () => {
	await runtime.close();
	host.stop();
	await world.cleanup();
});

const link = { kind: "link" } as const;

describe("uploading a file to a host", () => {
	test("seals chunk by chunk, keeps at most four in flight, and the link opens the exact file", async () => {
		await configure({}, false, UPLOAD_CONCURRENCY);
		const created = await runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: true });
		const parsed = parseShareLink(created.link);
		expect(parsed?.base).toBe(host.baseUrl);
		expect(host.maxConcurrent).toBe(UPLOAD_CONCURRENCY);
		const remote = parsed?.id ?? "";
		expect(host.shares.get(remote)?.versions.get(1)?.committed).toBe(true);
		expect(Buffer.compare(await openAll(remote, 1, parsed?.key ?? new Uint8Array()), content)).toBe(0);
		const row = world.library.shares.get(created.id);
		expect(row).toMatchObject({ host: "h1", remoteId: remote, ownerToken: `owner-${remote}`, version: 1, allowComments: true });
		expect(decodeBase64Url(row?.key ?? "")).toEqual(parsed?.key ?? new Uint8Array());
		expect(runtime.service.progress(item.id)).toMatchObject({ phase: "done", shareId: created.id });
	});

	test("after a failure it resumes: nothing already stored is sent again and no second share is made", async () => {
		host.failures.set(`${FIRST_SHARE}:1:3`, { remaining: 100, status: 503 });
		await expect(runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: false })).rejects.toThrow("the server is busy");
		expect(runtime.service.progress(item.id).phase).toBe("failed");
		expect(world.library.shares.live()).toHaveLength(0);
		host.failures.clear();
		const created = await runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: false });
		expect(host.creates).toBe(1);
		const stored = [...host.chunkStored.entries()].filter(([key]) => key.startsWith(`${FIRST_SHARE}:1:`));
		expect(stored).toHaveLength(6);
		expect(stored.every(([, count]) => count === 1)).toBe(true);
		const parsed = parseShareLink(created.link);
		expect(Buffer.compare(await openAll(FIRST_SHARE, 1, parsed?.key ?? new Uint8Array()), content)).toBe(0);
	});

	test("a newer version keeps the key, changes the prefix and carries the new bytes", async () => {
		const created = await runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: true });
		const parsed = parseShareLink(created.link);
		const key = parsed?.key ?? new Uint8Array();
		const edited = randomFile(2 * ASP_CHUNK_BYTES + 7);
		await writeFile(item.path, edited);
		const updated = await runtime.service.newVersion(created.id);
		expect(updated.version).toBe(2);
		expect(world.library.shares.get(created.id)?.version).toBe(2);
		expect(Buffer.compare(await openAll(FIRST_SHARE, 2, key), edited)).toBe(0);
		const stored = host.shares.get(FIRST_SHARE);
		const cryptoKey = await importContentKey(key);
		const first = (await openManifest(cryptoKey, stored?.versions.get(1)?.manifest ?? new Uint8Array(), 1)).prefix;
		const second = (await openManifest(cryptoKey, stored?.versions.get(2)?.manifest ?? new Uint8Array(), 2)).prefix;
		expect(second).not.toEqual(first);
	});

	test("refuses what the host's policy forbids, with its reason, before anything is created", async () => {
		await configure({ publicLinks: false, signinRequired: true });
		await expect(runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: true })).rejects.toThrow("only allows shares that require signing in");
		await expect(runtime.service.create({ artifactId: item.id, host: "h1", audience: { kind: "signin" }, allowComments: true })).rejects.toThrow("no sign-in set up");
		await configure({ maxBytes: 1000, maxDays: 7 });
		await expect(runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: true })).rejects.toThrow("accepts files up to 1000 bytes");
		await configure({ maxDays: 7 });
		await expect(runtime.service.create({ artifactId: item.id, host: "h1", audience: link, expiresInDays: 30, allowComments: true })).rejects.toThrow("at most 7 days");
		expect(host.creates).toBe(0);
	});
});

describe("revoking and commenting", () => {
	test("revoke deletes the remote share; an unreachable host keeps the link live", async () => {
		const first = await runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: true });
		await runtime.service.revoke(first.id);
		expect(host.shares.get(FIRST_SHARE)?.revoked).toBe(true);
		expect(world.library.shares.get(first.id)?.revokedAt).toBeDefined();
		const second = await runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: true });
		host.stop();
		await expect(runtime.service.revoke(second.id)).rejects.toThrow("could not be revoked");
		expect(world.library.shares.get(second.id)?.revokedAt).toBeUndefined();
	});

	test("a reply is sealed under the comment key, posted, and stored as read", async () => {
		const created = await runtime.service.create({ artifactId: item.id, host: "h1", audience: link, allowComments: true });
		const key = parseShareLink(created.link)?.key ?? new Uint8Array();
		const reply = await runtime.service.reply(created.id, "  looks great  ", { startMs: 1500 });
		expect(reply).toMatchObject({ body: "looks great", anchor: { startMs: 1500 }, shareId: created.id });
		expect(reply.readAt).toBeDefined();
		const posted = host.shares.get(FIRST_SHARE)?.comments ?? [];
		expect(posted).toHaveLength(1);
		const opened = await openComment(await deriveCommentKey(key), decodeBase64Url(posted[0]?.sealed ?? ""));
		expect(opened).toMatchObject({ body: "looks great", anchor: { startMs: 1500 }, version: 1 });
		expect((await runtime.service.comments(item.id)).map(comment => comment.id)).toEqual([reply.id]);
		await expect(runtime.service.reply(created.id, "", undefined)).rejects.toThrow("empty or longer");
	});
});
