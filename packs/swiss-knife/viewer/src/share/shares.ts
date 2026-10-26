import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { TUNNEL_MAX_ANNOUNCED_SHARES } from "@dimension/artifact-host/tunnel-protocol";
import {
	AspError,
	type Audience,
	audienceAllowedBy,
	type CommentAnchor,
	decodeBase64Url,
	deriveCommentKey,
	encodeBase64Url,
	generateContentKey,
	importContentKey,
	newVersionPrefix,
	type SharePolicy,
	sealComment,
	sealedSize,
	sealManifest,
	shareLink,
} from "@dimension/sdk/artifact-share";
import { errorMessage } from "../../../src/library/errors";
import { deleteRemoteShare, revokeRemote } from "../../../src/library/remote";
import { shareUrl } from "../../../src/library/rows";
import type { CommentRow, Library, LibraryItem, ShareRow, ShareSummary } from "../../../src/library/types";
import type { Fence } from "../fence";
import { type ChunkSource, FileChangedError, openChunkSource } from "./chunk-source";
import type { CommentSync } from "./comments";
import type { HostDirectory } from "./directory";
import { StoredFileError } from "./fs-json";
import { HostClient, HostRequestError, type PostedComment } from "./host-api";
import { HostConfigError, P2P_HOST_ID } from "./hosts";
import { buildManifest } from "./manifest";
import type { P2pRuntime } from "./p2p";
import { type PendingUpload, uploadVersion } from "./upload";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;
const MAX_PROGRESS_ENTRIES = 64;
const COMMENT_CATCH_UP_MS = 4000;
const MAX_AUTHOR_CHARS = 80;
const OPEN_LINK_ONLY = "a link from this computer is open to anyone who has it; signing in needs your own server";
const BUSY = "that file is already being shared; wait for it to finish";

export class ShareError extends Error {
	override readonly name = "ShareError";
}

export type SharePhase = "sealing" | "uploading" | "done" | "failed";

export interface ShareProgress {
	readonly phase: SharePhase;
	readonly sent: number;
	readonly total: number;
	readonly error?: string;
	readonly shareId?: string;
}

export interface CreateShareInput {
	readonly artifactId: string;
	readonly host: string;
	readonly audience: Audience;
	readonly expiresInDays?: number;
	readonly allowComments: boolean;
}

export interface ShareUpdateInput {
	readonly shareId: string;
	readonly audience?: Audience;
	readonly expiresInDays?: number;
	readonly allowComments?: boolean;
}

export type CreatedShare = ShareSummary & { readonly link: string };
export type CommentWithUrl = CommentRow & { readonly shareUrl: string };

export interface RevokeOutcome {
	readonly shareId: string;
	readonly revokedAt: number;
	readonly warning?: string;
}

export interface ShareServiceOptions {
	readonly library: Library;
	readonly fence: Fence;
	readonly directory: HostDirectory;
	readonly p2p: P2pRuntime;
	readonly sync: CommentSync;
	readonly onSharesChanged: () => void;
	readonly now?: () => number;
	readonly displayName?: () => Promise<string | undefined>;
}

interface UploadSession {
	readonly pending: PendingUpload;
	readonly keyBytes: Uint8Array;
	readonly key: CryptoKey;
	readonly baseUrl: string;
	readonly signature?: string;
	readonly expiresAt?: number;
}

function failureMessage(error: unknown): string {
	const known =
		error instanceof ShareError ||
		error instanceof HostRequestError ||
		error instanceof HostConfigError ||
		error instanceof FileChangedError ||
		error instanceof StoredFileError;
	return known ? error.message : `sharing failed: ${errorMessage(error)}`;
}

function sameFingerprint(session: UploadSession, source: ChunkSource): boolean {
	return session.pending.fingerprint.size === source.size && session.pending.fingerprint.mtimeMs === source.mtimeMs;
}

export class ShareService {
	readonly #options: ShareServiceOptions;
	readonly #library: Library;
	readonly #now: () => number;
	readonly #abort = new AbortController();
	readonly #running = new Set<string>();
	readonly #progress = new Map<string, ShareProgress>();
	readonly #sessions = new Map<string, UploadSession>();

