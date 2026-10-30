import type { Audience, CommentAnchor, SharePolicy } from "@dimension/sdk/artifact-share";
import { createToolCaller } from "@dimension/mcp-app-kit/tools";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CommentRow, DiscardOutcome, LibraryFacets, LibraryItem, LibraryPage, LibraryQuery, ShareSummary, ThumbMime } from "../../../../src/library/types";
import { type RevisionSpan, spanOf } from "../../../../src/library/revision";
import type { CheckedRow } from "./query";

export interface ShareHost {
	readonly id: string;
	readonly kind: "p2p" | "self" | "company" | "dimension";
	readonly name: string;
	readonly baseUrl: string;
	readonly status: "ok" | "unreachable" | "unauthorized";
	readonly policy?: SharePolicy;
	readonly oidc: boolean;
	readonly managed: boolean;
}

export interface ShareHosts {
	readonly hosts: readonly ShareHost[];
	readonly p2pAllowed: boolean;
	readonly cloudAllowed: boolean;
}

export interface ShareProgress {
	readonly phase: "sealing" | "uploading" | "done" | "failed";
	readonly sent: number;
	readonly total: number;
	readonly error?: string;
	readonly shareId?: string;
}

export type LinkedShare = ShareSummary & { readonly link: string };
export type ShareComment = CommentRow & { readonly shareUrl: string };

export interface ShareRequest {
	readonly artifactId: string;
	readonly host: string;
	readonly audience: Audience;
	readonly expiresInDays?: number;
	readonly allowComments: boolean;
}

export interface ShareChange {
	readonly shareId: string;
	readonly audience?: Audience;
	readonly expiresInDays?: number;
	readonly allowComments?: boolean;
}

export type HostPairing = { readonly pairing: string; readonly kind: "self" | "company" } | { readonly url: string; readonly token: string; readonly kind: "self" | "company" };

export interface ArtifactPatchInput {
	readonly title?: string | null;
	readonly note?: string | null;
	readonly tags?: readonly string[];
	readonly starred?: boolean;
}

export interface RevokeOutcome {
	readonly shareId: string;
	readonly revokedAt: number;
	readonly warning?: string;
}

export interface LibraryTools {
	readonly query: (args: LibraryQuery, signal?: AbortSignal) => Promise<LibraryPage>;
	readonly revision: (signal?: AbortSignal) => Promise<string>;
	readonly onWrite: (listener: (span: RevisionSpan) => void) => () => void;
	readonly facets: (scope: { readonly workspace?: string; readonly state?: "live" | "discarded" }, signal?: AbortSignal) => Promise<LibraryFacets>;
	readonly check: (ids: readonly string[], signal?: AbortSignal) => Promise<readonly ({ readonly id: string } & CheckedRow)[]>;
	readonly update: (id: string, patch: ArtifactPatchInput) => Promise<LibraryItem>;
	readonly stamp: (path: string) => Promise<LibraryItem>;
	readonly discardDefault: (id: string) => Promise<boolean>;
	readonly discard: (id: string, trash: boolean) => Promise<DiscardOutcome>;
	readonly restore: (id: string) => Promise<LibraryItem>;
	readonly open: (id: string) => Promise<CallToolResult>;
	readonly thumbsBase: () => Promise<string>;
	readonly setThumb: (id: string, data: string, mime: ThumbMime) => Promise<void>;
	readonly hosts: () => Promise<ShareHosts>;
	readonly addHost: (pairing: HostPairing) => Promise<ShareHost>;
	readonly removeHost: (id: string) => Promise<void>;
	readonly share: (request: ShareRequest) => Promise<LinkedShare>;
	readonly shareProgress: (artifactId: string) => Promise<ShareProgress>;
	readonly changeShare: (change: ShareChange) => Promise<ShareSummary>;
	readonly newVersion: (shareId: string) => Promise<ShareSummary>;
	readonly revoke: (shareId: string) => Promise<RevokeOutcome>;
	readonly link: (shareId: string) => Promise<string>;
	readonly comments: (artifactId: string, signal?: AbortSignal) => Promise<readonly ShareComment[]>;
	readonly reply: (shareId: string, body: string, anchor?: CommentAnchor) => Promise<ShareComment>;
	readonly markRead: (ids: readonly string[]) => Promise<void>;
	readonly askAgent: (text: string) => Promise<void>;
}

export function createLibraryTools(app: Pick<App, "callServerTool" | "sendMessage">): LibraryTools {
	const tools = createToolCaller(app);
	const listeners = new Set<(span: RevisionSpan) => void>();
	const announce = (content: unknown): void => {
		const span = spanOf(content);
		if (span === undefined) return;
		for (const listener of listeners) listener(span);
	};
	const options = (signal: AbortSignal | undefined) => (signal === undefined ? undefined : { signal });
	return {
		query: (args, signal) => tools.whole<LibraryPage>("library_query", { ...args }, options(signal)),
		facets: (scope, signal) => tools.whole<LibraryFacets>("library_facets", { ...scope }, options(signal)),
		revision: signal => tools.call("library_revision", {}, "revision", options(signal)),
		check: (ids, signal) => tools.call("library_check", { ids }, "items", options(signal)),
		update: async (id, patch) => {
			const answer = await tools.whole<{ readonly item: LibraryItem }>("library_update", { id, ...patch });
			announce(answer);
			return answer.item;
		},
		stamp: path => tools.call("library_stamp", { path }, "item"),
		discardDefault: id => tools.call("library_discard_default", { id }, "trash"),
		discard: (id, trash) => tools.whole<DiscardOutcome>("library_discard", { id, trash }),
		restore: id => tools.call("library_restore", { id }, "item"),
		open: async id => {
			const result = await tools.raw("library_open", { id });
			announce(result.structuredContent);
			return result;
		},
		thumbsBase: () => tools.call("library_thumbs", {}, "base"),
		setThumb: async (id, data, mime) => {
			announce(await tools.whole("library_set_thumb", { id, data, mime }));
		},
		hosts: () => tools.whole<ShareHosts>("share_hosts", {}),
		addHost: pairing => tools.call("share_host_add", { ...pairing }, "host"),
		removeHost: async id => {
			await tools.whole("share_host_remove", { id });
		},
		share: request => tools.call("share_create", { ...request }, "share"),
		shareProgress: artifactId => tools.whole<ShareProgress>("share_progress", { artifactId }),
		changeShare: change => tools.call<ShareSummary>("share_update", { ...change }, "share"),
		newVersion: shareId => tools.call<ShareSummary>("share_new_version", { shareId }, "share"),
		revoke: shareId => tools.whole<RevokeOutcome>("share_revoke", { shareId }),
		link: shareId => tools.call("share_link", { shareId }, "link"),
		comments: (artifactId, signal) => tools.call("share_comments", { artifactId }, "comments", options(signal)),
		reply: (shareId, body, anchor) => tools.call("share_reply", { shareId, body, ...(anchor === undefined ? {} : { anchor }) }, "comment"),
		markRead: async ids => {
			announce(await tools.whole("share_mark_read", { ids }));
		},
		onWrite: listener => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		askAgent: async text => {
			const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
			if (result.isError === true) throw new Error("The conversation did not take the message.");
		},
	};
}

export function thumbUrl(base: string, item: Pick<LibraryItem, "id" | "presentedAt">, bump: number): string {
	return `${base}/${encodeURIComponent(item.id)}?v=${item.presentedAt}-${bump}`;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
