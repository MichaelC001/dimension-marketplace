// The READING frame: HTML in a nested frame with `sandbox=""`: no scripts, no forms, no popups, no
// same-origin, no top navigation. The document is data, drawn, never run, for every reader, always.
// It arrives through `srcdoc`, so the frame also inherits the View's own CSP, which blocks every
// network fetch the page might attempt.
//
// Picking from the page (docs/design/88 section 2) does NOT change this frame. An opaque-origin View
// cannot read a frame inside it (nested frames inherit its sandbox flags, so none can share its
// origin), so every readable page also gets, by default, a SECOND frame over this one while Pick is armed
// (armed from the first frame; only a page past `PICK_FRAME_LIMIT` waits for the Pick tool). It is made from
// this frame's `srcdoc`, sandboxed `allow-scripts` and nothing else, and its document opens with a
// Content-Security-Policy admitting one script by hash. This frame stays underneath, unchanged, and is shown
// again whenever Pick is put down. Do not add a token to this attribute for the picker's sake.
import type { MountContext, Mounted, Renderer } from "./types";

async function mount(el: HTMLElement, bytes: Uint8Array, ctx: MountContext): Promise<Mounted> {
	const frame = document.createElement("iframe");
	frame.className = "vw-html";
	frame.setAttribute("sandbox", ""); // The empty token list: every restriction on.
	// The picker's seat finds the frame by this name and makes its pick frame from this frame's `srcdoc`.
	frame.dataset.slot = "viewer-html-frame";
	frame.referrerPolicy = "no-referrer";
	frame.title = ctx.filename;
	frame.srcdoc = new TextDecoder("utf-8").decode(bytes);
	el.append(frame);
	return {
		destroy: () => frame.remove(),
		zoom(factor) {
			// Scale the page, not the frame: the frame grows by the inverse so it still fills the pane.
			frame.style.transform = factor === 1 ? "" : `scale(${factor})`;
			frame.style.width = factor === 1 ? "" : `${100 / factor}%`;
			frame.style.height = factor === 1 ? "" : `${100 / factor}%`;
		},
	};
}

const renderer: Renderer = { mount };
export default renderer;
