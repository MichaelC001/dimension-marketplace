// The triage fold — pure functions over the rail's published `sessions` fact.
//
// Everything here is computed LOCALLY from `RailFacts.sessions` (the host's
// grouped, filtered, loop-lifted `RepoGroup[]`). The pack never sees a session
// snapshot: it sees rows, and it re-derives "what needs me / what is recent /
// what is stale" from the row fields alone. That is the point of the pack — a
// third party with nothing but the facts channel can build a whole rail.
//
// Typed STRUCTURALLY, on purpose. `SessionItem` grows on the host's schedule:
// `unread`, `interrupted` and `attention` arrive from a parallel change, so
// each is optional here and every rule degrades to "absent ⇒ false". A pack
// built against a newer host reads them; one loaded on an older host simply
// never lights the extra rows.

export type RailTriage = "needs-you" | "working" | "idle" | "resolved";

export type RecencyBucket = "now" | "today" | "yesterday" | "week" | "earlier";

/** The row fields the fold reads. Every field a rule depends on is named. */
export interface TriageRow {
	readonly id: string;
	readonly title: string;
	/** The rail dot's semantic state (`ActivityState`). */
	readonly status: string;
	readonly dotState?: string;
	readonly updatedAt?: string;
	readonly archived?: boolean;
	readonly pinned?: boolean;
	readonly locating?: boolean;
	readonly continuedInto?: unknown;
	readonly sessionRef?: unknown;
	/** The human has not looked since the assistant last spoke. Parallel PR. */
	readonly unread?: boolean;
	/** The engine aborted the last turn and will not resume it by itself. Parallel PR. */
	readonly interrupted?: boolean;
	/** When the session started waiting on a human. Parallel PR. */
	readonly attention?: { readonly since?: string };
}

export interface TriageGroup<Row extends TriageRow = TriageRow> {
	readonly repo: string;
	readonly branch: string;
	readonly items: readonly Row[];
	readonly searchOnly?: boolean;
}

/** A row plus the project it came from — the recency groups lose the project
 *  as a heading, so every row carries it as a caption instead. */
export interface Placed<Row extends TriageRow = TriageRow> {
	readonly item: Row;
	readonly repo: string;
}

export interface RecencySection<Row extends TriageRow = TriageRow> {
	readonly bucket: RecencyBucket;
	readonly rows: readonly Placed<Row>[];
}

export interface TriageFold<Row extends TriageRow = TriageRow> {
	/** Every `needs-you` row, deduped, oldest wait first. */
	readonly needsYou: readonly Placed<Row>[];
	/** Recency sections in fixed order; empty buckets omitted. */
	readonly sections: readonly RecencySection<Row>[];
	/** The host's lifted Autonomy group, kept whole — loop rows never bucket. */
	readonly loops: readonly Placed<Row>[];
	/** Rows in every section, in render order. Drives the compact rail. */
	readonly total: number;
}

/** The host's lifted loop group carries this synthetic branch key
 *  (`LOOPS_GROUP_BRANCH` in the kit). Matched by value so the pack needs no
 *  import for it. */
export const LOOPS_BRANCH = "autonomy";

export const RECENCY_ORDER: readonly RecencyBucket[] = ["now", "today", "yesterday", "week", "earlier"];

