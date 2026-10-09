// What the viewer SAYS when a recording will not play. One sentence each, in words a
// person would use, shared by the renderer (a file that will not open) and the transport
// (one that fails partway) so the two never describe the same failure differently.

export type MediaTag = "audio" | "video";

/** What the human calls the container, by its MIME type. */
const FORMAT_NAMES: Readonly<Record<string, string>> = {
	"audio/mpeg": "MP3",
	"audio/wav": "WAV",
	"audio/flac": "FLAC",
	"audio/ogg": "Ogg",
	"audio/mp4": "MP4 audio",
	"audio/aac": "AAC",
	"audio/webm": "WebM audio",
	"audio/x-matroska": "Matroska audio",
	"video/mp4": "MP4",
	"video/quicktime": "QuickTime",
	"video/webm": "WebM",
	"video/ogg": "Ogg video",
	"video/x-matroska": "Matroska",
};

/** Said when a recording never reports its length. */
export const OPEN_TIMEOUT_SENTENCE = "This file took too long to open.";

/** What a human can do about a recording the viewer cannot play, said after the reason. */
const ELSEWHERE = "copy its path to open it in a media player.";

/**
 * One sentence for a recording that would not open or play. `containerKnown` is whether the engine's
 * `canPlayType` knows the container at all; `code` is the element's `MediaError.code` (1 aborted, 2 network,
 * 3 decode, 4 not supported), or `undefined` for an engine that gave none. `detail` is the engine's own
 * `MediaError.message`. Chromium says `DEMUXER_ERROR_COULD_NOT_OPEN` when the bytes are not a recording at
 * all (a cut-off or damaged file), which is not the same thing as a codec it lacks, and the human should
 * not be told to look for a different player when the file is simply broken; but it says
 * `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` when the file opened fine and holds only streams it cannot decode,
 * which IS a codec it lacks. The words are a person's: "the viewer", never "the engine".
 */
export function describeMediaError(tag: MediaTag, mime: string | undefined, containerKnown: boolean, code: number | undefined, detail?: string): string {
	const format = mime === undefined ? undefined : FORMAT_NAMES[mime];
	if (code === 3) return `Part of this ${tag === "audio" ? "recording" : "video"} could not be decoded; the file may be damaged.`;
	if (code === 2) return "The file could not be read.";
	if (code === 4 || code === undefined) {
		const noStream = detail !== undefined && /NO_SUPPORTED_STREAMS/.test(detail);
		if (!noStream && detail !== undefined && /DEMUXER_ERROR/.test(detail)) return "It does not open as a recording; it may be damaged or cut short.";
		if (!containerKnown && !noStream)
			return format === undefined ? `The viewer cannot play this kind of file; ${ELSEWHERE}` : `The viewer cannot play ${format} files; ${ELSEWHERE}`;
		return `The viewer cannot play this file's codec; ${ELSEWHERE}`;
	}
	return "This file could not be played.";
}
