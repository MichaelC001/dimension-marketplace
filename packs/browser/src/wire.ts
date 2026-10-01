/**
 * The live stream's wire format: what the pack's listener writes and the View reads.
 * One message is a 9-byte header (kind, JSON length, body length, both little-endian u32), a JSON part, then a body:
 *
 *   picture  kind 1  JSON `PictureHead`   body = the JPEG bytes
 *   state    kind 2  JSON `BrowserState`  body = none
 *
 * Both sides import this file, so they cannot drift. `Reader` is bounded: a length above its caps is a protocol error, never a buffer.
 */
import type { Viewport } from "./contracts.js";

export const KIND_PICTURE = 1;
export const KIND_STATE = 2;
export const HEADER_BYTES = 9;
/** Larger than any real JPEG of a viewport of at most `MAX_VIEWPORT` at ratio 4; a bigger claim is a broken or hostile stream. */
export const MAX_PICTURE_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_BYTES = 4 * 1024 * 1024;

/** What a picture says about itself: the page size (CSS px) it was taken at, so a click on it maps exactly. */
export interface PictureHead {
	id: string;
	viewport: Viewport;
	/** Epoch ms when the browser produced it. */
	at: number;
}

export type Message =
	| { kind: typeof KIND_PICTURE; head: PictureHead; jpeg: Uint8Array }
	| { kind: typeof KIND_STATE; state: unknown };

const encoder = new TextEncoder();

/** The bytes of one message, as the two pieces to write (header + JSON, then the body) so a picture is never copied to join them. */
export function encode(kind: number, head: unknown, body: Uint8Array = new Uint8Array(0)): [Uint8Array, Uint8Array] {
	const json = encoder.encode(JSON.stringify(head));
	const prefix = new Uint8Array(HEADER_BYTES + json.length);
	const view = new DataView(prefix.buffer);
	prefix[0] = kind;
	view.setUint32(1, json.length, true);
	view.setUint32(5, body.length, true);
	prefix.set(json, HEADER_BYTES);
	return [prefix, body];
}

/** Incremental decoder: feed it whatever chunks arrive, get whole messages out. */
export class Reader {
	#parts: Uint8Array[] = [];
	#have = 0;
	/** Total size of the message being collected, once its header is known. */
	#need = 0;
	readonly #decoder = new TextDecoder();

	push(chunk: Uint8Array): Message[] {
		const out: Message[] = [];
		this.#parts.push(chunk);
		this.#have += chunk.length;
		for (;;) {
			if (this.#need === 0) {
				if (this.#have < HEADER_BYTES) break;
				const head = this.#take(HEADER_BYTES, false);
				const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
				const jsonLength = view.getUint32(1, true);
				const bodyLength = view.getUint32(5, true);
				if (jsonLength > MAX_JSON_BYTES || bodyLength > MAX_PICTURE_BYTES) throw new Error("the stream sent a message larger than allowed");
				this.#need = HEADER_BYTES + jsonLength + bodyLength;
			}
			if (this.#have < this.#need) break;
			const whole = this.#take(this.#need, true);
			this.#need = 0;
			out.push(this.#decode(whole));
		}
		return out;
	}

	/** The first `count` bytes as one buffer; `consume` removes them. */
	#take(count: number, consume: boolean): Uint8Array {
		const first = this.#parts[0];
		if (first && first.length >= count) {
			if (consume) {
				this.#parts[0] = first.subarray(count);
				this.#have -= count;
				if (this.#parts[0]?.length === 0) this.#parts.shift();
			}
			return first.subarray(0, count);
		}
		const joined = new Uint8Array(this.#have);
		let at = 0;
		for (const part of this.#parts) {
			joined.set(part, at);
			at += part.length;
		}
		this.#parts = joined.length > 0 ? [joined] : [];
		return this.#take(count, consume);
	}

	#decode(whole: Uint8Array): Message {
		const view = new DataView(whole.buffer, whole.byteOffset, whole.byteLength);
		const kind = whole[0];
		const jsonLength = view.getUint32(1, true);
		const json: unknown = JSON.parse(this.#decoder.decode(whole.subarray(HEADER_BYTES, HEADER_BYTES + jsonLength)));
		if (kind === KIND_STATE) return { kind: KIND_STATE, state: json };
		if (kind === KIND_PICTURE) return { kind: KIND_PICTURE, head: json as PictureHead, jpeg: whole.subarray(HEADER_BYTES + jsonLength) };
		throw new Error(`the stream sent a message of unknown kind ${kind}`);
	}
}
