import { describe, expect, test } from "bun:test";
import { base64Bytes, pickEncoding, posterCandidate, THUMB_MAX_BYTES } from "../app/view/library/poster-draw";
import { PosterQueue } from "../app/view/library/poster-queue";
import type { LibraryItem } from "../../src/library/types";

interface Job {
	readonly id: string;
	readonly signal: AbortSignal;
	readonly finish: () => void;
	readonly fail: () => void;
}

function harness() {
	const jobs: Job[] = [];
	const queue = new PosterQueue<{ readonly id: string }>((item, signal) => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		jobs.push({ id: item.id, signal, finish: resolve, fail: () => reject(new Error("no picture")) });
		return promise;
	});
	return { queue, jobs };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("poster queue", () => {
	test("draws one poster at a time, in the order the visible rows ask", async () => {
		const { queue, jobs } = harness();
		queue.want([{ id: "a" }, { id: "b" }]);
		expect(jobs.map(job => job.id)).toEqual(["a"]);
		jobs[0]?.finish();
		await settle();
		expect(jobs.map(job => job.id)).toEqual(["a", "b"]);
	});

	test("a poster scrolled out of view is cancelled and the newly visible one starts", async () => {
		const { queue, jobs } = harness();
		queue.want([{ id: "a" }]);
		queue.want([{ id: "c" }]);
		expect(jobs[0]?.signal.aborted).toBe(true);
		await settle();
		expect(jobs.map(job => job.id)).toEqual(["a", "c"]);
		expect(queue.running).toBe("c");
	});

	test("a cancelled poster is drawn when it comes back into view; a finished or failed one never again", async () => {
		const { queue, jobs } = harness();
		queue.want([{ id: "a" }]);
		queue.want([{ id: "b" }]);
		await settle();
		jobs[1]?.fail();
		await settle();
		queue.want([{ id: "a" }, { id: "b" }]);
		await settle();
		expect(jobs.map(job => job.id)).toEqual(["a", "b", "a"]);
		jobs[2]?.finish();
		await settle();
		queue.want([{ id: "a" }, { id: "b" }]);
		await settle();
		expect(jobs).toHaveLength(3);
	});

	test("disposing stops the poster in progress and refuses later asks", async () => {
		const { queue, jobs } = harness();
		queue.want([{ id: "a" }]);
		queue.dispose();
		expect(jobs[0]?.signal.aborted).toBe(true);
		await settle();
		queue.want([{ id: "b" }]);
		expect(jobs).toHaveLength(1);
	});
});

describe("poster encoding", () => {
	test("base64 length is turned into bytes, padding excluded", () => {
		expect(base64Bytes("AAAA")).toBe(3);
		expect(base64Bytes("AAA=")).toBe(2);
		expect(base64Bytes("AA==")).toBe(1);
	});

	test("the first encoding that is really that format and fits wins", () => {
		const big = "A".repeat(Math.ceil((THUMB_MAX_BYTES + 10) / 3) * 4);
		const picked = pickEncoding(
			[
				{ mime: "image/webp", dataUrl: "data:image/png;base64,AAAA" },
				{ mime: "image/webp", dataUrl: `data:image/webp;base64,${big}` },
				{ mime: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAA" },
			],
			THUMB_MAX_BYTES,
		);
		expect(picked).toEqual({ data: "AAAA", mime: "image/jpeg" });
		expect(pickEncoding([{ mime: "image/webp", dataUrl: "data:," }], THUMB_MAX_BYTES)).toBeNull();
	});

	test("only live videos and modest PDFs without a thumbnail are drawn", () => {
		const base = { id: "x", path: "/x", name: "x", tags: [], mime: "", size: 1000, mtimeMs: 1, source: "present", starred: false, state: "live", createdAt: 1, presentedAt: 1, hasThumb: false, shares: [] } as const;
		expect(posterCandidate({ ...base, kind: "video" } as LibraryItem)).toBe(true);
		expect(posterCandidate({ ...base, kind: "pdf" } as LibraryItem)).toBe(true);
		expect(posterCandidate({ ...base, kind: "pdf", size: 500 * 1024 * 1024 } as LibraryItem)).toBe(false);
		expect(posterCandidate({ ...base, kind: "audio" } as LibraryItem)).toBe(false);
		expect(posterCandidate({ ...base, kind: "video", hasThumb: true } as LibraryItem)).toBe(false);
		expect(posterCandidate({ ...base, kind: "video", state: "missing" } as LibraryItem)).toBe(false);
	});
});