export const RECENCY_LABEL: Record<RecencyBucket, string> = {
	now: "Now",
	today: "Today",
	yesterday: "Yesterday",
	week: "This week",
	earlier: "Earlier",
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A row untouched for longer than this is a sweep candidate. */
export const SWEEP_AGE_MS = 7 * DAY_MS;

export function parseTime(value: string | undefined): number {
	const time = Date.parse(value ?? "");
	return Number.isFinite(time) ? time : Number.NaN;
}

function dot(row: TriageRow): string {
	return row.dotState ?? row.status;
}

/** Live work: the dot claims it AND no terminal fact overrules the dot. The
 *  host's own fold applies a grace window to a stale `working` claim; the row
 *  it publishes already reflects that (its `time` reads the persisted age), so
 *  the pack trusts the dot it was handed. */
export function isLive(row: TriageRow): boolean {
	if (row.archived || row.continuedInto) return false;
	const state = dot(row);
	return state === "working" || state === "background" || state === "needs-you";
}

export function triageOf(row: TriageRow): RailTriage {
	if (row.archived || row.continuedInto) return "resolved";
	const state = dot(row);
	if (state === "needs-you" || state === "failed" || row.unread === true || row.interrupted === true) {
		return "needs-you";
	}
	if (state === "working" || state === "background") return "working";
	return "idle";
}

/** The instant a needs-you row started waiting. `attention.since` when the
 *  host says so, else the last activity. */
export function waitingSince(row: TriageRow): number {
	const since = parseTime(row.attention?.since ?? row.updatedAt);
	return Number.isFinite(since) ? since : 0;
}

/** Local midnight for `now` — recency buckets follow the user's calendar, not
 *  a rolling 24 h window: "Today" is the day you are in. */
export function startOfDay(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function recencyBucket(row: TriageRow, now: number, dayStart = startOfDay(now)): RecencyBucket {
	if (isLive(row)) return "now";
	const updated = parseTime(row.updatedAt);
	if (!Number.isFinite(updated)) return "earlier";
	if (updated >= dayStart) return "today";
	if (updated >= dayStart - DAY_MS) return "yesterday";
	if (updated >= now - 7 * DAY_MS) return "week";
	return "earlier";
}

/** Sort key inside a bucket: live rows first, then newest activity first,
 *  pinned rows ahead of everything. */
function recencyValue(row: TriageRow, now: number): number {
	if (isLive(row)) return now;
	const updated = parseTime(row.updatedAt);
	return Number.isFinite(updated) ? updated : 0;
}

function byRecency(now: number) {
	return (a: Placed, b: Placed): number => {
		const pin = Number(b.item.pinned === true) - Number(a.item.pinned === true);
		if (pin !== 0) return pin;
		return recencyValue(b.item, now) - recencyValue(a.item, now);
	};
}

/** @param hostStrip the host's own needs-you fold (`facts.triage`), when it
 *  publishes one. The pack derives its strip from the rows it renders, but the
 *  host's fold sees rows the activity window hid from `sessions` — a session
 *  parked on your permission for a fortnight is exactly the one the window
 *  hides and exactly the one that needs you. Merged, never substituted: a row
 *  the pack already triaged keeps its group credit; a host-only row joins
 *  with no project caption. */
export function foldTriage<Row extends TriageRow>(
	groups: readonly TriageGroup<Row>[],
	now: number = Date.now(),
	hostStrip: readonly Row[] = [],
): TriageFold<Row> {
	const dayStart = startOfDay(now);
	const seen = new Set<string>();
	const needsYou: Placed<Row>[] = [];
	const loops: Placed<Row>[] = [];
	const buckets: Record<RecencyBucket, Placed<Row>[]> = { now: [], today: [], yesterday: [], week: [], earlier: [] };
	for (const group of groups) {
		const isLoopGroup = group.branch === LOOPS_BRANCH;
		for (const item of group.items) {
			// The same session can surface in two groups (a project AND the
			// search-only Elsewhere bucket). It is one row here.
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			const placed: Placed<Row> = { item, repo: group.repo };
			if (isLoopGroup) {
				loops.push(placed);
			} else {
				buckets[recencyBucket(item, now, dayStart)].push(placed);
			}
			if (triageOf(item) === "needs-you") needsYou.push(placed);
		}
	}
	for (const item of hostStrip) {
		if (seen.has(item.id) || triageOf(item) !== "needs-you") continue;
		seen.add(item.id);
		needsYou.push({ item, repo: "" });
	}
	needsYou.sort((a, b) => waitingSince(a.item) - waitingSince(b.item));
	const sort = byRecency(now);
	const sections: RecencySection<Row>[] = [];
	let total = 0;
	for (const bucket of RECENCY_ORDER) {
		const rows = buckets[bucket];
		if (rows.length === 0) continue;
		rows.sort(sort);
		sections.push({ bucket, rows });
		total += rows.length;
	}
	return { needsYou, sections, loops, total: total + loops.length };
}

/** Rows a Sweep archives: idle (not unread, not live, not failed), unpinned,
 *  addressable (a real `sessionRef`), and untouched for longer than
 *  {@link SWEEP_AGE_MS}. A row with no parseable time is never swept — an
 *  unknown age is not an old one. */
export function sweepCandidates<Row extends TriageRow>(
	rows: readonly Placed<Row>[],
	now: number = Date.now(),
	ageMs: number = SWEEP_AGE_MS,
): readonly Placed<Row>[] {
	const out: Placed<Row>[] = [];
	for (const placed of rows) {
		const { item } = placed;
		if (item.pinned || item.locating || !item.sessionRef) continue;
		if (triageOf(item) !== "idle") continue;
		const updated = parseTime(item.updatedAt);
		if (!Number.isFinite(updated) || now - updated <= ageMs) continue;
		out.push(placed);
	}
	return out;
}

/** Compact wait age for the needs-you strip: `now` · `5m` · `2h` · `3d`. */
export function waitLabel(row: TriageRow, now: number = Date.now()): string {
	const since = waitingSince(row);
	if (since === 0) return "";
	const seconds = Math.max(0, Math.round((now - since) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}
