import type { Audience, SharePolicy } from "@dimension/sdk/artifact-share";
import { createToolCaller } from "@dimension/mcp-app-kit/tools";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CommentRow, LibraryFacets, LibraryItem, LibraryPage, LibraryQuery, ShareSummary, ThumbMime } from "../../../../src/library/types";
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

export interface DiscardResult {
	readonly item: LibraryItem;
	readonly trashed: boolean;
	readonly revoked: number;
}

export interface LibraryTools {
	readonly query: (args: LibraryQuery, signal?: AbortSignal) => Promise<LibraryPage>;
	readonly facets: (scope: { readonly workspace?: string; readonly state?: "live" | "discarded" }, signal?: AbortSignal) => Promise<LibraryFacets>;
	readonly check: (ids: readonly string[], signal?: AbortSignal) => Promise<readonly ({ readonly id: string } & CheckedRow)[]>;
	readonly update: (id: string, patch: ArtifactPatchInput) => Promise<LibraryItem>;
	readonly stamp: (path: string) => Promise<LibraryItem>;
	readonly discardDefault: (id: string) => Promise<boolean>;
	readonly discard: (id: string, trash: boolean) => Promise<DiscardResult>;
	readonly restore: (id: string) => Promise<LibraryItem>;
	readonly open: (id: string) => Promise<CallToolResult>;
	readonly thumbsBase: () => Promise<string>;
	readonly setThumb: (id: string, data: string, mime: ThumbMime) => Promise<void>;
	readonly hosts: () => Promise<ShareHosts>;
	readonly addHost: (pairing: HostPairing) => Promise<ShareHost>;
	readonly removeHost: (id: string) => Promise<void>;
	readonly share: (request: ShareRequest) => Promise<LinkedShare>;
	readonly shareProgress: (artifactId: string) => Promise<ShareProgress>;
	readonly changeShare: (change: ShareChange) => Promise<void>;
	readonly newVersion: (shareId: string) => Promise<void>;
	readonly revoke: (shareId: string) => Promise<void>;
	readonly link: (shareId: string) => Promise<string>;
	readonly comments: (artifactId: string, signal?: AbortSignal) => Promise<readonly ShareComment[]>;
	readonly reply: (shareId: string, body: string) => Promise<ShareComment>;
	readonly markRead: (ids: readonly string[]) => Promise<void>;
}

export function createLibraryTools(app: Pick<App, "callServerTool">): LibraryTools {
	const tools = createToolCaller(app);
	const options = (signal: AbortSignal | undefined) => (signal === undefined ? undefined : { signal });
	return {
		query: (args, signal) => tools.whole<LibraryPage>("library_query", { ...args }, options(signal)),
		facets: (scope, signal) => tools.whole<LibraryFacets>("library_facets", { ...scope }, options(signal)),
		check: (ids, signal) => tools.call("library_check", { ids }, "items", options(signal)),
		update: (id, patch) => tools.call("library_update", { id, ...patch }, "item"),
		stamp: path => tools.call("library_stamp", { path }, "item"),
		discardDefault: id => tools.call("library_discard_default", { id }, "trash"),
		discard: (id, trash) => tools.whole<DiscardResult>("library_discard", { id, trash }),
		restore: id => tools.call("library_restore", { id }, "item"),
		open: id => tools.raw("library_open", { id }),
		thumbsBase: () => tools.call("library_thumbs", {}, "base"),
		setThumb: async (id, data, mime) => {
			await tools.whole("library_set_thumb", { id, data, mime });
		},
		hosts: () => tools.whole<ShareHosts>("share_hosts", {}),
		addHost: pairing => tools.call("share_host_add", { ...pairing }, "host"),
		removeHost: async id => {
			await tools.raw("share_host_remove", { id }).then(failOnError);
		},
		share: request => tools.call("share_create", { ...request }, "share"),
		shareProgress: artifactId => tools.whole<ShareProgress>("share_progress", { artifactId }),
		changeShare: async change => {
			await tools.raw("share_update", { ...change }).then(failOnError);
		},
		newVersion: async shareId => {
			await tools.raw("share_new_version", { shareId }).then(failOnError);
		},
		revoke: async shareId => {
			await tools.raw("share_revoke", { shareId }).then(failOnError);
		},
		link: shareId => tools.call("share_link", { shareId }, "link"),
		comments: (artifactId, signal) => tools.call("share_comments", { artifactId }, "comments", options(signal)),
		reply: (shareId, body) => tools.call("share_reply", { shareId, body }, "comment"),
		markRead: async ids => {
			await tools.raw("share_mark_read", { ids }).then(failOnError);
		},
	};
}

function failOnError(result: CallToolResult): CallToolResult {
	if (!result.isError) return result;
	const text = result.content
		.map(block => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();
	throw new Error(text || "The viewer server refused that.");
}

export function thumbUrl(base: string, item: Pick<LibraryItem, "id" | "presentedAt">, bump: number): string {
	return `${base}/${encodeURIComponent(item.id)}?v=${item.presentedAt}-${bump}`;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
