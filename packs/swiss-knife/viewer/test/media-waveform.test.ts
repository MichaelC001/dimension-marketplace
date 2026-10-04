// When a recording is allowed to be decoded for a waveform, and what becomes of the sound that comes back.
// `decodeAudioData` turns the WHOLE file into samples at whatever length its bytes really hold, so the size a
// container's header CLAIMS is no bound: a 110 KB FLAC with a patched header decodes to 200 MB and a 640 KB one to
// 1.2 GB. The gate therefore hands the decoder a file of only TWO kinds, each bounded by its own bytes: an uncompressed
// WAV (its chunks, checked against the bytes there) and a STRICT MP3 (its frames WALKED from their own headers, from the
// first byte or the end of a verified ID3v2 tag, with no other container's magic near the start; the player's length
// must agree with the count). Every other compressed format is a plain track whatever the player says it lasts, and a
// sound that does come back is checked again against the caps and the player's length before a channel is read. The
// decodes themselves run one at a time. These are the cases that would hurt the View's memory, one at a time.
import { afterEach, describe, expect, test } from "bun:test";
import { decodePeaks, WAVEFORM_BUCKETS, waveformAllowed } from "../app/view/media-waveform";

const MIB = 1024 * 1024;
/** The most bytes of file that are ever decoded. */
const LIMIT_BYTES = 32 * MIB;
/** The most bytes of decoded 32-bit floats, every channel counted. */
const DECODED_CAP = 96 * MIB;
/** The rate the sound is decoded at, which is what a decoded length is read back at. */
const DECODE_RATE = 22_050;

const ascii = (text: string): number[] => Array.from(text, char => char.charCodeAt(0));
const le16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

const zeros = (length: number): Uint8Array => new Uint8Array(length);

function cat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** A copy of `file` with `bytes` written over it from `at`. */
function plant(file: Uint8Array, at: number, bytes: readonly number[]): Uint8Array {
	const out = file.slice();
	out.set(bytes, at);
	return out;
}

/** `head` at the start of `size` bytes of silence. */
const padded = (head: number[], size = 4096): Uint8Array => {
	const out = new Uint8Array(size);
	out.set(head);
	return out;
};

/** Bytes from a seeded generator: the same "random" file on every run. */
function noise(length: number, seed = 0x9e3779b9): Uint8Array {
	const out = new Uint8Array(length);
	let state = seed >>> 0;
	for (let index = 0; index < length; index += 1) {
		state = (state ^ (state << 13)) >>> 0;
		state = (state ^ (state >>> 17)) >>> 0;
		state = (state ^ (state << 5)) >>> 0;
		out[index] = state & 0xff;
	}
	return out;
}

/** The standard sub-format GUID base that follows the two format bytes in an extensible `fmt ` chunk. */
const GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

interface WavOptions {
	/** The format tag; `0xfffe` makes an extensible format that names `subTag`. */
	tag?: number;
	subTag?: number;
	guidTail?: number[];
	channels?: number;
	rate?: number;
	bits?: number;
	/** Bytes of sample data actually in the file. */
	data?: number;
	/** What the data chunk's header says; defaults to the truth. */
	declared?: number;
	/** Chunks between `WAVE` and `fmt `. */
	junkBefore?: number;
	/** A second chunk with this id, placed just before `data`. */
	repeat?: "fmt " | "data";
	omit?: "fmt " | "data";
	blockAlign?: number;
}

function chunk(id: string, body: number[]): number[] {
	return [...ascii(id), ...le32(body.length), ...body, ...(body.length % 2 === 1 ? [0] : [])];
}

/** A WAV file with `data` bytes of sound, built the way a real encoder lays it out. */
function wav(options: WavOptions = {}): Uint8Array {
	const { tag = 1, channels = 2, rate = 44100, bits = 16, data = 1000, junkBefore = 0 } = options;
	const blockAlign = options.blockAlign ?? channels * (bits / 8);
	const extensible = tag === 0xfffe;
	const fmtBody = [
		...le16(tag),
		...le16(channels),
		...le32(rate),
		...le32(rate * blockAlign),
		...le16(blockAlign),
		...le16(bits),
		...(extensible ? [...le16(22), ...le16(bits), ...le32(0), ...le16(options.subTag ?? 1), ...(options.guidTail ?? GUID_TAIL)] : []),
	];
	const fmt = chunk("fmt ", fmtBody);
	const junk = Array.from({ length: junkBefore }, () => chunk("JUNK", [0, 0])).flat();
	const sound = new Uint8Array(data);
	const header = (declared: number) => [...ascii("data"), ...le32(declared)];
	const dataHeader = header(options.declared ?? data);
	const head = [
		...ascii("RIFF"),
		...le32(0),
		...ascii("WAVE"),
		...junk,
		...(options.omit === "fmt " ? [] : fmt),
		...(options.repeat === "fmt " ? fmt : []),
		...(options.repeat === "data" ? [...header(4), 0, 0, 0, 0] : []),
	];
	const out = new Uint8Array(head.length + (options.omit === "data" ? 0 : dataHeader.length + data));
	out.set(head);
	if (options.omit !== "data") {
		out.set(dataHeader, head.length);
		out.set(sound, head.length + dataHeader.length);
	}
	return out;
}

/** What a player reports for a WAV is never read, so any positive length will do. */
const wavAllowed = (file: Uint8Array): boolean => waveformAllowed(file, 60);

// ── MP3 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Layer III frames as the standard lays them out: a 4-byte header, then the bytes its bitrate, rate and padding say.

/** Layer III bitrates in kbps by the header's index: MPEG 1, and MPEG 2 / 2.5. */
const MPEG2_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const KBPS: Readonly<Record<number, readonly number[]>> = { 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: MPEG2_KBPS, 0: MPEG2_KBPS };
/** Sample rates by the header's rate index, for each version: 3 is MPEG 1, 2 is MPEG 2, 0 is MPEG 2.5. */
const RATES: Readonly<Record<number, readonly number[]>> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8000] };

interface FrameSpec {
	/** The header's version bits. Defaults to MPEG 1. */
	version?: number;
	/** The header's bitrate index. Defaults to 9: 128 kbps in MPEG 1, 80 kbps in MPEG 2. */
	bitrate?: number;
	/** The header's rate index. Defaults to 0: 44.1 kHz in MPEG 1, 22.05 kHz in MPEG 2. */
	rate?: number;
	mono?: boolean;
	/** The header's layer bits: 1 is Layer III, 2 is Layer II, 3 is Layer I, 0 is reserved. */
	layer?: number;
}

/** One frame: the length its header names (417 bytes for a header that names none), the header, and silence. */
function frame(spec: FrameSpec, padding: boolean): Uint8Array {
	const { version = 3, bitrate = 9, rate = 0, mono = false, layer = 1 } = spec;
	const kbps = KBPS[version]?.[bitrate];
	const hz = RATES[version]?.[rate];
	const length = kbps && hz ? Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / hz) + (padding ? 1 : 0) : 417;
	const out = new Uint8Array(length);
	out.set([0xff, 0xe0 | (version << 3) | (layer << 1) | 1, (bitrate << 4) | (rate << 2) | (padding ? 2 : 0), mono ? 0xc0 : 0]);
	return out;
}

