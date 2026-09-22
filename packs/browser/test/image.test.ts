/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: `annotate` hands back the wrong
 *  pixels or dies on a bad region instead of refusing it. This is the pure half
 *  of annotation — no browser needed — so it pins the geometry contract the
 *  real-Chrome annotate test relies on: a region that runs off the edge is
 *  CLAMPED, a region that starts off the frame is REFUSED (never silently moved
 *  to somewhere the human never pointed at), and the returned bytes are the
 *  requested rectangle, not the whole frame.
 */
import { expect, test } from "bun:test";
import { PNG } from "pngjs";
import type { BrowserRegion } from "../src/contracts";
import { cropRegion } from "../src/image";
import { BrowserRuntimeError } from "../src/store";

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

/** A frame whose left half is red and right half blue, so an offset is visible. */
function frame(width = 8, height = 8): Buffer {
	const png = new PNG({ width, height });
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			const [r, g, b, a] = x < width / 2 ? RED : BLUE;
			png.data[at] = r;
			png.data[at + 1] = g;
			png.data[at + 2] = b;
			png.data[at + 3] = a;
		}
	}
	return PNG.sync.write(png);
}

function pixel(png: PNG, x: number, y: number): number[] {
	const at = (y * png.width + x) * 4;
	return [...png.data.subarray(at, at + 4)];
}

/** Run `work`, require a refusal, and yield its code. Resolving fails the test. */
function refusalCode(work: () => unknown): string {
	try {
		work();
	} catch (err) {
		if (err instanceof BrowserRuntimeError) return err.code;
		throw err;
	}
	throw new Error("expected cropRegion to refuse the region, but it returned");
}

test("cropRegion returns the requested rectangle's pixels, not the frame's", () => {
	const { png, region } = cropRegion(frame(), { x: 4, y: 0, width: 4, height: 8 });

	expect(region).toEqual({ x: 4, y: 0, width: 4, height: 8 });
	const cropped = PNG.sync.read(png);
	expect({ width: cropped.width, height: cropped.height }).toEqual({ width: 4, height: 8 });
	expect(pixel(cropped, 0, 0)).toEqual(BLUE);
	expect(pixel(cropped, 3, 7)).toEqual(BLUE);
});

test("cropRegion clamps a region that starts inside the frame and runs off its edge", () => {
	const { png, region } = cropRegion(frame(), { x: 2, y: 6, width: 100, height: 100 });

	expect(region).toEqual({ x: 2, y: 6, width: 6, height: 2 });
	const cropped = PNG.sync.read(png);
	expect({ width: cropped.width, height: cropped.height }).toEqual({ width: 6, height: 2 });
	// Clamping must preserve the ORIGIN: x=2 is still in the red half, and the
	// far column of the clamped crop is the frame's last (blue) column.
	expect(pixel(cropped, 0, 0)).toEqual(RED);
	expect(pixel(cropped, 5, 1)).toEqual(BLUE);
});

const refused: ReadonlyArray<{ name: string; region: BrowserRegion }> = [
	{ name: "an origin at the right edge", region: { x: 8, y: 0, width: 4, height: 4 } },
	{ name: "an origin below the bottom edge", region: { x: 0, y: 9, width: 4, height: 4 } },
	{ name: "a negative origin", region: { x: -1, y: 0, width: 4, height: 4 } },
	{ name: "zero width", region: { x: 0, y: 0, width: 0, height: 4 } },
	{ name: "a negative height", region: { x: 0, y: 0, width: 4, height: -4 } },
	{ name: "a non-finite width", region: { x: 0, y: 0, width: Number.NaN, height: 4 } },
];

for (const { name, region } of refused) {
	test(`cropRegion refuses a region with ${name}`, () => {
		expect(refusalCode(() => cropRegion(frame(), region))).toBe("bad_region");
	});
}

test("cropRegion refuses a frame wider than the supported maximum", () => {
	expect(refusalCode(() => cropRegion(frame(3_841, 2), { x: 0, y: 0, width: 10, height: 2 }))).toBe("frame_too_large");
});
