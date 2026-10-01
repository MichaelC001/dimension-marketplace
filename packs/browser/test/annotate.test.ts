/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an annotation stops describing
 *  the page the human marked. Either the facts under a mark come from a different
 *  rectangle than the one drawn (wrong offset, regions answered out of order),
 *  the page's own position (scroll) is lost so the agent cannot tell which part
 *  of a long page was on screen, a secret in a field reaches the agent, or a
 *  frame from BEFORE a navigation is still annotatable — so the model reads
 *  elements of a page that no longer matches the picture it was handed.
 */
import { afterEach, expect, test } from "bun:test";
import { MAX_ANNOTATION_REGIONS } from "../src/contracts";
import {
	BROWSER_TEST_TIMEOUT_MS,
	createRuntime,
	describeWithChrome,
	failureCode,
	perform,
	startFixture,
	teardown,
} from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const WHOLE = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };

// Closing a real Chrome and deleting its profile on Windows takes longer than
// bun's default hook budget; a leaked browser poisons every later test.
afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("annotate", () => {
	test(
		"answers the page's address and title, and the elements under the marked region",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "annot", viewport: VIEWPORT });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/") });
			const frame = await runtime.frame(opened.browserId);

			const context = await runtime.annotate(opened.browserId, frame.frameId, [WHOLE]);

			expect(context.url).toBe(fixture.url("/"));
			expect(context.title).toBe("fixture form");
			expect(context.capturedAt).toBe(frame.capturedAt);
			expect(context.viewport).toEqual(VIEWPORT);
			expect(context.regions).toHaveLength(1);
			expect(context.regions[0]?.region).toEqual(WHOLE);
			expect(context.regions[0]?.elements).toContain("button#go");
			expect(context.regions[0]?.elements).toContain("Submit");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a password field under a mark is named but never read",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "annot-secret", viewport: VIEWPORT });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/") });
			await perform(runtime, opened.browserId, { kind: "type", selector: "#pass", text: "hunter2-secret" });
			const frame = await runtime.frame(opened.browserId);

			const { regions } = await runtime.annotate(opened.browserId, frame.frameId, [WHOLE]);

			expect(regions[0]?.elements).toContain("input#pass");
			expect(regions[0]?.elements).toContain("[redacted input]");
			expect(regions[0]?.elements).not.toContain("hunter2-secret");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"each region is answered in the order it was asked, from its own rectangle, with an oversized one cut to the frame",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "annot-order", viewport: VIEWPORT });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/tall") });
			const frame = await runtime.frame(opened.browserId);

			const top = { x: 0, y: 0, width: 200, height: 90 };
			const lower = { x: 20, y: 310, width: 10_000, height: 10_000 };
			const { regions } = await runtime.annotate(opened.browserId, frame.frameId, [lower, top]);

			expect(regions.map((entry) => entry.region)).toEqual([
				{ x: 20, y: 310, width: VIEWPORT.width - 20, height: VIEWPORT.height - 310 },
				top,
			]);
			// The tall page is thirty 100px blocks: y 310..480 holds blocks 3 and 4, y 0..90 only block 0.
			expect(regions[0]?.elements).toContain("block 3");
			expect(regions[0]?.elements).not.toContain("block 0");
			expect(regions[1]?.elements).toContain("block 0");
			expect(regions[1]?.elements).not.toContain("block 3");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"says where a long page was scrolled to, and how large it is",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "annot-scroll", viewport: VIEWPORT });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/tall") });
			await perform(runtime, opened.browserId, { kind: "scroll", deltaY: 700 });
			const frame = await runtime.frame(opened.browserId);

			const { scroll, regions } = await runtime.annotate(opened.browserId, frame.frameId, [{ x: 0, y: 0, width: 200, height: 90 }]);

			expect(scroll.x).toBe(0);
			expect(scroll.y).toBeGreaterThanOrEqual(600);
			expect(scroll.height).toBe(3000);
			expect(scroll.width).toBeGreaterThan(0);
			// What is at the top of the screen is the block that scrolled there, not the top of the page.
			expect(regions[0]?.elements).toContain("block 7");
			expect(regions[0]?.elements).not.toContain("block 0");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"refuses no regions, more regions than a page of marks may have, and a region outside the frame",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "annot-bad", viewport: VIEWPORT });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/") });
			const frame = await runtime.frame(opened.browserId);

			expect(await failureCode(() => runtime.annotate(opened.browserId, frame.frameId, []))).toBe("bad_region");
			const crowd = Array.from({ length: MAX_ANNOTATION_REGIONS + 1 }, () => WHOLE);
			expect(await failureCode(() => runtime.annotate(opened.browserId, frame.frameId, crowd))).toBe("bad_region");
			expect(
				await failureCode(() => runtime.annotate(opened.browserId, frame.frameId, [{ x: VIEWPORT.width, y: 0, width: 10, height: 10 }])),
			).toBe("bad_region");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a frame captured before a navigation can no longer be annotated",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "annot-stale", viewport: VIEWPORT });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/") });

			const frame = await runtime.frame(opened.browserId);
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/page2") });

			expect(
				await failureCode(() => runtime.annotate(opened.browserId, frame.frameId, [{ x: 20, y: 10, width: 100, height: 80 }])),
			).toBe("stale_frame");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
