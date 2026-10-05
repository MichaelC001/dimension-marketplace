/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the live picture. H.264 only
 *  decodes in order: a delta is garbage without its key frame and a key frame is
 *  garbage without SPS/PPS. The gate decides, per viewer, which frames may reach
 *  the decoder; a slow viewer must have frames DROPPED (a late picture is worse
 *  than none) and be parked until a fresh key frame, and the encoder restart
 *  that key-frame request costs is rate-limited because one request serves every
 *  viewer.
 */
import { describe, expect, test } from "bun:test";
import { deliveryDecision, FrameGate, KeyframeThrottle } from "../src/shared/frame-gate";
import { FrameTag } from "../src/shared/frame-protocol";

const { Config, Key, Delta, Session, Shot } = FrameTag;

describe("FrameGate", () => {
  test("a stream walks awaiting-config -> awaiting-keyframe -> streaming", () => {
    const gate = new FrameGate();
    expect(gate.state).toBe("awaiting-config");
    expect(gate.admit(Config)).toBe(true);
    expect(gate.state).toBe("awaiting-keyframe");
    expect(gate.admit(Key)).toBe(true);
    expect(gate.state).toBe("streaming");
    expect(gate.admit(Delta)).toBe(true);
  });

  test("a key frame or delta that arrives before SPS/PPS is held back", () => {
    const gate = new FrameGate();
    expect(gate.admit(Key)).toBe(false);
    expect(gate.admit(Delta)).toBe(false);
    expect(gate.state).toBe("awaiting-config");
  });

  test("deltas are held back until a key frame has opened the stream", () => {
    const gate = new FrameGate();
    gate.admit(Config);
    expect(gate.admit(Delta)).toBe(false);
    expect(gate.state).toBe("awaiting-keyframe");
  });

  test("a new config mid-stream means the decoder's state is stale: deltas wait for the next key frame", () => {
    const gate = new FrameGate();
    gate.admit(Config);
    gate.admit(Key);
    expect(gate.admit(Delta)).toBe(true);
    expect(gate.admit(Config)).toBe(true);
    expect(gate.admit(Delta)).toBe(false);
    expect(gate.admit(Key)).toBe(true);
    expect(gate.admit(Delta)).toBe(true);
  });

  test("a session size and a still picture depend on no decoder state, and do not move the gate", () => {
    const gate = new FrameGate();
    expect(gate.admit(Session)).toBe(true);
    expect(gate.admit(Shot)).toBe(true);
    expect(gate.state).toBe("awaiting-config");
  });

  test("a gap asks for a key frame once, and only while streaming", () => {
    const gate = new FrameGate();
    expect(gate.gap()).toBe(false);
    gate.admit(Config);
    expect(gate.gap()).toBe(false);
    gate.admit(Key);
    expect(gate.gap()).toBe(true);
    expect(gate.state).toBe("awaiting-keyframe");
    expect(gate.gap()).toBe(false);
  });

  test("a reconnect forgets everything: back to awaiting the config", () => {
    const gate = new FrameGate();
    gate.admit(Config);
    gate.admit(Key);
    gate.reset();
    expect(gate.state).toBe("awaiting-config");
    expect(gate.admit(Delta)).toBe(false);
  });
});

describe("deliveryDecision: one frame, one viewer", () => {
  const MAX = 1_000;

  function streaming(): FrameGate {
    const gate = new FrameGate();
    gate.admit(Config);
    gate.admit(Key);
    return gate;
  }

  test("a viewer that keeps up is written to", () => {
    expect(deliveryDecision(streaming(), Delta, 0, MAX)).toEqual({ write: true });
    expect(deliveryDecision(streaming(), Key, MAX, MAX)).toEqual({ write: true });
  });

  test("past the backlog bound a picture is dropped, never queued, and the first drop asks for a key frame", () => {
    const gate = streaming();
    expect(deliveryDecision(gate, Delta, MAX + 1, MAX)).toEqual({ write: false, dropped: true, resync: true });
    expect(gate.state).toBe("awaiting-keyframe");
  });

  test("the viewer is parked: later deltas are held back even once its backlog clears, without asking again, until a key frame", () => {
    const gate = streaming();
    deliveryDecision(gate, Delta, MAX + 1, MAX);
    expect(deliveryDecision(gate, Delta, 0, MAX)).toEqual({ write: false, dropped: false, resync: false });
    expect(deliveryDecision(gate, Delta, MAX + 1, MAX)).toEqual({ write: false, dropped: true, resync: false });
    expect(deliveryDecision(gate, Key, 0, MAX)).toEqual({ write: true });
    expect(deliveryDecision(gate, Delta, 0, MAX)).toEqual({ write: true });
  });

  test("a dropped key frame always asks for another, whatever the gate says", () => {
    const gate = new FrameGate();
    gate.admit(Config);
    expect(deliveryDecision(gate, Key, MAX + 1, MAX)).toEqual({ write: false, dropped: true, resync: true });
  });

  test("config and session frames are tiny and a viewer cannot decode without them: never dropped for backlog", () => {
    const gate = new FrameGate();
    expect(deliveryDecision(gate, Session, MAX * 100, MAX)).toEqual({ write: true });
    expect(deliveryDecision(gate, Config, MAX * 100, MAX)).toEqual({ write: true });
    expect(gate.state).toBe("awaiting-keyframe");
  });

  test("a still picture over the bound is dropped without a key-frame request: a Shot viewer has no decoder to resync", () => {
    expect(deliveryDecision(new FrameGate(), Shot, MAX + 1, MAX)).toEqual({ write: false, dropped: true, resync: false });
  });

  test("a frame the gate refuses is not a drop and asks for nothing", () => {
    expect(deliveryDecision(new FrameGate(), Delta, 0, MAX)).toEqual({ write: false, dropped: false, resync: false });
  });
});

describe("KeyframeThrottle", () => {
  test("the first request fires; one inside the cooldown waits for exactly what is left of it", () => {
    const throttle = new KeyframeThrottle(1_000);
    expect(throttle.request(5_000)).toEqual({ fire: true, retryInMs: 0 });
    expect(throttle.request(5_400)).toEqual({ fire: false, retryInMs: 600 });
    expect(throttle.request(5_999)).toEqual({ fire: false, retryInMs: 1 });
  });

  test("a request exactly one cooldown after the last that fired fires", () => {
    const throttle = new KeyframeThrottle(1_000);
    throttle.request(0);
    expect(throttle.request(1_000)).toEqual({ fire: true, retryInMs: 0 });
  });

  test("a refused request does not extend the cooldown: the trailing one lands on time", () => {
    const throttle = new KeyframeThrottle(1_000);
    throttle.request(0);
    throttle.request(400);
    throttle.request(900);
    expect(throttle.request(1_000)).toEqual({ fire: true, retryInMs: 0 });
  });

  test("asking again after the advised wait fires", () => {
    const throttle = new KeyframeThrottle(1_000);
    throttle.request(100);
    const wait = throttle.request(300);
    expect(wait.fire).toBe(false);
    expect(throttle.request(300 + wait.retryInMs).fire).toBe(true);
  });
});
