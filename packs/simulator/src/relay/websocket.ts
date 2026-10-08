// A small RFC 6455 WebSocket server endpoint: the handshake, server -> client
// binary/text frames, client -> server frame parsing (masked, fragmented, with
// ping/pong/close). Written here so the pack carries no WebSocket dependency: the
// MCP SDK and ext-apps are the only runtime dependencies, and the frames lane
// needs nothing a few hundred lines of protocol do not give.
//
// Hard limits, because the peer is a page in a sandbox, not a friend: client
// messages are capped (`maxMessageBytes`), client frames must be masked, and
// anything malformed closes the socket.

import { createHash } from "node:crypto";
import type net from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const WS_OPEN_CODE = 1000;
export const WS_PROTOCOL_ERROR = 1002;
export const WS_TOO_BIG = 1009;
export const WS_INTERNAL_ERROR = 1011;

export function acceptKey(clientKey: string): string {
  return createHash("sha1").update(clientKey + GUID).digest("base64");
}

/** A client key is 16 random bytes, base64: 24 characters. */
export function validClientKey(key: string | undefined): key is string {
  return typeof key === "string" && /^[A-Za-z0-9+/]{22}==$/.test(key);
}

export function handshakeResponse(clientKey: string): string {
  return ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(clientKey)}`, "", ""].join("\r\n");
}

/** The frame header (FIN + opcode + length, unmasked) for a server -> client message of `length` payload bytes. */
export function frameHeader(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export function textFrame(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([frameHeader(OP_TEXT, body.length), body]);
}

export interface PeerHandlers {
  text(message: string): void;
  binary(message: Buffer): void;
  closed(code: number): void;
}

/** One accepted connection. After the handshake the socket belongs to the peer. */
export class WsPeer {
  readonly #socket: net.Socket;
  readonly #handlers: PeerHandlers;
  readonly #maxMessageBytes: number;
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmentOpcode = 0;
  #closed = false;

  constructor(socket: net.Socket, head: Buffer, handlers: PeerHandlers, maxMessageBytes: number) {
    this.#socket = socket;
    this.#handlers = handlers;
    this.#maxMessageBytes = maxMessageBytes;
    socket.setNoDelay(true);
    // OS-level liveness: a View that vanished without a FIN is found by TCP, with no JS timer per peer.
    socket.setKeepAlive(true, 15_000);
    socket.on("data", chunk => this.#feed(chunk));
    socket.on("close", () => this.#finish(WS_OPEN_CODE));
    socket.on("error", () => this.#finish(1006));
    if (head.length > 0) this.#feed(head);
  }

  /** Bytes accepted by `write` that the OS has not taken yet: the backlog a slow viewer builds. */
  get backlog(): number {
    return this.#socket.writableLength;
  }

  get open(): boolean {
    return !this.#closed && this.#socket.writable;
  }

  /** Write a complete, already-framed message (the relay frames once and shares the bytes across viewers). */
  writeFrame(frame: Buffer): void {
    if (this.open) this.#socket.write(frame);
  }

  sendText(text: string): void {
    this.writeFrame(textFrame(text));
  }

  close(code: number, reason = ""): void {
    if (this.#closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.#socket.end(Buffer.concat([frameHeader(OP_CLOSE, body.length), body]));
    this.#finish(code);
    // A peer that never answers the close must not hold the socket open.
    setTimeout(() => this.#socket.destroy(), 1_000).unref();
  }

  destroy(): void {
    this.#socket.destroy();
    this.#finish(1006);
  }

  #finish(code: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#handlers.closed(code);
  }

  #feed(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#closed) return;
      if (this.#buffer.length < 2) return;
      const first = this.#buffer[0] ?? 0;
      const second = this.#buffer[1] ?? 0;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (!masked) return this.#violate(WS_PROTOCOL_ERROR, "client frames must be masked");
      if ((first & 0x70) !== 0) return this.#violate(WS_PROTOCOL_ERROR, "reserved bits set");
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const big = this.#buffer.readBigUInt64BE(2);
        if (big > BigInt(this.#maxMessageBytes)) return this.#violate(WS_TOO_BIG, "message too big");
        length = Number(big);
        offset = 10;
      }
      const isControl = opcode >= 0x8;
      if (isControl && (!fin || length > 125)) return this.#violate(WS_PROTOCOL_ERROR, "bad control frame");
      if (length > this.#maxMessageBytes) return this.#violate(WS_TOO_BIG, "message too big");
      if (this.#buffer.length < offset + 4 + length) return;
      const mask = this.#buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.#buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
      this.#buffer = this.#buffer.subarray(offset + 4 + length);

      if (isControl) {
        if (opcode === OP_CLOSE) {
          this.close(WS_OPEN_CODE);
          return;
        }
        if (opcode === OP_PING) this.writeFrame(Buffer.concat([frameHeader(OP_PONG, payload.length), payload]));
        continue;
      }
      if (opcode === 0x0) {
        if (this.#fragmentOpcode === 0) return this.#violate(WS_PROTOCOL_ERROR, "unexpected continuation");
      } else {
        if (this.#fragmentOpcode !== 0) return this.#violate(WS_PROTOCOL_ERROR, "interleaved data frames");
        if (opcode !== OP_TEXT && opcode !== OP_BINARY) return this.#violate(WS_PROTOCOL_ERROR, "unknown opcode");
        this.#fragmentOpcode = opcode;
      }
      this.#fragments.push(payload);
      this.#fragmentBytes += payload.length;
      if (this.#fragmentBytes > this.#maxMessageBytes) return this.#violate(WS_TOO_BIG, "message too big");
      if (!fin) continue;
      const message = Buffer.concat(this.#fragments);
      const kind = this.#fragmentOpcode;
      this.#fragments = [];
      this.#fragmentBytes = 0;
      this.#fragmentOpcode = 0;
      if (kind === OP_TEXT) this.#handlers.text(message.toString("utf8"));
      else this.#handlers.binary(message);
    }
  }

  #violate(code: number, reason: string): void {
    this.#buffer = Buffer.alloc(0);
    this.close(code, reason);
  }
}
