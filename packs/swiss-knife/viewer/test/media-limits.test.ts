// The bounds a recording is held to, and the small pure rules around playing one: the size
// cap that is decided BEFORE a byte is read, the loudness picture's passes over the samples,
// the size and timing of a still, the length of a frame, and the one sentence a failure gets
// (when a waveform is allowed at all is `media-waveform.test.ts`). A recording is played from
// one Blob of all its bytes, so each of these is a way a big or odd file could otherwise hurt.
import { describe, expect, test } from "bun:test";
import { loadDocumentBytes, tooLargeToPlay } from "../app/view/document-bytes";
import { estimateFrameSeconds, frameSize, frameStepTarget, jpegBytes } from "../app/view/media-frame";
import { describeMediaError } from "../app/view/media-messages";
import { bucketPeaks } from "../app/view/media-waveform";
import type { DocTab } from "../app/view/tabs";
import { MAX_MEDIA_BYTES } from "../src/contract";

const tab = (over: Partial<DocTab> = {}): DocTab => ({
	key: "/w/take.mp4",
	path: "/w/take.mp4",
	filename: "take.mp4",
	kind: "video",
	size: 1024,
	mtimeMs: 1,
	revision: 0,
	annotateRequests: 0,
	...over,
});

/** A host that counts the reads asked of it, and refuses each one with a recognisable error. */
function counting() {
	const reads: unknown[] = [];
	const app = {
		callServerTool: async (params: unknown) => {
			reads.push(params);
			throw new Error("a read was attempted");
		},
	};
	return { reads, app: app as never };
}

describe("the size cap, decided before a byte moves", () => {
	test("a recording over the cap reads NOTHING, and says what the limit is", async () => {
		const { reads, app } = counting();
		const big = tab({ size: MAX_MEDIA_BYTES + 1, key: "/w/big.mp4" });
		await expect(loadDocumentBytes(app, big)).rejects.toThrow(/plays recordings up to 64\.0 MB/);
		await expect(loadDocumentBytes(app, tab({ kind: "audio", size: MAX_MEDIA_BYTES * 4, key: "/w/huge.wav" }))).rejects.toThrow(/plays recordings/);
		expect(reads).toHaveLength(0);
	});

	test("a recording exactly at the cap is played: the gate is `over`, not `at`", async () => {
		const { reads, app } = counting();
		await expect(loadDocumentBytes(app, tab({ size: MAX_MEDIA_BYTES, key: "/w/exact.mp4" }))).rejects.toThrow("a read was attempted");
		expect(reads).toHaveLength(1);
	});

	test("the cap is for recordings: a document of the same size is not refused by it", async () => {
		const { reads, app } = counting();
		const pdf = tab({ kind: "pdf", size: MAX_MEDIA_BYTES + 1, key: "/w/big.pdf", path: "/w/big.pdf", filename: "big.pdf" });
		expect(tooLargeToPlay(pdf)).toBe(false);
		await expect(loadDocumentBytes(app, pdf)).rejects.toThrow("a read was attempted");
		expect(reads).toHaveLength(1);
	});

	test("both kinds of recording are held to it", () => {
		expect(tooLargeToPlay({ kind: "audio", size: MAX_MEDIA_BYTES + 1 })).toBe(true);
		expect(tooLargeToPlay({ kind: "video", size: MAX_MEDIA_BYTES + 1 })).toBe(true);
		expect(tooLargeToPlay({ kind: "video", size: MAX_MEDIA_BYTES })).toBe(false);
	});
});

