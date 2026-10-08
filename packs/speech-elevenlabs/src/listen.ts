import type { ListenEvent, ListenSession } from "@dimension/sdk/provider";
import type { SocketFactory, SocketLike } from "./dialogue.js";
import { ElevenLabsError, unreachableFailure } from "./failure.js";
import { EventQueue } from "./output.js";
import {
	audioFrame,
	COMMIT_FRAME,
	LISTEN_SAMPLE_RATE,
	parseScribeEvent,
	type ScribeStart,
	scribeSocketUrl,
} from "./scribe.js";

const BYTES_PER_MS = (LISTEN_SAMPLE_RATE * 2) / 1000;
const MIN_CHUNK_BYTES = 100 * BYTES_PER_MS;
const MAX_CHUNK_BYTES = 1000 * BYTES_PER_MS;
const MAX_BACKLOG_BYTES = 3000 * BYTES_PER_MS;
const MAX_CONSECUTIVE_FAILURES = 3;
const SOCKET_OPEN = 1;

export interface ScribeTiming {
	readonly openTimeoutMs: number;
	readonly idleCloseMs: number;
	readonly muteCommitWaitMs: number;
	readonly retryGapMs: number;
}

const DEFAULT_TIMING: ScribeTiming = {
	openTimeoutMs: 10_000,
	idleCloseMs: 10_000,
	muteCommitWaitMs: 2_000,
	retryGapMs: 1_000,
};

export interface ScribeListenOptions extends ScribeStart {
	readonly apiKey: string;
	readonly connect: SocketFactory;
	readonly signal: AbortSignal;
	readonly now?: () => number;
	readonly timing?: Partial<ScribeTiming>;
}

export async function openScribe(options: ScribeListenOptions): Promise<ListenSession> {
	options.signal.throwIfAborted();
	const session = new ScribeListenSession(options);
	await session.ready;
	return session;
}

class ScribeListenSession implements ListenSession {
	readonly ready: Promise<void>;
	readonly events: AsyncIterable<ListenEvent>;

	readonly #options: ScribeListenOptions;
	readonly #queue = new EventQueue<ListenEvent>();
	readonly #opened = Promise.withResolvers<void>();
	readonly #now: () => number;
	readonly #timing: ScribeTiming;
	readonly #onAbort = () => this.close();
	readonly #pending: Uint8Array[] = [];
	readonly #backlog: Uint8Array[] = [];

	#ws: SocketLike | null = null;
	#started = false;
	#firstOpen = true;
	#ended = false;
	#muted = false;
	#utterance = false;
	#lastPartial = "";
	#pendingBytes = 0;
	#backlogBytes = 0;
	#carry: number | null = null;
	#failures = 0;
	#retryAt = 0;
	#lastSentAt = 0;
	#audioSinceCommit = false;
	#commitPending = false;
	#openTimer: Timer | undefined;
	#muteTimer: Timer | undefined;

