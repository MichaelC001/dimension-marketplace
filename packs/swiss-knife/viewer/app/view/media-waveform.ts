// The picture of a sound's loudness under the scrubber: decoration that also helps place a
// mark. It must never be the reason a recording is slow to open, a pane stutters, or the View
// runs out of memory, so it is made ONLY where the cost can be bounded beforehand without taking
// the file's word for it, and everywhere else the track is plain.
//
// `decodeAudioData` turns the WHOLE recording into samples, at whatever length the bytes really
// hold. The length a container's header CLAIMS is no bound on that: a 110 KB FLAC whose header was
// patched decodes to 200 MB, and a 640 KB one to 1.2 GB, and the player's `duration` is that same
// header's word again. Nothing short of a demuxer that counts a container's own samples bounds such a
// file, so the decoder is only ever handed a file of one of TWO kinds, each bounded in the way its bytes allow:
//   * an uncompressed WAV, judged on its own header: its format chunk says how many channels and at what
//     rate, and its data chunk, checked against the bytes actually there, says how many samples;
//   * a STRICT MP3: the frames are WALKED, each header giving its own length and its own samples, so the
//     length is counted from the bytes and an Xing header that claims ten seconds of a file holding an hour is
//     never read. The player's own `duration` must agree with the count, and both are bounded. Strict means the
//     engine cannot read the file as anything but the MP3 that was walked: the first frame header is at the very
//     first byte (or exactly where a verified ID3v2 tag ends), no other container's magic is in the bytes that
//     follow, and the frames run unbroken to the end. A prefix the walk tolerated would be bytes a sniffer could
//     read a different container out of, and then the count would be of a file that is not the one decoded.
// Everything else - Ogg, FLAC, MP4 and M4A, WebM, AIFF, raw AAC, a compressed WAV, a format nobody here can
// name, an MP3 that is not strictly one - is a plain flat track: no decode, no waveform, no cost, and nothing
// pretends to be a waveform that was not made.
//
// Decodes run ONE AT A TIME, in a queue the whole View shares: a decode cannot be cancelled, so three panes
// opening three recordings would otherwise hold three decodes at once. And even then the work after the decode is
// cut into slices that give the thread back, so no frame waits more than a few milliseconds for it. A decode
// that fails (a codec the engine lacks, an aborted pane) is a plain track too.

/** Past this many bytes of file the waveform is skipped (the decode needs its own copy of the file). */
export const WAVEFORM_MAX_BYTES = 32 * 1024 * 1024;
/** Past this many bytes of samples held at once while decoding (32-bit floats, every channel; see {@link decodedBytes} for what is held) it is skipped. */
export const WAVEFORM_MAX_DECODED_BYTES = 96 * 1024 * 1024;
/** More channels than this and it is skipped; a stereo mix is two, a surround one is eight. */
export const WAVEFORM_MAX_CHANNELS = 8;
/** Bars drawn: about one per pixel of a wide bar. */
export const WAVEFORM_BUCKETS = 600;
/** The rate the sound is decoded at. A loudness shape needs nothing like 48 kHz. */
export const WAVEFORM_DECODE_RATE = 22_050;
/** The longest an MP3 may run and still be drawn. Whether a sound this long also fits {@link WAVEFORM_MAX_DECODED_BYTES} depends on its rate and channels: only a mono recording at 24 kHz or less reaches 545 s, and a stereo one at 44.1 kHz stops at about 190 s. */
export const WAVEFORM_MP3_MAX_SECONDS = 545;
/** A player's length and a length counted from the bytes (or from the decoded sound) agree within the larger of this many seconds ... */
const AGREE_SECONDS = 1;
/** ... and this share of the longer of the two: an encoder's delay and padding and a rounded estimate are inside it, a header that lied is not. */
const AGREE_SHARE = 0.05;
/** Bytes after the last MP3 frame that may go unaccounted for (an ID3v1 or APE tag at the end). A decoder that found its footing again in them could still play some, so they count as the thinnest frames a stream can have. */
const MP3_MAX_TAIL = 16 * 1024;
/** The fewest bytes of Layer III audio that play a second: 8 kbps (MPEG 2 and 2.5). */
const MP3_SLOWEST_BYTES_PER_SECOND = 1000;
/** How far into the audio another container's magic bytes are looked for: a frame header is 4 bytes, and a sniffer reads the next few. */
const MP3_MAGIC_WINDOW = 16;
/** Consecutive frames, one right after the other, that make a sync word an MP3 and not a coincidence. */
const MP3_PROBE_FRAMES = 3;
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
 * What decoding `frames` samples a channel (held by the file at `sampleRate`) holds at its peak, in 32-bit floats: the
 * decoder has the file's samples while it brings them to {@link WAVEFORM_DECODE_RATE}, and the sound it makes is
 * alive beside them; the buffer the page is handed is then another copy of that sound. So the peak is the sound at
 * the decode rate plus the larger of the other two, which is what {@link WAVEFORM_MAX_DECODED_BYTES} caps.
 */
