import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import {
	ASP_CHUNK_BYTES,
	chunkCount,
	decodeBase64Url,
	encodeBase64Url,
	importContentKey,
	newVersionPrefix,
	sealChunk,
	sealedSize,
	sealManifest,
} from "@dimension/sdk/artifact-share";
import type { Library, LibraryItem, ShareRow } from "../../../src/library/types";
import { readRange } from "../chunk";
import type { Fence } from "../fence";
import { ChunkCache } from "./chunk-cache";
import type { Fingerprint } from "./chunk-source";
import { buildManifest } from "./manifest";
import type { P2pShareState, P2pStore } from "./p2p-store";

export interface P2pRequest {
	readonly method: "GET" | "HEAD";
	readonly path: string;
	readonly headers: Headers;
}

export interface P2pServerOptions {
	readonly library: Library;
	readonly fence: Fence;
	readonly store: P2pStore;
	readonly now?: () => number;
	readonly onVersionChange?: () => void;
}

interface LoadedState {
	readonly version: number;
	readonly prefix: Uint8Array;
	readonly size: number;
	readonly mtimeMs: number;
	readonly createdAt: number;
	readonly sealedManifest: Uint8Array;
}

interface ShareFile {
	readonly item: LibraryItem;
	readonly real: string;
	readonly fingerprint: Fingerprint;
}

const ROUTE = /^\/api\/v1\/shares\/([A-Za-z0-9_-]{16,64})(?:\/v\/(\d{1,9})\/(manifest|chunks\/(\d{1,9})))?$/;
const RANGE = /^bytes=(\d*)-(\d*)$/;
const CACHE_BYTES = 16 * ASP_CHUNK_BYTES;
const IMMUTABLE = "public, max-age=31536000, immutable";
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

