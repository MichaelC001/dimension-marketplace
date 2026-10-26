import type { PresentedKind } from "@dimension/sdk/presentation";
import { parseAudience } from "@dimension/sdk/artifact-share";
import { LibraryError } from "./errors";
import type { ArtifactSource, ArtifactState, CommentRow, ShareRow } from "./types";

export interface ArtifactRow {
	readonly id: string;
	readonly path: string;
	readonly path_key: string;
	readonly name: string;
	readonly title: string | null;
	readonly note: string | null;
	readonly tags: string;
	readonly kind: PresentedKind;
	readonly mime: string;
	readonly size: number;
	readonly mtime_ms: number;
	readonly width: number | null;
	readonly height: number | null;
	readonly duration_ms: number | null;
	readonly workspace: string | null;
	readonly session_id: string | null;
	readonly source: ArtifactSource;
	readonly starred: number;
	readonly state: ArtifactState;
	readonly created_at: number;
	readonly presented_at: number;
	readonly opened_at: number | null;
	readonly discarded_at: number | null;
	readonly thumb: string | null;
	readonly score?: number;
}

export interface ShareRecord {
	readonly id: string;
	readonly artifact_id: string;
	readonly host: string;
	readonly remote_id: string;
	readonly base_url: string;
	readonly key: string;
	readonly owner_token: string;
	readonly audience: string;
	readonly version: number;
	readonly version_at: number;
	readonly allow_comments: number;
	readonly created_at: number;
	readonly expires_at: number | null;
	readonly revoked_at: number | null;
	readonly comments_seen_at: number | null;
}

export interface ShareSummaryRecord {
	readonly id: string;
	readonly artifact_id: string;
	readonly host: string;
	readonly remote_id: string;
	readonly base_url: string;
	readonly audience: string;
	readonly version: number;
	readonly version_at: number;
	readonly allow_comments: number;
	readonly expires_at: number | null;
	readonly revoked_at: number | null;
	readonly comments: number;
	readonly unread: number;
}

export interface CommentRecord {
	readonly id: string;
	readonly share_id: string;
	readonly author: string;
	readonly body: string;
	readonly anchor: string | null;
	readonly version: number;
	readonly created_at: number;
	readonly read_at: number | null;
	readonly resolved_at: number | null;
}

export function readTags(text: string): string[] {
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
	} catch {
		return [];
	}
}

export function readAudience(shareId: string, text: string): ShareRow["audience"] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const audience = parseAudience(parsed);
	if (audience === undefined) throw new LibraryError(`share ${shareId} has an unreadable audience in library.db`);
	return audience;
}

export function shareUrl(baseUrl: string, remoteId: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/a/${encodeURIComponent(remoteId)}`;
}

export function shareFromRecord(record: ShareRecord): ShareRow {
	return {
		id: record.id,
		artifactId: record.artifact_id,
		host: record.host,
		remoteId: record.remote_id,
		baseUrl: record.base_url,
		key: record.key,
		ownerToken: record.owner_token,
		audience: readAudience(record.id, record.audience),
		version: record.version,
		versionAt: record.version_at,
		allowComments: record.allow_comments === 1,
		createdAt: record.created_at,
		...(record.expires_at === null ? {} : { expiresAt: record.expires_at }),
		...(record.revoked_at === null ? {} : { revokedAt: record.revoked_at }),
		...(record.comments_seen_at === null ? {} : { commentsSeenAt: record.comments_seen_at }),
	};
}

export function commentFromRecord(record: CommentRecord): CommentRow {
	return {
		id: record.id,
		shareId: record.share_id,
		author: record.author,
		body: record.body,
		...(record.anchor === null ? {} : { anchor: JSON.parse(record.anchor) as unknown }),
		version: record.version,
		createdAt: record.created_at,
		...(record.read_at === null ? {} : { readAt: record.read_at }),
		...(record.resolved_at === null ? {} : { resolvedAt: record.resolved_at }),
	};
}
