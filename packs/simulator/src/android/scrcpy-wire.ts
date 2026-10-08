// scrcpy-server 5.0's wire format, as measured against a live emulator (the
// protocol is the server's, not ours: this file is the only place it is known).
//
// VIDEO socket, device -> host, after the connection is made:
//   1 byte   dummy (forward tunnel: proves the other end is the server)
//   4 bytes  codec id ("h264")
//   then packets, each with a 12-byte header:
//     session  : u32 0x80000000, u32 width, u32 height          (video size; re-sent when it changes)
//     data     : u64 flags|pts, u32 size, <size bytes>
//                flags: bit 62 = config (Annex-B SPS/PPS), bit 61 = key frame; pts = low 61 bits
//
// CONTROL socket, host -> device, one message per write, big endian:
//   0  inject keycode   [0][action u8][keycode u32][repeat u32][meta u32]
//   1  inject text      [1][len u32][utf8]
//   2  inject touch     [2][action u8][pointer id u64][x i32][y i32][w u16][h u16][pressure u16][actionButton u32][buttons u32]
//  17  reset video      [17]   (restarts the encoder: a config and a key frame follow)

import type { PacketKind, VideoPacket } from "../contracts";

const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY = 1n << 61n;

export interface WireHandlers {
  session(width: number, height: number): void;
  packet(packet: VideoPacket): void;
  /** The stream is not scrcpy 5.0's. The caller closes it. */
  violation(message: string): void;
}

/** Largest packet accepted: a 4K key frame is well under this; anything bigger is a desynchronised stream. */
const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 12;

type Phase = "dummy" | "codec" | "packets";

/** Incremental parser of the VIDEO socket. Feed it TCP chunks; it calls the handlers in order. */
export class VideoStreamParser {
  #phase: Phase = "dummy";
  #pending: Buffer = Buffer.alloc(0);
  readonly #handlers: WireHandlers;

  constructor(handlers: WireHandlers) {
    this.#handlers = handlers;
  }

  /** True once the dummy byte and codec id have been read. */
  get ready(): boolean {
    return this.#phase === "packets";
  }

  feed(chunk: Buffer): void {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    for (;;) {
      if (this.#phase === "dummy") {
        if (this.#pending.length < 1) return;
        this.#pending = this.#pending.subarray(1);
        this.#phase = "codec";
      } else if (this.#phase === "codec") {
        if (this.#pending.length < 4) return;
        const codec = this.#pending.toString("ascii", 0, 4);
        if (codec !== "h264") {
          this.#handlers.violation(`scrcpy-server streams ${JSON.stringify(codec)}, this pack decodes h264`);
          return;
        }
        this.#pending = this.#pending.subarray(4);
        this.#phase = "packets";
      } else {
        if (this.#pending.length < HEADER_BYTES) return;
        if ((this.#pending[0] ?? 0) & 0x80) {
          this.#handlers.session(this.#pending.readUInt32BE(4), this.#pending.readUInt32BE(8));
          this.#pending = this.#pending.subarray(HEADER_BYTES);
          continue;
        }
        const flags = this.#pending.readBigUInt64BE(0);
        const size = this.#pending.readUInt32BE(8);
        if (size > MAX_PACKET_BYTES) {
          this.#handlers.violation(`scrcpy-server sent a ${size}-byte packet; the stream is out of step`);
          return;
        }
        if (this.#pending.length < HEADER_BYTES + size) return;
        // Copy out: the packet outlives the chunk it arrived in (the relay caches a key frame and its deltas).
        const data = Buffer.from(this.#pending.subarray(HEADER_BYTES, HEADER_BYTES + size));
        this.#pending = this.#pending.subarray(HEADER_BYTES + size);
        const kind: PacketKind = (flags & FLAG_CONFIG) !== 0n ? "config" : (flags & FLAG_KEY) !== 0n ? "key" : "delta";
        this.#handlers.packet({ kind, data });
      }
    }
  }
}

// ── control messages ────────────────────────────────────────────────────────

export const ACTION_DOWN = 0;
export const ACTION_UP = 1;
export const ACTION_MOVE = 2;
export type TouchAction = typeof ACTION_DOWN | typeof ACTION_UP | typeof ACTION_MOVE;

/** The pointer id scrcpy uses for "a finger" (-2). */
export const POINTER_FINGER = 0xfffffffffffffffen;

export function resetVideoMessage(): Buffer {
  return Buffer.from([17]);
}

export function keycodeMessage(action: typeof ACTION_DOWN | typeof ACTION_UP, keycode: number): Buffer {
  const out = Buffer.alloc(14);
  out[0] = 0;
  out[1] = action;
  out.writeUInt32BE(keycode, 2);
  return out;
}

export function textMessage(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const out = Buffer.alloc(5 + body.length);
  out[0] = 1;
  out.writeUInt32BE(body.length, 1);
  body.copy(out, 5);
  return out;
}

/** (x, y) in the VIDEO's pixels; the server scales to the device and drops a message whose (width, height) is not the current video size. */
export function touchMessage(action: TouchAction, x: number, y: number, width: number, height: number): Buffer {
  const out = Buffer.alloc(32);
  out[0] = 2;
  out[1] = action;
  out.writeBigUInt64BE(POINTER_FINGER, 2);
  out.writeInt32BE(x, 10);
  out.writeInt32BE(y, 14);
  out.writeUInt16BE(width, 18);
  out.writeUInt16BE(height, 20);
  out.writeUInt16BE(action === ACTION_UP ? 0 : 0xffff, 22);
  return out;
}

/** Android KeyEvent codes for the keys a View or an agent can press. */
export const KEYCODES: Record<string, number> = {
  home: 3,
  back: 4,
  menu: 82,
  recents: 187,
  power: 26,
  volumeUp: 24,
  volumeDown: 25,
  enter: 66,
  delete: 67,
  tab: 61,
  escape: 111,
};