	constructor(options: ScribeListenOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#timing = { ...DEFAULT_TIMING, ...options.timing };
		this.ready = this.#opened.promise;
		this.events = this.#queue;
		this.#connect();
		options.signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	push(pcm16k: Uint8Array): void {
		if (this.#ended || this.#muted || pcm16k.byteLength === 0) return;
		let bytes = pcm16k.slice();
		if (this.#carry !== null) {
			const joined = new Uint8Array(bytes.byteLength + 1);
			joined[0] = this.#carry;
			joined.set(bytes, 1);
			bytes = joined;
			this.#carry = null;
		}
		if (bytes.byteLength % 2 === 1) {
			this.#carry = bytes[bytes.byteLength - 1] ?? null;
			bytes = bytes.subarray(0, bytes.byteLength - 1);
		}
		this.#pending.push(bytes);
		this.#pendingBytes += bytes.byteLength;
		if (this.#pendingBytes >= MIN_CHUNK_BYTES) this.#sendPending();
	}

	mute(muted: boolean): void {
		if (this.#ended || muted === this.#muted) return;
		this.#muted = muted;
		if (!muted) {
			clearTimeout(this.#muteTimer);
			return;
		}
		if (this.#firstOpen) return;
		const live = this.#started && this.#ws !== null;
		if (live) this.#sendPending();
		this.#pending.length = 0;
		this.#pendingBytes = 0;
		this.#carry = null;
		if (live && (this.#audioSinceCommit || this.#commitPending)) {
			if (this.#audioSinceCommit) this.#commit();
			clearTimeout(this.#muteTimer);
			this.#muteTimer = setTimeout(() => {
				this.#endUtterance();
				this.#releaseSocket();
			}, this.#timing.muteCommitWaitMs);
			this.#muteTimer.unref();
			return;
		}
		this.#endUtterance();
		this.#releaseSocket();
	}

	close(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#options.signal.removeEventListener("abort", this.#onAbort);
		clearTimeout(this.#muteTimer);
		this.#releaseSocket();
		this.#queue.close();
		this.#opened.reject(
			this.#options.signal.reason ?? new Error("The ElevenLabs listening session was closed before it opened"),
		);
	}

	#connect(): void {
		const ws = this.#options.connect(scribeSocketUrl(this.#options), { "xi-api-key": this.#options.apiKey });
		this.#ws = ws;
		ws.onmessage = message => {
			if (this.#ws === ws && typeof message.data === "string") this.#onMessage(message.data);
		};
		ws.onclose = () => {
			if (this.#ws === ws) this.#onClosed();
		};
		this.#openTimer = setTimeout(() => {
			if (this.#ws !== ws || this.#started) return;
			this.#releaseSocket();
			this.#socketFailed(unreachableFailure("ElevenLabs", { code: "ETIMEDOUT" }));
		}, this.#timing.openTimeoutMs);
		this.#openTimer.unref();
	}

	#onMessage(raw: string): void {
		const event = parseScribeEvent(raw);
		if (!event || this.#ended) return;
		switch (event.kind) {
			case "started":
				clearTimeout(this.#openTimer);
				this.#started = true;
				this.#firstOpen = false;
				this.#opened.resolve();
				this.#drainBacklog();
				return;
			case "partial":
				this.#onPartial(event.text.trim());
				return;
			case "committed":
				this.#onCommitted(event.text.trim());
				return;
			case "released":
				this.#endUtterance();
				this.#releaseSocket();
				return;
			case "failure":
				this.#releaseSocket();
				if (event.retry) this.#socketFailed(event.error);
				else this.#fatal(event.error);
				return;
		}
	}

	#onClosed(): void {
		const wasStarted = this.#started;
		const idle = this.#now() - this.#lastSentAt >= this.#timing.idleCloseMs;
		this.#releaseSocket();
		if (this.#ended) return;
		if (!wasStarted) this.#socketFailed(unreachableFailure("ElevenLabs"));
		else if (!idle) this.#socketFailed(new ElevenLabsError("ElevenLabs closed the listening connection"));
		else this.#endUtterance();
	}

	#onPartial(text: string): void {
		if (text === "") return;
		this.#failures = 0;
		this.#beginUtterance();
		if (text === this.#lastPartial) return;
		this.#lastPartial = text;
		this.#queue.push({ t: "partial", text });
	}

	#onCommitted(text: string): void {
		this.#commitPending = false;
		this.#audioSinceCommit = false;
		if (text !== "") {
			this.#failures = 0;
			this.#beginUtterance();
		}
		this.#endUtterance();
		if (text !== "") this.#queue.push({ t: "final", text });
		if (this.#muted) {
			clearTimeout(this.#muteTimer);
			this.#releaseSocket();
		}
	}

	#beginUtterance(): void {
		if (this.#utterance) return;
		this.#utterance = true;
		this.#queue.push({ t: "speech-start" });
	}

	#endUtterance(): void {
		if (!this.#utterance) return;
		this.#utterance = false;
		this.#lastPartial = "";
		this.#queue.push({ t: "speech-end" });
	}

	#sendPending(): void {
		if (this.#pendingBytes === 0) return;
		const merged = new Uint8Array(this.#pendingBytes);
		let at = 0;
		for (const part of this.#pending.splice(0)) {
			merged.set(part, at);
			at += part.byteLength;
		}
		this.#pendingBytes = 0;
		for (let start = 0; start < merged.byteLength; start += MAX_CHUNK_BYTES) {
			this.#deliver(merged.subarray(start, start + MAX_CHUNK_BYTES));
		}
	}

	#deliver(chunk: Uint8Array): void {
		if (this.#ws === null) {
			if (this.#now() < this.#retryAt) return;
			try {
				this.#connect();
			} catch (error) {
				this.#socketFailed(unreachableFailure("ElevenLabs", error));
				return;
			}
		}
		if (this.#started) this.#send(chunk);
		else this.#hold(chunk);
	}

	#send(chunk: Uint8Array): void {
		if (this.#ws?.readyState !== SOCKET_OPEN) return;
		this.#ws.send(audioFrame(chunk));
		this.#lastSentAt = this.#now();
		this.#audioSinceCommit = true;
	}

	#hold(chunk: Uint8Array): void {
		this.#backlog.push(chunk);
		this.#backlogBytes += chunk.byteLength;
		while (this.#backlogBytes > MAX_BACKLOG_BYTES) {
			const dropped = this.#backlog.shift();
			if (!dropped) break;
			this.#backlogBytes -= dropped.byteLength;
		}
	}

	#drainBacklog(): void {
		for (const chunk of this.#backlog.splice(0)) this.#send(chunk);
		this.#backlogBytes = 0;
	}

	#commit(): void {
		if (this.#ws?.readyState !== SOCKET_OPEN) return;
		this.#ws.send(COMMIT_FRAME);
		this.#commitPending = true;
		this.#audioSinceCommit = false;
	}

	#releaseSocket(): void {
		clearTimeout(this.#openTimer);
		const ws = this.#ws;
		this.#ws = null;
		this.#started = false;
		this.#audioSinceCommit = false;
		this.#commitPending = false;
		this.#backlog.length = 0;
		this.#backlogBytes = 0;
		try {
			ws?.close();
		} catch {
			return;
		}
	}

	#socketFailed(error: ElevenLabsError): void {
		this.#endUtterance();
		this.#failures += 1;
		if (this.#firstOpen || this.#failures >= MAX_CONSECUTIVE_FAILURES) {
			this.#fatal(error);
			return;
		}
		this.#retryAt = this.#now() + this.#timing.retryGapMs * this.#failures;
	}

	#fatal(error: ElevenLabsError): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#options.signal.removeEventListener("abort", this.#onAbort);
		clearTimeout(this.#muteTimer);
		this.#releaseSocket();
		this.#opened.reject(error);
		this.#queue.fail(error);
	}
}
