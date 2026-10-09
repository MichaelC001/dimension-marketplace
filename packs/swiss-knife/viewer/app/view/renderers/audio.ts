// Sound: an `<audio>` element and a card for the file. The transport is the layer's (`media-core`).
import { mountMedia } from "./media-core";
import type { MountContext, Renderer } from "./types";

const renderer: Renderer = { mount: (el: HTMLElement, _bytes: Uint8Array, ctx: MountContext) => mountMedia(el, ctx, "audio") };
export default renderer;
