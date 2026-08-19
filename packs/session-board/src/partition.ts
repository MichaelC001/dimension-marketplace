// The board's pure model — no React, no host, unit-testable alone.
//
// Everything below types the host's published facts STRUCTURALLY (doc 68
// §3.3/§4.1): matching is by key name and published shape, never a shared
// type import. A field this file does not name simply does not exist to it;
// a host that stops publishing one degrades the row, never throws.

/** The structural subset of one `sessions/list` entry this board reads.
 *  (The published shape is the host's `CatalogEntry`; every field optional
 *  here because an unknown host owes us nothing.) */
export interface BoardSession {
	readonly ref?: { readonly sessionId?: string; readonly workspaceId?: string; readonly harness?: string };
	readonly title?: string;
	readonly updatedAt?: number;
	readonly archivedAt?: number;
	readonly liveStatus?: string;
	readonly blockedOnInput?: boolean;
	readonly source?: string;
	readonly workspace?: { readonly git?: { readonly currentBranch?: string; readonly worktree?: boolean } };
}

/** One rendered row: identity + the three facts the board shows. */
export interface BoardRow {
	readonly id: string;
	readonly workspaceId: string | undefined;
	readonly harness: string | undefined;
	readonly title: string;
	/** `branch · worktree` composition — same derivation the host's `meta`
	 *  fact publishes, restated here from the entry's structured parts. */
	readonly detail: string | null;
	readonly updatedAt: number;
}

export interface BoardPartition {
	/** Blocked on YOUR input — the reason this instrument exists. */
	readonly needsYou: readonly BoardRow[];
	/** Live right now (running). */
	readonly working: readonly BoardRow[];
	/** Everything else, newest first, capped by the caller's render. */
	readonly idle: readonly BoardRow[];
}

function toRow(session: BoardSession): BoardRow | null {
	const id = session.ref?.sessionId;
	if (!id) return null;
	const git = session.workspace?.git;
	const detail = git?.currentBranch
		? `${git.currentBranch}${git.worktree ? " · worktree" : ""}`
		: git?.worktree
			? "worktree"
			: null;
	return {
		id,
		workspaceId: session.ref?.workspaceId,
		harness: session.ref?.harness,
		title: session.title?.trim() || "Untitled session",
		detail,
		updatedAt: session.updatedAt ?? 0,
	};
}

const byRecency = (a: BoardRow, b: BoardRow) => b.updatedAt - a.updatedAt;

/**
 * Partition the catalog: blocked → working → idle, each newest-first.
 * "Working" is any LIVE state — `running`, `background` (grinding without
 * the foreground), `attached` (a live engine child) — because the board's
 * question is "who needs me / who is busy", and a session doing background
 * work reading as Idle answers it wrongly (review 2026-08-19). Archived
 * sessions are the one exclusion — a board that lists the closed shelf
 * stops being "what needs me" and becomes history, which the rail's
 * settled shelf already owns.
 */
export function partitionBoard(sessions: readonly BoardSession[]): BoardPartition {
	const needsYou: BoardRow[] = [];
	const working: BoardRow[] = [];
	const idle: BoardRow[] = [];
	for (const session of sessions) {
		if (session.archivedAt) continue;
		const row = toRow(session);
		if (!row) continue;
		if (session.blockedOnInput === true) needsYou.push(row);
		else if (
			session.liveStatus === "running" ||
			session.liveStatus === "background" ||
			session.liveStatus === "attached"
		)
			working.push(row);
		else idle.push(row);
	}
	needsYou.sort(byRecency);
	working.sort(byRecency);
	idle.sort(byRecency);
	return { needsYou, working, idle };
}
