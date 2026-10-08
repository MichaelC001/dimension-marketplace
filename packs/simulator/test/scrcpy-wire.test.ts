/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the live video lane. The pack
 *  speaks scrcpy-server 5.0's wire format (a 12-byte packet header, flags in the
 *  top bits of a u64) and a wrong bit means a key frame is treated as a delta (a
 *  new viewer never gets a picture) or SPS/PPS is not recognised (nothing
 *  decodes). The control messages are what a tap, a key and typed text become on
 *  the device; the server drops a touch whose size is not the current video's.
 */
import { describe, expect, test } from "bun:test";
import type { VideoPacket } from "../src/contracts";
import { DEVICE_KEYS } from "../src/shared/frame-protocol";
import {
  ACTION_DOWN,
  ACTION_MOVE,
  ACTION_UP,
  KEYCODES,
  keycodeMessage,
  POINTER_FINGER,
  resetVideoMessage,
  textMessage,
  touchMessage,
  VideoStreamParser,
  type WireHandlers,
} from "../src/android/scrcpy-wire";

const CONFIG = 1n << 62n;
const KEY = 1n << 61n;

/** What the parser said, in order. */
type Event = { kind: "session"; width: number; height: number } | { kind: "packet"; packet: VideoPacket } | { kind: "violation"; message: string };

function listener(): { events: Event[]; parser: VideoStreamParser } {
  const events: Event[] = [];
  const handlers: WireHandlers = {
    session: (width, height) => events.push({ kind: "session", width, height }),
    packet: packet => events.push({ kind: "packet", packet }),
    violation: message => events.push({ kind: "violation", message }),
  };
  return { events, parser: new VideoStreamParser(handlers) };
}

function dataPacket(flags: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function sessionPacket(width: number, height: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x80000000, 0);
  header.writeUInt32BE(width, 4);
  header.writeUInt32BE(height, 8);
  return header;
}

const PREAMBLE = Buffer.concat([Buffer.from([0]), Buffer.from("h264", "ascii")]);

describe("VideoStreamParser", () => {
  test("a session packet names the video size and consumes its twelve bytes", () => {
    const { events, parser } = listener();
    parser.feed(Buffer.concat([PREAMBLE, sessionPacket(1080, 2400)]));
    expect(events).toEqual([{ kind: "session", width: 1080, height: 2400 }]);
  });

  test("the config bit (62) marks SPS/PPS, the key bit (61) a key frame, neither a delta", () => {
    const { events, parser } = listener();
    parser.feed(Buffer.concat([PREAMBLE, dataPacket(CONFIG, Buffer.from([1, 2])), dataPacket(KEY, Buffer.from([3])), dataPacket(0n, Buffer.from([4, 5, 6]))]));
    expect(events.map(event => (event.kind === "packet" ? [event.packet.kind, [...event.packet.data]] : event.kind))).toEqual([
      ["config", [1, 2]],
      ["key", [3]],
      ["delta", [4, 5, 6]],
    ]);
  });

  test("the timestamp lives in the low 61 bits and cannot be mistaken for a flag", () => {
    const { events, parser } = listener();
    const pts = (1n << 60n) | 0x1234_5678_9abcn;
    parser.feed(Buffer.concat([PREAMBLE, dataPacket(pts, Buffer.from([9])), dataPacket(KEY | pts, Buffer.from([8]))]));
    expect(events.map(event => (event.kind === "packet" ? event.packet.kind : event.kind))).toEqual(["delta", "key"]);
  });

  test("a packet cut at any byte, however small the chunks, parses exactly as when it arrives whole", () => {
    const stream = Buffer.concat([
      PREAMBLE,
      sessionPacket(720, 1600),
      dataPacket(CONFIG, Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f])),
      dataPacket(KEY, Buffer.alloc(300, 7)),
      dataPacket(0n, Buffer.alloc(5, 1)),
      sessionPacket(1600, 720),
      dataPacket(0n, Buffer.alloc(2, 2)),
    ]);
    const whole = listener();
    whole.parser.feed(stream);
    // Seeded: a failure reproduces.
    let seed = 20_261_006;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let round = 0; round < 25; round++) {
      const cut = listener();
      for (let at = 0; at < stream.length; ) {
        const size = 1 + (next() % 17);
        cut.parser.feed(Buffer.from(stream.subarray(at, at + size)));
        at += size;
      }
      expect({ round, events: cut.events }).toEqual({ round, events: whole.events });
    }
    expect(whole.events).toHaveLength(6);
  });

  test("the parser is ready only once the dummy byte and the codec id are behind it", () => {
    const { parser } = listener();
    parser.feed(Buffer.from([0]));
    expect(parser.ready).toBe(false);
    parser.feed(Buffer.from("h26", "ascii"));
    expect(parser.ready).toBe(false);
    parser.feed(Buffer.from("4", "ascii"));
    expect(parser.ready).toBe(true);
  });

  test("a codec that is not h264 is a violation, and nothing after it is parsed as video", () => {
    const { events, parser } = listener();
    parser.feed(Buffer.concat([Buffer.from([0]), Buffer.from("h265", "ascii"), dataPacket(KEY, Buffer.from([1]))]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "violation" });
    expect(events[0]).toMatchObject({ message: expect.stringContaining("h265") });
  });

  test("a packet larger than 8 MiB means the stream is out of step: a violation, not a huge allocation", () => {
    const { events, parser } = listener();
    const header = Buffer.alloc(12);
    header.writeUInt32BE(8 * 1024 * 1024 + 1, 8);
    parser.feed(Buffer.concat([PREAMBLE, header]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "violation" });
  });

  test("a packet's bytes are its own: reusing the chunk it arrived in does not change it", () => {
    const { events, parser } = listener();
    const chunk = Buffer.concat([PREAMBLE, dataPacket(KEY, Buffer.from([1, 2, 3, 4]))]);
    parser.feed(chunk);
    chunk.fill(0xff);
    const packet = events[0];
    expect(packet?.kind === "packet" ? [...packet.packet.data] : null).toEqual([1, 2, 3, 4]);
  });
});