describe("bucketPeaks", () => {
	const ramp = (length: number, level: number): Float32Array => Float32Array.from({ length }, (_, index) => ((index % 2 === 0 ? 1 : -1) * level * (index + 1)) / length);

	test("each bucket is the loudest of its own equal part, scaled so the loudest of all is 1", async () => {
		// Four buckets over eight samples: 0.1 | 0.2 | 0.4 | 0.8 (signs ignored).
		const samples = Float32Array.of(0.1, -0.05, -0.2, 0.1, 0.4, 0.3, -0.8, 0.2);
		const peaks = await bucketPeaks([samples], 4);
		expect([...peaks].map(value => Math.round(value * 1000) / 1000)).toEqual([0.125, 0.25, 0.5, 1]);
	});

	test("silence is all zeros, not NaN from dividing by nothing", async () => {
		const peaks = await bucketPeaks([new Float32Array(1000)], 10);
		expect([...peaks]).toEqual(new Array<number>(10).fill(0));
		expect([...(await bucketPeaks([], 5))]).toEqual([0, 0, 0, 0, 0]);
	});

	test("every channel counts: a sound that is loud on one side is loud", async () => {
		const quiet = new Float32Array(100).fill(0.1);
		const loud = new Float32Array(100);
		loud[60] = 0.9;
		const peaks = await bucketPeaks([quiet, loud], 2);
		expect(peaks[0]).toBeCloseTo(0.1 / 0.9, 5);
		expect(peaks[1]).toBe(1);
	});

	test("fewer samples than buckets still gives every bucket a value", async () => {
		const peaks = await bucketPeaks([Float32Array.of(0.5, 1)], 8);
		expect(peaks).toHaveLength(8);
		expect(Math.max(...peaks)).toBe(1);
	});

	test("a long sound is worked in slices that give the thread back, and the answer is the same", async () => {
		const sound = ramp(200_000, 0.7);
		let yields = 0;
		const sliced = await bucketPeaks([sound], 600, {
			sliceMs: 0,
			yieldThread: async () => {
				yields += 1;
			},
		});
		expect(yields).toBeGreaterThan(100);
		expect([...sliced]).toEqual([...(await bucketPeaks([sound], 600, { sliceMs: Number.POSITIVE_INFINITY }))]);
	});

	test("a pane that goes away stops the work at the next slice", async () => {
		const controller = new AbortController();
		let yields = 0;
		const work = bucketPeaks([ramp(100_000, 1)], 600, {
			signal: controller.signal,
			sliceMs: 0,
			yieldThread: async () => {
				yields += 1;
				controller.abort();
			},
		});
		await expect(work).rejects.toThrow();
		expect(yields).toBe(1);
	});
});

