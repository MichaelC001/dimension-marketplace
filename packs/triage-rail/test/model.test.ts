/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the rail lies about what needs
 *  you — a session parked on your permission sinks under "Earlier", a row you
 *  already answered keeps shouting, Sweep offers to archive the thread you were
 *  mid-turn on, or "Today" shows yesterday's work because the day boundary was
 *  a rolling 24 h instead of your midnight. Every rule here is one the pack
 *  computes ALONE from the facts channel, so nothing upstream can catch it. */
import { describe, expect, test } from "bun:test";
import {
	foldTriage,
	recencyBucket,
	startOfDay,
	SWEEP_AGE_MS,
	sweepCandidates,
	type TriageGroup,
	type TriageRow,
	triageOf,
	waitingSince,
} from "../src/model";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A fixed "now" mid-afternoon so the day boundary is unambiguous. */
const NOW = new Date(2026, 8, 18, 15, 0, 0).getTime();
const TODAY = startOfDay(NOW);

const iso = (time: number): string => new Date(time).toISOString();

let seq = 0;
function row(over: Partial<TriageRow> = {}): TriageRow {
	seq += 1;
	return {
		id: `s${seq}`,
		title: `session ${seq}`,
		status: "idle",
		updatedAt: iso(NOW - HOUR),
		sessionRef: { workspaceId: "w", sessionId: `s${seq}` },
		...over,
	};
}

function group(repo: string, items: readonly TriageRow[], branch = "main"): TriageGroup {
	return { repo, branch, items };
}

describe("triage bucket", () => {
	test("needs-you is the union of the dot, a failure, unread, and an interruption", () => {
		expect(triageOf(row({ status: "needs-you" }))).toBe("needs-you");
		expect(triageOf(row({ status: "failed" }))).toBe("needs-you");
		expect(triageOf(row({ status: "idle", unread: true }))).toBe("needs-you");
		expect(triageOf(row({ status: "attached", interrupted: true }))).toBe("needs-you");
	});

	test("a terminal fact outranks every attention signal", () => {
		expect(triageOf(row({ status: "needs-you", archived: true }))).toBe("resolved");
		expect(triageOf(row({ status: "failed", unread: true, continuedInto: { toSessionId: "x" } }))).toBe("resolved");
	});

	test("an explicit dotState wins over the derived status", () => {
		expect(triageOf(row({ status: "idle", dotState: "needs-you" }))).toBe("needs-you");
	});

	test("working and background are live work; attached and idle are idle", () => {
		expect(triageOf(row({ status: "working" }))).toBe("working");
		expect(triageOf(row({ status: "background" }))).toBe("working");
		expect(triageOf(row({ status: "attached" }))).toBe("idle");
		expect(triageOf(row({ status: "idle" }))).toBe("idle");
	});
});

describe("recency bucket", () => {
	test("live work is Now whatever its persisted time says", () => {
		expect(recencyBucket(row({ status: "working", updatedAt: iso(NOW - 30 * DAY) }), NOW)).toBe("now");
		expect(recencyBucket(row({ status: "needs-you", updatedAt: undefined }), NOW)).toBe("now");
	});

	test("the day boundary is local midnight, not a rolling 24 hours", () => {
		expect(recencyBucket(row({ updatedAt: iso(TODAY + 1) }), NOW)).toBe("today");
		expect(recencyBucket(row({ updatedAt: iso(TODAY - 1) }), NOW)).toBe("yesterday");
		// 20 h ago is still "yesterday" here even though it is inside 24 h.
		expect(recencyBucket(row({ updatedAt: iso(NOW - 20 * HOUR) }), NOW)).toBe("yesterday");
	});

	test("the week is seven days from now; past it is Earlier", () => {
		expect(recencyBucket(row({ updatedAt: iso(NOW - 6 * DAY) }), NOW)).toBe("week");
		expect(recencyBucket(row({ updatedAt: iso(NOW - 8 * DAY) }), NOW)).toBe("earlier");
	});

	test("an unknown time is Earlier — never promoted", () => {
		expect(recencyBucket(row({ updatedAt: undefined }), NOW)).toBe("earlier");
		expect(recencyBucket(row({ updatedAt: "not a date" }), NOW)).toBe("earlier");
	});

	test("a handed-off working row is history, not Now", () => {
		expect(recencyBucket(row({ status: "working", continuedInto: { toSessionId: "x" }, updatedAt: iso(NOW - 2 * DAY) }), NOW)).toBe("week");
	});
});

