import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ASP_CHUNK_BYTES,
	importContentKey,
	openChunk,
	openManifest,
	parseShareLink,
} from "@dimension/sdk/artifact-share";
import type { LibraryItem } from "../../src/library/types";
import { type ShareRuntime, startShareRuntime } from "../src/share";
import { P2pStore } from "../src/share/p2p-store";
import { FakeRelay } from "./share-relay-fixture";
import { makeWorld, randomFile, until, type World } from "./share-fixtures";

const SIZE = ASP_CHUNK_BYTES + 5000;
const link = { kind: "link" } as const;

let world: World;
let relay: FakeRelay;
let runtime: ShareRuntime;
let item: LibraryItem;
let content: Uint8Array;

function boot(): ShareRuntime {
	return startShareRuntime({
		library: world.library,
		fence: world.fence,
		home: world.home,
		reconnect: { baseMs: 5, maxMs: 20, rateLimitedMs: 50 },
		log: () => undefined,
	});
}

async function shareFromThisComputer() {
	const created = await runtime.service.create({ artifactId: item.id, host: "p2p", audience: link, allowComments: true });
	const parsed = parseShareLink(created.link);
	if (parsed === undefined) throw new Error("the link did not parse");
	return { created, parsed };
}

beforeEach(async () => {
	world = await makeWorld();
	relay = FakeRelay.start();
	await world.writeHosts({ relay: relay.baseUrl });
	content = randomFile(SIZE);
	item = await world.addFile("screencast.bin", content);
	runtime = boot();
});

afterEach(async () => {
	await runtime.close();
	relay.stop();
	await world.cleanup();
});

describe("a link from this computer through the relay", () => {
	test("registers, announces the share, and streams a sealed chunk no faster than the relay grants credit", async () => {
		const { created, parsed } = await shareFromThisComputer();
		expect(parsed.base).toBe(`${relay.baseUrl}/p/${relay.tunnelId}`);
		expect(relay.hellos[0]).toEqual({});
		await until(() => relay.announced.some(frame => frame.shares.some(share => share.id === created.id)), "the share announcement");
		const announced = relay.announced.flatMap(frame => frame.shares).find(share => share.id === created.id);
		expect(announced).toEqual({ id: created.id, comments: true, expiresAt: 0, latest: 1 });
		const key = await importContentKey(parsed.key);
		const manifestRequest = relay.request(`/api/v1/shares/${parsed.id}/v/1/manifest`);
		await manifestRequest.finished;
		expect(manifestRequest.status).toBe(200);
		const { manifest, prefix } = await openManifest(key, manifestRequest.body, 1);
		expect(manifest.size).toBe(SIZE);
		const sealedLength = ASP_CHUNK_BYTES + 16;
		const chunk = relay.request(`/api/v1/shares/${parsed.id}/v/1/chunks/0`, { window: 4096, automaticCredit: false });
		await until(() => chunk.bytes === 4096, "the first window of data");
		while (chunk.bytes < sealedLength) {
			const before = chunk.bytes;
			chunk.credit(4096);
			await until(() => chunk.bytes > before, "data after credit");
		}
		await chunk.finished;
		expect(chunk.status).toBe(200);
		expect(chunk.overran).toBe(false);
		expect(chunk.bytes).toBe(sealedLength);
		expect(await openChunk(key, prefix, 1, 0, false, chunk.body)).toEqual(content.subarray(0, ASP_CHUNK_BYTES));
	});

	test("after the connection drops, and after the app restarts, it re-registers as the same tunnel with the saved token", async () => {
		const { created } = await shareFromThisComputer();
		relay.drop();
		await until(() => relay.hellos.length === 2 && relay.connected, "the reconnect");
		expect(relay.hellos[1]).toEqual({ tunnelId: relay.tunnelId, token: relay.token });
		await until(() => relay.announced.length >= 2, "the announcement after reconnecting");
		expect(relay.announced.at(-1)?.shares.map(share => share.id)).toEqual([created.id]);
		await runtime.close();
		await until(() => !relay.connected, "the tunnel to close with the app");
		runtime = boot();
		await until(() => relay.hellos.length === 3 && relay.connected, "the restart registration");
		expect(relay.hellos[2]).toEqual({ tunnelId: relay.tunnelId, token: relay.token });
	});

	test("revoking answers 410 over the tunnel at once and tells the relay; the tunnel closes when no live share is left", async () => {
		const { created, parsed } = await shareFromThisComputer();
		const other = await world.addFile("second.bin", randomFile(2048));
		const second = await runtime.service.create({ artifactId: other.id, host: "p2p", audience: link, allowComments: false });
		await runtime.service.revoke(created.id);
		const gone = relay.request(`/api/v1/shares/${parsed.id}/v/1/chunks/0`);
		await gone.finished;
		expect(gone.status).toBe(410);
		expect(new TextDecoder().decode(gone.body)).toContain("revoked");
		expect(relay.deletes).toEqual([`/p/${relay.tunnelId}/api/v1/shares/${created.id}|Bearer ${relay.token}`]);
		expect(relay.connected).toBe(true);
		await runtime.service.revoke(second.id);
		await runtime.p2p.reconcile();
		await until(() => !relay.connected, "the tunnel to close with no live share");
	});

	test("a relay that no longer knows this computer voids the credential and the links that depended on it", async () => {
		const { created } = await shareFromThisComputer();
		relay.rejectWith = "unknown_tunnel";
		relay.drop();
		await until(() => world.library.shares.get(created.id)?.revokedAt !== undefined, "the dead link to be marked revoked");
		expect(await new P2pStore(world.home).readTunnel()).toBeUndefined();
	});
});
