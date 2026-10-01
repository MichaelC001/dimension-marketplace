// What a recording IS, decided from its first bytes and its name. Content beats a wrong
// name for every container with a signature (as it does for images); the name only settles
// what the bytes cannot say (an ISO file whose brand is not telling); and a name alone never
// makes music out of text.
import { describe, expect, test } from "bun:test";
import { detectKind, sniffMedia } from "../src/kind";

const ascii = (text: string): number[] => Array.from(text, char => char.charCodeAt(0));
const head = (...parts: (number[] | string)[]): Uint8Array =>
	Uint8Array.from(parts.flatMap(part => (typeof part === "string" ? ascii(part) : part)));
const pad = (bytes: Uint8Array, to = 64): Uint8Array => {
	const out = new Uint8Array(Math.max(to, bytes.length));
	out.set(bytes);
	return out;
};

/** An MPEG audio frame of `length` bytes: the 4-byte header (`b1`, `b2` after the sync byte) and a body of zeros. */
const frame = (b1: number, b2: number, length: number): number[] => [0xff, b1, b2, 0x00, ...new Array<number>(length - 4).fill(0)];

const ID3 = pad(head("ID3", [3, 0, 0, 0, 0, 0x0a, 0x40]));
const MPEG = head(frame(0xfb, 0x90, 417), frame(0xfb, 0x90, 417));
const ADTS = pad(head([0xff, 0xf1, 0x50, 0x80, 0x1c]));
const WAV = pad(head("RIFF", [0x24, 0, 0, 0], "WAVEfmt "));
const FLAC = pad(head("fLaC", [0, 0, 0, 0x22]));
const OGG_PAGE = [...ascii("OggS"), 0, 2, ...new Array<number>(20).fill(0)];
const OGG_VORBIS = pad(head(OGG_PAGE, [0x01], "vorbis"));
const OGG_OPUS = pad(head(OGG_PAGE, "OpusHead"));
const OGG_THEORA = pad(head(OGG_PAGE, [0x80], "theora"));
const iso = (brand: string) => pad(head([0, 0, 0, 0x20], "ftyp", brand, [0, 0, 0, 0], "isomiso2"));
const EBML = (docType: string) => pad(head([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x84], docType));
const PNG = pad(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

describe("a recording is known by its container signature, under any name", () => {
	test.each([
		["MP3 with an ID3 tag", "song.dat", ID3, "audio", "audio/mpeg"],
		["MP3 with no tag, from the frame header", "song.dat", MPEG, "audio", "audio/mpeg"],
		["raw AAC (ADTS)", "clip.dat", ADTS, "audio", "audio/aac"],
		["WAV", "take.dat", WAV, "audio", "audio/wav"],
		["FLAC", "take.dat", FLAC, "audio", "audio/flac"],
		["Ogg Vorbis", "take.dat", OGG_VORBIS, "audio", "audio/ogg"],
		["Ogg Opus", "take.dat", OGG_OPUS, "audio", "audio/ogg"],
		["Ogg Theora", "take.dat", OGG_THEORA, "video", "video/ogg"],
		["an M4A", "take.dat", iso("M4A "), "audio", "audio/mp4"],
		["an MP4 (isom)", "take.dat", iso("isom"), "video", "video/mp4"],
		["an MP4 (mp42)", "take.dat", iso("mp42"), "video", "video/mp4"],
		["an M4V", "take.dat", iso("M4V "), "video", "video/mp4"],
		["a QuickTime movie", "take.dat", iso("qt  "), "video", "video/quicktime"],
		["a 3GP phone video", "take.dat", iso("3gp5"), "video", "video/mp4"],
		["WebM", "take.dat", EBML("webm"), "video", "video/webm"],
		["Matroska", "take.dat", EBML("matroska"), "video", "video/x-matroska"],
	] as const)("%s", (_what, name, bytes, kind, mime) => {
		expect(detectKind(name, bytes)).toBe(kind);
		expect(sniffMedia(bytes, name)).toEqual({ kind, mime });
	});

	test("what the extension says only settles what the bytes cannot: sound-only containers named for sound, picture named for picture", () => {
		// The same ISO brand is a film or a song; the name is the only tell.
		expect(detectKind("song.m4a", iso("isom"))).toBe("audio");
		expect(detectKind("film.mp4", iso("isom"))).toBe("video");
		expect(detectKind("song.weba", EBML("webm"))).toBe("audio");
		expect(detectKind("film.webm", EBML("webm"))).toBe("video");
		expect(detectKind("film.ogv", OGG_VORBIS)).toBe("video");
		// An ISO file in a brand nobody lists is a movie if it says it is one, and nothing if it does not.
		expect(detectKind("film.mp4", iso("xxxx"))).toBe("video");
		expect(detectKind("old.mov", iso("xxxx"))).toBe("video");
		expect(detectKind("unknown.bin", iso("xxxx"))).toBe("binary");
	});

	test("an old QuickTime file, which opens with an atom and no ftyp, is a movie only if it is named one", () => {
		const moov = pad(head([0, 0, 0x10, 0], "moov"));
		expect(detectKind("old.mov", moov)).toBe("video");
		expect(detectKind("old.bin", moov)).toBe("binary");
	});
});

describe("content beats a wrong name, and a name alone makes nothing", () => {
	test("a recording under the wrong name, or none, is still a recording", () => {
		expect(detectKind("song.txt", ID3)).toBe("audio");
		expect(detectKind("song", WAV)).toBe("audio");
		expect(detectKind("song.png", FLAC)).toBe("audio");
		expect(detectKind("film.mp3", iso("isom"))).toBe("video");
		expect(detectKind("film.pdf", EBML("webm"))).toBe("video");
	});

	test("a picture or a PDF under a recording's name is still the picture or the PDF", () => {
		expect(detectKind("song.mp3", PNG)).toBe("image");
		expect(detectKind("film.mp4", pad(head("%PDF-1.7\n")))).toBe("pdf");
		// AVIF is an ISO file too; it is an image, not a film.
		expect(detectKind("film.mp4", pad(head([0, 0, 0, 0x1c], "ftypavif")))).toBe("image");
	});

	test("text under a recording's name is text, and bytes nobody recognises are a file, not a song", () => {
		expect(detectKind("song.mp3", head("this is really a note to self\n"))).toBe("text");
		expect(detectKind("film.mp4", head("not a movie\n"))).toBe("text");
		expect(detectKind("song.mp3", pad(head([0x00, 0x01, 0x02, 0x03])))).toBe("binary");
		expect(detectKind("film.mkv", pad(head([0x00, 0x00, 0x00, 0x00])))).toBe("binary");
	});

	test("three letters that start a recording also start a note: `ID3` alone is not an MP3", () => {
		expect(detectKind("notes.txt", head("ID3 is the tag at the front of an MP3 file.\n"))).toBe("text");
		// …nor `OggS` with no page structure behind it.
		expect(detectKind("notes.txt", head("OggS stands for the page header\n"))).toBe("text");
	});

	test("a sync pattern that cannot be an audio frame is not one", () => {
		// Version bits 01 are reserved; layer 00 is reserved (that pattern is ADTS or nothing); bitrate index 15 and sample-rate 3 are reserved.
		for (const bytes of [[0xff, 0xeb, 0x90, 0], [0xff, 0xe1, 0x90, 0], [0xff, 0xfb, 0xf0, 0], [0xff, 0xfb, 0x9c, 0]]) {
			expect(detectKind("x.bin", pad(head(bytes))), bytes.map(byte => byte.toString(16)).join(" ")).toBe("binary");
		}
		// A JPEG also begins 0xFF: it must stay a picture, whatever follows.
		expect(detectKind("x.mp3", pad(head([0xff, 0xd8, 0xff, 0xe0])))).toBe("image");
	});

	test("an ADTS header names a sampling-frequency index of 0 to 12; 13 to 15 are reserved, so the header is not audio", () => {
		// Sync, layer 00, then profile 01 and the 4-bit index in the third byte.
		const adts = (index: number) => pad(head([0xff, 0xf1, 0x40 | (index << 2), 0x80, 0x1c]));
		for (let index = 0; index <= 12; index += 1) expect(sniffMedia(adts(index), "x.bin"), `index ${index}`).toEqual({ kind: "audio", mime: "audio/aac" });
		for (const index of [13, 14, 15]) expect(detectKind("x.bin", adts(index)), `index ${index}`).toBe("binary");
	});

	test("a modern ISO image (HEIC) is not mistaken for a film", () => {
		expect(detectKind("photo.heic", iso("heic"))).toBe("binary");
		expect(detectKind("photo.heic", iso("mif1"))).toBe("binary");
	});

	test("an empty file is empty text, whatever it is called", () => {
		expect(detectKind("song.mp3", new Uint8Array(0))).toBe("text");
	});
});

describe("MPEG audio is a chain of frames, not three bytes that could start anything", () => {
	// [what, b1, b2, the frame's length in bytes]: the lengths are the ones the MPEG audio tables give
	// (bitrate x samples per frame / sample rate, plus a padding byte or slot), worked by hand.
	const SHAPES = [
		["MPEG-1 layer III, 128 kbit/s, 44.1 kHz", 0xfb, 0x90, 417],
		["the same, with the padding byte", 0xfb, 0x92, 418],
		["MPEG-1 layer III, 32 kbit/s, 48 kHz", 0xfb, 0x14, 96],
		["MPEG-1 layer II, 128 kbit/s, 44.1 kHz", 0xfd, 0x80, 417],
		["MPEG-1 layer I, 128 kbit/s, 44.1 kHz (slots of four bytes)", 0xff, 0x40, 136],
		["the same, with its padding slot", 0xff, 0x42, 140],
		["MPEG-2 layer III, 64 kbit/s, 22.05 kHz (half the samples per frame)", 0xf3, 0x80, 208],
		["MPEG-2 layer II, 64 kbit/s, 22.05 kHz", 0xf5, 0x80, 417],
		["MPEG-2.5 layer III, 64 kbit/s, 11.025 kHz", 0xe3, 0x80, 417],
	] as const;

	test.each(SHAPES)("%s: two frames of that length are a recording", (_what, b1, b2, length) => {
		const bytes = head(frame(b1, b2, length), frame(b1, b2, length));
		expect(detectKind("take.dat", bytes)).toBe("audio");
		expect(sniffMedia(bytes, "take.dat")).toEqual({ kind: "audio", mime: "audio/mpeg" });
	});

	test.each(SHAPES)("%s: the length is held to the byte, so a next frame one byte early or late is not a chain", (_what, b1, b2, length) => {
		for (const off of [-1, 1]) {
			const bytes = head(frame(b1, b2, length + off), frame(b1, b2, length));
			expect(detectKind("take.dat", bytes), `${off} byte`).toBe("binary");
		}
	});

	test("a file of one frame is a recording; so is one frame and an ID3v1 tag after it", () => {
		expect(detectKind("short.dat", head(frame(0xfb, 0x90, 417)))).toBe("audio");
		expect(detectKind("short.dat", head(frame(0xfb, 0x90, 417), "TAG", new Array<number>(125).fill(0)))).toBe("audio");
	});

	test("a first frame cut short, or followed by bytes that are no frame, is not one", () => {
		expect(detectKind("cut.dat", head(frame(0xfb, 0x90, 417).slice(0, 300)))).toBe("binary");
		expect(detectKind("junk.dat", head(frame(0xfb, 0x90, 417), [0x12, 0x34, 0x56, 0x78, 0x9a]))).toBe("binary");
		expect(detectKind("junk.dat", head(frame(0xfb, 0x90, 417), [0x12, 0x34]))).toBe("binary");
	});

	test("a frame whose length the header cannot tell (free format) is not taken for a recording on its own say-so", () => {
		expect(detectKind("free.dat", head(frame(0xfb, 0x00, 417), frame(0xfb, 0x00, 417)))).toBe("binary");
	});
});

describe("text in UTF-16 or UTF-32 is not music: its byte-order mark is also an MPEG sync", () => {
	const utf16 = (text: string): Uint8Array => new Uint8Array(Buffer.from(`\uFEFF${text}`, "utf16le"));
	const utf32 = (text: string): Uint8Array => {
		const out = new Uint8Array(4 + text.length * 4);
		out.set([0xff, 0xfe, 0, 0]);
		for (let at = 0; at < text.length; at += 1) out[4 + at * 4] = text.charCodeAt(at);
		return out;
	};
	const prose = "Notes for Monday. Ask about the invoice, then move the call to Tuesday. ".repeat(12);

	test.each(["notes.txt", "data.csv", "readme.md", "song.mp3", "noname"])("a UTF-16 file called %s is still not a recording", name => {
		expect(detectKind(name, utf16(prose))).toBe("binary");
		expect(detectKind(name, utf16("H"))).toBe("binary");
		expect(detectKind(name, utf16("Hello, notes\n"))).toBe("binary");
		expect(sniffMedia(utf16(prose), name)).toBeUndefined();
	});

	test("…even when the header it begins with is a whole one: only a second frame makes a chain", () => {
		// FF FE 48 00 reads as MPEG-1 layer I, 128 kbit/s, 32 kHz: a 192-byte first frame the text is long enough to hold.
		const bytes = utf16("H".repeat(200));
		expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x48, 0x00]);
		expect(bytes.length).toBeGreaterThan(192 + 4);
		expect(sniffMedia(bytes, "notes.txt")).toBeUndefined();
	});

	test("a UTF-32 file is not music", () => {
		expect(detectKind("notes.txt", utf32(prose))).toBe("binary");
		expect(sniffMedia(utf32(prose), "notes.txt")).toBeUndefined();
	});

	test("UTF-16 text with no NUL in it is text, as it was before recordings were known", () => {
		expect(detectKind("notes.txt", utf16("中文".repeat(200)))).toBe("text");
	});
});