/** `count` frames of one stream back to back; `padding(index)` says which carry the padding bit (a constant-bitrate encoder sets it on most, to hold the average). */
function mp3(count: number, spec: FrameSpec = {}, padding: (index: number) => boolean = () => false): Uint8Array {
	const plain = frame(spec, false);
	const extra = frame(spec, true);
	let total = 0;
	for (let index = 0; index < count; index += 1) total += padding(index) ? extra.length : plain.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (let index = 0; index < count; index += 1) {
		const one = padding(index) ? extra : plain;
		out.set(one, at);
		at += one.length;
	}
	return out;
}

/** The seconds `count` frames of `spec` play for: 1152 samples a frame in MPEG 1, 576 in MPEG 2 and 2.5. This is what a player reads off the stream. */
const seconds = (count: number, { version = 3, rate = 0 }: FrameSpec = {}): number => (count * (version === 3 ? 1152 : 576)) / (RATES[version]?.[rate] as number);

/** The thinnest frames there are: MPEG 2 at 24 kHz and 8 kbps, mono, 24 bytes for 576 samples. */
const thin: FrameSpec = { version: 2, rate: 1, bitrate: 1, mono: true };

/** An ID3 size is four 7-bit bytes. */
const synchsafe = (size: number): number[] => [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];

interface Id3Options {
	/** Announces a footer by the flag and lays one out. A footer exists from version 2.4 on, which is the default then. */
	footer?: boolean;
	major?: number;
	revision?: number;
	/** The flags byte; defaults to the footer flag when there is a footer and no flags otherwise. */
	flags?: number;
	/** What the header says the size is; defaults to the truth. */
	sizeBytes?: number[];
	/** What the footer begins with ("3DI" is the header's "ID3" reversed). */
	footerMagic?: string;
}

/** An ID3v2 tag with `body` bytes of (silent) frames, and the 10-byte footer the flag announces when it has one. */
function id3(body: number, { footer = false, major = footer ? 4 : 3, revision = 0, flags = footer ? 0x10 : 0, sizeBytes = synchsafe(body), footerMagic = "3DI" }: Id3Options = {}): Uint8Array {
	const out = new Uint8Array(10 + body + (footer ? 10 : 0));
	out.set([...ascii("ID3"), major, revision, flags, ...sizeBytes]);
	if (footer) out.set(ascii(footerMagic), 10 + body);
	return out;
}

/** The first bytes of the containers whose magic a sniffer reads a file by. */
const MAGICS: Readonly<Record<string, readonly number[]>> = {
	ogg: ascii("OggS"),
	flac: ascii("fLaC"),
	mp4: ascii("ftyp"),
	riff: ascii("RIFF"),
	form: ascii("FORM"),
	ebml: [0x1a, 0x45, 0xdf, 0xa3],
};

// ── other compressed audio ───────────────────────────────────────────────────────────────────────────────────

interface AdtsOptions {
	/** Bytes of the file (at least the 7 of the header); defaults to the frame's length. */
	size?: number;
	/** The sampling-frequency index. */
	rate?: number;
	/** The layer bits, which are 00 in ADTS and the others in an MP3. */
	layer?: number;
}

/** One ADTS frame (the framing of raw AAC) whose header says it is `length` bytes. */
function adts(length: number, { size = length, rate = 4, layer = 0 }: AdtsOptions = {}): Uint8Array {
	const out = new Uint8Array(size);
	out.set([0xff, 0xf1 | (layer << 1), 0x40 | (rate << 2), 0x80 | ((length >> 11) & 3), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc]);
	return out;
}

/** One file of each kind of container the engine opens by its first bytes. */
const CONTAINERS: Readonly<Record<string, Uint8Array>> = {
	ogg: padded(ascii("OggS")),
	flac: padded(ascii("fLaC")),
	mp4: padded([0, 0, 0, 0x20, ...ascii("ftypM4A ")]),
	webm: padded([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii("webm")]),
	aiff: padded([...ascii("FORM"), 0, 0, 0x10, 0, ...ascii("AIFF")]),
	aifc: padded([...ascii("FORM"), 0, 0, 0x10, 0, ...ascii("AIFC")]),
	"aac, two frames": cat(adts(100), adts(100)),
	"aac, one frame reaching the end": adts(100),
};

describe("a WAV whose own header the viewer has checked is decoded", () => {
	test("the usual shapes: 16-bit stereo, 8-bit mono, 24-bit, 32-bit, and 32 and 64-bit float", () => {
		for (const [bits, tag] of [[8, 1], [16, 1], [24, 1], [32, 1], [32, 3], [64, 3]] as const) {
			expect(wavAllowed(wav({ tag, bits, channels: 2, data: 40_000 })), `${bits}-bit tag ${tag}`).toBe(true);
		}
		expect(wavAllowed(wav({ channels: 1, bits: 8, rate: 8000, data: 8000 }))).toBe(true);
	});

	test("an extensible format that names plain PCM or float is the same sound", () => {
		expect(wavAllowed(wav({ tag: 0xfffe, subTag: 1, bits: 24, channels: 6, data: 60_000 }))).toBe(true);
		expect(wavAllowed(wav({ tag: 0xfffe, subTag: 3, bits: 32, channels: 2, data: 40_000 }))).toBe(true);
	});

	test("a few other chunks around the two it needs are normal (a LIST of tags, a JUNK pad)", () => {
		expect(wavAllowed(wav({ junkBefore: 10 }))).toBe(true);
	});

	test("a WAV is judged on its own bytes whatever length the player reports, or does not report yet", () => {
		const good = wav({ data: 40_000 });
		const lying = wav({ data: 1000, declared: 1_000_000_000 });
		for (const claimed of [0, Number.NaN, Number.POSITIVE_INFINITY, -1, 0.001, 1e9]) {
			expect(waveformAllowed(good, claimed), `good WAV, player says ${claimed}`).toBe(true);
			expect(waveformAllowed(lying, claimed), `lying WAV, player says ${claimed}`).toBe(false);
		}
	});
});

