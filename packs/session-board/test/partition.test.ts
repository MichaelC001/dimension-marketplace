import { describe, expect, test } from "bun:test";
import { partitionBoard } from "../src/partition";

const session = (over: Record<string, unknown>) => ({
	ref: { sessionId: String(over.id ?? "s"), workspaceId: "w1" },
	title: "t",
	updatedAt: 0,
	...over,
});

describe("partitionBoard", () => {
	test("blocked outranks working outranks idle", () => {
		const p = partitionBoard([
			session({ id: "a", liveStatus: "running" }),
			session({ id: "b", blockedOnInput: true, liveStatus: "running" }),
			session({ id: "c" }),
		]);
		expect(p.needsYou.map(r => r.id)).toEqual(["b"]);
		expect(p.working.map(r => r.id)).toEqual(["a"]);
		expect(p.idle.map(r => r.id)).toEqual(["c"]);
	});

	test("every LIVE state counts as working - running, background, attached", () => {
		const p = partitionBoard([
			session({ id: "r", liveStatus: "running" }),
			session({ id: "b", liveStatus: "background" }),
			session({ id: "a", liveStatus: "attached" }),
			session({ id: "i", liveStatus: "settled" }),
		]);
		expect(p.working.map(r => r.id).sort()).toEqual(["a", "b", "r"]);
		expect(p.idle.map(r => r.id)).toEqual(["i"]);
	});

	test("archived sessions never appear, whatever their state", () => {
		const p = partitionBoard([
			session({ id: "a", archivedAt: 5, blockedOnInput: true }),
			session({ id: "b", archivedAt: 5, liveStatus: "running" }),
		]);
		expect(p.needsYou).toEqual([]);
		expect(p.working).toEqual([]);
		expect(p.idle).toEqual([]);
	});

	test("each section sorts newest first", () => {
		const p = partitionBoard([
			session({ id: "old", updatedAt: 1 }),
			session({ id: "new", updatedAt: 9 }),
			session({ id: "mid", updatedAt: 5 }),
		]);
		expect(p.idle.map(r => r.id)).toEqual(["new", "mid", "old"]);
	});

	test("an entry without a session id is dropped, never a phantom row", () => {
		const p = partitionBoard([{ title: "no ref" }, session({ id: "a" })]);
		expect(p.idle.map(r => r.id)).toEqual(["a"]);
	});

	test("detail composes branch · worktree exactly as the host's meta fact does", () => {
		const p = partitionBoard([
			session({ id: "a", workspace: { git: { currentBranch: "main", worktree: true } } }),
			session({ id: "b", workspace: { git: { currentBranch: "main" } } }),
			session({ id: "c", workspace: { git: { worktree: true } } }),
			session({ id: "d" }),
		]);
		const details = Object.fromEntries(p.idle.map(r => [r.id, r.detail]));
		expect(details).toEqual({ a: "main · worktree", b: "main", c: "worktree", d: null });
	});

	test("a blank or whitespace title renders as Untitled session", () => {
		const p = partitionBoard([session({ id: "a", title: "  " })]);
		expect(p.idle[0]?.title).toBe("Untitled session");
	});
});
