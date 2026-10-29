import type { Audience, CommentAnchor } from "@dimension/sdk/artifact-share";
import type { PresentedKind } from "@dimension/sdk/presentation";

export type ArtifactId = string;
export type EpochMs = number;
export type ArtifactSource = "present" | "stamp" | "human";
export type ArtifactState = "live" | "missing" | "discarded";
export type LibrarySort = "recent" | "name" | "size" | "opened" | "relevance";
export type ShareHostId = "p2p" | (string & {});
export type ThumbMime = "image/webp" | "image/png" | "image/jpeg";

export interface ShareRow {
	readonly id: string;
	readonly artifactId: ArtifactId;
	readonly host: ShareHostId;
	readonly remoteId: string;
	readonly baseUrl: string;
	readonly key: string;
	readonly ownerToken: string;
	readonly audience: Audience;
	readonly version: number;
	readonly versionAt: EpochMs;
	readonly allowComments: boolean;
	readonly createdAt: EpochMs;
	readonly expiresAt?: EpochMs;
	readonly revokedAt?: EpochMs;
	readonly commentsSeenAt?: EpochMs;
}

export interface CommentRow {
	readonly id: string;
	readonly shareId: string;
	readonly author: string;
	readonly body: string;
	readonly anchor?: CommentAnchor;
	readonly version: number;
	readonly createdAt: EpochMs;
	readonly readAt?: EpochMs;
	readonly resolvedAt?: EpochMs;
}

export interface ShareSummary {
	readonly id: string;
	readonly host: ShareHostId;
	readonly url: string;
	readonly audience: Audience;
	readonly version: number;
	readonly versionAt: EpochMs;
	readonly allowComments: boolean;
	readonly expiresAt?: EpochMs;
	readonly revokedAt?: EpochMs;
	readonly comments: number;
	readonly unread: number;
}

export interface LibraryItem {
	readonly id: ArtifactId;
	readonly path: string;
	readonly name: string;
	readonly title?: string;
	readonly note?: string;
	readonly tags: readonly string[];
	readonly kind: PresentedKind;
	readonly mime: string;
	readonly size: number;
	readonly mtimeMs: EpochMs;
	readonly width?: number;
	readonly height?: number;
	readonly durationMs?: number;
	readonly workspace?: string;
	readonly sessionId?: string;
	readonly source: ArtifactSource;
	readonly starred: boolean;
	readonly state: ArtifactState;
	readonly createdAt: EpochMs;
	readonly presentedAt: EpochMs;
	readonly openedAt?: EpochMs;
	readonly discardedAt?: EpochMs;
	readonly hasThumb: boolean;
	readonly shares: readonly ShareSummary[];
}

export interface LibraryQuery {
	readonly q?: string;
	readonly kinds?: readonly PresentedKind[];
	readonly tags?: readonly string[];
	readonly workspace?: string;
	readonly state?: "live" | "discarded";
	readonly starred?: boolean;
	readonly shared?: boolean;
	readonly sort?: LibrarySort;
	readonly cursor?: string;
	readonly limit?: number;
}

export interface LibraryPage {
	readonly items: readonly LibraryItem[];
	readonly next?: string;
	readonly total: number;
}

export interface LibraryFacets {
	readonly kinds: Readonly<Partial<Record<PresentedKind, number>>>;
	readonly workspaces: readonly { readonly path: string; readonly count: number }[];
	readonly tags: readonly { readonly tag: string; readonly count: number }[];
	readonly starred: number;
	readonly shared: number;
	readonly discarded: number;
}

export interface StampInput {
	readonly path: string;
	readonly source: ArtifactSource;
	readonly workspace?: string;
	readonly sessionId?: string;
	readonly title?: string;
	readonly note?: string;
	readonly tags?: readonly string[];
	readonly width?: number;
	readonly height?: number;
	readonly thumb?: { readonly bytes: Uint8Array; readonly mime: ThumbMime };
}

export interface ArtifactPatch {
	readonly title?: string | null;
	readonly note?: string | null;
	readonly tags?: readonly string[];
	readonly starred?: boolean;
	readonly durationMs?: number;
}

export interface UnrevokedShare {
	readonly shareId: string;
	readonly host: ShareHostId;
	readonly reason: string;
}

export interface DiscardOutcome {
	readonly item: LibraryItem;
	readonly trashed: boolean;
	readonly trashError?: string;
	readonly revoked: number;
	readonly unrevoked: readonly UnrevokedShare[];
}

export interface LibraryShares {
	insert(row: ShareRow): void;
	update(id: string, patch: Partial<Pick<ShareRow, "version" | "versionAt" | "audience" | "expiresAt" | "revokedAt" | "allowComments" | "commentsSeenAt">>): void;
	get(id: string): ShareRow | undefined;
	summary(id: string): ShareSummary | undefined;
	forArtifact(artifactId: ArtifactId): readonly ShareRow[];
	live(): readonly ShareRow[];
}

export interface LibraryComments {
	upsert(row: CommentRow): boolean;
	forArtifact(artifactId: ArtifactId, options?: { readonly unread?: boolean }): readonly (CommentRow & { readonly shareUrl: string })[];
	get(id: string): (CommentRow & { readonly shareUrl: string }) | undefined;
	latestId(shareId: string): string | undefined;
	markRead(ids: readonly string[], at: EpochMs): void;
}

export interface Library {
	readonly home: string;
	workspaceOf(cwd: string): string;
	query(query: LibraryQuery): LibraryPage;
	facets(scope: { readonly workspace?: string; readonly state?: "live" | "discarded" }): LibraryFacets;
	get(id: ArtifactId): LibraryItem | undefined;
	getByPath(realPath: string): LibraryItem | undefined;
	stamp(input: StampInput): Promise<LibraryItem>;
	update(id: ArtifactId, patch: ArtifactPatch): LibraryItem;
	discard(id: ArtifactId, options: { readonly trash: boolean }): Promise<DiscardOutcome>;
	restore(id: ArtifactId): LibraryItem;
	check(ids: readonly ArtifactId[]): Promise<readonly Pick<LibraryItem, "id" | "state" | "size" | "mtimeMs">[]>;
	markOpened(id: ArtifactId): void;
	setThumb(id: ArtifactId, bytes: Uint8Array, mime: ThumbMime): Promise<void>;
	thumbPath(id: ArtifactId): string | undefined;
	isLent(realPath: string): boolean;
	readonly shares: LibraryShares;
	readonly comments: LibraryComments;
	close(): void;
}

export type RevokeRemote = (share: ShareRow) => Promise<void>;
