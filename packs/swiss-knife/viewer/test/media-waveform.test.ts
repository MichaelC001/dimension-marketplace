// When a recording is allowed to be decoded for a waveform. `decodeAudioData` turns the WHOLE
// file into samples at whatever length its bytes really hold, so the size a container's header
// CLAIMS is no bound: a 110 KB FLAC with a patched header decodes to 200 MB and a 640 KB one to
// 1.2 GB. The gate therefore believes only what it can measure from the bytes it holds: an
// uncompressed WAV whose chunks agree with each other and with the file. Anything else is a
// plain track. These are the cases that would hurt the View's memory, one at a time.
import { afterEach, describe, expect, test } from "bun:test";
import { decodePeaks, WAVEFORM_BUCKETS, WAVEFORM_DECODE_RATE, WAVEFORM_MAX_BYTES, WAVEFORM_MAX_CHANNELS, WAVEFORM_MAX_DECODED_BYTES, waveformAllowed } from "../app/view/media-waveform";

const ascii = (text: string): number[] => Array.from(text, char => char.charCodeAt(0));
const le16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

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

describe("a WAV whose own header the viewer has checked is decoded", () => {
	test("the usual shapes: 16-bit stereo, 8-bit mono, 24-bit, 32-bit, and 32 and 64-bit float", () => {
		for (const [bits, tag] of [[8, 1], [16, 1], [24, 1], [32, 1], [32, 3], [64, 3]] as const) {
			expect(waveformAllowed(wav({ tag, bits, channels: 2, data: 40_000 })), `${bits}-bit tag ${tag}`).toBe(true);
		}
		expect(waveformAllowed(wav({ channels: 1, bits: 8, rate: 8000, data: 8000 }))).toBe(true);
	});

	test("an extensible format that names plain PCM or float is the same sound", () => {
		expect(waveformAllowed(wav({ tag: 0xfffe, subTag: 1, bits: 24, channels: 6, data: 60_000 }))).toBe(true);
		expect(waveformAllowed(wav({ tag: 0xfffe, subTag: 3, bits: 32, channels: 2, data: 40_000 }))).toBe(true);
	});

	test("a few other chunks around the two it needs are normal (a LIST of tags, a JUNK pad)", () => {
		expect(waveformAllowed(wav({ junkBefore: 10 }))).toBe(true);
	});
});