describe("anything the viewer cannot measure for itself is a plain track", () => {
	test("bytes that open like nothing the engine decodes are refused at any claim, however small and honest they look", () => {
		const heads: Record<string, number[]> = {
			// An ID3 tag (10 bytes) with nothing recognisable after it.
			"an ID3 tag and then nothing": [...ascii("ID3"), 3, 0, 0, 0, 0, 0, 10],
			// RIFF, but not WAVE: an AVI is not a sound.
			avi: [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("AVI "), ...ascii("LIST")],
			// Big-endian and 64-bit RIFF are not read at all.
			rifx: [...ascii("RIFX"), 0, 0, 0, 0, ...ascii("WAVE")],
			rf64: [...ascii("RF64"), 0xff, 0xff, 0xff, 0xff, ...ascii("WAVE")],
			// A FORM that is not an audio interchange file.
			"an IFF 8SVX": [...ascii("FORM"), 0, 0, 0x10, 0, ...ascii("8SVX")],
			text: ascii("this is not audio at all, however it is named"),
			silence: [],
		};
		const files: Record<string, Uint8Array> = { random: noise(8192), "every byte a sync word": new Uint8Array(4096).fill(0xff) };
		for (const [name, head] of Object.entries(heads)) files[name] = padded(head);
		for (const [name, file] of Object.entries(files)) {
			for (const claimed of [1, 60, 136]) expect(waveformAllowed(file, claimed), `${name} at ${claimed} s`).toBe(false);
		}
	});

	test("a magic cut off short, an empty file, and a bare RIFF are refused", () => {
		const cut: Record<string, Uint8Array> = {
			ogg: Uint8Array.of(...ascii("Ogg")),
			flac: Uint8Array.of(...ascii("fLa")),
			mp4: Uint8Array.of(0, 0, 0, 0x20, ...ascii("fty")),
			ebml: Uint8Array.of(0x1a, 0x45, 0xdf),
			aiff: Uint8Array.of(...ascii("FORM"), 0, 0, 0, 0, ...ascii("AIF")),
			riff: Uint8Array.of(...ascii("RIFF")),
			empty: new Uint8Array(0),
		};
		for (const [name, file] of Object.entries(cut)) {
			for (const claimed of [1, 60, 136]) expect(waveformAllowed(file, claimed), `${name} at ${claimed} s`).toBe(false);
		}
	});

	test("a WAV that is compressed (ADPCM, A-law, mu-law, MP3 inside) has no length the viewer can count, so it is refused", () => {
		for (const tag of [2, 6, 7, 0x11, 0x55]) expect(wavAllowed(wav({ tag, bits: 8, channels: 1 })), String(tag)).toBe(false);
	});

	test("a format whose numbers do not agree with each other is not believed", () => {
		expect(wavAllowed(wav({ blockAlign: 8 }))).toBe(false); // 16-bit stereo is 4 bytes a frame
		expect(wavAllowed(wav({ bits: 12, blockAlign: 3, channels: 2 }))).toBe(false);
		expect(wavAllowed(wav({ channels: 0, blockAlign: 0 }))).toBe(false);
		expect(wavAllowed(wav({ rate: 0 }))).toBe(false);
		expect(wavAllowed(wav({ tag: 3, bits: 16, channels: 1 }))).toBe(false); // float is 32 or 64 bits
		expect(wavAllowed(wav({ tag: 0xfffe, subTag: 1, guidTail: GUID_TAIL.map(byte => byte ^ 0xff) }))).toBe(false);
		expect(wavAllowed(wav({ tag: 0xfffe, subTag: 0x55 }))).toBe(false);
	});
});

describe("every other compressed format is a plain track, whatever length the player gives it", () => {
	// The gate once judged these on the player's own length, up to 136 s. A header that lies about a FLAC's length lies to the player as well, so nothing of the kind is believed now.
	test("each container is refused at 1 s, at 136 s, and at any length around them", () => {
		for (const [name, file] of Object.entries(CONTAINERS)) {
			for (const claimed of [0.5, 1, 60, 136, 136.01, 300, 545]) expect(waveformAllowed(file, claimed), `${name} at ${claimed} s`).toBe(false);
		}
	});

	test("an ID3v2 tag in front of one does not make it a file the engine decodes", () => {
		const tags: Record<string, Uint8Array> = { "an empty tag": id3(0), "a tag": id3(300), "a tag with a footer": id3(300, { footer: true }) };
		for (const [tagName, tag] of Object.entries(tags)) {
			for (const [name, file] of Object.entries(CONTAINERS)) {
				for (const claimed of [1, 136]) expect(waveformAllowed(cat(tag, file), claimed), `${tagName}, then ${name}, at ${claimed} s`).toBe(false);
			}
		}
	});
});

describe("the data chunk is believed only as far as the file holds it", () => {
	test("a size that says more than is there is a header that lies: refused, not trusted", () => {
		expect(wavAllowed(wav({ data: 1000, declared: 1_000_000_000 }))).toBe(false);
		expect(wavAllowed(wav({ data: 1000, declared: 1001 }))).toBe(false);
		expect(wavAllowed(wav({ data: 1000, declared: 0xffffffff }))).toBe(false);
		expect(wavAllowed(wav({ data: 1000, declared: 1000 }))).toBe(true);
	});

	test("a file with no sound in it, or no format, or no data, has nothing to draw", () => {
		expect(wavAllowed(wav({ data: 0 }))).toBe(false);
		expect(wavAllowed(wav({ data: 3 }))).toBe(false); // less than one frame of 4 bytes
		expect(wavAllowed(wav({ omit: "fmt " }))).toBe(false);
		expect(wavAllowed(wav({ omit: "data" }))).toBe(false);
	});

	test("two format chunks, or two data chunks, are a file a decoder may read differently: refused", () => {
		expect(wavAllowed(wav({ repeat: "fmt " }))).toBe(false);
		expect(wavAllowed(wav({ repeat: "data" }))).toBe(false);
	});

	test("the chunks are walked a bounded number of steps: a format buried behind a pile of chunks is refused", () => {
		expect(wavAllowed(wav({ junkBefore: 60 }))).toBe(true);
		expect(wavAllowed(wav({ junkBefore: 64 }))).toBe(false);
		expect(wavAllowed(wav({ junkBefore: 5000 }))).toBe(false);
	});
});

