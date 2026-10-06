/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the frames lane trusts what it
 *  should not. The View is a page in a sandbox, so what it sends (pointer
 *  coordinates, keys, text) is untrusted input that reaches a real device, and
 *  what it receives is read by byte offsets: one wrong offset and every picture
 *  is a protocol violation.
 */
import { describe, expect, test } from "bun:test";
import {
  avcCodecString,
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FrameTag,
  MAX_INPUT_MESSAGE_BYTES,
  MAX_INPUT_TEXT_CHARS,
  parseInputMessage,
  readSessionPayload,
  sessionPayload,
} from "../src/shared/frame-protocol";

describe("parseInputMessage: what the View may ask of a device", () => {
  test("a pointer message is clamped into the surface: the View cannot aim off the screen", () => {
    expect(parseInputMessage('{"t":"p","a":"down","x":-4,"y":7}')).toEqual({ t: "p", a: "down", x: 0, y: 1 });
    expect(parseInputMessage('{"t":"p","a":"move","x":0.25,"y":0.75}')).toEqual({ t: "p", a: "move", x: 0.25, y: 0.75 });
  });

  const refused: { name: string; raw: string }[] = [
    { name: "not JSON", raw: "{nope" },
    { name: "JSON that is not an object", raw: "42" },
    { name: "null", raw: "null" },
    { name: "an unknown message type", raw: '{"t":"shell","cmd":"rm -rf /"}' },
    { name: "a pointer with an unknown action", raw: '{"t":"p","a":"fling","x":0.5,"y":0.5}' },
    { name: "a pointer whose coordinates are strings", raw: '{"t":"p","a":"down","x":"0.5","y":"0.5"}' },
    { name: "a pointer whose coordinate is missing", raw: '{"t":"p","a":"down","x":0.5}' },
    { name: "a key that is not one of the device keys", raw: '{"t":"k","key":"reboot"}' },
    { name: "a key that is not a string", raw: '{"t":"k","key":3}' },
    { name: "empty text", raw: '{"t":"s","text":""}' },
    { name: "text that is not a string", raw: '{"t":"s","text":["a"]}' },
    { name: "an otherwise valid pointer message padded past the byte limit", raw: JSON.stringify({ t: "p", a: "down", x: 0.5, y: 0.5, pad: "x".repeat(MAX_INPUT_MESSAGE_BYTES) }) },
    { name: "text over the length limit", raw: JSON.stringify({ t: "s", text: "x".repeat(MAX_INPUT_TEXT_CHARS + 1) }) },
  ];
  for (const row of refused) {
    test(`refuses ${row.name}`, () => {
      expect(parseInputMessage(row.raw)).toBeNull();
    });
  }

  test("a pointer coordinate that is not a finite number is refused, not clamped", () => {
    expect(parseInputMessage('{"t":"p","a":"down","x":1e999,"y":0.5}')).toBeNull();
  });

  test("keys, text at the limit and a key-frame request are accepted", () => {
    expect(parseInputMessage('{"t":"k","key":"home"}')).toEqual({ t: "k", key: "home" });
    expect(parseInputMessage(JSON.stringify({ t: "s", text: "x".repeat(MAX_INPUT_TEXT_CHARS) }))).toEqual({ t: "s", text: "x".repeat(MAX_INPUT_TEXT_CHARS) });
    expect(parseInputMessage('{"t":"kf"}')).toEqual({ t: "kf" });
  });
});

describe("the binary frame", () => {
  test("round-trips tag, sequence number, timestamp and payload", () => {
    const frame = encodeFrame(FrameTag.Key, 4_000_000_000, 1_790_000_000_123.5, Uint8Array.of(9, 8, 7));
    expect(frame).toHaveLength(FRAME_HEADER_BYTES + 3);
    const decoded = decodeFrame(frame);
    expect(decoded).not.toBeNull();
    expect({ tag: decoded?.tag, seq: decoded?.seq, at: decoded?.at, payload: [...(decoded?.payload ?? [])] }).toEqual({ tag: FrameTag.Key, seq: 4_000_000_000, at: 1_790_000_000_123.5, payload: [9, 8, 7] });
  });

  test("the sequence number wraps at 32 bits", () => {
    expect(decodeFrame(encodeFrame(FrameTag.Delta, 2 ** 32 + 5, 0, new Uint8Array()))?.seq).toBe(5);
  });

  test("a message shorter than the header, or with an unknown tag, is not a picture", () => {
    expect(decodeFrame(new Uint8Array(FRAME_HEADER_BYTES - 1))).toBeNull();
    const unknown = encodeFrame(FrameTag.Delta, 1, 1, new Uint8Array());
    unknown[0] = 99;
    expect(decodeFrame(unknown)).toBeNull();
  });

  test("a decoded payload is a view of the message past the header, wherever the message sits in its buffer", () => {
    const frame = encodeFrame(FrameTag.Shot, 1, 1, Uint8Array.of(1, 2, 3));
    const padded = new Uint8Array(frame.length + 5);
    padded.set(frame, 5);
    expect([...(decodeFrame(padded.subarray(5))?.payload ?? [])]).toEqual([1, 2, 3]);
  });

  test("the session payload carries the video size, and zero is not a size", () => {
    expect(readSessionPayload(sessionPayload(1080, 2400))).toEqual({ width: 1080, height: 2400 });
    expect(readSessionPayload(sessionPayload(0, 2400))).toBeNull();
    expect(readSessionPayload(new Uint8Array(3))).toBeNull();
  });
});

describe("avcCodecString", () => {
  test("is avc1.<profile><constraints><level> of the SPS, after either start-code length", () => {
    const sps = [0x67, 0x64, 0x00, 0x1f, 0xac];
    expect(avcCodecString(Uint8Array.of(0, 0, 0, 1, ...sps, 0, 0, 0, 1, 0x68, 0xee))).toBe("avc1.64001f");
    expect(avcCodecString(Uint8Array.of(0, 0, 1, ...sps))).toBe("avc1.64001f");
  });

  test("skips a NAL that is not an SPS to find the one that is", () => {
    expect(avcCodecString(Uint8Array.of(0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80, 0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0x01))).toBe("avc1.42c028");
  });

  test("is null when there is no SPS", () => {
    expect(avcCodecString(Uint8Array.of(0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80))).toBeNull();
    expect(avcCodecString(new Uint8Array())).toBeNull();
  });
});
