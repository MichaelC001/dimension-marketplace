import { classifyMediaError, type MediaFailureKind, type MediaOpenError } from "@dimension/mcp-app-kit/media";

export type MediaTag = "audio" | "video";

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

export const OPEN_TIMEOUT_SENTENCE = "This file took too long to open.";
export const UNBOUNDED_SENTENCE = "This recording does not say how long it is, so notes use the time you hear.";

const ELSEWHERE = "copy its path to open it in a media player.";

function sentenceFor(kind: MediaFailureKind, tag: MediaTag, mime: string | undefined): string {
	switch (kind) {
		case "decode":
			return `Part of this ${tag === "audio" ? "recording" : "video"} could not be decoded; the file may be damaged.`;
		case "network":
			return "The file could not be read.";
		case "damaged":
			return "It does not open as a recording; it may be damaged or cut short.";
		case "container": {
			const format = mime === undefined ? undefined : FORMAT_NAMES[mime];
			return format === undefined ? `The viewer cannot play this kind of file; ${ELSEWHERE}` : `The viewer cannot play ${format} files; ${ELSEWHERE}`;
		}
		case "codec":
			return `The viewer cannot play this file's codec; ${ELSEWHERE}`;
		case "other":
			return "This file could not be played.";
	}
}

export function describeMediaError(tag: MediaTag, mime: string | undefined, containerKnown: boolean, code: number | undefined, detail?: string): string {
	return sentenceFor(classifyMediaError({ code, detail, containerKnown }), tag, mime);
}

export function describeOpenError(error: MediaOpenError, tag: MediaTag, mime: string | undefined): string {
	return error.kind === "timeout" ? OPEN_TIMEOUT_SENTENCE : sentenceFor(error.kind, tag, mime);
}