function decodedBytes(frames: number, sampleRate: number, channels: number): number {
	const resampled = Math.ceil((frames * WAVEFORM_DECODE_RATE) / sampleRate);
	return (resampled + Math.max(frames, resampled)) * channels * Float32Array.BYTES_PER_ELEMENT;
}

/** Whether two lengths in seconds are the same recording's: within {@link AGREE_SECONDS} or {@link AGREE_SHARE} of the longer. */
function lengthsAgree(a: number, b: number): boolean {
	return Math.abs(a - b) <= Math.max(AGREE_SECONDS, AGREE_SHARE * Math.max(a, b));
}

/** A WAV whose own header, checked against the bytes really there, puts the decoded sound within {@link WAVEFORM_MAX_DECODED_BYTES}. */
function wavAllowed(sound: WavSound | undefined): boolean {
	if (sound === undefined || sound.frames === 0 || sound.channels > WAVEFORM_MAX_CHANNELS) return false;
	return decodedBytes(sound.frames, sound.sampleRate, sound.channels) <= WAVEFORM_MAX_DECODED_BYTES;
}

// ── MP3 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// A frame is a 4-byte header and then the bytes its own bitrate, rate and padding say. A frame is held as ONE
// number so that walking a file of a million frames allocates nothing: the low 12 bits are its length in bytes
// (never more than 1441), the rest name its STREAM (version, rate and channel count), which must not change.

const MPEG1_L3_KBPS: readonly number[] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_KBPS: readonly number[] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** Sample rates by the header's version bits: 3 is MPEG 1, 2 is MPEG 2, 0 is MPEG 2.5 (1 is reserved). */
const MPEG_RATES: Readonly<Record<number, readonly number[]>> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8000] };