describe("the decoded sound is bounded, not just the file", () => {
	// While it decodes, the engine holds the sound at the decode rate AND the larger of (the file's own samples, that sound)
	// beside it: 96 MiB is 25,165,824 floats, so 12,582,912 samples a channel at 22.05 kHz, counted twice.
	test("more channels than a surround mix is refused; eight is the most", () => {
		expect(wavAllowed(wav({ channels: 8, bits: 16, data: 160_000 }))).toBe(true);
		expect(wavAllowed(wav({ channels: 9, bits: 16, data: 180_000 }))).toBe(false);
		expect(wavAllowed(wav({ channels: 65_535, bits: 8, blockAlign: 65_535, data: 65_535 * 4 }))).toBe(false);
	});

	test("a file past 32 MiB is refused whatever it holds; at 32 MiB it is not", () => {
		// 32-bit float mono at 22.05 kHz: 32 MiB of file is 8.4 M samples, decoded to about 64 MiB, so only the size of the FILE can refuse the next one.
		const float = { tag: 3, bits: 32, channels: 1, rate: 22050 } as const;
		const header = wav({ ...float, data: 0 }).length;
		const atTheLimit = wav({ ...float, data: LIMIT_BYTES - header });
		expect(atTheLimit.length).toBe(LIMIT_BYTES);
		expect(wavAllowed(atTheLimit)).toBe(true);
		expect(wavAllowed(wav({ ...float, data: LIMIT_BYTES - header + 4 }))).toBe(false);
	});

	test("at the decode rate the sound and its copy are both held: 12,582,912 samples a channel is the most", () => {
		expect(wavAllowed(wav({ channels: 1, bits: 16, rate: 22050, data: 25_165_824 })), "16-bit, at the cap").toBe(true);
		expect(wavAllowed(wav({ channels: 1, bits: 16, rate: 22050, data: 25_165_826 })), "16-bit, a sample over").toBe(false);
		expect(wavAllowed(wav({ channels: 1, bits: 8, rate: 22050, data: 12_582_912 })), "8-bit, at the cap").toBe(true);
		expect(wavAllowed(wav({ channels: 1, bits: 8, rate: 22050, data: 12_582_913 })), "8-bit, a sample over").toBe(false);
		// A 32 MB file of bytes decodes to eight times its size.
		expect(wavAllowed(wav({ channels: 1, bits: 8, rate: 22050, data: 33_000_000 }))).toBe(false);
	});

	test("44.1 kHz stereo is cut off at 8,388,608 frames (190 s): the file's samples are held beside the sound made from them", () => {
		const stereo = (frames: number) => wav({ channels: 2, bits: 8, rate: 44100, data: frames * 2 });
		expect(wavAllowed(stereo(8_388_608))).toBe(true);
		expect(wavAllowed(stereo(8_388_609))).toBe(false);
		// 10 M frames are 80 MB were the file's samples the only copy, so they fit that count; the sound made from them is the difference.
		expect(wavAllowed(stereo(10_000_000))).toBe(false);
	});

	test("a recording slower than the decode rate grows when it is brought up to it, and is counted at that size", () => {
		// 4,565,228 samples at 8 kHz become 12,582,911 at 22.05 kHz, and that sound is the larger of the two copies.
		expect(wavAllowed(wav({ channels: 1, bits: 8, rate: 8000, data: 4_565_228 }))).toBe(true);
		expect(wavAllowed(wav({ channels: 1, bits: 8, rate: 8000, data: 4_565_229 }))).toBe(false);
	});

	test("a recording faster than it is held at is counted at its own rate while it is read", () => {
		// At 96 kHz the file's samples are the larger copy: 20,465,219 of them and the sound made from them reach the cap.
		expect(wavAllowed(wav({ channels: 1, bits: 8, rate: 96_000, data: 20_465_219 }))).toBe(true);
		expect(wavAllowed(wav({ channels: 1, bits: 8, rate: 96_000, data: 20_465_220 }))).toBe(false);
		// 7.5 M frames of stereo at 192 kHz are brought down to 0.86 M: a long, fast file that costs little stays allowed.
		expect(wavAllowed(wav({ channels: 2, bits: 16, rate: 192_000, data: 30_000_000 }))).toBe(true);
	});
});

describe("an MP3 is judged on the frames its bytes hold, and the player's length must agree", () => {
	test("a constant-bitrate stream passes when the player's length is what its frames play for, in any version, rate and channel count", () => {
		const rows: [string, FrameSpec][] = [
			["MPEG 1, 44.1 kHz stereo", {}],
			["MPEG 1, 48 kHz stereo", { rate: 1 }],
			["MPEG 1, 32 kHz mono", { rate: 2, mono: true }],
			["MPEG 2, 22.05 kHz stereo", { version: 2 }],
			["MPEG 2, 24 kHz mono", { version: 2, rate: 1, mono: true }],
			["MPEG 2.5, 11.025 kHz mono", { version: 0, mono: true }],
		];
		for (const [name, spec] of rows) {
			// A constant-bitrate encoder sets the padding bit on most frames to hold its average, and the walk must follow every one of them.
			expect(waveformAllowed(mp3(800, spec, index => index % 25 !== 0), seconds(800, spec)), name).toBe(true);
		}
	});

	test("a length the frames do not add up to is refused, whichever way it is wrong", () => {
		const file = mp3(1000); // 26.1 s of sound
		expect(waveformAllowed(file, seconds(1000))).toBe(true);
		expect(waveformAllowed(file, 10), "the header says short and the bytes are long").toBe(false);
		expect(waveformAllowed(file, 60), "the header says long and the bytes are short").toBe(false);
	});

	test("the two lengths agree within a second or within 5% of the longer, whichever is wider", () => {
		const little = seconds(100); // 2.6 s: a second is the wider of the two allowances
		const big = seconds(2000); // 52.2 s: 5% is
		const rows: [string, number, number, boolean][] = [
			["short, a second over", 100, little + 0.99, true],
			["short, a second under", 100, little - 0.99, true],
			["short, past a second over", 100, little + 1.01, false],
			["short, past a second under", 100, little - 1.01, false],
			["long, 4% over", 2000, big * 1.04, true],
			["long, 4% under", 2000, big * 0.96, true],
			["long, 6% over", 2000, big * 1.06, false],
			["long, 6% under", 2000, big * 0.94, false],
		];
		for (const [name, frames, claimed, expected] of rows) expect(waveformAllowed(mp3(frames), claimed), name).toBe(expected);
	});
});

describe("an MP3 is never longer than 545 s, counted from its frames and from the player alike", () => {
	// At 24 kHz in MPEG 2 a frame is 576 samples: 22708 frames play 544.99 s and 22709 play 545.02 s. Thin frames are 24 bytes, so the file is small.
	const LAST = 22708;

	test("the last frame that keeps it within 545 s passes and the next is refused", () => {
		expect(waveformAllowed(mp3(LAST, thin), 545)).toBe(true);
		expect(waveformAllowed(mp3(LAST + 1, thin), 545)).toBe(false);
	});

	test("the frames are held to it whatever the player says: a player that claims less does not shorten them", () => {
		expect(waveformAllowed(mp3(LAST + 1, thin), 544)).toBe(false);
		expect(waveformAllowed(mp3(LAST + 100, thin), 545), "547 s of frames, which the player's 545 is within 5% of").toBe(false);
	});

	test("the player's length is held to it whatever the frames add up to: 545 s passes, past it is refused", () => {
		const file = mp3(LAST, thin);
		expect(waveformAllowed(file, 545)).toBe(true);
		expect(waveformAllowed(file, 545.01)).toBe(false);
	});

	test("bytes after the last frame count as the thinnest audio there is (1000 to the second), so they cannot carry a recording past it", () => {
		const frames = mp3(LAST, thin); // 0.008 s of room
		expect(waveformAllowed(cat(frames, zeros(7)), 545), "7 bytes: 544.999 s").toBe(true);
		expect(waveformAllowed(cat(frames, zeros(9)), 545), "9 bytes: 545.001 s").toBe(false);
		expect(waveformAllowed(cat(frames, zeros(16 * 1024)), 545), "16 KiB").toBe(false);
	});
});

