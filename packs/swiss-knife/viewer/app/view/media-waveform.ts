// The picture of a sound's loudness under the scrubber: decoration that also helps place a
// mark. It must never be the reason a recording is slow to open, a pane stutters, or the View
// runs out of memory, so it is made ONLY where the cost can be known for certain beforehand,
// and everywhere else the track is plain.
//
// `decodeAudioData` turns the WHOLE recording into samples, at whatever length the bytes really
// hold. The length a container's header CLAIMS is no bound on that: a 110 KB FLAC whose header was
// patched decodes to 200 MB, and a 640 KB one to 1.2 GB. So the decoder is only ever handed a file the
// viewer has itself measured, and the only file it can measure without decoding is an uncompressed
// WAV: its format chunk says how many channels and at what rate, and its data chunk, checked
// against the bytes actually there, says how many samples. Every other container (MP3, FLAC, Ogg,
// Opus, MP4, AAC, ...) is a plain track: no decode, no waveform, no cost.
//
// Even then the work is cut into slices that give the thread back, so no frame waits more than a few
// milliseconds for it. A decode that fails (a codec the engine lacks, an aborted pane) is a plain track too.

/** Past this many bytes of file the waveform is skipped (the decode needs its own copy of the file). */
export const WAVEFORM_MAX_BYTES = 32 * 1024 * 1024;
/** Past this many bytes of decoded samples (32-bit floats, every channel) it is skipped. */
export const WAVEFORM_MAX_DECODED_BYTES = 96 * 1024 * 1024;
/** More channels than this and it is skipped; a stereo mix is two, a surround one is eight. */
export const WAVEFORM_MAX_CHANNELS = 8;
/** Bars drawn: about one per pixel of a wide bar. */
export const WAVEFORM_BUCKETS = 600;
/** The rate the sound is decoded at. A loudness shape needs nothing like 48 kHz. */
export const WAVEFORM_DECODE_RATE = 22_050;
/** The most chunks looked through for the two a WAV needs; a real file has a handful. */
const MAX_CHUNKS = 64;
/** Longest the passes over the samples run before giving the thread back. */
const SLICE_MS = 6;

const text4 = (bytes: Uint8Array, at: number): string => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

/** What a WAV file's own chunks say about its sound. */
interface WavSound {
	readonly channels: number;
	readonly sampleRate: number;
	/** Samples per channel the data chunk holds. */
	readonly frames: number;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;
/** What follows the two format bytes of an extensible format's sub-format GUID when it is a plain PCM or float one. */
const GUID_TAIL: readonly number[] = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** The fields of a `fmt ` chunk the gate trusts: those of an uncompressed format whose sizes add up. */
interface WavFormat {
	readonly channels: number;
	readonly sampleRate: number;
	/** Bytes in one sample of every channel. */
	readonly blockAlign: number;
}

/** The uncompressed format a `fmt ` chunk (its body starts at `body`, `size` long) names, or `undefined` for any other, or one whose numbers do not agree. */
function readFormat(file: Uint8Array, view: DataView, body: number, size: number): WavFormat | undefined {
	if (size < 16) return undefined;
	let tag = view.getUint16(body, true);
	if (tag === FORMAT_EXTENSIBLE) {
		// The real format is the first two bytes of a sub-format GUID, and only the standard GUID base is a plain one.
		if (size < 40 || !GUID_TAIL.every((byte, index) => file[body + 26 + index] === byte)) return undefined;
		tag = view.getUint16(body + 24, true);
	}
	const channels = view.getUint16(body + 2, true);
	const sampleRate = view.getUint32(body + 4, true);
	const blockAlign = view.getUint16(body + 12, true);
	const bits = view.getUint16(body + 14, true);
	const sized = tag === FORMAT_PCM ? bits === 8 || bits === 16 || bits === 24 || bits === 32 : tag === FORMAT_FLOAT && (bits === 32 || bits === 64);
	return sized && channels >= 1 && sampleRate >= 1 && blockAlign === channels * (bits / 8) ? { channels, sampleRate, blockAlign } : undefined;
}

/**
 * The sound in a RIFF/WAVE file of uncompressed samples (integer PCM or IEEE float), read from its own bytes, or
 * `undefined` for anything else - a header that does not add up included. The file must be exactly what a decoder
 * would read the same way: ONE `fmt ` chunk and ONE `data` chunk (a decoder may play on into a second, or take a
 * later format), the chunks walked to the end of the file in no more than {@link MAX_CHUNKS} steps, and the `data`
 * chunk inside the file - a size that claims more than is there is a header that lies, and nothing is believed of it.
 */
function readWav(file: Uint8Array): WavSound | undefined {
	if (file.length < 12 || text4(file, 0) !== "RIFF" || text4(file, 8) !== "WAVE") return undefined;
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	let format: WavFormat | undefined;
	let formats = 0;
	let dataBytes = 0;
	let datas = 0;
	let at = 12;
	for (let chunk = 0; at + 8 <= file.length; chunk += 1) {
		if (chunk === MAX_CHUNKS) return undefined;
		const size = view.getUint32(at + 4, true);
		const body = at + 8;
		const id = text4(file, at);
		if (id === "fmt ") {
			formats += 1;
			format = body + size > file.length ? undefined : readFormat(file, view, body, size);
		} else if (id === "data") {
			if (body + size > file.length) return undefined;
			datas += 1;
			dataBytes = size;
		}
		// A chunk is padded to an even length.
		at = body + size + (size & 1);
	}
	if (format === undefined || formats !== 1 || datas !== 1) return undefined;
	return { channels: format.channels, sampleRate: format.sampleRate, frames: Math.floor(dataBytes / format.blockAlign) };
}

/**
 * Whether the recording `file` (its whole bytes) may be decoded for a waveform: only an uncompressed WAV whose own
 * header, checked against the bytes really there, puts the decoded sound within {@link WAVEFORM_MAX_DECODED_BYTES}.
 * The decoder briefly holds the sound at the file's rate and then again at {@link WAVEFORM_DECODE_RATE}, so the
 * larger of the two is what counts.
 */
export function waveformAllowed(file: Uint8Array): boolean {
	if (file.length > WAVEFORM_MAX_BYTES) return false;
	const sound = readWav(file);
	if (sound === undefined || sound.frames === 0 || sound.channels > WAVEFORM_MAX_CHANNELS) return false;
	const frames = Math.max(sound.frames, Math.ceil((sound.frames * WAVEFORM_DECODE_RATE) / sound.sampleRate));
	return frames * sound.channels * Float32Array.BYTES_PER_ELEMENT <= WAVEFORM_MAX_DECODED_BYTES;
}

export interface PeakOptions {
	readonly signal?: AbortSignal;
	/** Give the thread back; the default waits a macrotask. */
	readonly yieldThread?: () => Promise<void>;
	/** How long a slice may run. */
	readonly sliceMs?: number;
}

function nextTask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	return promise;
}

