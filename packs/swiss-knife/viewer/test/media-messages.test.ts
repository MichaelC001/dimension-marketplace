import { describe, expect, test } from "bun:test";
import { describeMediaError } from "../app/view/media-messages";

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
