// Moving pictures: a `<video>` letterboxed in its stage, a click to play and pause it. The transport is the layer's (`media-core`).
import { mountMedia } from "./media-core";
import type { MountContext, Renderer } from "./types";

const renderer: Renderer = { mount: (el: HTMLElement, _bytes: Uint8Array, ctx: MountContext) => mountMedia(el, ctx, "video") };
export default renderer;
