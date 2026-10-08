// The frames lane's wire format, shared by the server relay and the View.
//
// Two lanes, never mixed. Control (MCP tools) is JSON request/response over the
// host's bridge. Frames are THIS: one binary WebSocket per viewer, server -> View
// carrying media, View -> server carrying small JSON input messages (text frames).
//
// Every binary message is a 13-byte header followed by the payload:
//
//   u8  tag      (FrameTag)
//   u32 seq      (big endian, per stream, wraps)
//   f64 at       (big endian, Date.now() on the server when the packet was read;
//                 the View runs on the same machine, so `Date.now() - at` is the
//                 age of a picture when it reaches the screen)
//   ... payload  (Session: u16 width, u16 height; Config/Key/Delta: Annex-B H.264;
//                 Shot: a PNG)
//
// No Node imports: the View bundles this file.

export const FRAME_HEADER_BYTES = 13;

export const FrameTag = { Config: 1, Key: 2, Delta: 3, Session: 4, Shot: 5 } as const;
export type FrameTag = (typeof FrameTag)[keyof typeof FrameTag];

const TAG_VALUES: readonly number[] = Object.values(FrameTag);

export interface MediaFrame {
  readonly tag: FrameTag;
  readonly seq: number;
  readonly at: number;
  readonly payload: Uint8Array;
}

/** Write the 13-byte header into `target` at `offset`. */
export function writeFrameHeader(target: Uint8Array, offset: number, tag: FrameTag, seq: number, at: number): void {
  const view = new DataView(target.buffer, target.byteOffset + offset, FRAME_HEADER_BYTES);
  view.setUint8(0, tag);
  view.setUint32(1, seq >>> 0, false);
  view.setFloat64(5, at, false);
}

export function encodeFrame(tag: FrameTag, seq: number, at: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  writeFrameHeader(out, 0, tag, seq, at);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/** The payload of a Session frame: the video size the following packets are in. */
export function sessionPayload(width: number, height: number): Uint8Array {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint16(0, width, false);
  view.setUint16(2, height, false);
  return out;
}

export function readSessionPayload(payload: Uint8Array): { width: number; height: number } | null {
  if (payload.length !== 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, 4);
  const width = view.getUint16(0, false);
  const height = view.getUint16(2, false);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** `null` for anything that is not a well-formed message: the caller treats it as a protocol violation, never as a picture. */
export function decodeFrame(bytes: Uint8Array): MediaFrame | null {
  if (bytes.length < FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_HEADER_BYTES);
  const tag = view.getUint8(0);
  if (!TAG_VALUES.includes(tag)) return null;
  return {
    tag: tag as FrameTag,
    seq: view.getUint32(1, false),
    at: view.getFloat64(5, false),
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

/**
 * The WebCodecs codec string (`avc1.PPCCLL`) of an Annex-B SPS/PPS config packet:
 * profile_idc, the constraint flags and level_idc are the three bytes after the
 * SPS NAL header. `null` when no SPS (NAL type 7) is found.
 */
export function avcCodecString(config: Uint8Array): string | null {
  for (let i = 0; i + 4 < config.length; i++) {
    const long = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 0 && config[i + 3] === 1;
    const short = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1;
    if (!long && !short) continue;
    const nal = i + (long ? 4 : 3);
    if (nal + 3 >= config.length) return null;
    if ((config[nal] & 0x1f) !== 7) continue;
    const hex = (value: number): string => value.toString(16).padStart(2, "0");
    return `avc1.${hex(config[nal + 1])}${hex(config[nal + 2])}${hex(config[nal + 3])}`;
  }
  return null;
}

/**
 * The access unit a decoder can START from. The encoder's key frame carries only
 * the IDR slice; SPS and PPS arrive once, in the Config packet. A WebCodecs
 * Annex-B decoder configured without a `description` learns them from the
 * bitstream alone, so a key frame fed bare decodes to nothing and no error.
 */
export function keyAccessUnit(config: Uint8Array | null, key: Uint8Array): Uint8Array {
  if (config === null) return key;
  const unit = new Uint8Array(config.length + key.length);
  unit.set(config, 0);
  unit.set(key, config.length);
  return unit;
}

// ── View -> server: input messages (JSON text frames) ───────────────────────

export const DEVICE_KEYS = ["home", "back", "recents", "power", "volumeUp", "volumeDown", "enter", "delete", "tab", "escape", "menu"] as const;
export type DeviceKey = (typeof DEVICE_KEYS)[number];

export type PointerAction = "down" | "move" | "up";

export type InputMessage =
  | { readonly t: "p"; readonly a: PointerAction; readonly x: number; readonly y: number }
  | { readonly t: "k"; readonly key: DeviceKey }
  | { readonly t: "s"; readonly text: string }
  | { readonly t: "kf" };

export const MAX_INPUT_MESSAGE_BYTES = 8 * 1024;
export const MAX_INPUT_TEXT_CHARS = 512;

/** Validate an untrusted input message. `null` = refuse (the relay ignores it and counts it). */
export function parseInputMessage(raw: string): InputMessage | null {
  if (raw.length > MAX_INPUT_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message.t) {
    case "p": {
      if (message.a !== "down" && message.a !== "move" && message.a !== "up") return null;
      if (typeof message.x !== "number" || typeof message.y !== "number") return null;
      if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return null;
      return { t: "p", a: message.a, x: Math.min(1, Math.max(0, message.x)), y: Math.min(1, Math.max(0, message.y)) };
    }
    case "k":
      return typeof message.key === "string" && (DEVICE_KEYS as readonly string[]).includes(message.key) ? { t: "k", key: message.key as DeviceKey } : null;
    case "s":
      return typeof message.text === "string" && message.text.length > 0 && message.text.length <= MAX_INPUT_TEXT_CHARS ? { t: "s", text: message.text } : null;
    case "kf":
      return { t: "kf" };
    default:
      return null;
  }
}

// ── server -> View: status messages (JSON text frames) ──────────────────────
//   {"t":"ready","serial":"emulator-5554","mode":"h264"}   sent once, when the socket is accepted
//   {"t":"ended","reason":"..."}                           sent before the server closes it, when the source died

export type StreamMode = "h264" | "shot";
