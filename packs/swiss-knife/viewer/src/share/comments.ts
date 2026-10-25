import { decodeBase64Url, deriveCommentKey, openComment } from "@dimension/sdk/artifact-share";
import { z } from "zod";
import type { Library, ShareRow } from "../../../src/library/types";
import { HostClient, type SealedComment } from "./host-api";
import { P2P_HOST_ID } from "./hosts";
import { backoffDelay, type BackoffOptions, sleepFor } from "./retry";
import { readEvents } from "./sse";

export const SHARES_PER_STREAM = 200;
export const MAX_STREAMS = 8;
const CATCH_UP_CONCURRENCY = 4;
const CATCH_UP_PAGES = 20;
const STREAM_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 60_000 };

const commentEventSchema = z.object({ share: z.string(), id: z.string().min(1), at: z.number().int().nonnegative(), sealed: z.string().min(1) });
const revokedEventSchema = z.object({ share: z.string(), reason: z.enum(["revoked", "expired"]) });
const readyEventSchema = z.object({ rejected: z.array(z.object({ id: z.string(), error: z.string() })).default([]) });

export interface CommentSyncOptions {
	readonly library: Library;
	readonly fetch?: typeof fetch;
	readonly backoff?: BackoffOptions;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
	readonly onShareEnded?: () => void;
}

interface Stream {
	readonly signature: string;
	readonly abort: AbortController;
	readonly done: Promise<void>;
}

export class CommentSync {
	readonly #options: CommentSyncOptions;
	readonly #streams = new Map<string, Stream>();
	readonly #keys = new Map<string, CryptoKey>();
	readonly #cursors = new Map<string, string>();
	#closed = false;

	constructor(options: CommentSyncOptions) {
		this.#options = options;
	}