describe("the decoded size of an MP3 counts the sound made and the larger of it and the samples the file holds", () => {
	// 96 MiB is 25,165,824 floats. The sound at 22.05 kHz is one copy, and the file's own samples (at the file's rate) or that sound, whichever is larger, is the other.
	test("44.1 kHz stereo is cut off at 7281 frames (190 s): the samples are held at 44.1 kHz beside the sound brought down to 22.05 kHz", () => {
		expect(waveformAllowed(mp3(7281), seconds(7281))).toBe(true);
		expect(waveformAllowed(mp3(7282), seconds(7282))).toBe(false);
	});

	test("22.05 kHz stereo has nothing to bring down, holds the same sound twice, and stops at 10922 frames (285 s)", () => {
		const spec: FrameSpec = { version: 2 };
		expect(waveformAllowed(mp3(10922, spec), seconds(10922, spec))).toBe(true);
		expect(waveformAllowed(mp3(10923, spec), seconds(10923, spec))).toBe(false);
	});

	test("mono costs half as much as stereo: 44.1 kHz mono runs to 14563 frames (380 s), where 24 kHz stereo stops at 11385 (273 s)", () => {
		const mono: FrameSpec = { mono: true };
		expect(waveformAllowed(mp3(14563, mono), seconds(14563))).toBe(true);
		expect(waveformAllowed(mp3(14564, mono), seconds(14564))).toBe(false);
		const stereo24: FrameSpec = { version: 2, rate: 1 };
		expect(waveformAllowed(mp3(11385, stereo24), seconds(11385, stereo24))).toBe(true);
		expect(waveformAllowed(mp3(11386, stereo24), seconds(11386, stereo24))).toBe(false);
	});

	test("the bytes after the last frame are in the decoded size too, as the thinnest audio there is", () => {
		// 7281 frames leave 896 samples of room: 20 bytes of tail is 882 of them, 21 bytes is 926.
		const frames = mp3(7281);
		expect(waveformAllowed(cat(frames, zeros(20)), seconds(7281))).toBe(true);
		expect(waveformAllowed(cat(frames, zeros(21)), seconds(7281))).toBe(false);
		expect(waveformAllowed(cat(frames, zeros(16 * 1024)), seconds(7281))).toBe(false);
	});
});

describe("an MP3 begins where its audio does, and an ID3v2 tag is the only thing that may come first", () => {
	const frames = mp3(1000);
	const claimed = seconds(1000);

	test("a verified tag's own size says where the audio begins, however large the tag", () => {
		for (const size of [0, 2000, 200_000]) expect(waveformAllowed(cat(id3(size), frames), claimed), `a tag of ${size} bytes`).toBe(true);
	});

	test("every version's defined flags are allowed", () => {
		const rows: [number, number][] = [[2, 0x80], [2, 0xc0], [3, 0x40], [3, 0xe0], [4, 0x20], [4, 0xe0]];
		for (const [major, flags] of rows) expect(waveformAllowed(cat(id3(100, { major, flags }), frames), claimed), `2.${major}, flags ${flags.toString(16)}`).toBe(true);
	});

	test("a footer adds ten bytes that are not audio either, and the audio begins right after it", () => {
		expect(waveformAllowed(cat(id3(100, { footer: true }), frames), claimed)).toBe(true);
		expect(waveformAllowed(cat(id3(0, { footer: true }), frames), claimed)).toBe(true);
	});

	test("one byte between the tag and the first frame is enough to refuse it: no tolerance, however little or much", () => {
		for (const size of [1, 2, 3, 10, 4095, 4096]) expect(waveformAllowed(cat(id3(100), zeros(size), frames), claimed), `${size} bytes after the tag`).toBe(false);
		expect(waveformAllowed(cat(id3(100, { footer: true }), zeros(1), frames), claimed), "after a footer").toBe(false);
	});

	test("a size with a byte that is not 7 bits is a tag that cannot be trusted: refused", () => {
		for (const at of [1, 2, 3]) {
			const sizeBytes = [0, 0, 0, 0];
			sizeBytes[at] = 0x80;
			// The tag as a reader taking the bytes as they come would size it, so that it would find the audio right after it.
			const taken = sizeBytes.reduce((size, byte) => size * 128 + byte, 0);
			expect(waveformAllowed(cat(id3(taken, { sizeBytes }), frames), claimed), `size byte ${at}`).toBe(false);
		}
	});

	test("a version that does not exist, or a revision of 0xFF, is a tag that cannot be trusted: refused", () => {
		for (const major of [0, 1, 5, 0xff]) expect(waveformAllowed(cat(id3(100, { major }), frames), claimed), `version ${major}`).toBe(false);
		expect(waveformAllowed(cat(id3(100, { revision: 0xff }), frames), claimed), "revision").toBe(false);
	});

	test("a flag its version does not define is refused: the footer flag is not a flag of 2.3, nor are the low bits of any", () => {
		const rows: [number, number][] = [[3, 0x10], [3, 0x01], [2, 0x20], [2, 0x10], [4, 0x08], [4, 0x01]];
		for (const [major, flags] of rows) expect(waveformAllowed(cat(id3(100, { major, flags }), frames), claimed), `2.${major}, flags ${flags.toString(16)}`).toBe(false);
		expect(waveformAllowed(cat(id3(100, { major: 3, footer: true }), frames), claimed), "a footer in a 2.3 tag").toBe(false);
	});

	test("a footer that does not begin with 3DI is not a footer: refused", () => {
		expect(waveformAllowed(cat(id3(100, { footer: true, footerMagic: "XXX" }), frames), claimed)).toBe(false);
		expect(waveformAllowed(cat(id3(100, { footer: true, footerMagic: "ID3" }), frames), claimed), "the header's own magic, not its reverse").toBe(false);
	});

	test("a tag whose size runs past the end of the file leaves nothing to decode", () => {
		expect(waveformAllowed(cat(id3(100, { sizeBytes: synchsafe(50_000_000) }), frames), claimed)).toBe(false);
	});
});

describe("the frames of an MP3 keep to one stream from the first to the last", () => {
	test("a second stream spliced on after the first is refused, though the player played both", () => {
		const others: [string, FrameSpec][] = [
			["mono", { mono: true }],
			["another rate", { rate: 1 }],
			["another version", { version: 2 }],
		];
		for (const [name, other] of others) {
			const spliced = cat(mp3(1000), mp3(1000, other));
			expect(waveformAllowed(spliced, seconds(1000) + seconds(1000, other)), name).toBe(false);
		}
	});

	test("three frames of three streams are not a chain, however well each header reads", () => {
		const file = cat(frame({}, false), frame({ rate: 1 }, false), frame({ mono: true }, false));
		expect(waveformAllowed(file, 0.05)).toBe(false);
	});
});

describe("bytes after the last frame of an MP3", () => {
	const frames = mp3(1000);
	const claimed = seconds(1000);
	const tag128 = Uint8Array.of(...ascii("TAG"), ...new Array<number>(125).fill(0x20));

	test("an ID3v1 tag, a cut frame, or up to 16 KiB of anything else is allowed for", () => {
		expect(waveformAllowed(cat(frames, tag128), claimed), "ID3v1 tag").toBe(true);
		expect(waveformAllowed(cat(frames, frame({}, false).subarray(0, 300)), claimed), "frame cut short").toBe(true);
		expect(waveformAllowed(cat(frames, zeros(16 * 1024)), claimed), "16 KiB").toBe(true);
	});

	test("past 16 KiB the sound is undefined and refused: a gap, and then more audio the player would play", () => {
		expect(waveformAllowed(cat(frames, zeros(16 * 1024 + 1)), claimed), "16 KiB and a byte").toBe(false);
		expect(waveformAllowed(cat(frames, zeros(100), mp3(1000)), claimed), "a gap and more frames").toBe(false);
	});
});

