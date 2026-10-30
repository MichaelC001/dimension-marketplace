import { constants, statSync } from "node:fs";
import { chmod, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { classifyFile } from "@dimension/sdk/presentation";
import { denyReason, textRefusal } from "../../viewer/src/fence";
import { encodeCursor } from "./cursor";
import { openDriver, restrictDatabaseFiles, type SqlDriver, type SqlStatement, type SqlValue } from "./driver";
import { errorMessage, hasCode, LibraryError } from "./errors";
import { pathKey } from "./paths";
import { EXPIRY_RESOLUTION_MS, LIVE_SHARE_IDS, placeholders, planList } from "./queries";
import { revokeRemote as defaultRevokeRemote } from "./remote";
import {
	type ArtifactRow,
	type CommentRecord,
	commentFromRecord,
	readTags,
	type ShareRecord,
	type ShareSummaryRecord,
	shareFromRecord,
	shareUrl,
	readAudience,
} from "./rows";
import { prepareDatabase } from "./schema";
import { HAS_TAGS, MAX_FACET_TAGS, MAX_TAG_CHARS, MAX_TAGS } from "./tags";
import { moveToTrash } from "./trash";
import { removeThumbs, writeThumb, THUMB_FILE_NAME } from "./thumbs";
import { createWorkspaceResolver } from "./workspace-root";
import type {
	ArtifactId,
	ArtifactPatch,
	CommentRow,
	DiscardOutcome,
	Library,
	LibraryComments,
	LibraryFacets,
	LibraryItem,
	LibraryPage,
	LibraryQuery,
	LibraryShares,
	RevokeRemote,
	ShareRow,
	ShareSummary,
	StampInput,
	ThumbMime,
	UnrevokedShare,
} from "./types";

export interface LibraryOptions {
	readonly home: string;
	readonly projectsFile?: string;
	readonly now?: () => number;
	readonly platform?: NodeJS.Platform;
	readonly revokeRemote?: RevokeRemote;
	readonly trash?: (path: string) => Promise<void>;
}

const HEAD_BYTES = 512;
const CHECK_BATCH = 32;
const MAX_CHECK_IDS = 200;
const STATEMENT_CACHE_LIMIT = 256;
const MAX_TITLE_CHARS = 200;
const MAX_NOTE_CHARS = 4000;
const MAX_FACET_WORKSPACES = 500;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const PRIVATE_DIRECTORY_MODE = 0o700;

const MEMO_LIMIT = 128;

const SHARE_COLUMNS: Record<"version" | "versionAt" | "audience" | "expiresAt" | "revokedAt" | "allowComments" | "commentsSeenAt", string> = {
	version: "version",
	versionAt: "version_at",
	audience: "audience",
	expiresAt: "expires_at",
	revokedAt: "revoked_at",
	allowComments: "allow_comments",
	commentsSeenAt: "comments_seen_at",
};

const UPSERT_ARTIFACT = `
INSERT INTO artifacts(id, path, path_key, name, title, note, tags, kind, mime, size, mtime_ms, width, height,
  workspace, session_id, source, created_at, presented_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, '[]'), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
ON CONFLICT(path_key) DO UPDATE SET
  path = excluded.path, name = excluded.name,
  title = COALESCE(?5, title), note = COALESCE(?6, note), tags = COALESCE(?7, tags),
  kind = excluded.kind, mime = excluded.mime, size = excluded.size, mtime_ms = excluded.mtime_ms,
  width = COALESCE(excluded.width, width), height = COALESCE(excluded.height, height),
  workspace = COALESCE(?14, workspace), session_id = COALESCE(?15, session_id),
  state = 'live', presented_at = ?17, discarded_at = NULL
WHERE artifacts.state != 'discarded' OR ?16 = 'human' OR excluded.mtime_ms > artifacts.discarded_at
`;

const SUMMARY_SELECT = `SELECT s.id, s.artifact_id, s.host, s.remote_id, s.base_url, s.audience, s.version, s.version_at, s.allow_comments, s.expires_at, s.revoked_at,
	(SELECT COUNT(*) FROM comments c WHERE c.share_id = s.id) AS comments,
	(SELECT COUNT(*) FROM comments c WHERE c.share_id = s.id AND c.read_at IS NULL) AS unread
FROM shares s`;

const COMMENT_SELECT = `SELECT c.*, s.base_url AS share_base_url, s.remote_id AS share_remote_id
FROM comments c JOIN shares s ON s.id = c.share_id`;

type CommentJoinRecord = CommentRecord & { readonly share_base_url: string; readonly share_remote_id: string };

function summaryFromRecord(record: ShareSummaryRecord): ShareSummary {
	return {
		id: record.id,
		host: record.host,
		url: shareUrl(record.base_url, record.remote_id),
		audience: readAudience(record.id, record.audience),
		version: record.version,
		versionAt: record.version_at,
		allowComments: record.allow_comments === 1,
		...(record.expires_at === null ? {} : { expiresAt: record.expires_at }),
		...(record.revoked_at === null ? {} : { revokedAt: record.revoked_at }),
		comments: record.comments,
		unread: record.unread,
	};
}

function commentWithUrl(record: CommentJoinRecord): CommentRow & { readonly shareUrl: string } {
	return { ...commentFromRecord(record), shareUrl: shareUrl(record.share_base_url, record.share_remote_id) };
}

function newId(now: number): string {
	let time = "";
	let remaining = now;
	for (let digit = 0; digit < 10; digit++) {
		time = `${CROCKFORD.charAt(remaining % 32)}${time}`;
		remaining = Math.floor(remaining / 32);
	}
	const random = crypto.getRandomValues(new Uint8Array(10));
	return time + Array.from(random, byte => CROCKFORD.charAt(byte % 32)).join("");
}

function cleanText(field: string, value: string | null | undefined, max: number): string | null | undefined {
	if (value === undefined || value === null) return value;
	const trimmed = value.trim();
	if ([...trimmed].length > max) throw new LibraryError(`${field} is longer than ${max} characters`);
	return trimmed === "" ? null : trimmed;
}

function cleanTags(tags: readonly string[] | undefined): string[] | undefined {
	if (tags === undefined) return undefined;
	const seen = new Set<string>();
	const clean: string[] = [];
	for (const tag of tags) {
		const trimmed = tag.trim();
		if (trimmed === "") continue;
		if ([...trimmed].length > MAX_TAG_CHARS) throw new LibraryError(`a tag is longer than ${MAX_TAG_CHARS} characters`);
		const folded = trimmed.toLowerCase();
		if (seen.has(folded)) continue;
		seen.add(folded);
		clean.push(trimmed);
	}
	if (clean.length > MAX_TAGS) throw new LibraryError(`an artifact takes at most ${MAX_TAGS} tags`);
	return clean;
}

export async function createLibrary(options: LibraryOptions): Promise<Library> {
	const now = options.now ?? Date.now;
	const platform = options.platform ?? process.platform;
	const revokeRemote = options.revokeRemote ?? defaultRevokeRemote;
	const trashFile = options.trash ?? ((path: string) => moveToTrash(path, platform));
	const directory = join(options.home, "artifacts");
	const thumbsDirectory = join(directory, "thumbs");
	await mkdir(thumbsDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	if (process.platform !== "win32") await chmod(directory, PRIVATE_DIRECTORY_MODE);
	const databaseFile = join(directory, "library.db");
	const workspaceOf = createWorkspaceResolver({ home: options.home, ...(options.projectsFile === undefined ? {} : { projectsFile: options.projectsFile }) });
	const db: SqlDriver = await openDriver(databaseFile);
	try {
		prepareDatabase(db, now(), workspaceOf);
		await restrictDatabaseFiles(databaseFile);
	} catch (error) {
		db.close();
		throw error;
	}

	const statements = new Map<string, SqlStatement>();
	function releaseStatements(): void {
		for (const statement of statements.values()) statement.finalize();
		statements.clear();
	}
	function sql(text: string): SqlStatement {
		let statement = statements.get(text);
		if (statement === undefined) {
			if (statements.size >= STATEMENT_CACHE_LIMIT) releaseStatements();
			statement = db.prepare(text);
			statements.set(text, statement);
		}
		return statement;
	}

	function rowOf(id: ArtifactId): ArtifactRow | undefined {
		return sql("SELECT * FROM artifacts WHERE id = ?").get<ArtifactRow>(id);
	}

	function requireRow(id: ArtifactId): ArtifactRow {
		const row = rowOf(id);
		if (row === undefined) throw new LibraryError(`no artifact ${id} in the library`);
		return row;
	}

	function summariesOf(ids: readonly ArtifactId[]): Map<string, ShareSummary[]> {
		const byArtifact = new Map<string, ShareSummary[]>();
		if (ids.length === 0) return byArtifact;
		const records = sql(`${SUMMARY_SELECT} WHERE s.artifact_id IN (${placeholders(ids.length)}) ORDER BY s.created_at, s.id`).all<ShareSummaryRecord>(...ids);
		for (const record of records) {
			const summary = summaryFromRecord(record);
			const list = byArtifact.get(record.artifact_id);
			if (list === undefined) byArtifact.set(record.artifact_id, [summary]);
			else list.push(summary);
		}
		return byArtifact;
	}

	function itemsOf(rows: readonly ArtifactRow[]): LibraryItem[] {
		const shares = summariesOf(rows.map(row => row.id));
		return rows.map(row => ({
			id: row.id,
			path: row.path,
			name: row.name,
			...(row.title === null ? {} : { title: row.title }),
			...(row.note === null ? {} : { note: row.note }),
			tags: readTags(row.tags),
			kind: row.kind,
			mime: row.mime,
			size: row.size,
			mtimeMs: row.mtime_ms,
			...(row.width === null ? {} : { width: row.width }),
			...(row.height === null ? {} : { height: row.height }),
			...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
			...(row.workspace === null ? {} : { workspace: row.workspace }),
			...(row.session_id === null ? {} : { sessionId: row.session_id }),
			source: row.source,
			starred: row.starred === 1,
			state: row.state,
			createdAt: row.created_at,
			presentedAt: row.presented_at,
			...(row.opened_at === null ? {} : { openedAt: row.opened_at }),
			...(row.discarded_at === null ? {} : { discardedAt: row.discarded_at }),
			hasThumb: row.thumb !== null,
			shares: shares.get(row.id) ?? [],
		}));
	}

	function itemOf(row: ArtifactRow): LibraryItem {
		const [item] = itemsOf([row]);
		if (item === undefined) throw new LibraryError(`artifact ${row.id} could not be read`);
		return item;
	}

	const memo = new Map<string, unknown>();
	let memoVersion = "";

	function revision(): string {
		const own = sql("SELECT total_changes() AS n").get<{ readonly n: number }>()?.n ?? 0;
		const other = sql("PRAGMA data_version").get<{ readonly data_version: number }>()?.data_version ?? 0;
		return `${own}:${other}`;
	}

	function remembered<T>(key: string, compute: () => T): T {
		const version = revision();
		if (version !== memoVersion) {
			memo.clear();
			memoVersion = version;
		}
		if (memo.has(key)) return memo.get(key) as T;
		const fresh = compute();
		if (memo.size >= MEMO_LIMIT) memo.clear();
		memo.set(key, fresh);
		return fresh;
	}

	function query(request: LibraryQuery): LibraryPage {
		const plan = planList(request, now());
		const rows = sql(plan.page.sql).all<ArtifactRow>(...plan.page.params);
		const more = rows.length > plan.limit;
		const page = more ? rows.slice(0, plan.limit) : rows;
		const last = page[page.length - 1];
		const total = remembered(plan.total.key, () => sql(plan.total.sql).get<{ readonly n: number }>(...plan.total.params)?.n ?? 0);
		return {
			items: itemsOf(page),
			...(more && last !== undefined ? { next: encodeCursor(plan.positionOf(last)) } : {}),
			total,
		};
	}

	function facets(scope: { readonly workspace?: string; readonly state?: "live" | "discarded" }): LibraryFacets {
		const moment = now();
		const bucket = Math.floor(moment / EXPIRY_RESOLUTION_MS);
		return remembered(`facets ${JSON.stringify([scope.workspace ?? null, scope.state ?? "live", bucket])}`, () => {
			const view = scope.state === "discarded" ? "a.state = 'discarded'" : "a.state != 'discarded'";
			const inWorkspace = scope.workspace === undefined ? "" : " AND a.workspace = ?";
			const workspaceParams: SqlValue[] = scope.workspace === undefined ? [] : [scope.workspace];
			const kinds: Partial<Record<LibraryItem["kind"], number>> = {};
			for (const row of sql(`SELECT a.kind AS kind, COUNT(*) AS n FROM artifacts a WHERE ${view}${inWorkspace} GROUP BY a.kind`).all<{ readonly kind: LibraryItem["kind"]; readonly n: number }>(...workspaceParams)) {
				kinds[row.kind] = row.n;
			}
			const workspaces = sql(
				`SELECT a.workspace AS path, COUNT(*) AS count FROM artifacts a WHERE ${view} AND a.workspace IS NOT NULL GROUP BY a.workspace ORDER BY count DESC, a.workspace LIMIT ${MAX_FACET_WORKSPACES}`,
			).all<{ readonly path: string; readonly count: number }>();
			const tags = sql(
				`SELECT MIN(j.value) AS tag, COUNT(*) AS count FROM artifacts a, json_each(a.tags) j WHERE ${view}${inWorkspace} AND ${HAS_TAGS} GROUP BY lower(j.value) ORDER BY count DESC, lower(j.value) LIMIT ${MAX_FACET_TAGS}`,
			).all<{ readonly tag: string; readonly count: number }>(...workspaceParams);
			const count = (text: string, ...params: readonly SqlValue[]): number => sql(text).get<{ readonly n: number }>(...params)?.n ?? 0;
			return {
				kinds,
				workspaces,
				tags,
				starred: count(`SELECT COUNT(*) AS n FROM artifacts a WHERE a.starred = 1 AND a.state != 'discarded'${inWorkspace}`, ...workspaceParams),
				shared: count(`SELECT COUNT(*) AS n FROM artifacts a WHERE a.state != 'discarded'${inWorkspace} AND a.id IN (${LIVE_SHARE_IDS})`, ...workspaceParams, moment),
				discarded: count(`SELECT COUNT(*) AS n FROM artifacts a WHERE a.state = 'discarded'${inWorkspace}`, ...workspaceParams),
			};
		});
	}

	function get(id: ArtifactId): LibraryItem | undefined {
		const row = rowOf(id);
		return row === undefined ? undefined : itemOf(row);
	}

	function getByPath(realPath: string): LibraryItem | undefined {
		const row = sql("SELECT * FROM artifacts WHERE path_key = ?").get<ArtifactRow>(pathKey(realPath, platform));
		return row === undefined ? undefined : itemOf(row);
	}

	async function stamp(input: StampInput): Promise<LibraryItem> {
		const requested = input.path;
		const refuse = (reason: string) => new LibraryError(`cannot add to the library: ${reason}`);
		if (typeof requested !== "string" || requested.trim() === "") throw refuse("the path is empty");
		if (requested.includes("\0")) throw refuse("the path contains a NUL byte");
		if (!isAbsolute(requested)) throw refuse(`"${requested}" is not an absolute path`);
		const spelling = textRefusal(requested, platform, "presentable");
		if (spelling !== undefined) throw refuse(spelling);
		const early = denyReason(resolve(requested));
		if (early !== undefined) throw refuse(early);
		let real: string;
		try {
			real = await realpath(resolve(requested));
		} catch (error) {
			throw refuse(hasCode(error, "ENOENT", "ENOTDIR") ? `no such file: "${requested}"` : `"${requested}" cannot be resolved (${errorMessage(error)})`);
		}
		if (denyReason(real) !== undefined) throw refuse("it resolves to a protected location (credentials, keys or engine state)");
		const before = await stat(real);
		if (!before.isFile()) throw refuse("it is not a regular file");

		const handle = await open(real, READ_FLAGS);
		let facts: { readonly kind: LibraryItem["kind"]; readonly mime: string; readonly size: number; readonly mtimeMs: number };
		try {
			const opened = await handle.stat();
			if (!opened.isFile()) throw refuse("it is not a regular file");
			const head = Buffer.allocUnsafe(Math.min(HEAD_BYTES, opened.size));
			const { bytesRead } = await handle.read(head, 0, head.length, 0);
			const { kind, mime } = classifyFile(basename(real), head.subarray(0, bytesRead));
			facts = { kind, mime, size: opened.size, mtimeMs: opened.mtimeMs };
		} finally {
			await handle.close();
		}

		const title = cleanText("title", input.title, MAX_TITLE_CHARS) ?? null;
		const note = cleanText("note", input.note, MAX_NOTE_CHARS) ?? null;
		const tags = cleanTags(input.tags);
		const moment = now();
		const key = pathKey(real, platform);
		sql(UPSERT_ARTIFACT).run(
			newId(moment),
			real,
			key,
			basename(real),
			title,
			note,
			tags === undefined ? null : JSON.stringify(tags),
			facts.kind,
			facts.mime,
			facts.size,
			facts.mtimeMs,
			input.width ?? null,
			input.height ?? null,
			input.workspace ?? null,
			input.sessionId ?? null,
			input.source,
			moment,
		);
		const row = sql("SELECT * FROM artifacts WHERE path_key = ?").get<ArtifactRow>(key);
		if (row === undefined) throw new LibraryError(`"${requested}" could not be recorded`);
		if (input.thumb !== undefined && row.state !== "discarded") {
			const name = await writeThumb(thumbsDirectory, row.id, input.thumb.bytes, input.thumb.mime);
			sql("UPDATE artifacts SET thumb = ? WHERE id = ?").run(name, row.id);
		}
		return itemOf(requireRow(row.id));
	}

	function update(id: ArtifactId, patch: ArtifactPatch): LibraryItem {
		requireRow(id);
		const sets: string[] = [];
		const params: SqlValue[] = [];
		const title = cleanText("title", patch.title, MAX_TITLE_CHARS);
		if (title !== undefined) {
			sets.push("title = ?");
			params.push(title);
		}
		const note = cleanText("note", patch.note, MAX_NOTE_CHARS);
		if (note !== undefined) {
			sets.push("note = ?");
			params.push(note);
		}
		const tags = cleanTags(patch.tags);
		if (tags !== undefined) {
			sets.push("tags = ?");
			params.push(JSON.stringify(tags));
		}
		if (patch.starred !== undefined) {
			sets.push("starred = ?");
			params.push(patch.starred ? 1 : 0);
		}
		if (patch.durationMs !== undefined) {
			if (!Number.isFinite(patch.durationMs) || patch.durationMs < 0) throw new LibraryError("durationMs must be a number of milliseconds, zero or more");
			sets.push("duration_ms = ?");
			params.push(Math.round(patch.durationMs));
		}
		if (sets.length > 0) sql(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
		return itemOf(requireRow(id));
	}

	function liveShares(artifactId: ArtifactId): ShareRow[] {
		return sql("SELECT * FROM shares WHERE artifact_id = ? AND revoked_at IS NULL ORDER BY created_at, id")
			.all<ShareRecord>(artifactId)
			.map(shareFromRecord);
	}

	const shares: LibraryShares = {
		insert(row) {
			sql(
				`INSERT INTO shares(id, artifact_id, host, remote_id, base_url, key, owner_token, audience, version, version_at, allow_comments,
					created_at, expires_at, revoked_at, comments_seen_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				row.id,
				row.artifactId,
				row.host,
				row.remoteId,
				row.baseUrl,
				row.key,
				row.ownerToken,
				JSON.stringify(row.audience),
				row.version,
				row.versionAt,
				row.allowComments ? 1 : 0,
				row.createdAt,
				row.expiresAt ?? null,
				row.revokedAt ?? null,
				row.commentsSeenAt ?? null,
			);
		},
		update(id, patch) {
			const sets: string[] = [];
			const params: SqlValue[] = [];
			for (const field of Object.keys(SHARE_COLUMNS) as (keyof typeof SHARE_COLUMNS)[]) {
				if (!(field in patch)) continue;
				const value = patch[field];
				sets.push(`${SHARE_COLUMNS[field]} = ?`);
				if (field === "audience") params.push(JSON.stringify(value));
				else if (field === "allowComments") params.push(value === true ? 1 : 0);
				else params.push(typeof value === "number" ? value : null);
			}
			if (sets.length > 0) sql(`UPDATE shares SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
		},
		get(id) {
			const record = sql("SELECT * FROM shares WHERE id = ?").get<ShareRecord>(id);
			return record === undefined ? undefined : shareFromRecord(record);
		},
		summary(id) {
			const record = sql(`${SUMMARY_SELECT} WHERE s.id = ?`).get<ShareSummaryRecord>(id);
			return record === undefined ? undefined : summaryFromRecord(record);
		},
		forArtifact(artifactId) {
			return sql("SELECT * FROM shares WHERE artifact_id = ? ORDER BY created_at, id").all<ShareRecord>(artifactId).map(shareFromRecord);
		},
		live() {
			return sql("SELECT * FROM shares WHERE revoked_at IS NULL ORDER BY created_at, id").all<ShareRecord>().map(shareFromRecord);
		},
	};

	const comments: LibraryComments = {
		upsert(row) {
			return (
				sql(
					`INSERT INTO comments(id, share_id, author, body, anchor, version, created_at, read_at, resolved_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
				).run(
					row.id,
					row.shareId,
					row.author,
					row.body,
					row.anchor === undefined ? null : JSON.stringify(row.anchor),
					row.version,
					row.createdAt,
					row.readAt ?? null,
					row.resolvedAt ?? null,
				).changes > 0
			);
		},
		forArtifact(artifactId, filter) {
			const unread = filter?.unread === true ? " AND c.read_at IS NULL" : "";
			return sql(`${COMMENT_SELECT} WHERE s.artifact_id = ?${unread} ORDER BY c.created_at, c.id`).all<CommentJoinRecord>(artifactId).map(commentWithUrl);
		},
		get(id) {
			const record = sql(`${COMMENT_SELECT} WHERE c.id = ?`).get<CommentJoinRecord>(id);
			return record === undefined ? undefined : commentWithUrl(record);
		},
		latestId(shareId) {
			return sql("SELECT MAX(id) AS id FROM comments WHERE share_id = ?").get<{ readonly id: string | null }>(shareId)?.id ?? undefined;
		},
		markRead(ids, at) {
			for (let start = 0; start < ids.length; start += 500) {
				const batch = ids.slice(start, start + 500);
				sql(`UPDATE comments SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders(batch.length)})`).run(at, ...batch);
			}
		},
	};

	async function verifiedFile(row: ArtifactRow): Promise<string> {
		const real = await realpath(row.path);
		const unchanged = pathKey(real, platform) === row.path_key && denyReason(real) === undefined && (await stat(real)).isFile();
		if (!unchanged) throw new LibraryError("the path no longer leads to the file that was added, so it was left in place");
		return real;
	}

	async function discard(id: ArtifactId, request: { readonly trash: boolean }): Promise<DiscardOutcome> {
		const row = requireRow(id);
		let revoked = 0;
		const unrevoked: UnrevokedShare[] = [];
		for (const share of liveShares(id)) {
			try {
				await revokeRemote(share);
			} catch (error) {
				if (share.host !== "p2p") {
					unrevoked.push({ shareId: share.id, host: share.host, reason: errorMessage(error) });
					continue;
				}
			}
			shares.update(share.id, { revokedAt: now() });
			revoked++;
		}
		if (row.state !== "discarded") {
			sql("UPDATE artifacts SET state = 'discarded', discarded_at = ?, thumb = NULL WHERE id = ?").run(now(), id);
		}
		try {
			await removeThumbs(thumbsDirectory, id);
		} catch (error) {
			console.error(`library: thumbnail of ${id} was not removed: ${errorMessage(error)}`);
		}
		let trashed = false;
		let trashError: string | undefined;
		if (request.trash) {
			try {
				await trashFile(await verifiedFile(row));
				trashed = true;
			} catch (error) {
				trashError = hasCode(error, "ENOENT") ? "the file no longer exists" : errorMessage(error);
			}
		}
		return { item: itemOf(requireRow(id)), trashed, ...(trashError === undefined ? {} : { trashError }), revoked, unrevoked };
	}

	function restore(id: ArtifactId): LibraryItem {
		const row = requireRow(id);
		if (row.state !== "discarded") return itemOf(row);
		const present = statSync(row.path, { throwIfNoEntry: false })?.isFile() === true;
		sql("UPDATE artifacts SET state = ?, discarded_at = NULL WHERE id = ?").run(present ? "live" : "missing", id);
		return itemOf(requireRow(id));
	}

	async function check(ids: readonly ArtifactId[]): Promise<readonly Pick<LibraryItem, "id" | "state" | "size" | "mtimeMs">[]> {
		const wanted = [...new Set(ids)].slice(0, MAX_CHECK_IDS);
		if (wanted.length === 0) return [];
		const rows = sql(`SELECT id, path, state, size, mtime_ms FROM artifacts WHERE id IN (${placeholders(wanted.length)})`).all<
			Pick<ArtifactRow, "id" | "path" | "state" | "size" | "mtime_ms">
		>(...wanted);
		const answers = new Map<string, Pick<LibraryItem, "id" | "state" | "size" | "mtimeMs">>();
		const changed: { readonly id: string; readonly state: "live" | "missing"; readonly size: number; readonly mtimeMs: number }[] = [];
		for (let start = 0; start < rows.length; start += CHECK_BATCH) {
			await Promise.all(
				rows.slice(start, start + CHECK_BATCH).map(async row => {
					const known = { id: row.id, state: row.state, size: row.size, mtimeMs: row.mtime_ms };
					if (row.state === "discarded") {
						answers.set(row.id, known);
						return;
					}
					let next = known;
					try {
						const info = await stat(row.path);
						next = info.isFile() ? { id: row.id, state: "live", size: info.size, mtimeMs: info.mtimeMs } : { ...known, state: "missing" };
					} catch (error) {
						if (hasCode(error, "ENOENT", "ENOTDIR")) next = { ...known, state: "missing" };
					}
					answers.set(row.id, next);
					if (next.state !== known.state || next.size !== known.size || next.mtimeMs !== known.mtimeMs) {
						changed.push({ id: row.id, state: next.state === "missing" ? "missing" : "live", size: next.size, mtimeMs: next.mtimeMs });
					}
				}),
			);
		}
		if (changed.length > 0) {
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const change of changed) {
					sql("UPDATE artifacts SET state = ?, size = ?, mtime_ms = ? WHERE id = ? AND state != 'discarded'").run(change.state, change.size, change.mtimeMs, change.id);
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		return wanted.flatMap(id => answers.get(id) ?? []);
	}

	async function setThumb(id: ArtifactId, bytes: Uint8Array, mime: ThumbMime): Promise<void> {
		const row = requireRow(id);
		if (row.state === "discarded") throw new LibraryError("a discarded artifact keeps no thumbnail");
		const name = await writeThumb(thumbsDirectory, id, bytes, mime);
		sql("UPDATE artifacts SET thumb = ? WHERE id = ?").run(name, id);
	}

	let closed = false;

	return {
		home: options.home,
		workspaceOf,
		query,
		revision,
		facets,
		get,
		getByPath,
		stamp,
		update,
		discard,
		restore,
		check,
		markOpened(id) {
			sql("UPDATE artifacts SET opened_at = ? WHERE id = ?").run(now(), id);
		},
		setThumb,
		thumbPath(id) {
			const name = sql("SELECT thumb FROM artifacts WHERE id = ? AND state != 'discarded'").get<{ readonly thumb: string | null }>(id)?.thumb;
			return name !== null && name !== undefined && THUMB_FILE_NAME.test(name) ? join(thumbsDirectory, name) : undefined;
		},
		isLent(realPath) {
			return sql("SELECT 1 AS lent FROM artifacts WHERE path_key = ? AND state != 'discarded'").get(pathKey(realPath, platform)) !== undefined;
		},
		shares,
		comments,
		close() {
			if (closed) return;
			closed = true;
			releaseStatements();
			db.close();
		},
	};
}