describe("anything the viewer cannot measure for itself is a plain track", () => {
	/** A FLAC the way the reviewer made one: honest bytes, a STREAMINFO that says how long the sound is. */
	function flac(options: { rate: number; channels: number; bps: number; totalSamples: number; padTo: number }): Uint8Array {
		const info = new Uint8Array(34);
		info.set([0x10, 0x00, 0x10, 0x00]); // block sizes 4096
		const rateBits = BigInt(options.rate) << 44n;
		const packed = rateBits | (BigInt(options.channels - 1) << 41n) | (BigInt(options.bps - 1) << 36n) | BigInt(options.totalSamples);
		for (let index = 0; index < 8; index += 1) info[10 + index] = Number((packed >> BigInt(56 - index * 8)) & 0xffn);
		const out = new Uint8Array(options.padTo);
		out.set([...ascii("fLaC"), 0x80, 0, 0, 34], 0);
		out.set(info, 8);
		return out;
	}

	test("a FLAC whose header says it is half an hour long is 643 KB of bytes and 1.2 GB once decoded: refused", () => {
		const lies = flac({ rate: 44100, channels: 2, bps: 16, totalSamples: 44100 * 1800, padTo: 643_612 });
		expect(waveformAllowed(lies)).toBe(false);
	});

	test("a FLAC of eight channels whose header was patched to 1800:1 is refused, and so is an honest one", () => {
		expect(waveformAllowed(flac({ rate: 48000, channels: 8, bps: 24, totalSamples: 48000 * 1800, padTo: 110_000 }))).toBe(false);
		expect(waveformAllowed(flac({ rate: 44100, channels: 2, bps: 16, totalSamples: 44100, padTo: 90_000 }))).toBe(false);
	});

	test("every container but an uncompressed WAV is refused, however small and honest it looks", () => {
		const heads: Record<string, number[]> = {
			mp3: [...ascii("ID3"), 3, 0, 0, 0, 0, 0, 10],
			ogg: [...ascii("OggS"), 0, 2, ...new Array<number>(20).fill(0), 1, ...ascii("vorbis")],
			m4a: [0, 0, 0, 0x20, ...ascii("ftypM4A "), 0, 0, 0, 0],
			webm: [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii("webm")],
			aac: [0xff, 0xf1, 0x50, 0x80, 0x1c],
			// RIFF, but not WAVE: an AVI is not a sound.
			avi: [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("AVI "), ...ascii("LIST")],
			// Big-endian and 64-bit RIFF are not read at all.
			rifx: [...ascii("RIFX"), 0, 0, 0, 0, ...ascii("WAVE")],
			rf64: [...ascii("RF64"), 0xff, 0xff, 0xff, 0xff, ...ascii("WAVE")],
		};
		for (const [name, head] of Object.entries(heads)) {
			const file = new Uint8Array(4096);
			file.set(head);
			expect(waveformAllowed(file), name).toBe(false);
		}
		expect(waveformAllowed(new Uint8Array(0))).toBe(false);
		expect(waveformAllowed(Uint8Array.of(0x52, 0x49, 0x46, 0x46))).toBe(false);
	});

	test("a WAV that is compressed (ADPCM, A-law, mu-law, MP3 inside) has no length the viewer can count, so it is refused", () => {
		for (const tag of [2, 6, 7, 0x11, 0x55]) expect(waveformAllowed(wav({ tag, bits: 8, channels: 1 })), String(tag)).toBe(false);
	});

	test("a format whose numbers do not agree with each other is not believed", () => {
		expect(waveformAllowed(wav({ blockAlign: 8 }))).toBe(false); // 16-bit stereo is 4 bytes a frame
		expect(waveformAllowed(wav({ bits: 12, blockAlign: 3, channels: 2 }))).toBe(false);
		expect(waveformAllowed(wav({ channels: 0, blockAlign: 0 }))).toBe(false);
		expect(waveformAllowed(wav({ rate: 0 }))).toBe(false);
		expect(waveformAllowed(wav({ tag: 3, bits: 16, channels: 1 }))).toBe(false); // float is 32 or 64 bits
		expect(waveformAllowed(wav({ tag: 0xfffe, subTag: 1, guidTail: GUID_TAIL.map(byte => byte ^ 0xff) }))).toBe(false);
		expect(waveformAllowed(wav({ tag: 0xfffe, subTag: 0x55 }))).toBe(false);
	});
});

describe("the data chunk is believed only as far as the file holds it", () => {
	test("a size that says more than is there is a header that lies: refused, not trusted", () => {
		expect(waveformAllowed(wav({ data: 1000, declared: 1_000_000_000 }))).toBe(false);
		expect(waveformAllowed(wav({ data: 1000, declared: 1001 }))).toBe(false);
		expect(waveformAllowed(wav({ data: 1000, declared: 0xffffffff }))).toBe(false);
		expect(waveformAllowed(wav({ data: 1000, declared: 1000 }))).toBe(true);
	});

	test("a file with no sound in it, or no format, or no data, has nothing to draw", () => {
		expect(waveformAllowed(wav({ data: 0 }))).toBe(false);
		expect(waveformAllowed(wav({ data: 3 }))).toBe(false); // less than one frame of 4 bytes
		expect(waveformAllowed(wav({ omit: "fmt " }))).toBe(false);
		expect(waveformAllowed(wav({ omit: "data" }))).toBe(false);
	});

	test("two format chunks, or two data chunks, are a file a decoder may read differently: refused", () => {
		expect(waveformAllowed(wav({ repeat: "fmt " }))).toBe(false);
		expect(waveformAllowed(wav({ repeat: "data" }))).toBe(false);
	});

	test("the chunks are walked a bounded number of steps: a format buried behind a pile of chunks is refused", () => {
		expect(waveformAllowed(wav({ junkBefore: 60 }))).toBe(true);
		expect(waveformAllowed(wav({ junkBefore: 64 }))).toBe(false);
		expect(waveformAllowed(wav({ junkBefore: 5000 }))).toBe(false);
	});
});