/** The Layer III frame whose header is at `at`, or 0 when there is none there: a sync word, a real version and rate, and a bitrate that gives the frame a length. */
function mp3Frame(file: Uint8Array, at: number): number {
	const b1 = file[at + 1];
	const b2 = file[at + 2];
	const b3 = file[at + 3];
	if (file[at] !== 0xff || b1 === undefined || b2 === undefined || b3 === undefined || (b1 & 0xe0) !== 0xe0) return 0;
	const version = (b1 >> 3) & 3;
	// Layer III is `01`; the other layers are other codecs, and version `01` is reserved.
	if (version === 1 || ((b1 >> 1) & 3) !== 1) return 0;
	const kbps = (version === 3 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[b2 >> 4];
	const rateIndex = (b2 >> 2) & 3;
	const rate = MPEG_RATES[version]?.[rateIndex];
	// Bitrate 0 is free format (no length to walk by); 15 and rate index 3 are invalid.
	if (kbps === undefined || kbps === 0 || rate === undefined) return 0;
	const bytes = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + ((b2 >> 1) & 1);
	return (((version << 3) | (rateIndex << 1) | ((b3 >> 6) === 3 ? 1 : 0)) << 12) | bytes;
}

const frameBytes = (frame: number): number => frame & 0xfff;
const frameStream = (frame: number): number => frame >> 12;

/** Whether `MP3_PROBE_FRAMES` frames of one stream follow each other from `at`: a sync word that is an MP3 and not four bytes that happened to look like one. */
function mp3Chain(file: Uint8Array, at: number): boolean {
	const first = mp3Frame(file, at);
	if (first === 0) return false;
	let next = at;
	for (let frame = 0; frame < MP3_PROBE_FRAMES; frame += 1) {
		const found = mp3Frame(file, next);
		if (found === 0 || frameStream(found) !== frameStream(first)) return false;
		next += frameBytes(found);
	}
	return next <= file.length;
}

/** What walking an MP3 from its first frame to its last found. */
interface Mp3Sound {
	readonly sampleRate: number;
	readonly channels: number;
	/** Seconds of sound in the frames walked. */
	readonly seconds: number;
	/** Bytes after the last frame. */
	readonly tail: number;
}

/** The flags each ID3v2 major version defines: 2.2 has unsynchronisation and compression, 2.3 adds an extended header and the experimental bit, 2.4 the footer. */
const ID3_FLAGS: Readonly<Record<number, number>> = { 2: 0xc0, 3: 0xe0, 4: 0xf0 };
const ID3_FOOTER_FLAG = 0x10;

/**
 * Where the audio of `file` begins: 0 with no ID3v2 tag at its head, and otherwise exactly where a VERIFIED tag ends -
 * a version and flags the standard defines, a size of four 7-bit bytes (none has its top bit set, so a tag can never be
 * mistaken for a sync word), a footer that is one when the flag announces it, and all of it inside the file. -1 for a tag
 * that is none of that. The frames must begin right there: nothing is looked for past it.
 */
function audioStart(file: Uint8Array): number {
	if (file[0] !== 0x49 || file[1] !== 0x44 || file[2] !== 0x33) return 0;
	if (file.length < 10) return -1;
	const major = file[3] as number;
	const flags = file[5] as number;
	const defined = ID3_FLAGS[major];
	if (defined === undefined || file[4] === 0xff || (flags & ~defined) !== 0) return -1;
	let size = 0;
	for (let at = 6; at < 10; at += 1) {
		const byte = file[at] as number;
		if (byte >= 0x80) return -1;
		size = (size << 7) | byte;
	}
	const footer = (flags & ID3_FOOTER_FLAG) !== 0;
	const end = 10 + size + (footer ? 10 : 0);
	// The footer is the header again, with "3DI" for "ID3".
	if (end > file.length || (footer && !text4(file, end - 10).startsWith("3DI"))) return -1;
	return end;
}

/** The 4-byte starts of the other containers this engine opens by their magic bytes (the first of them is EBML, the framing of WebM and Matroska). */
const OTHER_CONTAINER_MAGICS: readonly string[] = ["OggS", "fLaC", "ftyp", "RIFF", "FORM", "\u001aE\u00df\u00a3"];

/** Whether any other container's magic bytes are within {@link MP3_MAGIC_WINDOW} bytes from `start`, at any offset: a sniffer that finds one reads the file as that container, whatever frames follow. */
function opensAsAnotherContainer(file: Uint8Array, start: number): boolean {
	for (let at = start; at + 4 <= start + MP3_MAGIC_WINDOW; at += 1) if (OTHER_CONTAINER_MAGICS.includes(text4(file, at))) return true;
	return false;
}

/**
 * The sound in a STRICT MP3, COUNTED from its frames: every frame's header gives its own length and its own samples, so
 * the duration is whatever the bytes hold and no tag's claim of it is read. The first frame must be where the audio
 * begins (the first byte, or the end of a verified ID3v2 tag), with {@link MP3_PROBE_FRAMES} of one stream in a row and
 * no other container's magic in its first {@link MP3_MAGIC_WINDOW} bytes. The frames must then follow each other without
 * a gap or a change of stream to (within {@link MP3_MAX_TAIL} bytes of) the end of the file. A file that does not is
 * `undefined`, since a decoder that found its footing again after a gap would play more than was counted.
 *
 * The walk gives up the moment the frames it has counted play for longer than {@link WAVEFORM_MP3_MAX_SECONDS}: the
 * file is refused whatever follows (the tail only adds), and what a hostile file of millions of the thinnest frames
 * could cost is therefore a fixed number of steps, not a 32 MiB walk.
 */
function readMp3(file: Uint8Array): Mp3Sound | undefined {
	const first = audioStart(file);
	if (first < 0 || !mp3Chain(file, first) || opensAsAnotherContainer(file, first)) return undefined;
	const stream = frameStream(mp3Frame(file, first));
	const version = stream >> 3;
	const sampleRate = MPEG_RATES[version]?.[(stream >> 1) & 3] as number;
	const samplesPerFrame = version === 3 ? 1152 : 576;
	const mostFrames = Math.floor((WAVEFORM_MP3_MAX_SECONDS * sampleRate) / samplesPerFrame);
	let at = first;
	let frames = 0;
	for (;;) {
		const frame = mp3Frame(file, at);
		if (frame === 0 || frameStream(frame) !== stream || at + frameBytes(frame) > file.length) break;
		at += frameBytes(frame);
		frames += 1;
		if (frames > mostFrames) return undefined;
	}
	const tail = file.length - at;
	if (tail > MP3_MAX_TAIL) return undefined;
	return { sampleRate, channels: (stream & 1) === 1 ? 1 : 2, seconds: (frames * samplesPerFrame) / sampleRate, tail };
}

/** An MP3 of which the player says `claimed` seconds: short enough, in seconds and in decoded bytes, and a recording the player and the bytes agree on. */
function mp3Allowed(sound: Mp3Sound, claimed: number): boolean {
	// What a decoder could play at most: the frames counted, and the tail as if it were the thinnest frames there are.
	const bound = sound.seconds + sound.tail / MP3_SLOWEST_BYTES_PER_SECOND;
	if (bound > WAVEFORM_MP3_MAX_SECONDS || !lengthsAgree(sound.seconds, claimed)) return false;
	return decodedBytes(Math.ceil(bound * sound.sampleRate), sound.sampleRate, sound.channels) <= WAVEFORM_MAX_DECODED_BYTES;
}

/**
 * Whether the recording `file` (its whole bytes), which the player says is `claimedSeconds` long, may be decoded for a
 * waveform: a WAV, judged on its own bytes alone, or a strict MP3, judged on the length its frames add up to, which the
 * player must agree with. Nothing else is (see the top of this file). A length that is not a positive number (not loaded
 * yet, or a recording that never says), or is past the longest an MP3 may run, allows nothing but a WAV.
 */
export function waveformAllowed(file: Uint8Array, claimedSeconds: number): boolean {
	if (file.length > WAVEFORM_MAX_BYTES) return false;
	if (text4(file, 0) === "RIFF") return wavAllowed(readWav(file));
	if (!(Number.isFinite(claimedSeconds) && claimedSeconds > 0 && claimedSeconds <= WAVEFORM_MP3_MAX_SECONDS)) return false;
	const mp3 = readMp3(file);
	return mp3 !== undefined && mp3Allowed(mp3, claimedSeconds);
}

export const WAVEFORM_PROBE_BYTES = 16;

export function waveformCouldApply(head: Uint8Array, claimedSeconds: number): boolean {
	if (text4(head, 0) === "RIFF") return true;
	if (!(claimedSeconds > 0 && claimedSeconds <= WAVEFORM_MP3_MAX_SECONDS)) return false;
	return text4(head, 0).startsWith("ID3") || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
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

export interface DecodeOptions extends Omit<PeakOptions, "signal"> {
	/** What the player says the length is, in seconds: the decoded sound must agree with it, or the picture would not line up with the playback. */
	readonly claimedSeconds?: number;
}

/**
 * Whether a decoded sound may be read out: what the header promised is no bound, so the decoder's own answer is held
 * to the same caps the file was, and to the length the player gave.
 */
function decodedAllowed(sound: Pick<AudioBuffer, "numberOfChannels" | "length">, claimedSeconds: number | undefined): boolean {
	if (sound.numberOfChannels > WAVEFORM_MAX_CHANNELS) return false;
	if (sound.length * sound.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > WAVEFORM_MAX_DECODED_BYTES) return false;
	return claimedSeconds === undefined || lengthsAgree(sound.length / WAVEFORM_DECODE_RATE, claimedSeconds);
}

/**
 * The decodes, one behind the other. A decode cannot be cancelled, so the only way to have at most one alive is to start
 * the next when the last has really ended; each entry therefore waits on the one before it, and `turn` is always the
 * last of them, settled whether that one succeeded or not.
 */
let turn: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` when every decode asked for before it has ended, or rejects without starting it if `signal` aborted while
 * it waited. A decode already running when its pane goes away is not interrupted (it cannot be): it ends, its result is
 * dropped by the caller, and only then does the next begin.
 */
function inTurn<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
	const mine = turn.then(() => {
		signal.throwIfAborted();
		return work();
	});
	turn = mine.catch(() => undefined);
	return mine;
}

/**
 * The waveform of the recording `file`, or `null` when this engine cannot make one, or the sound it made is not the one
 * the file promised (see {@link decodedAllowed}). `file` is NOT consumed: `decodeAudioData` takes the buffer it is given,
 * so it gets a copy - made when this decode's turn comes, so a queue of them holds one copy and not one each - which is
 * why the file bound above is the size it is. Call it only for a file {@link waveformAllowed} passed.
 */
export function decodePeaks(file: Uint8Array, signal: AbortSignal, options: DecodeOptions = {}): Promise<Float32Array | null> {
	if (typeof OfflineAudioContext === "undefined") return Promise.resolve(null);
	const { claimedSeconds, ...pacing } = options;
	return inTurn(signal, async () => {
		const context = new OfflineAudioContext(1, 1, WAVEFORM_DECODE_RATE);
		const sound = await context.decodeAudioData(file.slice().buffer);
		signal.throwIfAborted();
		if (!decodedAllowed(sound, claimedSeconds)) return null;
		const peaks = new Float32Array(WAVEFORM_BUCKETS);
		const slices = slicer({ ...pacing, signal });
		for (let index = 0; index < sound.numberOfChannels; index += 1) {
			// One channel to a turn: reading a channel's samples out of a decoded sound is a copy of all of them.
			await slices.yieldNow();
			await accumulate(peaks, sound.getChannelData(index), sound.length, slices);
		}
		return normalise(peaks);
	});
}
