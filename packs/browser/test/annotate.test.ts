/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an annotation stops describing
 *  the picture the human is looking at. Either the crop comes from somewhere
 *  other than the frame that was captured (wrong offset, or a fresh screenshot
 *  silently substituted), or a frame from BEFORE a navigation is still
 *  annotatable — so the model points at coordinates on a page that no longer
 *  exists and acts on something else entirely.
 */
import { afterEach, expect, test } from "bun:test";
import { PNG } from "pngjs";
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
const ORIGIN = { x: 20, y: 10 };

// Closing a real Chrome and deleting its profile on Windows takes longer than
// bun's default hook budget; a leaked browser poisons every later test.
afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("annotate", () => {
	test(
		"an oversized region is clamped to the captured frame and crops it at the requested offset",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "annot", viewport: VIEWPORT });
			await perform(runtime, opened.browserId, { kind: "navigate", url: fixture.url("/") });

			const frame = await runtime.frame(opened.browserId);
			const captured = PNG.sync.read(Buffer.from(frame.data, "base64"));

			const annotation = await runtime.annotate(
				opened.browserId,
				frame.frameId,
				{ ...ORIGIN, width: 10_000, height: 10_000 },
				"the submit button",
			);

			expect(annotation.region).toEqual({
				...ORIGIN,
				width: captured.width - ORIGIN.x,
				height: captured.height - ORIGIN.y,
			});
			const cropped = PNG.sync.read(Buffer.from(annotation.data, "base64"));
			expect({ width: cropped.width, height: cropped.height }).toEqual({
				width: annotation.region.width,
				height: annotation.region.height,
			});
			// Same pixels as the stored frame, at the requested offset — not a new
			// screenshot, and not the frame's top-left corner.
			expect([...cropped.data.subarray(0, 4)]).toEqual([
				...captured.data.subarray((ORIGIN.y * captured.width + ORIGIN.x) * 4, (ORIGIN.y * captured.width + ORIGIN.x) * 4 + 4),
			]);
			expect(annotation.url).toBe(fixture.url("/"));
			expect(annotation.note).toBe("the submit button");
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
				await failureCode(() =>
					runtime.annotate(opened.browserId, frame.frameId, { ...ORIGIN, width: 100, height: 80 }, "gone"),
				),
			).toBe("stale_frame");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
