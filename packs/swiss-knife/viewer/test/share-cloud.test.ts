/// <reference path="../../../../../node_modules/@dimension/artifact-host/src/embedded-viewer.d.ts" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@dimension/artifact-host/config";
import { createHostServer, type RunningServer } from "@dimension/artifact-host/server";
import { ASP_CHUNK_BYTES, importContentKey, openChunk, openManifest, parseShareLink } from "@dimension/sdk/artifact-share";
import type { LibraryItem } from "../../src/library/types";
import { placeOf } from "../app/view/library/share-options";
import { type ShareRuntime, startShareRuntime } from "../src/share";
import { DEFAULT_RELAY_URL } from "../src/share/hosts";
import { makeWorld, randomFile, type World } from "./share-fixtures";

const SIZE = ASP_CHUNK_BYTES + 77;
const link = { kind: "link" } as const;

let dataDir: string;
let cloud: RunningServer;
let world: World;
let runtime: ShareRuntime;
let item: LibraryItem;
let content: Uint8Array;

const atCloud = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(String(input).replace(DEFAULT_RELAY_URL, cloud.url), init)) as typeof fetch;

async function readBack(shareLink: string, version: number): Promise<{ readonly name: string; readonly size: number; readonly bytes: Uint8Array }> {
	const parsed = parseShareLink(shareLink);
	if (parsed === undefined) throw new Error(`not a share link: ${shareLink}`);
	const key = await importContentKey(parsed.key);
	const api = `${parsed.base}/api/v1/shares/${parsed.id}/v/${version}`;
	const { manifest, prefix } = await openManifest(key, new Uint8Array(await (await atCloud(`${api}/manifest`)).arrayBuffer()), version);
	const parts: Uint8Array[] = [];
	for (let index = 0; index < manifest.chunks; index++) {
		const sealed = new Uint8Array(await (await atCloud(`${api}/chunks/${index}`)).arrayBuffer());
		parts.push(await openChunk(key, prefix, version, index, index === manifest.chunks - 1, sealed));
	}
	return { name: manifest.name, size: manifest.size, bytes: Buffer.concat(parts) };
}

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "share-cloud-"));
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = probe.port as number;
	await probe.stop(true);
	cloud = await createHostServer(
		parseConfig({
			dataDir,
			listen: { host: "127.0.0.1", port },
			publicUrl: `http://127.0.0.1:${port}`,
			openUploads: true,
			relay: { enabled: true },
		}),
		{ assets: {} },
	);
});

afterAll(async () => {
	await cloud.stop();
	await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(async () => {
	world = await makeWorld();
	content = randomFile(SIZE);
	item = await world.addFile("clip.bin", content);
	runtime = startShareRuntime({
		library: world.library,
		fence: world.fence,
		home: world.home,
		fetch: atCloud,
		retry: { attempts: 2, baseMs: 1, maxMs: 2 },
		log: () => undefined,
	});
});

afterEach(async () => {
	await runtime.close();
	await world.cleanup();
});

describe("sharing to Dimension cloud, a real artifact host that is also the built-in relay and takes uploads without a token", () => {
	test("needs no server of your own: the link's manifest opens and the file comes back byte for byte", async () => {
		await world.writeHosts({ hosts: [] });
		const listing = await runtime.directory.list();
		expect(listing.hosts.map(entry => `${entry.id}:${entry.status}`)).toEqual(["p2p:ok", "cloud:ok"]);

		const created = await runtime.service.create({ artifactId: item.id, host: "cloud", audience: link, allowComments: false });
		expect(placeOf(created)).toBe("On Dimension cloud");
		expect(parseShareLink(created.link)?.base).toBe(DEFAULT_RELAY_URL);
		expect(world.library.shares.get(created.id)).toMatchObject({ host: "cloud", baseUrl: DEFAULT_RELAY_URL });

		const opened = await readBack(created.link, 1);
		expect(opened).toMatchObject({ name: "clip.bin", size: SIZE });
		expect(Buffer.compare(opened.bytes, content)).toBe(0);
	});

	test("an existing cloud share keeps updating where it lives, even after sharing is pointed at another relay", async () => {
		await world.writeHosts({ hosts: [] });
		const created = await runtime.service.create({ artifactId: item.id, host: "cloud", audience: link, allowComments: false });
		const edited = randomFile(ASP_CHUNK_BYTES + 5);
		await writeFile(item.path, edited);
		await world.writeHosts({ relay: "https://relay.elsewhere.example", hosts: [] });

		const updated = await runtime.service.newVersion(created.id);
		expect(updated).toMatchObject({ host: "cloud", version: 2 });
		const opened = await readBack(created.link, 2);
		expect(opened.size).toBe(edited.byteLength);
		expect(Buffer.compare(opened.bytes, edited)).toBe(0);

		const day = 86_400_000;
		const shortened = await runtime.service.update({ shareId: created.id, expiresInDays: 7 });
		expect(shortened.expiresAt).toBeGreaterThan(Date.now() + 6 * day);
		expect(shortened.expiresAt).toBeLessThan(Date.now() + 8 * day);
	});

	test("when the administrator's approved servers leave cloud out, the share is refused in words and none is made", async () => {
		await world.writeHosts({ policy: { only: ["corp"] }, hosts: [] });
		await expect(runtime.service.create({ artifactId: item.id, host: "cloud", audience: link, allowComments: false })).rejects.toThrow("administrator");
		expect(world.library.shares.live()).toHaveLength(0);
	});
});
