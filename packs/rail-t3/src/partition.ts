import type { RepoGroup, SessionItem } from "@fraym/ui";

/** ActivityState from session item status field.
 *  Mirrors the activity states: working | needs-you | failed | background | ok | idle | attached | off
 */
export type T3Status = "working" | "attention" | "failed" | "done" | "ready";

export interface T3Row {
	readonly item: SessionItem;
	readonly group: RepoGroup;
	readonly status: T3Status;
}

export interface T3Partition {
	readonly live: readonly T3Row[];
	readonly quiet: readonly T3Row[];
	readonly settled: readonly T3Row[];
}

/** Map ActivityState to T3Status for display.
 *
 * ActivityState values from @fraym/config:
 * - working → "working"
 * - needs-you → "attention"
 * - failed → "failed"
 * - background → "done"
 * - ok, idle, attached, off → "ready"
 */
export function t3Status(item: SessionItem): T3Status {
	const state = item.status;
	switch (state) {
		case "working":
			return "working";
		case "needs-you":
			return "attention";
		case "failed":
			return "failed";
		case "background":
			return "done";
		default:
			return "ready";
	}
}

/** Sort urgency for live rows (attention > failed > working > done > active-ready) */
function liveStatusPriority(status: T3Status, active: boolean): number {
	const priorities: Record<T3Status, number> = {
		attention: 0,
		failed: 1,
		working: 2,
		done: 3,
		ready: 4,
	};
	const basePriority = priorities[status];
	return active ? basePriority + 100 : basePriority;
}

/** Compare two dates, using fallbacks (updatedAt > createdAt, stable). */
function compareDates(a: SessionItem, b: SessionItem): number {
	const aDate = a.updatedAt || a.createdAt || "1970-01-01";
	const bDate = b.updatedAt || b.createdAt || "1970-01-01";
	return new Date(bDate).getTime() - new Date(aDate).getTime();
}

/** Partition sessions into live (work), quiet (slim rows), and settled (archived).
 *
 * Filters optional search case-insensitively against item.title and item.branch.
 * Sorts: live by urgency then date desc; quiet by date desc; settled by date desc.
 */
export function partitionSessions(groups: readonly RepoGroup[], search?: string): T3Partition {
	const liveRows: T3Row[] = [];
	const quietRows: T3Row[] = [];
	const settledRows: T3Row[] = [];

	const searchLower = search?.toLowerCase() || "";
	const matchesSearch = (text: string): boolean => {
		if (!search) return true;
		return text.toLowerCase().includes(searchLower);
	};

	// Flatten and partition
	for (const group of groups) {
		for (const item of group.items) {
			// Check search filter — the row's EFFECTIVE branch, the same
			// resolution the card renders (worktree wins, then item, then group).
			const titleMatch = matchesSearch(item.title);
			const branchMatch = matchesSearch(item.worktreeBranch ?? item.branch ?? group.branch ?? "");
			if (!titleMatch && !branchMatch) continue;

			const status = t3Status(item);
			const row: T3Row = { item, group, status };

			if (item.archived) {
				settledRows.push(row);
			} else if (
				status === "working" ||
				status === "attention" ||
				status === "failed" ||
				status === "done" ||
				item.active
			) {
				liveRows.push(row);
			} else {
				quietRows.push(row);
			}
		}
	}

	// Sort live: urgency then date desc
	liveRows.sort((a, b) => {
		const aPriority = liveStatusPriority(a.status, a.item.active || false);
		const bPriority = liveStatusPriority(b.status, b.item.active || false);
		if (aPriority !== bPriority) return aPriority - bPriority;
		return compareDates(a.item, b.item);
	});

	// Sort quiet and settled: date desc
	quietRows.sort((a, b) => compareDates(a.item, b.item));
	settledRows.sort((a, b) => compareDates(a.item, b.item));

	return {
		live: liveRows,
		quiet: quietRows,
		settled: settledRows,
	};
}
