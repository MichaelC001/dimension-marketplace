// The person's pointer and keyboard, as the messages the relay understands.
//
// The View never sends pixels: a pointer position is normalized to the canvas box
// (0..1). The server alone knows the video and device sizes, so a pane resize or a
// device rotation can never make a click land wrong. Moves are coalesced to one
// per animation frame; a press and its release are always sent, in order.

import type { DeviceKey, InputMessage } from "../shared/frame-protocol";

const KEY_MAP: Record<string, DeviceKey> = { Enter: "enter", Backspace: "delete", Tab: "tab", Escape: "escape" };
const MAX_PASTE_CHARS = 512;

export function bindInput(canvas: HTMLCanvasElement, send: (message: InputMessage) => void): () => void {
  let pressed: number | null = null;
  let latest: { x: number; y: number } | null = null;
  let frame: number | null = null;

  // Captured pointers keep reporting outside the box: clamp, so a drag past the edge still ends on it.
  const point = (event: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const clamp = (value: number): number => Math.min(1, Math.max(0, value));
    return { x: clamp((event.clientX - rect.left) / (rect.width || 1)), y: clamp((event.clientY - rect.top) / (rect.height || 1)) };
  };

  const flushMove = (): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (latest !== null) send({ t: "p", a: "move", x: latest.x, y: latest.y });
    latest = null;
  };

  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || pressed !== null) return;
    const at = point(event);
    pressed = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
    send({ t: "p", a: "down", x: at.x, y: at.y });
    event.preventDefault();
  };
  const move = (event: PointerEvent): void => {
    if (pressed !== event.pointerId) return;
    latest = point(event);
    frame ??= requestAnimationFrame(() => {
      frame = null;
      flushMove();
    });
  };
  const up = (event: PointerEvent): void => {
    if (pressed !== event.pointerId) return;
    flushMove();
    const at = point(event);
    pressed = null;
    send({ t: "p", a: "up", x: at.x, y: at.y });
    event.preventDefault();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const special = KEY_MAP[event.key];
    if (special !== undefined) send({ t: "k", key: special });
    else if (event.key.length === 1) send({ t: "s", text: event.key });
    else return;
    event.preventDefault();
  };
  const paste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text") ?? "";
    for (let at = 0; at < text.length; at += MAX_PASTE_CHARS) send({ t: "s", text: text.slice(at, at + MAX_PASTE_CHARS) });
    event.preventDefault();
  };
  const noMenu = (event: Event): void => event.preventDefault();

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("keydown", key);
  canvas.addEventListener("paste", paste);
  canvas.addEventListener("contextmenu", noMenu);
  return () => {
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
    canvas.removeEventListener("keydown", key);
    canvas.removeEventListener("paste", paste);
    canvas.removeEventListener("contextmenu", noMenu);
  };
}
