import { describe, expect, test } from "bun:test";
import { drawnRect } from "../app/view/media-frame";

describe("where the picture is drawn in its box", () => {
	const NONE = { left: 0, top: 0, width: 0, height: 0 };

	test.each([
		["a box wider than the video has bars left and right, and the picture the full height", [100, 100, 400, 200], { left: 100, top: 0, width: 200, height: 200 }],
		["a box taller than the video has bars above and below, and the picture the full width", [100, 100, 200, 400], { left: 0, top: 100, width: 200, height: 200 }],
		["a box the video's own size is filled", [1920, 1080, 1920, 1080], { left: 0, top: 0, width: 1920, height: 1080 }],
		["a smaller box of the video's shape is filled", [1920, 1080, 640, 360], { left: 0, top: 0, width: 640, height: 360 }],
		["a small video is enlarged to fill the box: 64x36 in 640x640 is drawn 640x360, centred", [64, 36, 640, 640], { left: 0, top: 140, width: 640, height: 360 }],
		["a portrait video in a landscape box is pillarboxed", [1080, 1920, 1920, 1080], { left: 656.25, top: 0, width: 607.5, height: 1080 }],
	] as const)("%s", (_what, [videoW, videoH, boxW, boxH], expected) => {
		const rect = drawnRect(videoW, videoH, boxW, boxH);
		expect(rect.left).toBeCloseTo(expected.left, 9);
		expect(rect.top).toBeCloseTo(expected.top, 9);
		expect(rect.width).toBeCloseTo(expected.width, 9);
		expect(rect.height).toBeCloseTo(expected.height, 9);
	});

	test.each([
		["a video with no picture yet reports 0x0", [0, 0, 640, 360]],
		["a video with no width", [0, 360, 640, 360]],
		["a video with no height", [640, 0, 640, 360]],
		["a box with no room", [640, 360, 0, 0]],
		["a box with no width", [640, 360, 0, 360]],
		["a box with no height", [640, 360, 640, 0]],
		["a negative video", [-640, 360, 640, 360]],
		["a negative box", [640, 360, -640, 360]],
		["a video whose size is not a number", [Number.NaN, 360, 640, 360]],
		["a box whose size is not a number", [640, 360, Number.NaN, 360]],
		["an unbounded video", [Number.POSITIVE_INFINITY, 360, 640, 360]],
		["an unbounded box", [640, 360, 640, Number.POSITIVE_INFINITY]],
	] as const)("there is nothing to draw on for %s", (_what, [videoW, videoH, boxW, boxH]) => {
		expect(drawnRect(videoW, videoH, boxW, boxH)).toEqual(NONE);
	});

	test("whatever the shapes, the picture keeps its shape, fits the box, touches it on one axis and sits in the middle", () => {
		const videos = [[1920, 1080], [1080, 1920], [64, 36], [640, 640], [1, 1], [4096, 16]] as const;
		const boxes = [[640, 360], [360, 640], [1000, 1000], [1, 1], [333, 777], [3840, 2160]] as const;
		for (const [videoW, videoH] of videos) {
			for (const [boxW, boxH] of boxes) {
				const where = `${videoW}x${videoH} in ${boxW}x${boxH}`;
				const { left, top, width, height } = drawnRect(videoW, videoH, boxW, boxH);
				const eps = 1e-9 * Math.max(boxW, boxH);
				expect(Math.abs(width / height - videoW / videoH) / (videoW / videoH), where).toBeLessThan(1e-9);
				expect(left, where).toBeGreaterThanOrEqual(-eps);
				expect(top, where).toBeGreaterThanOrEqual(-eps);
				expect(left + width, where).toBeLessThanOrEqual(boxW + eps);
				expect(top + height, where).toBeLessThanOrEqual(boxH + eps);
				expect(Math.min(Math.abs(boxW - width), Math.abs(boxH - height)), where).toBeLessThan(eps);
				expect(Math.abs(left - (boxW - width - left)), where).toBeLessThan(eps);
				expect(Math.abs(top - (boxH - height - top)), where).toBeLessThan(eps);
			}
		}
	});
});
