import { sealChunk, sealedChunkSize } from "@dimension/sdk/artifact-share";
import { type ChunkSource, type Fingerprint, plainChunkBytes } from "./chunk-source";
import { type HostClient, HostRequestError } from "./host-api";

export const UPLOAD_CONCURRENCY = 4;
const COMMIT_ROUNDS = 3;

export interface PendingUpload {
	readonly remoteId: string;
	readonly ownerToken: string;
	readonly version: number;
	readonly prefix: Uint8Array;
	readonly sealedManifest: Uint8Array;
	readonly fingerprint: Fingerprint;
	readonly chunks: number;
	readonly sealedBytes: number;
	readonly done: Set<number>;
}

export interface UploadContext {
	readonly client: HostClient;
	readonly key: CryptoKey;
	readonly source: ChunkSource;
	readonly signal: AbortSignal;
	readonly onProgress: (sentBytes: number) => void;
}

function sealedLength(pending: PendingUpload, index: number): number {
	return sealedChunkSize(plainChunkBytes(pending.fingerprint.size, index));
}

async function uploadMissing(pending: PendingUpload, context: UploadContext, sent: { bytes: number }): Promise<void> {
	const { client, key, source, signal, onProgress } = context;
	const inflight = new Set<Promise<void>>();
	let failure: unknown;
	for (let index = 0; index < pending.chunks && failure === undefined; index++) {
		if (pending.done.has(index)) continue;
		while (inflight.size >= UPLOAD_CONCURRENCY) await Promise.race(inflight);
		if (failure !== undefined) break;
		let sealed: Uint8Array;
		try {
			sealed = await sealChunk(key, pending.prefix, pending.version, index, index === pending.chunks - 1, await source.chunk(index));
		} catch (error) {
			failure = error;
			break;
		}
		const task: Promise<void> = client
			.putChunk(pending.ownerToken, pending.remoteId, pending.version, index, sealed, signal)
			.then(
				() => {
					pending.done.add(index);
					sent.bytes += sealed.length;
					onProgress(sent.bytes);
				},
				(error: unknown) => {
					failure ??= error;
				},
			)
			.finally(() => inflight.delete(task));
		inflight.add(task);
	}
	await Promise.all(inflight);
	if (failure !== undefined) throw failure;
}

export async function uploadVersion(pending: PendingUpload, context: UploadContext): Promise<void> {
	const { client, source, signal, onProgress } = context;
	const sent = { bytes: 0 };
	for (const index of pending.done) sent.bytes += sealedLength(pending, index);
	onProgress(sent.bytes);
	await client.putManifest(pending.ownerToken, pending.remoteId, pending.version, pending.sealedManifest, signal);
	for (let round = 1; ; round++) {
		await uploadMissing(pending, context, sent);
		await source.verifyUnchanged();
		try {
			await client.commit(pending.ownerToken, pending.remoteId, pending.version, signal);
			return;
		} catch (error) {
			const missing = error instanceof HostRequestError && error.code === "incomplete" ? error.missing : undefined;
			if (missing === undefined || missing.length === 0 || round >= COMMIT_ROUNDS) throw error;
			for (const index of missing) {
				if (pending.done.delete(index)) sent.bytes -= sealedLength(pending, index);
			}
		}
	}
}