export class P2pRefusal extends Error {
	override readonly name = "P2pRefusal";
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function refusalResponse(refusal: P2pRefusal): Response {
	return new Response(JSON.stringify({ error: refusal.code, message: refusal.message }), {
		status: refusal.status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
}

function bytesResponse(request: P2pRequest, bytes: Uint8Array): Response {
	const headers: Record<string, string> = {
		"content-type": "application/octet-stream",
		"cache-control": IMMUTABLE,
		"accept-ranges": "bytes",
	};
	const spec = RANGE.exec(request.headers.get("range") ?? "");
	let status = 200;
	let body = bytes;
	if (spec !== null && request.method === "GET") {
		const [, first = "", last = ""] = spec;
		const suffix = first === "" ? Number(last) : undefined;
		const start = suffix === undefined ? Number(first) : Math.max(0, bytes.length - suffix);
		const end = suffix !== undefined || last === "" ? bytes.length - 1 : Math.min(Number(last), bytes.length - 1);
		if ((first === "" && last === "") || start >= bytes.length || end < start || suffix === 0) {
			return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
		}
		status = 206;
		body = bytes.subarray(start, end + 1);
		headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
	}
	headers["content-length"] = String(body.length);
	return new Response(request.method === "HEAD" ? null : (body as Uint8Array<ArrayBuffer>), { status, headers });
}

export class P2pServer {
	readonly #library: Library;
	readonly #fence: Fence;
	readonly #store: P2pStore;
	readonly #now: () => number;
	readonly #onVersionChange: () => void;
	readonly #states = new Map<string, LoadedState>();
	readonly #keys = new Map<string, CryptoKey>();
	readonly #locks = new Map<string, Promise<unknown>>();
	readonly #inflight = new Map<string, Promise<Uint8Array>>();
	readonly #cache = new ChunkCache(CACHE_BYTES);

	constructor(options: P2pServerOptions) {
		this.#library = options.library;
		this.#fence = options.fence;
		this.#store = options.store;
		this.#now = options.now ?? Date.now;
		this.#onVersionChange = options.onVersionChange ?? (() => undefined);
	}

	async handle(request: P2pRequest): Promise<Response> {
		try {
			return await this.#route(request);
		} catch (error) {
			if (error instanceof P2pRefusal) return refusalResponse(error);
			throw error;
		}
	}

	async #route(request: P2pRequest): Promise<Response> {
		const match = ROUTE.exec(new URL(request.path, "http://share.invalid").pathname);
		if (match === null) throw new P2pRefusal(404, "not_found", "There is nothing at this address.");
		const [, shareId = "", version, leaf, chunkIndex] = match;
		const row = this.#live(shareId);
		const file = await this.#file(row);
		const state = await this.#current(row, file);
		if (leaf === undefined) return this.#meta(request, row, state);
		if (Number(version) !== state.version) throw new P2pRefusal(404, "not_found", "That version of this share is no longer available.");
		if (leaf === "manifest") return bytesResponse(request, state.sealedManifest);
		const index = Number(chunkIndex);
		if (index >= chunkCount(state.size)) throw new P2pRefusal(404, "not_found", "There is no such part in this share.");
		return bytesResponse(request, await this.#sealed(row, file, state, index));
	}

	#live(shareId: string): ShareRow {
		const row = this.#library.shares.get(shareId);
		if (row === undefined || row.host !== "p2p") throw new P2pRefusal(404, "not_found", "This share does not exist.");
		if (row.revokedAt !== undefined) throw new P2pRefusal(410, "revoked", "The person who shared this has stopped sharing it.");
		if (row.expiresAt !== undefined && row.expiresAt <= this.#now()) throw new P2pRefusal(410, "expired", "This link has expired.");
		return row;
	}

	async #file(row: ShareRow): Promise<ShareFile> {
		const item = this.#library.get(row.artifactId);
		if (item === undefined || item.state === "discarded") throw new P2pRefusal(410, "revoked", "The person who shared this has stopped sharing it.");
		const verdict = await this.#fence.check(item.path);
		const gone = new P2pRefusal(404, "not_found", "The file is no longer on the sharing computer.");
		if (!verdict.ok) throw gone;
		const sameFile = FOLD_CASE ? verdict.real.toLowerCase() === item.path.toLowerCase() : verdict.real === item.path;
		if (!sameFile) throw gone;
		let info: Stats;
		try {
			info = await stat(verdict.real);
		} catch {
			throw gone;
		}
		if (!info.isFile()) throw gone;
		return { item, real: verdict.real, fingerprint: { size: info.size, mtimeMs: info.mtimeMs } };
	}

	#locked<T>(shareId: string, work: () => Promise<T>): Promise<T> {
		const run = (this.#locks.get(shareId) ?? Promise.resolve()).then(work);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.#locks.set(shareId, tail);
		void tail.then(() => {
			if (this.#locks.get(shareId) === tail) this.#locks.delete(shareId);
		});
		return run;
	}

	async #key(row: ShareRow): Promise<CryptoKey> {
		let key = this.#keys.get(row.id);
		if (key === undefined) {
			key = await importContentKey(decodeBase64Url(row.key));
			this.#keys.set(row.id, key);
		}
		return key;
	}

	async #load(row: ShareRow): Promise<LoadedState | undefined> {
		const cached = this.#states.get(row.id);
		if (cached !== undefined) return cached;
		const stored: P2pShareState | undefined = await this.#store.readShare(row.id);
		if (stored === undefined) return undefined;
		const loaded: LoadedState = {
			version: stored.version,
			prefix: decodeBase64Url(stored.prefix),
			size: stored.size,
			mtimeMs: stored.mtimeMs,
			createdAt: stored.createdAt,
			sealedManifest: decodeBase64Url(stored.manifest),
		};
		this.#states.set(row.id, loaded);
		return loaded;
	}

	async #seal(row: ShareRow, item: LibraryItem, fingerprint: Fingerprint, version: number): Promise<LoadedState> {
		const key = await this.#key(row);
		const prefix = newVersionPrefix();
		const manifest = await buildManifest(this.#library, item, version, fingerprint.size);
		const sealedManifest = await sealManifest(key, prefix, manifest);
		await this.#store.writeShare(row.id, {
			version,
			prefix: encodeBase64Url(prefix),
			size: fingerprint.size,
			mtimeMs: fingerprint.mtimeMs,
			createdAt: manifest.createdAt,
			manifest: encodeBase64Url(sealedManifest),
		});
		const state: LoadedState = { version, prefix, size: fingerprint.size, mtimeMs: fingerprint.mtimeMs, createdAt: manifest.createdAt, sealedManifest };
		this.#states.set(row.id, state);
		this.#cache.dropWithPrefix(`${row.id}:`);
		if (row.version !== version) {
			this.#library.shares.update(row.id, { version });
			this.#onVersionChange();
		}
		return state;
	}

	#current(row: ShareRow, file: ShareFile): Promise<LoadedState> {
		return this.#locked(row.id, async () => {
			const loaded = await this.#load(row);
			if (loaded !== undefined && loaded.version === row.version && loaded.size === file.fingerprint.size && loaded.mtimeMs === file.fingerprint.mtimeMs) {
				return loaded;
			}
			return this.#seal(row, file.item, file.fingerprint, Math.max(loaded?.version ?? 0, row.version) + 1);
		});
	}

	create(row: ShareRow, item: LibraryItem, fingerprint: Fingerprint): Promise<void> {
		return this.#locked(row.id, async () => {
			await this.#seal(row, item, fingerprint, row.version);
		});
	}

	newVersion(row: ShareRow): Promise<number> {
		return this.#locked(row.id, async () => {
			const file = await this.#file(row);
			const loaded = await this.#load(row);
			return (await this.#seal(row, file.item, file.fingerprint, Math.max(loaded?.version ?? 0, row.version) + 1)).version;
		});
	}

	async forget(shareId: string): Promise<void> {
		this.#states.delete(shareId);
		this.#keys.delete(shareId);
		this.#cache.dropWithPrefix(`${shareId}:`);
		await this.#store.removeShare(shareId);
	}

	#meta(request: P2pRequest, row: ShareRow, state: LoadedState): Response {
		const body = JSON.stringify({
			id: row.id,
			latest: state.version,
			pinned: null,
			versions: [{ version: state.version, chunks: chunkCount(state.size), sealedBytes: sealedSize(state.size), createdAt: state.createdAt }],
			allowComments: row.allowComments,
			expiresAt: row.expiresAt ?? null,
		});
		return new Response(request.method === "HEAD" ? null : body, {
			status: 200,
			headers: { "content-type": "application/json", "cache-control": "no-cache", "content-length": String(Buffer.byteLength(body)) },
		});
	}

	#sealed(row: ShareRow, file: ShareFile, state: LoadedState, index: number): Promise<Uint8Array> {
		const id = `${row.id}:${state.version}:${index}`;
		const hit = this.#cache.get(id);
		if (hit !== undefined) return Promise.resolve(hit);
		const pending = this.#inflight.get(id);
		if (pending !== undefined) return pending;
		const work = (async () => {
			const start = index * ASP_CHUNK_BYTES;
			const length = Math.min(ASP_CHUNK_BYTES, state.size - start);
			const read = await readRange(file.real, start, length);
			if (read.size !== state.size || read.mtimeMs !== state.mtimeMs || read.bytes.length !== length) {
				throw new P2pRefusal(409, "changed", "The file changed while it was being read; reload this page.");
			}
			const plain = new Uint8Array(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
			const sealed = await sealChunk(await this.#key(row), state.prefix, state.version, index, index === chunkCount(state.size) - 1, plain);
			this.#cache.put(id, sealed);
			return sealed;
		})().finally(() => this.#inflight.delete(id));
		this.#inflight.set(id, work);
		return work;
	}
}