describe("a sync word is not an MP3 until a chain of frames follows it", () => {
	test("one header in garbage, one frame, two frames, or a third cut short are not audio; three whole frames are", () => {
		const garbage = noise(4096);
		garbage.set([0xff, 0xfb, 0x90, 0x00], 100);
		const three = mp3(3);
		const rows: [string, Uint8Array, boolean][] = [
			["a sync word in noise", garbage, false],
			["one frame and silence", cat(frame({}, false), zeros(2000)), false],
			["two frames", mp3(2), false],
			["a third frame cut short", three.subarray(0, three.length - 1), false],
			["three frames", three, true],
		];
		for (const [name, file, expected] of rows) expect(waveformAllowed(file, seconds(3)), name).toBe(expected);
	});

	test("a header the standard gives no Layer III frame length is not a frame: other layers, reserved values, free format, an invalid bitrate or rate", () => {
		const rows: [string, FrameSpec][] = [
			["Layer II", { layer: 2 }],
			["Layer I", { layer: 3 }],
			["reserved layer", { layer: 0 }],
			["reserved version", { version: 1 }],
			["free-format bitrate", { bitrate: 0 }],
			["invalid bitrate", { bitrate: 15 }],
			["invalid rate", { rate: 3 }],
		];
		for (const [name, spec] of rows) expect(waveformAllowed(mp3(100, spec), 2.6), name).toBe(false);
	});
});

describe("a file that is an MP3 and another container at once is refused", () => {
	const chain = mp3(40);
	const claimed = seconds(40);

	test("the chain alone passes: it is the control for everything below", () => {
		expect(waveformAllowed(chain, claimed)).toBe(true);
	});

	test("another container's magic in front of the chain refuses it, at byte 0 and at any offset up to 12 or well past it", () => {
		for (const [name, magic] of Object.entries(MAGICS)) {
			for (const offset of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 64]) {
				expect(waveformAllowed(cat(zeros(offset), Uint8Array.of(...magic), chain), claimed), `${name} at byte ${offset}`).toBe(false);
			}
		}
	});

	test("so does the same behind a verified ID3v2 tag: the first frame is not where the tag ends", () => {
		for (const [name, magic] of Object.entries(MAGICS)) {
			for (const offset of [0, 1, 6, 12]) {
				expect(waveformAllowed(cat(id3(50), zeros(offset), Uint8Array.of(...magic), chain), claimed), `${name}, ${offset} bytes after the tag`).toBe(false);
			}
		}
	});

	test("a single byte of anything before the first frame refuses it", () => {
		for (const byte of [0x00, 0x20, 0x49, 0xff]) expect(waveformAllowed(cat(Uint8Array.of(byte), chain), claimed), `byte ${byte.toString(16)}`).toBe(false);
	});

	test("a magic inside the first 16 bytes of the first frame refuses a chain that is otherwise perfect; one past them does not", () => {
		for (const [name, magic] of Object.entries(MAGICS)) {
			// A frame header is the first 4 bytes. A magic that begins at 12 ends on the 16th byte, the last of the window.
			for (let offset = 4; offset <= 12; offset += 1) expect(waveformAllowed(plant(chain, offset, magic), claimed), `${name} at byte ${offset}`).toBe(false);
			expect(waveformAllowed(plant(chain, 13, magic), claimed), `${name} at byte 13, which runs one byte past the window`).toBe(true);
		}
	});

	test("the 16 bytes are those of the first frame, not of the file: a verified tag may carry any magic", () => {
		for (const [name, magic] of Object.entries(MAGICS)) {
			expect(waveformAllowed(cat(plant(id3(100), 14, magic), chain), claimed), `${name} inside the tag`).toBe(true);
			expect(waveformAllowed(cat(plant(id3(100), 14, magic), plant(chain, 8, magic)), claimed), `${name} inside the tag and inside the frame`).toBe(false);
		}
	});

	test("a compressed WAV that carries MP3 frames is a WAV, and refused as one at any claim", () => {
		const file = cat(wav({ tag: 0x55, bits: 8, channels: 1, data: 0 }), mp3(1000));
		for (const claimed of [seconds(1000), 60, 0]) expect(waveformAllowed(file, claimed), String(claimed)).toBe(false);
	});
});

describe("a length that is not a positive finite number allows nothing but a WAV", () => {
	test("none of the containers, nor a strict MP3, passes at 0, a negative, or a number that is not one", () => {
		const files: Record<string, Uint8Array> = { ...CONTAINERS, mp3: mp3(1000), "ID3 and FLAC": cat(id3(300), CONTAINERS.flac as Uint8Array) };
		const good = wav({ data: 40_000 });
		for (const claimed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			for (const [name, file] of Object.entries(files)) expect(waveformAllowed(file, claimed), `${name} at ${claimed}`).toBe(false);
			expect(waveformAllowed(good, claimed), `a good WAV at ${claimed}`).toBe(true);
		}
	});
});

