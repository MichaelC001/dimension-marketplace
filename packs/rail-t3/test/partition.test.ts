import "./test-globals";
import { describe, expect, test } from "bun:test";
import type { RepoGroup, SessionItem } from "@fraym/ui";
import { partitionSessions, t3Status } from "../src/partition";

const now = new Date().toISOString();
const earlier = new Date(Date.now() - 3600000).toISOString();
const much_earlier = new Date(Date.now() - 7200000).toISOString();

// Minimal fixture items
const makeItem = (overrides: Partial<SessionItem> = {}): SessionItem => ({
	id: "item-" + Math.random().toString(36).slice(2),
	title: "Test Item",
	time: "1h",
	status: "ok",
	updatedAt: now,
	createdAt: now,
	...overrides,
});

const makeGroup = (overrides: Partial<RepoGroup> = {}): RepoGroup => ({
	repo: "test-repo",
	branch: "main",
	dot: "bg-blue-400",
	items: [],
	...overrides,
});

describe("t3Status", () => {
	test("maps 'working' to 'working'", () => {
		const item = makeItem({ status: "working" });
		expect(t3Status(item)).toBe("working");
	});

	test("maps 'needs-you' to 'attention'", () => {
		const item = makeItem({ status: "needs-you" });
		expect(t3Status(item)).toBe("attention");
	});

	test("maps 'failed' to 'failed'", () => {
		const item = makeItem({ status: "failed" });
		expect(t3Status(item)).toBe("failed");
	});

	test("maps 'background' to 'done'", () => {
		const item = makeItem({ status: "background" });
		expect(t3Status(item)).toBe("done");
	});

	test("maps 'ok' to 'ready'", () => {
		const item = makeItem({ status: "ok" });
		expect(t3Status(item)).toBe("ready");
	});

	test("maps 'idle' to 'ready'", () => {
		const item = makeItem({ status: "idle" });
		expect(t3Status(item)).toBe("ready");
	});

	test("maps 'attached' to 'ready'", () => {
		const item = makeItem({ status: "attached" });
		expect(t3Status(item)).toBe("ready");
	});

	test("maps 'off' to 'ready'", () => {
		const item = makeItem({ status: "off" });
		expect(t3Status(item)).toBe("ready");
	});
});