describe("control messages", () => {
  test("a key press is 14 bytes: type 0, action, keycode big-endian", () => {
    const down = keycodeMessage(ACTION_DOWN, 187);
    expect(down).toHaveLength(14);
    expect([...down.subarray(0, 6)]).toEqual([0, ACTION_DOWN, 0, 0, 0, 187]);
    expect(keycodeMessage(ACTION_UP, 4)[1]).toBe(ACTION_UP);
  });

  test("typed text is type 1, a big-endian byte length, then UTF-8 (length in bytes, not characters)", () => {
    const message = textMessage("h\u00e9llo");
    expect(message[0]).toBe(1);
    expect(message.readUInt32BE(1)).toBe(6);
    expect(message.subarray(5).toString("utf8")).toBe("h\u00e9llo");
  });

  test("a touch is 32 bytes: finger id -2, position, the video's size, full pressure down and none on release", () => {
    const down = touchMessage(ACTION_DOWN, 540, 1200, 1080, 2400);
    expect(down).toHaveLength(32);
    expect(down[0]).toBe(2);
    expect(down[1]).toBe(ACTION_DOWN);
    expect(down.readBigUInt64BE(2)).toBe(POINTER_FINGER);
    expect([down.readInt32BE(10), down.readInt32BE(14), down.readUInt16BE(18), down.readUInt16BE(20)]).toEqual([540, 1200, 1080, 2400]);
    expect(down.readUInt16BE(22)).toBe(0xffff);
    expect(touchMessage(ACTION_MOVE, 1, 2, 1080, 2400).readUInt16BE(22)).toBe(0xffff);
    expect(touchMessage(ACTION_UP, 1, 2, 1080, 2400).readUInt16BE(22)).toBe(0);
  });

  test("reset video is the single byte 17", () => {
    expect([...resetVideoMessage()]).toEqual([17]);
  });
});

describe("KEYCODES", () => {
  // Android's own KeyEvent constants: a wrong number presses a different key.
  const android: Record<string, number> = { home: 3, back: 4, menu: 82, recents: 187, power: 26, volumeUp: 24, volumeDown: 25, enter: 66, delete: 67, tab: 61, escape: 111 };

  test("each key is the Android KeyEvent code for it", () => {
    expect(KEYCODES).toEqual(android);
  });

  test("every key the View or an agent may press has a code: no tool offers a key the backend refuses", () => {
    for (const key of DEVICE_KEYS) expect(KEYCODES[key]).toBeDefined();
  });
});
