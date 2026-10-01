// What a file IS, decided from its name and its first bytes. Pure: the server
// hands it the head of the file, so the same rules are testable without a disk.
//
// The order matters and is the whole design: CONTENT beats a wrong name for the
// formats with an unmistakable signature (a `.png` that is really a PDF opens as
// a PDF), the name decides what the bytes cannot say (`.md` vs `.txt`, and which
// Office format a ZIP is), and anything left is text unless it has a NUL byte.
// The logic mirrors fraym's `file-view/file-kind.ts` (extension tables) with the
// magic-byte layer added; it is a reference, not an import, because a server
// must not depend on the UI package.
import type { ViewerKind } from "./contract";

/** How many leading bytes {@link detectKind} wants; the server reads this many. */
export const KIND_HEAD_BYTES = 8192;

const EXTENSION_KINDS: Readonly<Record<string, ViewerKind>> = {
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	bmp: "image",
	ico: "image",
	avif: "image",
	svg: "image",
	pdf: "pdf",
	html: "html",
	htm: "html",
	xhtml: "html",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	docx: "docx",
	pptx: "pptx",
	xlsx: "xlsx",
	xlsm: "xlsx",
};

/** Formats whose Office kind needs the ZIP container the name promises. */
const OFFICE_KINDS: Readonly<Record<string, true>> = { docx: true, pptx: true, xlsx: true };

export function fileExtension(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? filename;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const startsWith = (head: Uint8Array, signature: readonly number[], at = 0): boolean =>
	head.length >= at + signature.length && signature.every((byte, index) => head[at + index] === byte);

const ascii = (text: string): number[] => Array.from(text, char => char.charCodeAt(0));

type Sniffed = "image" | "pdf" | "zip" | "binary" | undefined;

function sniff(head: Uint8Array): Sniffed {
	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
	if (startsWith(head, [0xff, 0xd8, 0xff])) return "image"; // JPEG
	if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return "image";
	if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "image";
	if (startsWith(head, ascii("ftypavif"), 4) || startsWith(head, ascii("ftypavis"), 4)) return "image"; // AVIF
	// A PDF may carry up to 1 KiB of junk before its header (the spec's own allowance).
	const pdf = ascii("%PDF-");
	for (let at = 0; at <= Math.min(1024, head.length - pdf.length); at++) if (startsWith(head, pdf, at)) return "pdf";
	if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return "zip";
	if (startsWith(head, [0x1f, 0x8b])) return "binary"; // gzip
	if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return "binary"; // ELF
	if (startsWith(head, [0x4d, 0x5a])) return "binary"; // MZ (exe, dll)
	if (startsWith(head, ascii("SQLite format 3\0"))) return "binary";
	if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(head, ascii("Rar!"))) return "binary";
	if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "binary"; // legacy OLE (doc, xls)
	return undefined;
}

/** A recording: whether it is sound or picture, and the MIME type its `Blob` is given so the browser opens the right demuxer. */
export interface MediaSniff {
	readonly kind: "audio" | "video";
	readonly mime: string;
}

const audio = (mime: string): MediaSniff => ({ kind: "audio", mime });
const video = (mime: string): MediaSniff => ({ kind: "video", mime });

/** ISO base media brands (the four bytes after `ftyp`) that are sound only. */
const ISO_AUDIO_BRANDS: Readonly<Record<string, true>> = { "M4A ": true, "M4B ": true, "M4P ": true, "F4A ": true };
/** General-purpose brands: an MP4 with these is a film OR a song. The name is the only tell, and the bytes are never taken as proof of a picture over it. */
const ISO_GENERIC_BRANDS: Readonly<Record<string, true>> = { isom: true, iso2: true, iso3: true, iso4: true, iso5: true, iso6: true, mp41: true, mp42: true };
/** Brands that are a picture. A brand in none of the tables is judged by the name. */
const ISO_VIDEO_BRANDS: Readonly<Record<string, true>> = {
	avc1: true,
	dash: true,
	"M4V ": true,
	M4VH: true,
	M4VP: true,
	"F4V ": true,
	mmp4: true,
	MSNV: true,
	XAVC: true,
};
/** Atoms an old QuickTime file opens with, where a modern one has `ftyp`. */
const QUICKTIME_ATOMS: Readonly<Record<string, true>> = { moov: true, mdat: true, wide: true, free: true, skip: true };

