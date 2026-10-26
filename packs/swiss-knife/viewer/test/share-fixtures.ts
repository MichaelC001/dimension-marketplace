import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { SharePolicy } from "@dimension/sdk/artifact-share";
import { createLibrary } from "../../src/library/library";
import type { Library, LibraryItem } from "../../src/library/types";
import { createFence, type Fence } from "../src/fence";

export interface World {
	readonly root: string;
	readonly home: string;
	readonly library: Library;
	readonly fence: Fence;
	readonly clock: { now: number };
	addFile(name: string, content: Uint8Array | string): Promise<LibraryItem>;
	writeHosts(value: unknown): Promise<void>;
	cleanup(): Promise<void>;
}

export async function makeWorld(): Promise<World> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "share-client-")));
	const home = join(root, "home");
	const clock = { now: Date.now() };
	const library = await createLibrary({ home, now: () => clock.now, revokeRemote: async () => undefined, trash: async () => undefined });
	const fence = createFence({ home: root, env: {}, indexed: library });
	return {
		root,
		home,
		library,
		fence,
		clock,
		async addFile(name, content) {
			const path = join(root, "files", name);
			await mkdir(join(root, "files"), { recursive: true });
			await writeFile(path, content);
			return library.stamp({ path, source: "human" });
		},
		async writeHosts(value) {
			await mkdir(join(home, "artifacts"), { recursive: true });
			await writeFile(join(home, "artifacts", "hosts.json"), JSON.stringify(value));
		},
		async cleanup() {
			library.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

export function randomFile(bytes: number): Uint8Array {
	const out = new Uint8Array(bytes);
	for (let offset = 0; offset < bytes; offset += 65_536) crypto.getRandomValues(out.subarray(offset, Math.min(bytes, offset + 65_536)));
	return out;
}

interface FakeVersion {
	manifest?: Uint8Array;
	readonly chunks: Map<number, Uint8Array>;
	readonly expected: number;
	committed: boolean;
}

export interface FakeShare {
	readonly id: string;
	readonly ownerToken: string;
	readonly body: { readonly audience: unknown; readonly allowComments: boolean; readonly chunks: number; readonly sealedBytes: number; readonly expiresAt?: number };
	readonly versions: Map<number, FakeVersion>;
	readonly comments: { id: string; at: number; sealed: string }[];
	revoked: boolean;
}

export interface FakeHostOptions {
	readonly uploadToken?: string;
	readonly mode?: "host" | "relay";
	readonly policy?: Partial<SharePolicy>;
	readonly oidc?: boolean;
	readonly parkUntil?: number;
}

export class FakeHost {
	readonly shares = new Map<string, FakeShare>();
	readonly chunkAttempts = new Map<string, number>();
	readonly chunkStored = new Map<string, number>();
	readonly failures = new Map<string, { remaining: number; status: number }>();
	readonly eventStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	creates = 0;
	maxConcurrent = 0;
	#active = 0;
	readonly #parked: (() => void)[] = [];
	#server!: Server<undefined>;
	readonly #options: FakeHostOptions;

	private constructor(options: FakeHostOptions) {
		this.#options = options;
	}

	static start(options: FakeHostOptions = {}): FakeHost {
		const host = new FakeHost(options);
		host.#server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: request => host.#handle(request) });
		return host;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.#server.port}`;
	}

	stop(): void {
		for (const controller of this.eventStreams) controller.close();
		this.eventStreams.clear();
		void this.#server.stop(true);
	}

	pushComment(shareId: string, sealed: string, id: string, at: number): void {
		const share = this.shares.get(shareId);
		if (share === undefined) throw new Error("no such share");
		share.comments.push({ id, at, sealed });
		const frame = new TextEncoder().encode(`event: comment\nid: ${id}\ndata: ${JSON.stringify({ share: shareId, id, at, sealed })}\n\n`);
		for (const controller of this.eventStreams) controller.enqueue(frame);
	}

	#json(status: number, body: unknown): Response {
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}

	#problem(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
		return this.#json(status, { error, message, ...extra });
	}

	#owner(request: Request, id: string): FakeShare | Response {
		const share = this.shares.get(id);
		if (share === undefined) return this.#problem(404, "not_found", "no such share");
		if (request.headers.get("authorization") !== `Bearer ${share.ownerToken}`) return this.#problem(401, "unauthorized", "bad owner token");
		return share;
	}

	async #handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const policy: SharePolicy = { publicLinks: true, signinRequired: false, maxBytes: 2 ** 40, maxDays: 90, ...this.#options.policy };
		if (path === "/.well-known/dimension-artifacts") {
			return this.#json(200, { asp: 1, name: "Fake host", mode: this.#options.mode ?? "host", auth: this.#options.oidc === true ? { oidc: { issuer: "https://idp.example" } } : {}, policy });
		}
		if (path === "/api/v1/ping") {
			const needed = this.#options.uploadToken;
			if (needed !== undefined && request.headers.get("authorization") !== `Bearer ${needed}`) return this.#problem(401, "unauthorized", "that token is not accepted");
			return this.#json(200, { ok: true });
		}
		if (path === "/api/v1/shares" && request.method === "POST") {
			const needed = this.#options.uploadToken;
			if (needed !== undefined && request.headers.get("authorization") !== `Bearer ${needed}`) return this.#problem(401, "unauthorized", "that token is not accepted");
			const body = (await request.json()) as FakeShare["body"];
			this.creates++;
			const id = `fake${String(this.creates).padStart(12, "0")}`;
			const expiresAt = body.expiresAt ?? Date.now() + policy.maxDays * 86_400_000;
			this.shares.set(id, {
				id,
				ownerToken: `owner-${id}`,
				body: { ...body, expiresAt },
				versions: new Map([[1, { chunks: new Map(), committed: false, expected: body.chunks }]]),
				comments: [],
				revoked: false,
			});
			return this.#json(201, { id, ownerToken: `owner-${id}`, version: 1, expiresAt });
		}
		if (path === "/api/v1/events" && request.method === "POST") {
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const stream = new ReadableStream<Uint8Array>({
				start: c => {
					controller = c;
					c.enqueue(new TextEncoder().encode(`event: ready\ndata: {"rejected":[]}\n\n`));
					this.eventStreams.add(c);
				},
				cancel: () => {
					this.eventStreams.delete(controller);
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		}
		const match = /^\/api\/v1\/shares\/([^/]+)(?:\/(.*))?$/.exec(path);
		if (match === null) return this.#problem(404, "not_found", "no such route");
		const [, id = "", rest = ""] = match;
		const owned = this.#owner(request, id);
		if (owned instanceof Response) return rest === "comments" && request.method === "POST" ? this.#postComment(request, id) : owned;
		if (request.method === "DELETE" && rest === "") {
			owned.revoked = true;
			return this.#json(200, { revoked: true });
		}
		if (request.method === "PATCH" && rest === "") {
			const patch = (await request.json()) as { expiresAt?: number | null };
			return this.#json(200, { id, expiresAt: patch.expiresAt ?? owned.body.expiresAt ?? null });
		}
		if (request.method === "POST" && rest === "versions") {
			const body = (await request.json()) as { chunks: number };
			const version = Math.max(...owned.versions.keys()) + 1;
			owned.versions.set(version, { chunks: new Map(), committed: false, expected: body.chunks });
			return this.#json(201, { version, chunks: body.chunks });
		}
		if (rest === "comments" && request.method === "GET") return this.#json(200, owned.comments);
		if (rest === "comments" && request.method === "POST") return this.#postComment(request, id);
		const versionMatch = /^v\/(\d+)\/(manifest|commit|chunks\/(\d+))$/.exec(rest);
		if (versionMatch === null) return this.#problem(404, "not_found", "no such route");
		const version = owned.versions.get(Number(versionMatch[1]));
		if (version === undefined) return this.#problem(404, "not_found", "no such version");
		if (versionMatch[2] === "manifest") {
			version.manifest = new Uint8Array(await request.arrayBuffer());
			return this.#json(200, { ok: true });
		}
		if (versionMatch[2] === "commit") {
			const missing = Array.from({ length: version.expected }, (_, index) => index).filter(index => !version.chunks.has(index));
			if (version.manifest === undefined || missing.length > 0) return this.#problem(409, "incomplete", "chunks are missing", { missing });
			version.committed = true;
			return this.#json(200, { ok: true });
		}
		return this.#putChunk(request, owned, versionMatch[1] ?? "", Number(versionMatch[3]));
	}

	async #postComment(request: Request, id: string): Promise<Response> {
		const share = this.shares.get(id);
		if (share === undefined) return this.#problem(404, "not_found", "no such share");
		const body = (await request.json()) as { sealed: string };
		const comment = { id: `c${String(share.comments.length + 1).padStart(6, "0")}`, at: Date.now(), sealed: body.sealed };
		share.comments.push(comment);
		return this.#json(201, { id: comment.id, at: comment.at });
	}

	#releaseParked(share: FakeShare, version: string): void {
		const limit = this.#options.parkUntil;
		if (limit === undefined || this.#parked.length === 0) return;
		const remaining = share.body.chunks - (share.versions.get(Number(version))?.chunks.size ?? 0);
		if (this.#parked.length >= Math.min(limit, remaining)) for (const release of this.#parked.splice(0)) release();
	}

	async #putChunk(request: Request, share: FakeShare, version: string, index: number): Promise<Response> {
		const key = `${share.id}:${version}:${index}`;
		this.chunkAttempts.set(key, (this.chunkAttempts.get(key) ?? 0) + 1);
		this.#active++;
		this.maxConcurrent = Math.max(this.maxConcurrent, this.#active);
		try {
			const bytes = new Uint8Array(await request.arrayBuffer());
			if (this.#options.parkUntil !== undefined) {
				await new Promise<void>(resolve => {
					this.#parked.push(resolve);
					this.#releaseParked(share, version);
				});
			}
			const failure = this.failures.get(key);
			if (failure !== undefined && failure.remaining > 0) {
				failure.remaining--;
				return this.#problem(failure.status, "busy", "the server is busy");
			}
			share.versions.get(Number(version))?.chunks.set(index, bytes);
			this.chunkStored.set(key, (this.chunkStored.get(key) ?? 0) + 1);
			return this.#json(200, { ok: true });
		} finally {
			this.#active--;
			this.#releaseParked(share, version);
		}
	}
}

export async function until(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}