describe("decodePeaks", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext");
	let probe: Probe | undefined;
	afterEach(() => {
		// A test that failed with a decode still held would block every later one: the queue is shared by the whole file.
		probe?.drain();
		probe = undefined;
		if (original === undefined) Reflect.deleteProperty(globalThis, "OfflineAudioContext");
		else Object.defineProperty(globalThis, "OfflineAudioContext", original);
	});

	/** A decoder that hands back the given channels and says when each one is read out. */
	function install(channels: Float32Array[], log: string[]): void {
		Object.defineProperty(globalThis, "OfflineAudioContext", {
			configurable: true,
			writable: true,
			value: class {
				decodeAudioData(): Promise<unknown> {
					return Promise.resolve({
						numberOfChannels: channels.length,
						length: channels[0]?.length ?? 0,
						getChannelData: (index: number) => {
							log.push(`read ${index}`);
							return channels[index];
						},
					});
				}
			},
		});
	}

	/** A decoder that answers (once `decoded` settles) with a sound of the stated size, whatever it really holds, and says when a channel is read out. */
	function installSound(sound: { numberOfChannels: number; length: number }, log: string[], decoded: Promise<void> = Promise.resolve()): void {
		const samples = new Float32Array(64).fill(0.5);
		Object.defineProperty(globalThis, "OfflineAudioContext", {
			configurable: true,
			writable: true,
			value: class {
				async decodeAudioData(): Promise<unknown> {
					await decoded;
					return {
						...sound,
						getChannelData: (index: number) => {
							log.push(`read ${index}`);
							return samples;
						},
					};
				}
			},
		});
	}

	/** What the engine was asked and what was done with its answers, and the means to end the decodes it holds. */
	interface Probe {
		/** In order: `decode N` when the engine is handed file N, `read N` when a channel of its sound is read out. */
		readonly events: string[];
		/** The decodes in progress now, and the most there ever were at once. */
		readonly alive: { now: number; most: number };
		/** Ends the decode of file `label`. */
		finish(label: number): void;
		/** Ends the decode of file `label` with an error: a codec the engine lacks. */
		fail(label: number, error: Error): void;
		/** Settles once `event` is in `events`, at once if it is. */
		reached(event: string): Promise<void>;
		/** Ends every decode held, and lets later ones through unheld. */
		drain(): void;
	}

	/** Where the one loud sample of file `label`'s sound is, among the {@link WAVEFORM_BUCKETS} it has (a sample to each bucket). */
	const loud = (label: number): number => (label - 1) * 299;

	/** An engine whose every decode waits for the test to end it, and which takes the buffer it is handed. File N is the single byte N, and its sound is silence with one loud sample at `loud(N)`. */
	function installProbe(): Probe {
		const events: string[] = [];
		const alive = { now: 0, most: 0 };
		const held = new Map<number, PromiseWithResolvers<void>>();
		let draining = false;
		const waiters = new Map<string, PromiseWithResolvers<void>>();
		const emit = (event: string): void => {
			events.push(event);
			waiters.get(event)?.resolve();
		};
		Object.defineProperty(globalThis, "OfflineAudioContext", {
			configurable: true,
			writable: true,
			value: class {
				async decodeAudioData(buffer: ArrayBuffer): Promise<unknown> {
					const label = new Uint8Array(buffer)[0] as number;
					// A real engine takes the buffer it is handed: nothing may read it after this.
					structuredClone(buffer, { transfer: [buffer] });
					emit(`decode ${label}`);
					alive.now += 1;
					alive.most = Math.max(alive.most, alive.now);
					try {
						if (!draining) {
							const gate = Promise.withResolvers<void>();
							held.set(label, gate);
							await gate.promise;
						}
					} finally {
						alive.now -= 1;
					}
					const samples = new Float32Array(WAVEFORM_BUCKETS);
					samples[loud(label)] = 0.5;
					return {
						numberOfChannels: 1,
						length: samples.length,
						getChannelData: () => {
							emit(`read ${label}`);
							return samples;
						},
					};
				}
			},
		});
		const waiting = (label: number): PromiseWithResolvers<void> => {
			const gate = held.get(label);
			if (gate === undefined) throw new Error(`the decode of file ${label} is not waiting`);
			held.delete(label);
			return gate;
		};
		return {
			events,
			alive,
			reached: event => {
				const waiter = Promise.withResolvers<void>();
				if (events.includes(event)) waiter.resolve();
				else waiters.set(event, waiter);
				return waiter.promise;
			},
			finish: label => waiting(label).resolve(),
			fail: (label, error) => waiting(label).reject(error),
			drain: () => {
				draining = true;
				for (const gate of held.values()) gate.resolve();
				held.clear();
			},
		};
	}

	/** What a call came to, which never rejects: a pane's abort may fall on a call nobody is awaiting yet. */
	type Outcome = { readonly value: Float32Array | null } | { readonly error: unknown };
	const outcome = (work: Promise<Float32Array | null>): Promise<Outcome> => work.then(value => ({ value }), (error: unknown) => ({ error }));
	const peaksOf = (result: Outcome): Float32Array => {
		if (!("value" in result) || result.value === null) throw new Error(`expected a waveform, got ${"error" in result ? String(result.error) : "none"}`);
		return result.value;
	};

	/** Asks for the waveform of file `label` with no waiting between the steps of its own work. */
	const ask = (label: number, signal: AbortSignal = new AbortController().signal): Promise<Outcome> => outcome(decodePeaks(Uint8Array.of(label), signal, quick));

	/** Lets a call asked for just now reach the engine: it needs a few turns of the microtask queue, and no clock. */
	async function settle(): Promise<void> {
		for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
	}

	/** No waiting between channels, so a test is not about the clock. */
	const quick = { sliceMs: Number.POSITIVE_INFINITY, yieldThread: async () => {} };
	const decode = (claimedSeconds?: number): Promise<Float32Array | null> => decodePeaks(new Uint8Array(8), new AbortController().signal, { ...quick, claimedSeconds });
	const reads = (channels: number): string[] => Array.from({ length: channels }, (_, index) => `read ${index}`);

	test("each channel is read out on a turn of its own, with the thread given back between them", async () => {
		const log: string[] = [];
		install([Float32Array.of(0.1, 0.2, 0.3, 0.4), Float32Array.of(0.4, 0.3, 0.2, 0.9)], log);
		const peaks = await decodePeaks(new Uint8Array(8), new AbortController().signal, {
			sliceMs: Number.POSITIVE_INFINITY,
			yieldThread: async () => void log.push("yield"),
		});
		expect(log).toEqual(["yield", "read 0", "yield", "read 1"]);
		expect(peaks).toHaveLength(WAVEFORM_BUCKETS);
		// The loudest sample of either channel is 0.9, in the last part: it is 1 and nothing is louder.
		expect(Math.max(...(peaks as Float32Array))).toBe(1);
		expect((peaks as Float32Array)[WAVEFORM_BUCKETS - 1]).toBe(1);
	});

	test("a pane that goes away between channels never reads the next one", async () => {
		const log: string[] = [];
		install([new Float32Array(100).fill(0.5), new Float32Array(100).fill(0.5), new Float32Array(100).fill(0.5)], log);
		const controller = new AbortController();
		const work = decodePeaks(new Uint8Array(8), controller.signal, {
			yieldThread: async () => {
				log.push("yield");
				if (log.filter(entry => entry === "yield").length === 2) controller.abort();
			},
		});
		await expect(work).rejects.toThrow();
		expect(log).toEqual(["yield", "read 0", "yield"]);
	});

	test("an engine with no decoder draws no waveform", async () => {
		Reflect.deleteProperty(globalThis, "OfflineAudioContext");
		expect(await decode()).toBeNull();
	});

	// What a header claimed is no bound on what the decoder returns, so the sound it returns is held to the caps before one channel is copied out of it.
	test("a sound whose floats would not fit the decoded cap is dropped unread, and one that fits is read in full", async () => {
		const fits = DECODED_CAP / 4 / 2; // samples a channel, of two, that fill the cap exactly
		const rows: [string, number, number, boolean][] = [
			["stereo filling the cap", 2, fits, true],
			["stereo a sample over", 2, fits + 1, false],
			["mono of the same length, half the cost", 1, fits + 1, true],
			["eight channels of the stereo length", 8, fits, false],
			["half an hour of stereo that a header called one minute", 2, 1800 * DECODE_RATE, false],
		];
		for (const [name, channels, length, readOut] of rows) {
			const log: string[] = [];
			installSound({ numberOfChannels: channels, length }, log);
			const peaks = await decode();
			expect(log, name).toEqual(readOut ? reads(channels) : []);
			if (readOut) expect(peaks, name).toHaveLength(WAVEFORM_BUCKETS);
			else expect(peaks, name).toBeNull();
		}
	});

	test("more than eight channels is dropped unread; eight is read", async () => {
		for (const [channels, readOut] of [[9, false], [8, true]] as const) {
			const log: string[] = [];
			installSound({ numberOfChannels: channels, length: 1000 }, log);
			const peaks = await decode();
			expect(log, `${channels} channels`).toEqual(readOut ? reads(channels) : []);
			if (readOut) expect(peaks, `${channels} channels`).toHaveLength(WAVEFORM_BUCKETS);
			else expect(peaks, `${channels} channels`).toBeNull();
		}
	});

	test("the largest sounds the gate admits are read out after the decode, not dropped by the second check", async () => {
		// The gate's caps count more than the decoded sound alone, so a sound it admitted at its limit is within what the decoder may hand back.
		const rows: [string, Uint8Array, number, number][] = [
			["a mono MP3 of 545 s", mp3(22708, thin), seconds(22708, thin), 1],
			["a stereo 44.1 kHz MP3 of 190 s", mp3(7281), seconds(7281), 2],
			["an 8-channel WAV at the cap", wav({ channels: 8, bits: 8, rate: 22050, data: 12_582_912 }), 1_572_864 / DECODE_RATE, 8],
		];
		for (const [name, file, claimed, channels] of rows) {
			expect(waveformAllowed(file, claimed), `${name} is admitted`).toBe(true);
			const log: string[] = [];
			installSound({ numberOfChannels: channels, length: Math.round(claimed * DECODE_RATE) }, log);
			expect(await decode(claimed), name).toHaveLength(WAVEFORM_BUCKETS);
			expect(log, name).toEqual(reads(channels));
		}
	});

	test("given the player's length, a sound of another length is dropped unread and one that agrees is read", async () => {
		const hundred = 100 * DECODE_RATE;
		const short = 2 * DECODE_RATE;
		const rows: [string, number, number | undefined, boolean][] = [
			["agrees", hundred, 100, true],
			["the header said short and the sound is long", hundred, 10, false],
			["the header said long and the sound is short", hundred, 1000, false],
			["a second out on a short sound", short, 2.9, true],
			["past a second out on a short sound", short, 3.1, false],
			["4% out on a long sound", hundred, 104, true],
			["6% out on a long sound", hundred, 106, false],
			["no length given: nothing to disagree with", hundred, undefined, true],
		];
		for (const [name, length, claimed, readOut] of rows) {
			const log: string[] = [];
			installSound({ numberOfChannels: 1, length }, log);
			const peaks = await decode(claimed);
			expect(log, name).toEqual(readOut ? reads(1) : []);
			if (readOut) expect(peaks, name).toHaveLength(WAVEFORM_BUCKETS);
			else expect(peaks, name).toBeNull();
		}
	});

	test("a pane that goes away while the sound is being decoded gets a rejection, and its sound is never read, even when it is one that would be dropped", async () => {
		const log: string[] = [];
		const { promise, resolve } = Promise.withResolvers<void>();
		installSound({ numberOfChannels: 9, length: 1800 * DECODE_RATE }, log, promise);
		const controller = new AbortController();
		const work = outcome(decodePeaks(new Uint8Array(8), controller.signal, { ...quick, claimedSeconds: 10 }));
		// Let the decode begin: it is already running when the pane goes away.
		await settle();
		controller.abort();
		resolve();
		expect("error" in (await work)).toBe(true);
		expect(log).toEqual([]);
	});

	test("three decodes asked for at once never overlap, and run in the order they were asked", async () => {
		probe = installProbe();
		const calls = [ask(1), ask(2), ask(3)];
		await probe.reached("decode 1");
		await settle();
		expect(probe.events, "only the first has begun").toEqual(["decode 1"]);

		probe.finish(1);
		await probe.reached("decode 2");
		expect(probe.events, "the second begins once the first has been read out").toEqual(["decode 1", "read 1", "decode 2"]);

		probe.finish(2);
		await probe.reached("decode 3");
		expect(probe.events).toEqual(["decode 1", "read 1", "decode 2", "read 2", "decode 3"]);

		probe.finish(3);
		const results = await Promise.all(calls);
		expect(probe.events).toEqual(["decode 1", "read 1", "decode 2", "read 2", "decode 3", "read 3"]);
		expect(probe.alive.most).toBe(1);
		// Each call got its own file's sound back.
		for (const [index, result] of results.entries()) expect(peaksOf(result).indexOf(1), `call ${index + 1}`).toBe(loud(index + 1));
	});

	test("a call whose pane went away before its turn never starts a decode, and the calls around it still run", async () => {
		probe = installProbe();
		const gone = new AbortController();
		const first = ask(1);
		const skipped = ask(2, gone.signal);
		const last = ask(3);
		await probe.reached("decode 1");

		gone.abort();
		probe.finish(1);
		await probe.reached("decode 3");
		expect(probe.events, "file 2 was never handed to the engine").toEqual(["decode 1", "read 1", "decode 3"]);

		probe.finish(3);
		const [one, two, three] = await Promise.all([first, skipped, last]);
		expect("error" in two, "the skipped call ends in a rejection, which its pane takes as a plain track").toBe(true);
		expect(peaksOf(one).indexOf(1)).toBe(loud(1));
		expect(peaksOf(three).indexOf(1)).toBe(loud(3));
		expect(probe.events).toEqual(["decode 1", "read 1", "decode 3", "read 3"]);
		expect(probe.alive.most).toBe(1);
	});

	test("a pane that goes away while its sound is decoding does not stop the decode, drops the result, and lets the next call run only once it has ended", async () => {
		probe = installProbe();
		const gone = new AbortController();
		const first = ask(1, gone.signal);
		const next = ask(2);
		await probe.reached("decode 1");
		gone.abort();
		await settle();
		expect(probe.events, "a decode in the engine cannot be cancelled, so the next waits for it").toEqual(["decode 1"]);

		probe.finish(1);
		await probe.reached("decode 2");
		expect("error" in (await first), "the aborted call is rejected").toBe(true);
		expect(probe.events, "its sound was never read out").toEqual(["decode 1", "decode 2"]);

		probe.finish(2);
		expect(peaksOf(await next).indexOf(1)).toBe(loud(2));
		expect(probe.events).toEqual(["decode 1", "decode 2", "read 2"]);
		expect(probe.alive.most).toBe(1);
	});

	test("the engine is handed a copy of exactly the file's bytes: the buffer it consumes is not the caller's", async () => {
		probe = installProbe();
		const store = Uint8Array.of(9, 9, 1, 9, 9);
		const work = outcome(decodePeaks(store.subarray(2, 3), new AbortController().signal, quick));
		await settle();
		expect(probe.events, "the engine saw the one byte of the file and not the bytes around it").toEqual(["decode 1"]);
		probe.finish(1);
		expect(peaksOf(await work).indexOf(1)).toBe(loud(1));
		expect(store, "the caller's bytes survive a decode that takes its buffer").toEqual(Uint8Array.of(9, 9, 1, 9, 9));
	});

	test("a decode the engine fails ends its turn like any other: the calls behind it still run", async () => {
		probe = installProbe();
		const failing = ask(1);
		const next = ask(2);
		const last = ask(3);
		await probe.reached("decode 1");
		probe.fail(1, new Error("the engine has no codec for this"));
		await probe.reached("decode 2");
		expect(probe.events).toEqual(["decode 1", "decode 2"]);

		probe.finish(2);
		await probe.reached("decode 3");
		probe.finish(3);
		const first = await failing;
		expect("error" in first && (first.error as Error).message).toBe("the engine has no codec for this");
		expect(peaksOf(await next).indexOf(1)).toBe(loud(2));
		expect(peaksOf(await last).indexOf(1)).toBe(loud(3));
		expect(probe.alive.most).toBe(1);
	});
});
