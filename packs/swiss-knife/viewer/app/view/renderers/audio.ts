// Sound: an `<audio>` element and a card for the file. The transport is the layer's (`media-core`).
import { mountMedia } from "./media-core";
import type { MountContext, Renderer } from "./types";

const renderer: Renderer = { mount: (el: HTMLElement, bytes: Uint8Array, ctx: MountContext) => mountMedia(el, bytes, ctx, "audio") };
export default renderer;
