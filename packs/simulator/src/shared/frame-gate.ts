// The frame-gate state machine, shared by the server (one per viewer socket) and
// the View (one per decoder). H.264 is only decodable in order: a delta frame is
// garbage without the keyframe it follows, and a keyframe is garbage without the
// SPS/PPS config. The gate is the single place that rule lives:
//
//   awaiting-config -> awaiting-keyframe -> streaming
//
// A gap (a dropped frame, a decoder error, a new config) walks back to
// awaiting-keyframe; a new session (reconnect) back to awaiting-config.

import { FrameTag } from "./frame-protocol";

export type GateState = "awaiting-config" | "awaiting-keyframe" | "streaming";

export class FrameGate {
  #state: GateState = "awaiting-config";

  get state(): GateState {
    return this.#state;
  }

  /** Decide one frame and advance. A skipped frame must not reach the decoder / the socket. */
  admit(tag: FrameTag): boolean {
    switch (tag) {
      case FrameTag.Session:
      case FrameTag.Shot:
        // A session names the size; a shot is a whole picture. Neither depends on decoder state.
        return true;
      case FrameTag.Config:
        // New SPS/PPS: whatever decoder state existed is stale until the next keyframe.
        this.#state = "awaiting-keyframe";
        return true;
      case FrameTag.Key:
        if (this.#state === "awaiting-config") return false;
        this.#state = "streaming";
        return true;
      case FrameTag.Delta:
        return this.#state === "streaming";
    }
  }

  /**
   * A frame was lost or could not be decoded. Returns true when the caller must now
   * ask for a keyframe (it was streaming); false when it was already waiting for one.
   */
  gap(): boolean {
    if (this.#state !== "streaming") return false;
    this.#state = "awaiting-keyframe";
    return true;
  }

  /** A fresh connection / decoder: nothing is known. */
  reset(): void {
    this.#state = "awaiting-config";
  }
}

export type Delivery = { readonly write: true } | { readonly write: false; readonly dropped: boolean; readonly resync: boolean };

/**
 * One frame, one viewer: write it, or why not. A slow viewer (its socket backlog past
 * `maxBacklog`) has pictures DROPPED, never queued: a late picture is worse than none.
 * Config and session frames are tiny and a viewer cannot decode without them, so they
 * are never dropped for backlog. A dropped key frame, or the first dropped delta, parks
 * the viewer at the gate and asks for a new key frame (`resync`).
 */
export function deliveryDecision(gate: FrameGate, tag: FrameTag, backlog: number, maxBacklog: number): Delivery {
  const picture = tag === FrameTag.Key || tag === FrameTag.Delta || tag === FrameTag.Shot;
  if (picture && backlog > maxBacklog) {
    const parkedNow = gate.gap();
    return { write: false, dropped: true, resync: tag === FrameTag.Key || parkedNow };
  }
  if (!gate.admit(tag)) return { write: false, dropped: false, resync: false };
  return { write: true };
}

export interface ThrottleDecision {
  /** Send now. */
  readonly fire: boolean;
  /** When `fire` is false: wait this long and ask again (a trailing request, never lost). */
  readonly retryInMs: number;
}

/**
 * Keyframe requests restart the encoder's stream: expensive, and one serves every
 * viewer. A burst collapses to one now plus one trailing request.
 */
export class KeyframeThrottle {
  #last: number | null = null;
  readonly #cooldownMs: number;

  constructor(cooldownMs: number) {
    this.#cooldownMs = cooldownMs;
  }

  request(now: number): ThrottleDecision {
    if (this.#last === null || now - this.#last >= this.#cooldownMs) {
      this.#last = now;
      return { fire: true, retryInMs: 0 };
    }
    return { fire: false, retryInMs: this.#cooldownMs - (now - this.#last) };
  }
}