	constructor(options: ShareServiceOptions) {
		this.#options = options;
		this.#library = options.library;
		this.#now = options.now ?? Date.now;
	}

	close(): void {
		this.#abort.abort();
	}

	progress(artifactId: string): ShareProgress {
		return this.#progress.get(artifactId) ?? { phase: "done", sent: 0, total: 0 };
	}

	#report(artifactId: string, progress: ShareProgress): void {
		this.#progress.delete(artifactId);
		this.#progress.set(artifactId, progress);
		for (const [oldest] of this.#progress) {
			if (this.#progress.size <= MAX_PROGRESS_ENTRIES) break;
			this.#progress.delete(oldest);
		}
	}

	summarize(shareId: string): ShareSummary {
		const summary = this.#library.shares.summary(shareId);
		if (summary === undefined) throw new ShareError("that share does not exist");
		return summary;
	}

	#liveItem(artifactId: string): LibraryItem {
		const item = this.#library.get(artifactId);
		if (item === undefined) throw new ShareError("that file is not in your library");
		if (item.state === "discarded") throw new ShareError("that file was discarded, so it cannot be shared");
		if (item.state === "missing") throw new ShareError("that file is no longer on this computer");
		return item;
	}

	async #realPath(item: LibraryItem): Promise<string> {
		const verdict = await this.#options.fence.check(item.path);
		if (!verdict.ok) throw new ShareError(`that file cannot be shared: ${verdict.reason}`);
		if (this.#library.getByPath(verdict.real)?.id !== item.id) throw new ShareError("that file moved since it was added to your library; open the library to refresh it");
		return verdict.real;
	}

	#liveRow(shareId: string): ShareRow {
		const row = this.#library.shares.get(shareId);
		if (row === undefined) throw new ShareError("that share does not exist");
		if (row.revokedAt !== undefined) throw new ShareError("that link has been revoked");
		return row;
	}

	linkOf(shareId: string): string {
		const row = this.#liveRow(shareId);
		return shareLink({ base: row.baseUrl, id: row.remoteId, key: decodeBase64Url(row.key) });
	}

	async #track<T>(artifactId: string, work: () => Promise<T>): Promise<T> {
		if (this.#running.has(artifactId)) throw new ShareError(BUSY);
		this.#running.add(artifactId);
		this.#report(artifactId, { phase: "sealing", sent: 0, total: 0 });
		try {
			return await work();
		} catch (error) {
			const last = this.progress(artifactId);
			const message = failureMessage(error);
			this.#report(artifactId, { phase: "failed", sent: last.sent, total: last.total, error: message });
			throw error instanceof ShareError ? error : new ShareError(message);
		} finally {
			this.#running.delete(artifactId);
		}
	}

	#finish(artifactId: string, shareId: string): void {
		const { total } = this.progress(artifactId);
		this.#report(artifactId, { phase: "done", sent: total, total, shareId });
	}

	async create(input: CreateShareInput): Promise<CreatedShare> {
		const item = this.#liveItem(input.artifactId);
		return this.#track(item.id, async () => {
			const row = input.host === P2P_HOST_ID ? await this.#createP2p(input, item) : await this.#createHosted(input, item);
			this.#finish(item.id, row.id);
			this.#options.onSharesChanged();
			return { ...this.summarize(row.id), link: this.linkOf(row.id) };
		});
	}

	#checkPolicy(audience: Audience, expiresInDays: number | undefined, policy: SharePolicy, oidc: boolean, size: number | undefined): void {
		const refusal = audienceAllowedBy(audience, policy);
		if (refusal !== undefined) throw new ShareError(refusal);
		if (audience.kind === "signin" && !oidc) throw new ShareError("this server has no sign-in set up, so a link that needs signing in cannot be made here");
		if (expiresInDays !== undefined && expiresInDays > policy.maxDays) throw new ShareError(`this server keeps shares for at most ${policy.maxDays} days`);
		if (size !== undefined && size > policy.maxBytes) throw new ShareError(`this server accepts files up to ${policy.maxBytes} bytes; this one is ${size}`);
	}

	async #createP2p(input: CreateShareInput, item: LibraryItem): Promise<ShareRow> {
		if (input.audience.kind !== "link") throw new ShareError(OPEN_LINK_ONLY);
		const live = this.#options.p2p.liveRows().length;
		if (live >= TUNNEL_MAX_ANNOUNCED_SHARES) throw new ShareError(`this computer already shares ${live} links directly; stop one or use a share server`);
		const { discovery } = await this.#options.directory.resolveRelay();
		const refusal = audienceAllowedBy(input.audience, discovery.policy);
		if (refusal !== undefined) throw new ShareError(refusal);
		const real = await this.#realPath(item);
		const info = await stat(real);
		if (!info.isFile()) throw new ShareError("only a regular file can be shared");
		const fingerprint = { size: info.size, mtimeMs: info.mtimeMs };
		return this.#options.p2p.withTunnel(async session => {
			const id = encodeBase64Url(randomBytes(16));
			const now = this.#now();
			const row: ShareRow = {
				id,
				artifactId: item.id,
				host: P2P_HOST_ID,
				remoteId: id,
				baseUrl: session.baseUrl,
				key: encodeBase64Url(generateContentKey()),
				ownerToken: session.token,
				audience: { kind: "link" },
				version: 1,
				versionAt: now,
				allowComments: input.allowComments,
				createdAt: now,
				...(input.expiresInDays === undefined ? {} : { expiresAt: now + input.expiresInDays * DAY_MS }),
			};
			await this.#options.p2p.server.create(row, item, fingerprint);
			try {
				this.#library.shares.insert(row);
			} catch (error) {
				await this.#options.p2p.server.forget(id);
				throw error;
			}
			this.#options.p2p.announce();
			return row;
		});
	}

	async #createHosted(input: CreateShareInput, item: LibraryItem): Promise<ShareRow> {
		const { host, client, discovery } = await this.#options.directory.resolve(input.host);
		const source = await openChunkSource(await this.#realPath(item));
		try {
			this.#checkPolicy(input.audience, input.expiresInDays, discovery.policy, discovery.auth.oidc !== undefined, source.size);
			const sessionKey = `create|${item.id}|${host.id}`;
			const signature = JSON.stringify([input.audience, input.expiresInDays ?? null, input.allowComments, client.baseUrl]);
			let session = this.#sessions.get(sessionKey);
			if (session !== undefined && (session.signature !== signature || !sameFingerprint(session, source))) {
				this.#dropSession(sessionKey, session);
				session = undefined;
			}
			if (session === undefined) {
				const keyBytes = generateContentKey();
				const key = await importContentKey(keyBytes);
				const requestedExpiry = input.expiresInDays === undefined ? undefined : this.#now() + input.expiresInDays * DAY_MS;
				const created = await client.createShare(
					host.token,
					{
						audience: input.audience,
						...(requestedExpiry === undefined ? {} : { expiresAt: requestedExpiry }),
						allowComments: input.allowComments,
						chunks: source.chunks,
						sealedBytes: sealedSize(source.size),
					},
					this.#abort.signal,
				);
				const expiresAt = created.expiresAt ?? requestedExpiry;
				session = {
					pending: await this.#pendingFor(item, key, created.id, created.ownerToken, created.version, source),
					keyBytes,
					key,
					baseUrl: client.baseUrl,
					signature,
					...(expiresAt === undefined ? {} : { expiresAt }),
				};
				this.#keepSession(sessionKey, session);
			}
			await this.#upload(item.id, sessionKey, session, client, source);
			const createdAt = this.#now();
			const row: ShareRow = {
				id: encodeBase64Url(randomBytes(16)),
				artifactId: item.id,
				host: host.id,
				remoteId: session.pending.remoteId,
				baseUrl: client.baseUrl,
				key: encodeBase64Url(session.keyBytes),
				ownerToken: session.pending.ownerToken,
				audience: input.audience,
				version: session.pending.version,
				versionAt: createdAt,
				allowComments: input.allowComments,
				createdAt,
				...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
			};
			try {
				this.#library.shares.insert(row);
			} catch (error) {
				this.#dropSession(sessionKey, session);
				throw error;
			}
			this.#sessions.delete(sessionKey);
			return row;
		} finally {
			await source.close();
		}
	}

	async #pendingFor(item: LibraryItem, key: CryptoKey, remoteId: string, ownerToken: string, version: number, source: ChunkSource): Promise<PendingUpload> {
		const prefix = newVersionPrefix();
		const manifest = await buildManifest(this.#library, item, version, source.size);
		return {
			remoteId,
			ownerToken,
			version,
			prefix,
			sealedManifest: await sealManifest(key, prefix, manifest),
			fingerprint: { size: source.size, mtimeMs: source.mtimeMs },
			chunks: source.chunks,
			sealedBytes: sealedSize(source.size),
			done: new Set<number>(),
		};
	}

	#keepSession(sessionKey: string, session: UploadSession): void {
		this.#sessions.set(sessionKey, session);
		for (const [oldestKey, oldest] of this.#sessions) {
			if (this.#sessions.size <= MAX_SESSIONS) break;
			this.#dropSession(oldestKey, oldest);
		}
	}

	#dropSession(sessionKey: string, session: UploadSession): void {
		this.#sessions.delete(sessionKey);
		void deleteRemoteShare({ baseUrl: session.baseUrl, remoteId: session.pending.remoteId, ownerToken: session.pending.ownerToken }).catch(() => undefined);
	}

	async #upload(artifactId: string, sessionKey: string, session: UploadSession, client: HostClient, source: ChunkSource): Promise<void> {
		const total = session.pending.sealedBytes;
		this.#report(artifactId, { phase: "uploading", sent: 0, total });
		try {
			await uploadVersion(session.pending, {
				client,
				key: session.key,
				source,
				signal: this.#abort.signal,
				onProgress: sent => this.#report(artifactId, { phase: "uploading", sent, total }),
			});
		} catch (error) {
			if (!(error instanceof HostRequestError && error.retryable)) this.#dropSession(sessionKey, session);
			throw error;
		}
	}

	async newVersion(shareId: string): Promise<ShareSummary> {
		const row = this.#liveRow(shareId);
		return this.#track(row.artifactId, async () => {
			if (row.host === P2P_HOST_ID) await this.#options.p2p.server.newVersion(row);
			else await this.#newHostedVersion(row);
			this.#options.p2p.announce();
			this.#finish(row.artifactId, row.id);
			return this.summarize(row.id);
		});
	}

	async #newHostedVersion(row: ShareRow): Promise<void> {
		const item = this.#liveItem(row.artifactId);
		const { client, discovery } = await this.#options.directory.resolve(row.host);
		const source = await openChunkSource(await this.#realPath(item));
		try {
			this.#checkPolicy(row.audience, undefined, discovery.policy, discovery.auth.oidc !== undefined, source.size);
			const sessionKey = `version|${row.id}`;
			let session = this.#sessions.get(sessionKey);
			if (session !== undefined && !sameFingerprint(session, source)) {
				this.#sessions.delete(sessionKey);
				session = undefined;
			}
			if (session === undefined) {
				const version = await client.createVersion(row.ownerToken, row.remoteId, { chunks: source.chunks, sealedBytes: sealedSize(source.size) }, this.#abort.signal);
				const keyBytes = decodeBase64Url(row.key);
				const key = await importContentKey(keyBytes);
				session = { pending: await this.#pendingFor(item, key, row.remoteId, row.ownerToken, version, source), keyBytes, key, baseUrl: client.baseUrl };
				this.#sessions.set(sessionKey, session);
			}
			await this.#upload(row.artifactId, sessionKey, session, client, source);
			this.#sessions.delete(sessionKey);
			this.#library.shares.update(row.id, { version: session.pending.version, versionAt: this.#now() });
		} finally {
			await source.close();
		}
	}

	async update(input: ShareUpdateInput): Promise<ShareSummary> {
		const row = this.#liveRow(input.shareId);
		const audience = input.audience ?? row.audience;
		const patch: { audience?: Audience; expiresAt?: number; allowComments?: boolean } = {};
		if (input.expiresInDays !== undefined) patch.expiresAt = this.#now() + input.expiresInDays * DAY_MS;
		if (input.audience !== undefined) patch.audience = input.audience;
		if (input.allowComments !== undefined) patch.allowComments = input.allowComments;
		if (row.host === P2P_HOST_ID) {
			if (audience.kind !== "link") throw new ShareError(OPEN_LINK_ONLY);
		} else {
			const { client, discovery } = await this.#options.directory.resolve(row.host);
			this.#checkPolicy(audience, input.expiresInDays, discovery.policy, discovery.auth.oidc !== undefined, undefined);
			try {
				const confirmed = await client.patch(row.ownerToken, row.remoteId, patch, this.#abort.signal);
				if (confirmed.expiresAt !== undefined) patch.expiresAt = confirmed.expiresAt;
			} catch (error) {
				throw new ShareError(failureMessage(error));
			}
		}
		this.#library.shares.update(row.id, patch);
		this.#options.onSharesChanged();
		return this.summarize(row.id);
	}

	async revoke(shareId: string): Promise<RevokeOutcome> {
		const row = this.#library.shares.get(shareId);
		if (row === undefined) throw new ShareError("that share does not exist");
		if (row.revokedAt !== undefined) return { shareId, revokedAt: row.revokedAt };
		const revokedAt = this.#now();
		if (row.host === P2P_HOST_ID) {
			this.#library.shares.update(row.id, { revokedAt });
			await this.#options.p2p.server.forget(row.id);
			let warning: string | undefined;
			try {
				await revokeRemote(row);
			} catch (error) {
				warning = errorMessage(error);
			}
			this.#options.onSharesChanged();
			return { shareId, revokedAt, ...(warning === undefined ? {} : { warning }) };
		}
		try {
			await revokeRemote(row);
		} catch (error) {
			throw new ShareError(errorMessage(error));
		}
		this.#library.shares.update(row.id, { revokedAt });
		this.#options.onSharesChanged();
		return { shareId, revokedAt };
	}

	async comments(artifactId: string): Promise<readonly CommentWithUrl[]> {
		const live = this.#library.shares.forArtifact(artifactId).filter(row => row.revokedAt === undefined);
		await this.#options.sync.catchUp(live, AbortSignal.timeout(COMMENT_CATCH_UP_MS));
		return this.#library.comments.forArtifact(artifactId);
	}

	markRead(ids: readonly string[]): void {
		this.#library.comments.markRead(ids, this.#now());
	}

	async reply(shareId: string, body: string, anchor?: CommentAnchor): Promise<CommentWithUrl> {
		const row = this.#liveRow(shareId);
		if (!row.allowComments) throw new ShareError("comments are turned off for this link");
		const author = ((await this.#options.displayName?.()) ?? userInfo().username).slice(0, MAX_AUTHOR_CHARS);
		const at = this.#now();
		let sealed: Uint8Array;
		try {
			sealed = await sealComment(await deriveCommentKey(decodeBase64Url(row.key)), { author, body, ...(anchor === undefined ? {} : { anchor }), version: row.version, at });
		} catch (error) {
			if (error instanceof AspError) throw new ShareError("that reply is empty or longer than 8000 characters");
			throw error;
		}
		let posted: PostedComment;
		try {
			posted = await new HostClient(row.baseUrl).postComment(row.ownerToken, row.remoteId, encodeBase64Url(sealed), this.#abort.signal);
		} catch (error) {
			throw new ShareError(failureMessage(error));
		}
		this.#library.comments.upsert({
			id: posted.id,
			shareId: row.id,
			author,
			body: body.trim(),
			...(anchor === undefined ? {} : { anchor }),
			version: row.version,
			createdAt: posted.at,
		});
		this.#library.comments.markRead([posted.id], at);
		const stored = this.#library.comments.get(posted.id);
		if (stored === undefined) throw new ShareError("the reply was posted but could not be read back");
		return stored;
	}
}
