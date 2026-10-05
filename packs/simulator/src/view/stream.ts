// The View's end of the frames lane: a WebSocket, a frame gate, a WebCodecs
// decoder and a canvas.
//
// Live (h264): every Session/Config/Key/Delta message goes through the SAME
// FrameGate the server runs per viewer. The decoder only ever sees an in-order
// access unit: config first, then a key frame, then deltas. A lost frame, a
// decoder error or a backed-up decode queue walks the gate back to
// awaiting-keyframe and asks the encoder for one (throttled: a request restarts
// the encoder's stream for every viewer).
//
// Shot (fallback): ONLY when WebCodecs is missing or `isConfigSupported` says the
// stream's profile cannot be decoded here. Then the server sends whole PNGs and
// the canvas shows the newest one. The chip says "Shot fallback", never "Live".
//
// Pictures are painted at most once per animation frame and newest-first: a
// slow display never builds a queue of old pictures.

import { FrameGate, KeyframeThrottle } from "../shared/frame-gate";
import { avcCodecString, decodeFrame, FrameTag, type InputMessage, type MediaFrame, readSessionPayload, type StreamMode } from "../shared/frame-protocol";
import type { Grant } from "./client";
import type { StreamStatus } from "./view-model";

export interface StreamHost {
  /** A fresh address and token: tokens are per View and per connection. */
  acquire(mode: StreamMode): Promise<Grant>;
  onSize(width: number, height: number): void;
  onStatus(status: StreamStatus): void;
}

const KEYFRAME_COOLDOWN_MS = 1_000;
/** A decoder this far behind is not coming back on its own; resync instead. */
const MAX_DECODE_QUEUE = 8;
const MAX_RECONNECTS = 8;
const FRAME_US = 16_667;

export const webCodecsPresent = (): boolean => typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";

export class LiveStream {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #host: StreamHost;
  readonly #gate = new FrameGate();
  readonly #throttle = new KeyframeThrottle(KEYFRAME_COOLDOWN_MS);
  readonly #inflight = new Map<number, number>();
  #socket: WebSocket | null = null;
  #decoder: VideoDecoder | null = null;
  #config: Uint8Array | null = null;
  #chain: Promise<void> = Promise.resolve();
  #pending: VideoFrame | null = null;
  #raf: number | null = null;
  #timestamp = 0;
  #requested: StreamMode = "h264";
  #mode: StreamMode = "h264";
  #fallbackReason: string | null = null;
  #attempt = 0;
  #stopped = true;
  #endedReason: string | null = null;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #trailing: ReturnType<typeof setTimeout> | undefined;
  #stats: ReturnType<typeof setInterval> | undefined;
  #drawn = 0;
  #ages: number[] = [];
  #shotBusy = false;
  #shotNext: Uint8Array | null = null;
  #phase: StreamStatus["phase"] = "connecting";
  #detail: string | null = null;
  #fps = 0;
  #latency: number | null = null;

  constructor(canvas: HTMLCanvasElement, host: StreamHost) {
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (context === null) throw new Error("this page cannot draw on a canvas");
    this.#canvas = canvas;
    this.#context = context;
    this.#host = host;
  }

  start(preferred: StreamMode): void {
    this.stop();
    this.#stopped = false;
    this.#requested = preferred;
    this.#attempt = 0;
    this.#stats = setInterval(() => this.#tick(), 1_000);
    void this.#connect(preferred);
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#trailing);
    clearInterval(this.#stats);
    this.#teardownSocket();
    this.#closeDecoder();
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
    this.#pending?.close();
    this.#pending = null;
    this.#inflight.clear();
    this.#gate.reset();
    this.#config = null;
  }

  send(message: InputMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #status(phase: StreamStatus["phase"], detail: string | null = null): void {
    this.#phase = phase;
    this.#detail = detail;
    this.#publish();
  }

  #publish(): void {
    this.#host.onStatus({ phase: this.#phase, mode: this.#mode, fallbackReason: this.#fallbackReason, fps: this.#fps, latencyMs: this.#latency, detail: this.#detail });
  }