describe("a still", () => {
	test("its long edge is at most 768 px; a smaller picture is not enlarged, a portrait is scaled by its height", () => {
		expect(frameSize(1920, 1080)).toEqual({ width: 768, height: 432 });
		expect(frameSize(600, 400)).toEqual({ width: 600, height: 400 });
		expect(frameSize(400, 1000)).toEqual({ width: 307, height: 768 });
		expect(frameSize(768, 768)).toEqual({ width: 768, height: 768 });
	});

	test("it is never zero pixels wide, however thin the picture", () => {
		expect(frameSize(5000, 1)).toEqual({ width: 768, height: 1 });
		expect(frameSize(1, 5000)).toEqual({ width: 1, height: 768 });
	});

	test("only a JPEG is a still: an engine that cannot encode answers `data:,`, and that is a failed grab", () => {
		expect(jpegBytes("data:image/jpeg;base64,/9j/4AAQ")).toEqual(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10));
		expect(jpegBytes("data:,")).toBeNull();
		expect(jpegBytes("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
		expect(jpegBytes("data:image/jpeg;base64,")).toBeNull();
	});
});

describe("the length of a frame", () => {
	const at = (fps: number, count: number, from = 0): number[] => Array.from({ length: count }, (_, index) => from + index / fps);

	test("playback at 30 and 24 frames a second says so", () => {
		expect(estimateFrameSeconds(at(30, 8))).toBeCloseTo(1 / 30, 5);
		expect(estimateFrameSeconds(at(24, 8))).toBeCloseTo(1 / 24, 5);
	});

	test("a dropped frame or a seek in the middle does not pass for the rate", () => {
		const dropped = [...at(25, 5), 5 / 25 + 1 / 25, 5 / 25 + 2 / 25 + 0, ...at(25, 3, 0.5)];
		expect(estimateFrameSeconds(dropped)).toBeCloseTo(1 / 25, 2);
		const seeked = [...at(30, 5), 90, 90 + 1 / 30, 90 + 2 / 30];
		expect(estimateFrameSeconds(seeked)).toBeCloseTo(1 / 30, 5);
	});

	test("with too little to go on it says nothing, and nonsense gaps are not a rate", () => {
		expect(estimateFrameSeconds(at(30, 3))).toBeNull();
		expect(estimateFrameSeconds([])).toBeNull();
		expect(estimateFrameSeconds([0, 10, 20, 30, 40])).toBeNull();
		expect(estimateFrameSeconds([1, 1, 1, 1, 1])).toBeNull();
	});

	test("a step lands inside the next or previous frame, not on the line between them", () => {
		const frame = 1 / 30;
		const next = frameStepTarget(1, frame, 1);
		expect(next).toBeGreaterThan(1 + frame);
		expect(next).toBeLessThan(1 + 2 * frame);
		const before = frameStepTarget(1, frame, -1);
		expect(before).toBeGreaterThan(1 - frame);
		expect(before).toBeLessThan(1);
		expect(frameStepTarget(0, frame, -1)).toBe(0);
	});
});

describe("the one sentence a failure gets", () => {
	test("a container the viewer does not know is named; a known one with a codec it cannot play is not blamed on the container", () => {
		expect(describeMediaError("video", "video/x-matroska", false, 4)).toMatch(/^The viewer cannot play Matroska files; /);
		expect(describeMediaError("video", "video/mp4", true, 4)).toMatch(/^The viewer cannot play this file's codec; /);
		expect(describeMediaError("audio", undefined, false, 4)).toMatch(/^The viewer cannot play this kind of file; /);
	});

	test("bytes the viewer could not even open are a damaged file, not a codec to go and find", () => {
		const chromium = "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed";
		expect(describeMediaError("video", "video/mp4", true, 4, chromium)).toBe("It does not open as a recording; it may be damaged or cut short.");
		expect(describeMediaError("video", "video/mp4", true, 4, "DECODER_ERROR_NOT_SUPPORTED")).toMatch(/codec/);
	});

	test("a file that opened but holds only streams the viewer cannot decode is a codec problem, not a damaged file", () => {
		// What Chrome 154 says for MPEG-4 Part 2 video with WMA audio in Matroska.
		const chromium = "DEMUXER_ERROR_NO_SUPPORTED_STREAMS: FFmpegDemuxer: no supported streams";
		const said = describeMediaError("video", "video/x-matroska", false, 4, chromium);
		expect(said).toMatch(/codec/);
		expect(said).not.toMatch(/damaged/);
	});

	test("a decode failure, a read failure and a player that said nothing each have their own words", () => {
		expect(describeMediaError("audio", "audio/mpeg", true, 3)).toMatch(/recording could not be decoded; the file may be damaged/);
		expect(describeMediaError("video", "video/mp4", true, 3)).toMatch(/video could not be decoded/);
		expect(describeMediaError("video", "video/mp4", true, 2)).toBe("The file could not be read.");
		expect(describeMediaError("video", "video/mp4", true, undefined)).toMatch(/codec/);
		expect(describeMediaError("video", "video/mp4", true, 1)).toBe("This file could not be played.");
	});

	test("every sentence is a person's: none names the engine", () => {
		const details = [undefined, "DEMUXER_ERROR_COULD_NOT_OPEN", "DEMUXER_ERROR_NO_SUPPORTED_STREAMS"];
		for (const code of [1, 2, 3, 4, undefined])
			for (const known of [true, false])
				for (const detail of details) expect(describeMediaError("video", "video/webm", known, code, detail)).not.toMatch(/engine/i);
	});
});