const text4 = (head: Uint8Array, at: number): string => String.fromCharCode(...head.subarray(at, at + 4));
const isIn = (table: Readonly<Record<string, true>>, key: string): boolean => Object.hasOwn(table, key);

/** MPEG audio bitrates (kbit/s) for bitrate indexes 1 to 14, by the version and layer the header names. */
const BITRATES_V1_L1: readonly number[] = [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const BITRATES_V1_L2: readonly number[] = [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const BITRATES_V1_L3: readonly number[] = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L1: readonly number[] = [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const BITRATES_V2_L2_L3: readonly number[] = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** Sample rates (Hz) by sample-rate index 0 to 2, for the version bits: 3 is MPEG-1, 2 is MPEG-2, 0 is MPEG-2.5. */
const MPEG_RATES: Readonly<Record<number, readonly number[]>> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * The length in bytes of the MPEG audio frame whose header starts at `at`, or `undefined` when what is there is
 * not a frame header: the 11 sync bits, and a version, layer, bitrate and sample rate that are not reserved.
 * A free-format frame (bitrate index 0) has no length the header can tell, so it is not one either.
 */
function mpegFrameLength(head: Uint8Array, at: number): number | undefined {
	const b1 = head[at + 1];
	const b2 = head[at + 2];
	if (head[at] !== 0xff || b1 === undefined || b2 === undefined || (b1 & 0xe0) !== 0xe0) return undefined;
	const version = (b1 >> 3) & 3;
	const layer = (b1 >> 1) & 3; // 3 is layer I, 2 is II, 1 is III
	const bitrateIndex = b2 >> 4;
	const rate = MPEG_RATES[version]?.[(b2 >> 2) & 3];
	if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 0xf || rate === undefined) return undefined;
	const mpeg1 = version === 3;
	const bitrates = layer === 3 ? (mpeg1 ? BITRATES_V1_L1 : BITRATES_V2_L1) : layer === 2 ? (mpeg1 ? BITRATES_V1_L2 : BITRATES_V2_L2_L3) : mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L2_L3;
	const bitrate = (bitrates[bitrateIndex - 1] as number) * 1000;
	const padding = (b2 >> 1) & 1;
	// Layer I counts in 4-byte slots; layer III of MPEG-2 and 2.5 has half the samples per frame of the rest.
	if (layer === 3) return (Math.floor((12 * bitrate) / rate) + padding) * 4;
	return Math.floor(((layer === 1 && !mpeg1 ? 72 : 144) * bitrate) / rate) + padding;
}

/**
 * Whether `head` opens with MPEG audio that is not just three bytes that could start anything: a whole first frame
 * (its length worked out from its own header) followed by another frame, a tag, or nothing. A bare `FF Ex` is
 * also how a UTF-16 text file begins (its byte-order mark is `FF FE`), so one header alone is not a recording.
 */
function isMpegAudioFrame(head: Uint8Array): boolean {
	const length = mpegFrameLength(head, 0);
	if (length === undefined) return false;
	// After a frame comes the next frame, an ID3v1 tag at the end of the file, or the end of a file of one frame.
	return head.length === length || mpegFrameLength(head, length) !== undefined || startsWith(head, ascii("TAG"), length);
}

/** An ID3v2 tag: `ID3`, a major version of 2 to 4, and a size written in 7-bit bytes. Three letters alone are also how a text file can begin. */
function isId3Tag(head: Uint8Array): boolean {
	const major = head[3] ?? 0;
	return startsWith(head, ascii("ID3")) && major >= 2 && major <= 4 && head.length >= 10 && [6, 7, 8, 9].every(at => (head[at] ?? 0xff) < 0x80);
}

/** An ADTS header (raw AAC): twelve sync bits, layer 00, a defined sampling-frequency index. */
function isAdtsFrame(head: Uint8Array): boolean {
	const b0 = head[0];
	const b1 = head[1];
	const b2 = head[2];
	return b0 === 0xff && b1 !== undefined && b2 !== undefined && (b1 & 0xf6) === 0xf0 && ((b2 >> 2) & 0xf) < 13;
}

/**
 * Whether `head` is a recording the browser can be asked to play, from its first bytes (the
 * container's signature) and, where the bytes cannot say, its name. A name alone never makes
 * a recording: `a.mp3` over text is text.
 */
export function sniffMedia(head: Uint8Array, filename: string): MediaSniff | undefined {
	const extension = fileExtension(filename);
	if (isId3Tag(head) || isMpegAudioFrame(head)) return audio("audio/mpeg");
	if (isAdtsFrame(head)) return audio("audio/aac");
	if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WAVE"), 8)) return audio("audio/wav");
	if (startsWith(head, ascii("fLaC"))) return audio("audio/flac");
	// An Ogg page opens `OggS` and a stream-structure version of 0.
	if (startsWith(head, ascii("OggS")) && head[4] === 0) {
		// Theora in the first page is a picture; everything else Ogg carries here is sound.
		const theora = String.fromCharCode(...head.subarray(0, 256)).includes("\x80theora");
		return extension === "ogv" || theora ? video("video/ogg") : audio("audio/ogg");
	}
	if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
		// The EBML header names its document type in plain ASCII: `webm`, or `matroska`.
		const matroska = String.fromCharCode(...head.subarray(0, 64)).includes("matroska");
		if (extension === "weba" || extension === "mka") return audio(matroska ? "audio/x-matroska" : "audio/webm");
		return video(matroska ? "video/x-matroska" : "video/webm");
	}
	if (startsWith(head, ascii("ftyp"), 4)) {
		const brand = text4(head, 8);
		const named = extension === "m4a" || extension === "m4b";
		if (isIn(ISO_AUDIO_BRANDS, brand) || (named && isIn(ISO_GENERIC_BRANDS, brand))) return audio("audio/mp4");
		if (brand === "qt  ") return video("video/quicktime");
		if (isIn(ISO_GENERIC_BRANDS, brand) || isIn(ISO_VIDEO_BRANDS, brand) || brand.startsWith("3gp") || brand.startsWith("3g2")) return video("video/mp4");
		// Some other brand (an image, a raw video stream): only the name can say it is a movie.
		if (extension === "mp4" || extension === "m4v") return video("video/mp4");
		if (extension === "mov") return video("video/quicktime");
		return undefined;
	}
	if (extension === "mov" && isIn(QUICKTIME_ATOMS, text4(head, 4))) return video("video/quicktime");
	return undefined;
}

/** Which renderer a file gets. `head` is the file's first {@link KIND_HEAD_BYTES}
 *  bytes (or all of it); `size` is its full length. */
export function detectKind(filename: string, head: Uint8Array, size: number = head.length): ViewerKind {
	// Nothing to render: an empty file is an empty text, whatever it is called.
	if (size === 0) return "text";
	// A NUL byte in the head is the classic "this is not text" test (`head.includes(0)` below).
	const extension = fileExtension(filename);
	// `hasOwn`: a file called `x.constructor` must not resolve through the prototype chain.
	const named = Object.hasOwn(EXTENSION_KINDS, extension) ? EXTENSION_KINDS[extension] : undefined;
	const sniffed = sniff(head);
	if (sniffed === "image" || sniffed === "pdf") return sniffed;
	// A recording by its container signature; the name only settles what the bytes cannot (an ISO file with no
	// telling brand). An `.mp3` over text is text, and unrecognisable bytes under any name stay binary.
	const recording = sniffMedia(head, filename);
	if (recording !== undefined) return recording.kind;
	if (named !== undefined && OFFICE_KINDS[named]) {
		if (sniffed === "zip") return named;
	} else if (named === "image") {
		// SVG is text; the raster formats without a strong signature need the name AND a plausible head.
		if (extension === "svg") return head.includes(0) ? "binary" : "image";
		if (extension === "bmp" && startsWith(head, ascii("BM"))) return "image";
		if (extension === "ico" && (startsWith(head, [0, 0, 1, 0]) || startsWith(head, [0, 0, 2, 0]))) return "image";
	} else if (named === "html" || named === "markdown") {
		return head.includes(0) ? "binary" : named;
	}
	return sniffed === "binary" || sniffed === "zip" || head.includes(0) ? "binary" : "text";
}