/** Runs in slices: `tick()` gives the thread back once the slice has had its time, and stops if the pane has gone. */
interface Slices {
	/** Give the thread back now. */
	yieldNow(): Promise<void>;
	/** Give it back only if the slice has run its time. */
	tick(): Promise<void>;
}

function slicer({ signal, yieldThread = nextTask, sliceMs = SLICE_MS }: PeakOptions): Slices {
	let started = performance.now();
	const yieldNow = async (): Promise<void> => {
		signal?.throwIfAborted();
		await yieldThread();
		signal?.throwIfAborted();
		started = performance.now();
	};
	return {
		yieldNow,
		tick: async (): Promise<void> => {
			if (performance.now() - started >= sliceMs) await yieldNow();
		},
	};
}

/** Folds one channel into `peaks`: each bucket keeps the loudest sample any channel has had in its part of `length`. */
async function accumulate(peaks: Float32Array, channel: Float32Array, length: number, slices: Slices): Promise<void> {
	const buckets = peaks.length;
	for (let bucket = 0; bucket < buckets; bucket += 1) {
		const from = Math.floor((bucket * length) / buckets);
		const to = Math.min(channel.length, Math.max(from + 1, Math.floor(((bucket + 1) * length) / buckets)));
		let loudest = peaks[bucket] as number;
		for (let at = from; at < to; at += 1) {
			const level = Math.abs(channel[at] as number);
			if (level > loudest) loudest = level;
		}
		peaks[bucket] = loudest;
		await slices.tick();
	}
}

/** `peaks` scaled so the loudest bucket is 1; silence stays all zeros. */
function normalise(peaks: Float32Array): Float32Array {
	let overall = 0;
	for (const peak of peaks) if (peak > overall) overall = peak;
	if (overall > 0) for (let bucket = 0; bucket < peaks.length; bucket += 1) peaks[bucket] = (peaks[bucket] as number) / overall;
	return peaks;
}

/**
 * The loudest sample in each of `buckets` equal parts of the sound, across its channels, scaled so the
 * loudest of all is 1. Silence is all zeros. Runs in slices of `sliceMs`; rejects if `signal` aborts.
 */
export async function bucketPeaks(channels: readonly Float32Array[], buckets: number, options: PeakOptions = {}): Promise<Float32Array> {
	const peaks = new Float32Array(buckets);
	const length = channels.reduce((most, channel) => Math.max(most, channel.length), 0);
	if (length === 0) return peaks;
	const slices = slicer(options);
	for (const channel of channels) await accumulate(peaks, channel, length, slices);
	return normalise(peaks);
}

/**
 * The waveform of the recording `file`, or `null` when this engine cannot make one. `file` is NOT consumed:
 * `decodeAudioData` takes the buffer it is given, so it gets a copy (which is why the file bound above is the
 * size it is). Call it only for a file {@link waveformAllowed} passed.
 */
export async function decodePeaks(file: Uint8Array, signal: AbortSignal, options: Omit<PeakOptions, "signal"> = {}): Promise<Float32Array | null> {
	if (typeof OfflineAudioContext === "undefined") return null;
	const context = new OfflineAudioContext(1, 1, WAVEFORM_DECODE_RATE);
	const sound = await context.decodeAudioData(file.slice().buffer);
	signal.throwIfAborted();
	const peaks = new Float32Array(WAVEFORM_BUCKETS);
	const slices = slicer({ ...options, signal });
	for (let index = 0; index < sound.numberOfChannels; index += 1) {
		// One channel to a turn: reading a channel's samples out of a decoded sound is a copy of all of them.
		await slices.yieldNow();
		await accumulate(peaks, sound.getChannelData(index), sound.length, slices);
	}
	return normalise(peaks);
}
