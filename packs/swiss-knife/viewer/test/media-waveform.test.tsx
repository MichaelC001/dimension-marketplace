import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { WAVEFORM_BUCKETS } from "@dimension/mcp-app-kit/media";
import type { MediaPlayer } from "@dimension/mcp-app-kit/media";
import type { App } from "@modelcontextprotocol/ext-apps";
import * as react from "react";
import { createElement } from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import * as reactDom from "react-dom";
import type * as Waveform from "../app/view/media-waveform";
import type { DocTab } from "../app/view/tabs";
import { installReact, type ReactEnv } from "./media-react";

const MEDIA_KIT = "@dimension/mcp-app-kit/media/react";

const kitSource = dirname(Bun.resolveSync(MEDIA_KIT, import.meta.dir));
for (const [id, real] of [
	["react", react],
	["react/jsx-runtime", jsxRuntime],
	["react/jsx-dev-runtime", jsxDevRuntime],
	["react-dom", reactDom],
] as const) {
	mock.module(Bun.resolveSync(id, kitSource), () => real);
}

let env: ReactEnv;
let useWaveform: typeof Waveform.useWaveform;
let useMediaPlayer: (media: HTMLMediaElement, options: { readonly active: boolean }) => MediaPlayer;
const original = Object.getOwnPropertyDescriptor(globalThis, "OfflineAudioContext");

beforeAll(async () => {
	env = await installReact();
	useMediaPlayer = (await import(MEDIA_KIT)).useMediaPlayer;
	({ useWaveform } = await import("../app/view/media-waveform"));
});
afterEach(async () => {
	await env.cleanup();
	if (original === undefined) Reflect.deleteProperty(globalThis, "OfflineAudioContext");
	else Object.defineProperty(globalThis, "OfflineAudioContext", original);
});
afterAll(() => env.restore());

class FakeMedia extends EventTarget {
	paused = true;
	ended = false;
	playbackRate = 1;
	volume = 1;
	muted = false;
	error: MediaError | null = null;
	readyState = 4;
	currentTime = 0;
	seekable = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;
	constructor(public duration: number) {
		super();
	}
	pause(): void {}
}

const ascii = (text: string): number[] => [...Buffer.from(text, "latin1")];
const WAV_RATE = 22_050;

function wavOf(seconds: number): Uint8Array {
	const data = WAV_RATE * 2 * seconds;
	const bytes = new Uint8Array(44 + data);
	const view = new DataView(bytes.buffer);
	bytes.set(ascii("RIFF"), 0);
	view.setUint32(4, 36 + data, true);
	bytes.set(ascii("WAVEfmt "), 8);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, WAV_RATE, true);
	view.setUint32(28, WAV_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	bytes.set(ascii("data"), 36);
	view.setUint32(40, data, true);
	return bytes;
}

let seq = 0;
function served(file: Uint8Array, filename: string): { readonly app: App; readonly tab: DocTab; readonly reads: { offset: number; length: number }[] } {
	seq += 1;
	const reads: { offset: number; length: number }[] = [];
	const app = {
		callServerTool: async (call: { readonly arguments?: Record<string, unknown> }) => {
			const offset = Number(call.arguments?.offset ?? 0);
			const length = Number(call.arguments?.length ?? 0);
			reads.push({ offset, length });
			const part = file.slice(offset, offset + length);
			return { content: [], structuredContent: { base64: Buffer.from(part).toString("base64"), offset, length: part.length, size: file.length, eof: offset + part.length >= file.length } };
		},
	} as unknown as App;
	const tab: DocTab = { key: `waveform-${seq}`, path: `/music/${filename}`, filename, kind: "audio", size: file.length, mtimeMs: 1, revision: 0, annotateRequests: 0 };
	return { app, tab, reads };
}

function installDecoder(sound: { readonly length: number }): { decoded: Uint8Array[] } {
	const heard = { decoded: [] as Uint8Array[] };
	const samples = new Float32Array(sound.length);
	samples.fill(0.8, sound.length / 2);
	Object.defineProperty(globalThis, "OfflineAudioContext", {
		configurable: true,
		writable: true,
		value: class {
			decodeAudioData(file: ArrayBuffer): Promise<unknown> {
				heard.decoded.push(new Uint8Array(file));
				return Promise.resolve({ numberOfChannels: 1, length: sound.length, getChannelData: () => samples });
			}
		},
	});
	return heard;
}

const seen: { value: Float32Array | undefined } = { value: undefined };

function Probe({ app, tab, media }: { app: App; tab: DocTab; media: FakeMedia }) {
	const player = useMediaPlayer(media as unknown as HTMLMediaElement, { active: true });
	seen.value = useWaveform(app, tab, true, player);
	return null;
}

const settle = () => env.act(async () => {
	for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
});

describe("the pane's waveform reads the tab's file through the document door", () => {
	test("a WAV the player gave the length of is read from its own bytes and its loudness comes back", async () => {
		const seconds = 2;
		const { app, tab, reads } = served(wavOf(seconds), "take.wav");
		const heard = installDecoder({ length: WAV_RATE * seconds });
		await env.mount(createElement(Probe, { app, tab, media: new FakeMedia(seconds) }));
		await settle();
		expect(heard.decoded).toHaveLength(1);
		expect(heard.decoded[0]).toHaveLength(tab.size);
		expect(reads[0]?.offset).toBe(0);
		expect(seen.value).toBeDefined();
		expect(seen.value?.length).toBeLessThanOrEqual(WAVEFORM_BUCKETS);
		expect(Math.max(...(seen.value ?? []))).toBe(1);
	});

	test("a track that is not a WAV or a strict MP3 is read for its first bytes only: the whole file is never fetched", async () => {
		const file = new Uint8Array(20_000);
		file.set(ascii("OggS"));
		const { app, tab, reads } = served(file, "take.ogg");
		const heard = installDecoder({ length: WAV_RATE });
		await env.mount(createElement(Probe, { app, tab, media: new FakeMedia(10) }));
		await settle();
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every(read => read.offset === 0 && read.length <= 4096)).toBe(true);
		expect(heard.decoded).toHaveLength(0);
		expect(seen.value).toBeUndefined();
	});
});