describe("the decoded sound is bounded, not just the file", () => {
	const MIB = 1024 * 1024;

	test("more channels than a surround mix is refused; eight is the most", () => {
		expect(WAVEFORM_MAX_CHANNELS).toBe(8);
		expect(waveformAllowed(wav({ channels: 8, bits: 16, data: 160_000 }))).toBe(true);
		expect(waveformAllowed(wav({ channels: 9, bits: 16, data: 180_000 }))).toBe(false);
		expect(waveformAllowed(wav({ channels: 65_535, bits: 8, blockAlign: 65_535, data: 65_535 * 4 }))).toBe(false);
	});

	test("a file past 32 MiB is refused whatever it holds; at 32 MiB it is not", () => {
		const header = wav({ channels: 1, bits: 16, rate: 22050, data: 0 }).length;
		// 16-bit mono at 22.05 kHz: 16 MiB of samples is 32 MiB of file, decoded to about 64 MiB.
		const atTheLimit = wav({ channels: 1, bits: 16, rate: 22050, data: WAVEFORM_MAX_BYTES - header });
		expect(atTheLimit.length).toBe(WAVEFORM_MAX_BYTES);
		expect(waveformAllowed(atTheLimit)).toBe(true);
		expect(waveformAllowed(wav({ channels: 1, bits: 16, rate: 22050, data: WAVEFORM_MAX_BYTES - header + 2 }))).toBe(false);
	});

	test("a small file can still decode to something enormous: the decoded size, 32-bit per sample per channel, is capped at 96 MiB", () => {
		expect(WAVEFORM_MAX_DECODED_BYTES).toBe(96 * MIB);
		// 8-bit mono at 22.05 kHz is a byte a sample: 32 MB of it decodes to 4x that.
		expect(waveformAllowed(wav({ channels: 1, bits: 8, rate: 22050, data: 33_000_000 }))).toBe(false);
		expect(waveformAllowed(wav({ channels: 1, bits: 8, rate: 22050, data: 24_000_000 }))).toBe(true);
		expect(waveformAllowed(wav({ channels: 1, bits: 16, rate: 22050, data: 33_000_000 }))).toBe(true);
	});

	test("a recording slower than the decode rate grows when it is brought up to it, and is counted at that size", () => {
		expect(WAVEFORM_DECODE_RATE).toBe(22_050);
		// 11 M samples at 22.05 kHz are 44 MB decoded; the same 11 M at 8 kHz are brought up to 30 M samples: 121 MB.
		expect(waveformAllowed(wav({ channels: 1, bits: 8, rate: 22050, data: 11_000_000 }))).toBe(true);
		expect(waveformAllowed(wav({ channels: 1, bits: 8, rate: 8000, data: 11_000_000 }))).toBe(false);
	});

	test("a recording faster than it is held at is counted at its own rate while it is read: the larger of the two", () => {
		// 33 M samples at 96 kHz are 7.6 M once brought down, but the decoder holds all 33 M first.
		expect(waveformAllowed(wav({ channels: 1, bits: 8, rate: 96_000, data: 33_000_000 }))).toBe(false);
		expect(waveformAllowed(wav({ channels: 2, bits: 16, rate: 192_000, data: 30_000_000 }))).toBe(true);
	});
});

describe("decodePeaks", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext");
	afterEach(() => {
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
		expect(await decodePeaks(new Uint8Array(8), new AbortController().signal)).toBeNull();
	});
});