  #tick(): void {
    this.#fps = this.#drawn;
    this.#drawn = 0;
    this.#latency = this.#ages.length === 0 ? null : Math.round(this.#ages.reduce((sum, age) => sum + age, 0) / this.#ages.length);
    this.#ages = [];
    this.#publish();
  }

  async #connect(mode: StreamMode): Promise<void> {
    this.#status(this.#attempt === 0 ? "connecting" : "reconnecting", this.#detail);
    let grant: Grant;
    try {
      grant = await this.#host.acquire(mode);
    } catch (error) {
      if (!this.#stopped) this.#scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.#stopped) return;
    let chosen = grant.mode;
    this.#fallbackReason = grant.downgraded;
    if (chosen === "h264" && !webCodecsPresent()) {
      // This browser has no WebCodecs: ask for pictures instead, and say why.
      this.#fallbackReason = "this window cannot decode video (no WebCodecs)";
      chosen = "shot";
      try {
        grant = await this.#host.acquire("shot");
      } catch (error) {
        if (!this.#stopped) this.#scheduleReconnect(error instanceof Error ? error.message : String(error));
        return;
      }
      if (this.#stopped) return;
    }
    this.#mode = grant.mode;
    this.#open(grant.url);
  }

  #open(url: string): void {
    this.#teardownSocket();
    this.#gate.reset();
    this.#config = null;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#endedReason = null;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#status("live");
    };
    socket.onmessage = event => {
      if (this.#socket !== socket) return;
      if (typeof event.data === "string") {
        this.#onText(event.data);
        return;
      }
      const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
      if (frame === null) {
        // Both ends disagree about the format; nothing after a bad header can be trusted.
        socket.close();
        return;
      }
      this.#chain = this.#chain.then(() => this.#handle(frame)).catch(() => undefined);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#closeDecoder();
      if (!this.#stopped) this.#scheduleReconnect(this.#endedReason ?? "the connection closed");
    };
    socket.onerror = () => undefined; // onclose follows with the reason.
  }

  #onText(text: string): void {
    try {
      const message = JSON.parse(text) as { t?: string; reason?: string };
      if (message.t === "ended" && typeof message.reason === "string") this.#endedReason = message.reason;
    } catch {
      // not ours
    }
  }

  #teardownSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  #scheduleReconnect(reason: string): void {
    if (this.#attempt >= MAX_RECONNECTS) {
      this.#status("ended", reason);
      return;
    }
    const wait = Math.min(8_000, 500 * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#status("reconnecting", reason);
    this.#retry = setTimeout(() => void this.#connect(this.#requested), wait);
  }

  async #handle(frame: MediaFrame): Promise<void> {
    if (this.#stopped) return;
    switch (frame.tag) {
      case FrameTag.Session: {
        const size = readSessionPayload(frame.payload);
        if (size !== null) {
          this.#canvas.width = size.width;
          this.#canvas.height = size.height;
          this.#host.onSize(size.width, size.height);
        }
        return;
      }
      case FrameTag.Config:
        if (this.#gate.admit(FrameTag.Config)) {
          this.#config = new Uint8Array(frame.payload);
          await this.#configure();
        }
        return;
      case FrameTag.Key:
      case FrameTag.Delta:
        if (!this.#gate.admit(frame.tag)) return;
        this.#decode(frame);
        return;
      case FrameTag.Shot:
        this.#showShot(frame.payload);
        return;
    }
  }

  async #configure(): Promise<void> {
    const config = this.#config;
    if (config === null) return;
    const codec = avcCodecString(config);
    if (codec === null) {
      this.#fallBackToShots("the stream carried no H.264 parameters");
      return;
    }
    // Annex-B access units (no `description`): the browsers' WebCodecs reads them as is.
    const decoderConfig = { codec, optimizeForLatency: true, avc: { format: "annexb" } } as VideoDecoderConfig;
    const support = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => ({ supported: false }));
    if (this.#stopped) return;
    if (support.supported !== true) {
      this.#fallBackToShots(`this window cannot decode ${codec}`);
      return;
    }
    this.#closeDecoder();
    const decoder = new VideoDecoder({
      output: picture => this.#onPicture(picture),
      error: error => {
        if (this.#decoder !== decoder) return;
        this.#decoder = null;
        // Rebuild from the config we hold, then wait for a key frame.
        this.#gate.reset();
        this.#gate.admit(FrameTag.Config);
        this.#detail = error.message;
        this.#chain = this.#chain.then(() => this.#configure()).then(() => this.requestKeyframe());
      },
    });
    this.#decoder = decoder;
    decoder.configure(decoderConfig);
  }

  #fallBackToShots(reason: string): void {
    if (this.#mode === "shot") return;
    this.#fallbackReason = reason;
    this.#requested = "shot";
    this.#teardownSocket();
    this.#closeDecoder();
    this.#attempt = 0;
    void this.#connect("shot");
  }

  #decode(frame: MediaFrame): void {
    const decoder = this.#decoder;
    if (decoder === null || decoder.state !== "configured") return;
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      if (this.#gate.gap()) this.requestKeyframe();
      return;
    }
    this.#timestamp += FRAME_US;
    this.#inflight.set(this.#timestamp, frame.at);
    try {
      decoder.decode(new EncodedVideoChunk({ type: frame.tag === FrameTag.Key ? "key" : "delta", timestamp: this.#timestamp, data: frame.payload }));
    } catch {
      this.#inflight.delete(this.#timestamp);
      if (this.#gate.gap()) this.requestKeyframe();
    }
  }

  #closeDecoder(): void {
    const decoder = this.#decoder;
    this.#decoder = null;
    if (decoder !== null && decoder.state !== "closed") {
      try {
        decoder.close();
      } catch {
        // already closing
      }
    }
  }

  #onPicture(picture: VideoFrame): void {
    const sentAt = this.#inflight.get(picture.timestamp);
    this.#inflight.delete(picture.timestamp);
    if (sentAt !== undefined) this.#ages.push(Date.now() - sentAt);
    // Newest wins: a picture the display never got to is dropped, not queued.
    this.#pending?.close();
    this.#pending = picture;
    this.#raf ??= requestAnimationFrame(() => {
      this.#raf = null;
      const next = this.#pending;
      this.#pending = null;
      if (next === null) return;
      if (this.#canvas.width !== next.displayWidth || this.#canvas.height !== next.displayHeight) {
        this.#canvas.width = next.displayWidth;
        this.#canvas.height = next.displayHeight;
        this.#host.onSize(next.displayWidth, next.displayHeight);
      }
      this.#context.drawImage(next, 0, 0);
      next.close();
      this.#drawn += 1;
    });
  }

  #showShot(png: Uint8Array): void {
    if (this.#shotBusy) {
      this.#shotNext = new Uint8Array(png);
      return;
    }
    this.#shotBusy = true;
    const bytes = new Uint8Array(png);
    void createImageBitmap(new Blob([bytes], { type: "image/png" }))
      .then(bitmap => {
        if (!this.#stopped) {
          if (this.#canvas.width !== bitmap.width || this.#canvas.height !== bitmap.height) {
            this.#canvas.width = bitmap.width;
            this.#canvas.height = bitmap.height;
            this.#host.onSize(bitmap.width, bitmap.height);
          }
          this.#context.drawImage(bitmap, 0, 0);
          this.#drawn += 1;
        }
        bitmap.close();
      })
      .catch(() => undefined)
      .finally(() => {
        this.#shotBusy = false;
        const next = this.#shotNext;
        this.#shotNext = null;
        if (next !== null && !this.#stopped) this.#showShot(next);
      });
  }

  /** Ask the encoder for a key frame: one now, plus one trailing request if a burst came in. */
  requestKeyframe(): void {
    if (this.#mode !== "h264") return;
    const decision = this.#throttle.request(Date.now());
    if (decision.fire) {
      this.send({ t: "kf" });
      return;
    }
    if (this.#trailing !== undefined) return;
    this.#trailing = setTimeout(() => {
      this.#trailing = undefined;
      this.requestKeyframe();
    }, decision.retryInMs);
  }
}