describe("foldTriage", () => {
	test("empty buckets are omitted and rows sort newest first with pinned on top", () => {
		const old = row({ updatedAt: iso(TODAY + 1 * HOUR) });
		const fresh = row({ updatedAt: iso(TODAY + 3 * HOUR) });
		const pinned = row({ updatedAt: iso(TODAY + 2 * HOUR), pinned: true });
		const fold = foldTriage([group("app", [old, fresh, pinned])], NOW);
		expect(fold.sections.map(s => s.bucket)).toEqual(["today"]);
		expect(fold.sections[0]?.rows.map(r => r.item.id)).toEqual([pinned.id, fresh.id, old.id]);
		expect(fold.total).toBe(3);
	});

	test("the same session in two groups is one row, credited to the first", () => {
		const shared = row();
		const fold = foldTriage([group("app", [shared]), group("Sessions outside your projects", [shared])], NOW);
		expect(fold.total).toBe(1);
		expect(fold.sections[0]?.rows[0]?.repo).toBe("app");
	});

	test("the strip is every needs-you row, oldest wait first, from attention.since before updatedAt", () => {
		const waitingLong = row({ status: "needs-you", updatedAt: iso(NOW - 5 * 60_000), attention: { since: iso(NOW - 2 * HOUR) } });
		const waitingShort = row({ status: "failed", updatedAt: iso(NOW - 10 * 60_000) });
		const unread = row({ unread: true, updatedAt: iso(NOW - HOUR) });
		const quiet = row();
		const fold = foldTriage([group("app", [quiet, waitingShort, unread, waitingLong])], NOW);
		expect(fold.needsYou.map(r => r.item.id)).toEqual([waitingLong.id, unread.id, waitingShort.id]);
		expect(waitingSince(waitingLong)).toBe(NOW - 2 * HOUR);
		// A strip is a view, not a move: the rows still sit in their bucket.
		expect(fold.sections.flatMap(s => s.rows).map(r => r.item.id)).toContain(waitingLong.id);
	});

	test("the host's published strip joins the pack's: hidden rows appear once, merged rows keep their project", () => {
		const visible = row({ status: "needs-you", updatedAt: iso(NOW - HOUR) });
		const hiddenByWindow = row({ status: "needs-you", updatedAt: iso(NOW - 14 * DAY) });
		const notNeedsYou = row();
		const fold = foldTriage([group("app", [visible])], NOW, [visible, hiddenByWindow, notNeedsYou]);
		expect(fold.needsYou.map(r => [r.item.id, r.repo])).toEqual([
			[hiddenByWindow.id, ""],
			[visible.id, "app"],
		]);
		// A host-only row is strip-only: it was never in a section to bucket.
		expect(fold.total).toBe(1);
	});

	test("the lifted Autonomy group stays whole and never buckets", () => {
		const tick = row({ status: "working", source: "autonomy" } as Partial<TriageRow>);
		const fold = foldTriage([group("app", [row()]), group("Autonomy", [tick], "autonomy")], NOW);
		expect(fold.loops.map(r => r.item.id)).toEqual([tick.id]);
		expect(fold.sections.flatMap(s => s.rows).map(r => r.item.id)).not.toContain(tick.id);
		expect(fold.total).toBe(2);
	});
});

describe("sweepCandidates", () => {
	const stale = (over: Partial<TriageRow> = {}) => row({ updatedAt: iso(NOW - SWEEP_AGE_MS - HOUR), ...over });

	test("an idle row untouched for longer than the window is a candidate", () => {
		const target = stale();
		expect(sweepCandidates([{ item: target, repo: "app" }], NOW).map(r => r.item.id)).toEqual([target.id]);
	});

	test("exactly at the window is NOT older than it", () => {
		const edge = row({ updatedAt: iso(NOW - SWEEP_AGE_MS) });
		expect(sweepCandidates([{ item: edge, repo: "app" }], NOW)).toHaveLength(0);
	});

	test("anything that still needs you, is live, pinned, unaddressable or of unknown age is never swept", () => {
		const rows = [
			stale({ unread: true }),
			stale({ status: "failed" }),
			stale({ status: "working" }),
			stale({ pinned: true }),
			stale({ sessionRef: undefined }),
			stale({ locating: true }),
			row({ updatedAt: undefined }),
			stale({ archived: true }),
		].map(item => ({ item, repo: "app" }));
		expect(sweepCandidates(rows, NOW)).toHaveLength(0);
	});
});