describe("partitionSessions", () => {
	test("places archived items in settled regardless of status", () => {
		const groups = [
			makeGroup({
				items: [
					makeItem({ id: "archived-working", title: "Archived Working", status: "working", archived: true }),
					makeItem({ id: "archived-idle", title: "Archived Idle", status: "idle", archived: true }),
				],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.settled).toHaveLength(2);
		expect(result.live).toHaveLength(0);
		expect(result.quiet).toHaveLength(0);
	});

	test("places working items in live", () => {
		const groups = [
			makeGroup({
				items: [makeItem({ id: "working-1", title: "Working", status: "working" })],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.live).toHaveLength(1);
		expect(result.live[0].item.status).toBe("working");
	});

	test("places needs-you items in live", () => {
		const groups = [
			makeGroup({
				items: [makeItem({ id: "attention-1", title: "Needs You", status: "needs-you" })],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.live).toHaveLength(1);
		expect(result.live[0].item.status).toBe("needs-you");
	});

	test("places failed items in live", () => {
		const groups = [
			makeGroup({
				items: [makeItem({ id: "failed-1", title: "Failed", status: "failed" })],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.live).toHaveLength(1);
		expect(result.live[0].item.status).toBe("failed");
	});

	test("places background items in live", () => {
		const groups = [
			makeGroup({
				items: [makeItem({ id: "bg-1", title: "Background", status: "background" })],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.live).toHaveLength(1);
		expect(result.live[0].item.status).toBe("background");
	});

	test("places active items in live", () => {
		const groups = [
			makeGroup({
				items: [makeItem({ id: "active-1", title: "Active", status: "ok", active: true })],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.live).toHaveLength(1);
		expect(result.live[0].item.active).toBe(true);
	});

	test("places ok/idle/attached/off items in quiet", () => {
		const groups = [
			makeGroup({
				items: [
					makeItem({ id: "ok-1", title: "OK", status: "ok" }),
					makeItem({ id: "idle-1", title: "Idle", status: "idle" }),
					makeItem({ id: "attached-1", title: "Attached", status: "attached" }),
					makeItem({ id: "off-1", title: "Off", status: "off" }),
				],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.quiet).toHaveLength(4);
		expect(result.live).toHaveLength(0);
	});

	test("keeps group reference on each row", () => {
		// A default item (status "ok", not active) lands in QUIET per the
		// partition contract — the row must still carry its group.
		const group = makeGroup({ repo: "my-repo", items: [makeItem()] });
		const result = partitionSessions([group]);

		expect(result.quiet[0]?.group).toBe(group);
	});

	test("filters by title case-insensitively", () => {
		const groups = [
			makeGroup({
				items: [
					makeItem({ id: "1", title: "Authentication", status: "ok" }),
					makeItem({ id: "2", title: "Database", status: "ok" }),
				],
			}),
		];

		const result = partitionSessions(groups, "AUTH");
		expect(result.quiet).toHaveLength(1);
		expect(result.quiet[0].item.title).toBe("Authentication");
	});

	test("filters by branch case-insensitively", () => {
		const groups = [
			makeGroup({
				branch: "feature/auth",
				items: [makeItem({ id: "1", status: "ok" })],
			}),
			makeGroup({
				branch: "main",
				items: [makeItem({ id: "2", status: "ok" })],
			}),
		];

		const result = partitionSessions(groups, "FEATURE");
		expect(result.quiet).toHaveLength(1);
		expect(result.quiet[0].group.branch).toBe("feature/auth");
	});

	test("live sort: attention before failed before working before done", () => {
		const groups = [
			makeGroup({
				items: [
					makeItem({ id: "1", title: "Done", status: "background", updatedAt: now }),
					makeItem({ id: "2", title: "Working", status: "working", updatedAt: now }),
					makeItem({ id: "3", title: "Failed", status: "failed", updatedAt: now }),
					makeItem({ id: "4", title: "Attention", status: "needs-you", updatedAt: now }),
				],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.live.map(r => r.item.title)).toEqual(["Attention", "Failed", "Working", "Done"]);
	});

	test("live sort: ties broken by updatedAt desc (newest first)", () => {
		const groups = [
			makeGroup({
				items: [
					makeItem({ id: "1", title: "Older", status: "working", updatedAt: much_earlier }),
					makeItem({ id: "2", title: "Newer", status: "working", updatedAt: now }),
				],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.live.map(r => r.item.title)).toEqual(["Newer", "Older"]);
	});

	test("live sort: falls back to createdAt when updatedAt is absent", () => {
		const groups = [
			makeGroup({
				items: [
					makeItem({ id: "1", title: "Old", status: "working", updatedAt: undefined, createdAt: much_earlier }),
					makeItem({ id: "2", title: "New", status: "working", updatedAt: undefined, createdAt: now }),
				],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.live.map(r => r.item.title)).toEqual(["New", "Old"]);
	});

	test("quiet sorted by updatedAt desc", () => {
		const groups = [
			makeGroup({
				items: [
					makeItem({ id: "1", title: "Older", status: "ok", updatedAt: much_earlier }),
					makeItem({ id: "2", title: "Newer", status: "idle", updatedAt: now }),
				],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.quiet.map(r => r.item.title)).toEqual(["Newer", "Older"]);
	});

	test("settled sorted by updatedAt desc", () => {
		const groups = [
			makeGroup({
				items: [
					makeItem({ id: "1", title: "Older", status: "ok", archived: true, updatedAt: much_earlier }),
					makeItem({ id: "2", title: "Newer", status: "working", archived: true, updatedAt: now }),
				],
			}),
		];

		const result = partitionSessions(groups);
		expect(result.settled.map(r => r.item.title)).toEqual(["Newer", "Older"]);
	});
});
