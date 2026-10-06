// Pointer geometry, shared by the server (maps what the View sends) and the View.
//
// The View never sends pixels: it sends coordinates normalized to the canvas box
// (0..1), so a pane resize, a device rotation or a different video size can never
// make a click land wrong. The server alone knows the sizes.

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** A normalized point as a pixel inside `size` (0 .. size - 1, so it is always on the surface). */
export function toPixels(nx: number, ny: number, size: Size): Point {
  return {
    x: Math.round(clamp01(nx) * (size.width - 1)),
    y: Math.round(clamp01(ny) * (size.height - 1)),
  };
}

export type Gesture =
  | { readonly kind: "tap"; readonly at: Point }
  | { readonly kind: "swipe"; readonly from: Point; readonly to: Point; readonly durationMs: number };

/** A press that stays within this many pixels of where it started is a tap. */
export const TAP_SLOP_PX = 12;
const MIN_SWIPE_MS = 60;
const MAX_SWIPE_MS = 2000;

/**
 * Without a live control channel the pointer reaches the device as `adb shell input`,
 * which has no press/move/release, only tap and swipe. Collapse one press into the
 * one it was.
 */
export function classifyGesture(down: Point, up: Point, heldMs: number): Gesture {
  const distance = Math.hypot(up.x - down.x, up.y - down.y);
  if (distance <= TAP_SLOP_PX) return { kind: "tap", at: up };
  return { kind: "swipe", from: down, to: up, durationMs: Math.round(Math.min(MAX_SWIPE_MS, Math.max(MIN_SWIPE_MS, heldMs))) };
}