	async #commentKey(row: ShareRow): Promise<CryptoKey> {
		let key = this.#keys.get(row.id);
		if (key === undefined) {
			key = await deriveCommentKey(decodeBase64Url(row.key));
			this.#keys.set(row.id, key);
		}
		return key;
	}

	#cursor(row: ShareRow): string | undefined {
		const known = this.#cursors.get(row.id);
		if (known !== undefined) return known;
		let latest: string | undefined;
		for (const comment of this.#options.library.comments.forArtifact(row.artifactId)) {
			if (comment.shareId === row.id && (latest === undefined || comment.id > latest)) latest = comment.id;
		}
		if (latest !== undefined) this.#cursors.set(row.id, latest);
		return latest;
	}

	async #ingest(row: ShareRow, sealed: SealedComment): Promise<void> {
		const cursor = this.#cursors.get(row.id);
		if (cursor === undefined || sealed.id > cursor) this.#cursors.set(row.id, sealed.id);
		try {
			const comment = await openComment(await this.#commentKey(row), decodeBase64Url(sealed.sealed));
			this.#options.library.comments.upsert({
				id: sealed.id,
				shareId: row.id,
				author: comment.author,
				body: comment.body,
				...(comment.anchor === undefined ? {} : { anchor: comment.anchor }),
				version: comment.version,
				createdAt: sealed.at,
			});
		} catch {
			this.#options.log?.("a comment on one of your shares could not be opened and was skipped");
		}
	}

	#markEnded(row: ShareRow, reason: "revoked" | "expired"): void {
		const now = (this.#options.now ?? Date.now)();
		if (reason === "revoked") this.#options.library.shares.update(row.id, { revokedAt: now });
		else if (row.expiresAt === undefined || row.expiresAt > now) this.#options.library.shares.update(row.id, { expiresAt: now });
		this.#options.onShareEnded?.();
	}

	async catchUp(rows: readonly ShareRow[], signal?: AbortSignal): Promise<void> {
		const queue = [...rows];
		const worker = async (): Promise<void> => {
			for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
				const client = new HostClient(row.baseUrl, this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch });
				try {
					for (let page = 0; page < CATCH_UP_PAGES; page++) {
						const batch = await client.comments(row.ownerToken, row.remoteId, this.#cursor(row), signal);
						if (batch.length === 0) break;
						for (const sealed of batch) await this.#ingest(row, sealed);
					}
				} catch (error) {
					if (signal?.aborted) return;
					this.#options.log?.(`could not read comments for a share on ${new URL(row.baseUrl).host}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(CATCH_UP_CONCURRENCY, queue.length) }, worker));
	}

	reconcile(rows: readonly ShareRow[]): void {
		if (this.#closed) return;
		const liveIds = new Set(rows.map(row => row.id));
		for (const id of [...this.#cursors.keys(), ...this.#keys.keys()]) {
			if (!liveIds.has(id)) {
				this.#cursors.delete(id);
				this.#keys.delete(id);
			}
		}
		const desired = new Map<string, readonly ShareRow[]>();
		const byBase = new Map<string, ShareRow[]>();
		for (const row of rows) byBase.set(row.baseUrl, [...(byBase.get(row.baseUrl) ?? []), row]);
		for (const [base, group] of byBase) {
			for (let start = 0; start < group.length; start += SHARES_PER_STREAM) desired.set(`${base}#${start / SHARES_PER_STREAM}`, group.slice(start, start + SHARES_PER_STREAM));
		}
		for (const [key, stream] of this.#streams) {
			const group = desired.get(key);
			if (group === undefined || this.#signature(group) !== stream.signature) {
				stream.abort.abort();
				this.#streams.delete(key);
			}
		}
		for (const [key, group] of desired) {
			if (this.#streams.has(key) || this.#streams.size >= MAX_STREAMS) continue;
			const abort = new AbortController();
			this.#streams.set(key, { signature: this.#signature(group), abort, done: this.#run(group, abort.signal) });
		}
	}

	#signature(group: readonly ShareRow[]): string {
		return group.map(row => `${row.id}:${row.ownerToken.length}`).join(",");
	}

	async #run(group: readonly ShareRow[], signal: AbortSignal): Promise<void> {
		const fetcher = this.#options.fetch ?? fetch;
		const backoff = this.#options.backoff ?? STREAM_BACKOFF;
		const first = group[0];
		if (first === undefined) return;
		const relayed = first.host === P2P_HOST_ID;
		const byRemote = new Map(group.map(row => [row.remoteId, row]));
		let attempt = 0;
		while (!signal.aborted) {
			try {
				const shares = group.map(row => {
					const after = this.#cursor(row);
					return { id: row.remoteId, ...(relayed ? {} : { ownerToken: row.ownerToken }), ...(after === undefined ? {} : { after }) };
				});
				const response = await fetcher(`${first.baseUrl.replace(/\/+$/, "")}/api/v1/events`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "text/event-stream", ...(relayed ? { authorization: `Bearer ${first.ownerToken}` } : {}) },
					body: JSON.stringify({ shares }),
					signal,
				});
				if (!response.ok || response.body === null) throw new Error(`the server answered ${response.status}`);
				for await (const event of readEvents(response.body)) {
					attempt = 0;
					await this.#handle(event.event, event.data, byRemote);
				}
			} catch (error) {
				if (signal.aborted) return;
				this.#options.log?.(`comment stream from ${new URL(first.baseUrl).host} dropped: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				await sleepFor(Math.max(backoff.baseMs, backoffDelay(attempt++, backoff)), signal);
			} catch {
				return;
			}
		}
	}

	async #handle(event: string, data: string, byRemote: ReadonlyMap<string, ShareRow>): Promise<void> {
		let payload: unknown;
		try {
			payload = JSON.parse(data);
		} catch {
			return;
		}
		if (event === "comment") {
			const parsed = commentEventSchema.safeParse(payload);
			const row = parsed.success ? byRemote.get(parsed.data.share) : undefined;
			if (parsed.success && row !== undefined) await this.#ingest(row, parsed.data);
		} else if (event === "revoked") {
			const parsed = revokedEventSchema.safeParse(payload);
			const row = parsed.success ? byRemote.get(parsed.data.share) : undefined;
			if (parsed.success && row !== undefined) this.#markEnded(row, parsed.data.reason);
		} else if (event === "ready") {
			const parsed = readyEventSchema.safeParse(payload);
			if (!parsed.success) return;
			for (const rejected of parsed.data.rejected) {
				const row = byRemote.get(rejected.id);
				if (row !== undefined && (rejected.error === "revoked" || rejected.error === "expired")) this.#markEnded(row, rejected.error);
			}
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		const streams = [...this.#streams.values()];
		this.#streams.clear();
		for (const stream of streams) stream.abort.abort();
		await Promise.all(streams.map(stream => stream.done));
	}
}
