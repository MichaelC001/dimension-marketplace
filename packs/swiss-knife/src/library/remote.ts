import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "./errors";
import type { RevokeRemote } from "./types";

const REVOKE_TIMEOUT_MS = 15_000;
const REVOKE_ATTEMPTS = 2;
const RETRY_PAUSE_MS = 600;

export interface RemoteShareAddress {
	readonly baseUrl: string;
	readonly remoteId: string;
	readonly ownerToken: string;
}

async function reasonOf(response: Response): Promise<string> {
	const body: unknown = await response.json().catch(() => undefined);
	if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" && body.message !== "") return body.message;
	return `the server answered ${response.status}`;
}

async function deleteOnce(share: RemoteShareAddress, url: string): Promise<{ readonly done: true } | { readonly done: false; readonly reason: string; readonly retry: boolean }> {
	let response: Response;
	try {
		response = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${share.ownerToken}` }, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) });
	} catch (error) {
		return { done: false, reason: `${new URL(share.baseUrl).host} could not be reached (${errorMessage(error)})`, retry: true };
	}
	if (response.ok || response.status === 404 || response.status === 410) return { done: true };
	return { done: false, reason: await reasonOf(response), retry: response.status >= 500 || response.status === 429 };
}

export async function deleteRemoteShare(share: RemoteShareAddress): Promise<void> {
	const url = `${share.baseUrl.replace(/\/+$/, "")}/api/v1/shares/${encodeURIComponent(share.remoteId)}`;
	for (let attempt = 1; ; attempt++) {
		const outcome = await deleteOnce(share, url);
		if (outcome.done) return;
		if (!outcome.retry || attempt >= REVOKE_ATTEMPTS) throw new Error(`the link could not be revoked: ${outcome.reason}`);
		await sleep(RETRY_PAUSE_MS);
	}
}

export const revokeRemote: RevokeRemote = deleteRemoteShare;
