import { type CursorKey, type CursorPosition, decodeCursor } from "./cursor";
import type { SqlValue } from "./driver";
import type { ArtifactRow } from "./rows";
import { parseSearch } from "./search";
import type { LibraryQuery } from "./types";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

type OrderingName = "recent" | "discarded" | "name" | "size" | "opened" | "relevance";

interface Ordering {
	readonly column: string;
	readonly idColumn: string;
	readonly field: "presented_at" | "discarded_at" | "name" | "size" | "opened_at" | "score";
	readonly descending: boolean;
	readonly nullable: boolean;
}

const ORDERINGS: Record<OrderingName, Ordering> = {
	recent: { column: "a.presented_at", idColumn: "a.id", field: "presented_at", descending: true, nullable: false },
	discarded: { column: "a.discarded_at", idColumn: "a.id", field: "discarded_at", descending: true, nullable: false },
	name: { column: "a.name", idColumn: "a.id", field: "name", descending: false, nullable: false },
	size: { column: "a.size", idColumn: "a.id", field: "size", descending: true, nullable: false },
	opened: { column: "a.opened_at", idColumn: "a.id", field: "opened_at", descending: true, nullable: true },
	relevance: { column: "score", idColumn: "id", field: "score", descending: false, nullable: false },
};

const FULL_TEXT_FROM = "artifacts_fts CROSS JOIN artifacts a ON a.rowid = artifacts_fts.rowid";
const RELEVANCE = "bm25(artifacts_fts, 8.0, 5.0, 2.0, 2.0, 1.0)";
export const LIVE_SHARE_IDS = "SELECT s.artifact_id FROM shares s WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)";
export const EXPIRY_RESOLUTION_MS = 60_000;

export const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(", ");

export interface PlannedStatement {
	readonly sql: string;
	readonly params: readonly SqlValue[];
}

export interface ListPlan {
	readonly page: PlannedStatement;
	readonly total: PlannedStatement & { readonly key: string };
	readonly limit: number;
	positionOf(row: ArtifactRow): CursorPosition;
}

function resolveOrdering(sort: LibraryQuery["sort"], discarded: boolean, matched: boolean): OrderingName {
	if (sort === "relevance" && matched) return "relevance";
	if (sort === "name" || sort === "size" || sort === "opened") return sort;
	return discarded ? "discarded" : "recent";
}

function after(ordering: Ordering, position: CursorPosition): PlannedStatement {
	const { column, idColumn, descending, nullable } = ordering;
	const key = position.key;
	if (key === null) return { sql: `(${column} IS NULL AND ${idColumn} > ?)`, params: [position.id] };
	const beyond = descending ? "<" : ">";
	const bound = `${column} ${beyond}= ? AND (${column} ${beyond} ? OR ${idColumn} > ?)`;
	const params: SqlValue[] = [key, key, position.id];
	return nullable ? { sql: `((${bound}) OR ${column} IS NULL)`, params } : { sql: `(${bound})`, params };
}

export function planList(query: LibraryQuery, now: number): ListPlan {
	const search = parseSearch(query.q);
	const fullText = search?.kind === "match" ? search.expression : undefined;
	const matched = fullText !== undefined;
	const discarded = query.state === "discarded";
	const orderingName = resolveOrdering(query.sort, discarded, matched);
	const ordering = ORDERINGS[orderingName];
	const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);

	const where: string[] = [discarded ? "a.state = 'discarded'" : "a.state != 'discarded'"];
	const filterParams: SqlValue[] = [];
	if (fullText !== undefined) filterParams.push(fullText);
	if (query.kinds !== undefined && query.kinds.length > 0) {
		where.push(`a.kind IN (${placeholders(query.kinds.length)})`);
		filterParams.push(...query.kinds);
	}
	if (query.workspace !== undefined) {
		where.push("a.workspace = ?");
		filterParams.push(query.workspace);
	}
	if (query.starred !== undefined) {
		where.push("a.starred = ?");
		filterParams.push(query.starred ? 1 : 0);
	}
	let sharedParam = -1;
	if (query.shared !== undefined) {
		where.push(`a.id ${query.shared ? "" : "NOT "}IN (${LIVE_SHARE_IDS})`);
		sharedParam = filterParams.length;
		filterParams.push(now);
	}
	if (search?.kind === "prefix") {
		where.push("a.name >= ? AND a.name < ?");
		filterParams.push(search.from, search.to);
	}

	const from = matched ? FULL_TEXT_FROM : "artifacts a";
	const match = matched ? "artifacts_fts MATCH ? AND " : "";
	const filtered = `${match}${where.join(" AND ")}`;
	const cursor = query.cursor === undefined ? undefined : after(ordering, decodeCursor(query.cursor, orderingName));
	const direction = ordering.descending ? " DESC" : "";
	const cursorParams = cursor?.params ?? [];

	const page: PlannedStatement =
		orderingName === "relevance"
			? {
					sql:
						`WITH hits AS MATERIALIZED (SELECT a.*, ${RELEVANCE} AS score FROM ${from} WHERE ${filtered}) ` +
						`SELECT * FROM hits${cursor === undefined ? "" : ` WHERE ${cursor.sql}`} ORDER BY score, id LIMIT ?`,
					params: [...filterParams, ...cursorParams, limit + 1],
				}
			: {
					sql:
						`SELECT a.* FROM ${from} WHERE ${filtered}${cursor === undefined ? "" : ` AND ${cursor.sql}`} ` +
						`ORDER BY ${ordering.column}${direction}, ${ordering.idColumn} LIMIT ?`,
					params: [...filterParams, ...cursorParams, limit + 1],
				};

	const countSql = `SELECT COUNT(*) AS n FROM ${from} WHERE ${filtered}`;
	const countKeyParams = filterParams.map((value, index) => (index === sharedParam ? Math.floor(now / EXPIRY_RESOLUTION_MS) : value));

	return {
		page,
		total: { sql: countSql, params: filterParams, key: JSON.stringify([countSql, countKeyParams]) },
		limit,
		positionOf(row) {
			const key: CursorKey = row[ordering.field] ?? null;
			return { ordering: orderingName, key, id: row.id };
		},
	};
}
