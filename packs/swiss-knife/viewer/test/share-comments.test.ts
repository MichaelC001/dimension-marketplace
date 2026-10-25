import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deriveCommentKey, encodeBase64Url, generateContentKey, sealComment } from "@dimension/sdk/artifact-share";
import type { ShareRow } from "../../src/library/types";
import { CommentSync } from "../src/share/comments";
import { makeWorld, until, type World } from "./share-fixtures";

interface Recorded {
	readonly url: string;
	readonly headers: Headers;
	readonly body: { shares: { id: string; ownerToken?: string; after?: string }[] };
}

const encoder = new TextEncoder();
const BACKOFF = { baseMs: 1, maxMs: 2 };

let world: World;
let keyBytes: Uint8Array;
let recorded: Recorded[];
let script: (() => Response)[];
let ended: number;
let sync: CommentSync;
let row: ShareRow;

function events(...entries: { event: string; data: unknown; id?: string }[]): Response {
	const text = entries.map(entry => `event: ${entry.event}\n${entry.id === undefined ? "" : `id: ${entry.id}\n`}data: ${JSON.stringify(entry.data)}\n\n`).join("");
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(text));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

const scripted = (async (input: RequestInfo | URL, init?: RequestInit) => {
	if (init?.method === "POST") {
		recorded.push({ url: String(input), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
		const next = script.shift();
		if (next !== undefined) return next();
		return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
	}
	throw new Error(`unexpected ${init?.method ?? "GET"} ${String(input)}`);
}) as typeof fetch;

async function sealed(body: string, version = 1): Promise<string> {
	return encodeBase64Url(await sealComment(await deriveCommentKey(keyBytes), { author: "Ana", body, anchor: { kind: "time", startMs: 2000 }, version, at: 5 }));
}

async function shareRow(overrides: Partial<ShareRow> = {}): Promise<ShareRow> {
	const item = await world.addFile(`file-${Math.random().toString(36).slice(2)}.bin`, "content");
	const created: ShareRow = {
		id: `share-${item.id}`,
		artifactId: item.id,
		host: "h1",
		remoteId: "remoteshare0123456789",
		baseUrl: "https://host.example",
		key: encodeBase64Url(keyBytes),
		ownerToken: "owner-token",
		audience: { kind: "link" },
		version: 1,
		allowComments: true,
		createdAt: world.clock.now,
		...overrides,
	};
	world.library.shares.insert(created);
	return created;
}

beforeEach(async () => {
	world = await makeWorld();
	keyBytes = generateContentKey();
	recorded = [];
	script = [];
	ended = 0;
	sync = new CommentSync({ library: world.library, fetch: scripted, backoff: BACKOFF, log: () => undefined, onShareEnded: () => ended++ });
	row = await shareRow();
});

afterEach(async () => {
	await sync.close();
	await world.cleanup();
});

describe("mirroring comments from a host's event stream", () => {
	test("opens each comment locally, skips one that will not open, resumes after the last id, and records a revocation", async () => {
		const first = await sealed("first");
		const garbage = encodeBase64Url(crypto.getRandomValues(new Uint8Array(48)));
		script.push(
			() =>
				events(
					{ event: "ready", data: { rejected: [] } },
					{ event: "comment", id: "c1", data: { share: row.remoteId, id: "c1", at: 100, sealed: first } },
					{ event: "comment", id: "c2", data: { share: row.remoteId, id: "c2", at: 200, sealed: garbage } },
				),
			() => events({ event: "revoked", data: { share: row.remoteId, reason: "revoked" } }),
		);
		sync.reconcile([row]);
		await until(() => world.library.shares.get(row.id)?.revokedAt !== undefined, "the revocation to be recorded");
		const comments = world.library.comments.forArtifact(row.artifactId);
		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({ id: "c1", author: "Ana", body: "first", anchor: { kind: "time", startMs: 2000 }, version: 1, createdAt: 100, shareId: row.id });
		expect(comments[0]?.readAt).toBeUndefined();
		expect(recorded[0]?.url).toBe("https://host.example/api/v1/events");
		expect(recorded[0]?.headers.get("authorization")).toBeNull();
		expect(recorded[0]?.body.shares).toEqual([{ id: row.remoteId, ownerToken: "owner-token" }]);
		expect(recorded[1]?.body.shares[0]?.after).toBe("c2");
		expect(ended).toBe(1);
	});

	test("a share from this computer asks the relay with the tunnel token and never sends an owner token in the body", async () => {
		const relayed = await shareRow({ host: "p2p", baseUrl: "https://relay.example/p/tunnel0123456789abcdef", ownerToken: "tunnel-token", remoteId: "relayshare012345678901" });
		sync.reconcile([relayed]);
		await until(() => recorded.length === 1, "the relay stream to open");
		expect(recorded[0]?.url).toBe("https://relay.example/p/tunnel0123456789abcdef/api/v1/events");
		expect(recorded[0]?.headers.get("authorization")).toBe("Bearer tunnel-token");
		expect(recorded[0]?.body.shares).toEqual([{ id: relayed.remoteId }]);
	});

	test("a new connection resumes after the newest comment already stored, even across an app restart", async () => {
		world.library.comments.upsert({ id: "c9", shareId: row.id, author: "Ana", body: "old", version: 1, createdAt: 1 });
		sync.reconcile([row]);
		await until(() => recorded.length === 1, "the stream to open");
		expect(recorded[0]?.body.shares).toEqual([{ id: row.remoteId, ownerToken: "owner-token", after: "c9" }]);
	});

	test("catching up pages through the host's comments until none are left", async () => {
		const pages: string[] = [];
		const answers = [[{ id: "c1", at: 10, sealed: await sealed("one") }], [{ id: "c2", at: 20, sealed: await sealed("two") }], []];
		const paged = (async (input: RequestInfo | URL) => {
			pages.push(String(input));
			return Response.json(answers.shift() ?? []);
		}) as typeof fetch;
		const catching = new CommentSync({ library: world.library, fetch: paged, backoff: BACKOFF, log: () => undefined });
		await catching.catchUp([row]);
		expect(world.library.comments.forArtifact(row.artifactId).map(comment => comment.body)).toEqual(["one", "two"]);
		expect(pages).toEqual([
			"https://host.example/api/v1/shares/remoteshare0123456789/comments",
			"https://host.example/api/v1/shares/remoteshare0123456789/comments?after=c1",
			"https://host.example/api/v1/shares/remoteshare0123456789/comments?after=c2",
		]);
	});
});
