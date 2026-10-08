// Screenshots without a decoder.
//
// `adb exec-out screencap` (no `-p`) answers the framebuffer RAW: a small header
// (width, height, pixel format, and on newer Android a colour space) then the
// pixels. A raw frame needs no PNG decode, so downscaling it to a model-sized
// picture is one pass over memory, and the PNG we write is built here from
// `zlib` alone. No dependency, no native module.
//
// The pass yields to the event loop between bands: the MCP server also relays
// live video and answers tool calls on this thread, and a 10 MB frame must not
// hold either of them.

import { setImmediate as yieldToLoop } from "node:timers/promises";
import { crc32, deflate } from "node:zlib";
import { fail } from "../contracts";

export interface RawScreen {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, a view into the capture. */
  readonly pixels: Uint8Array;
}

const FORMAT_RGBA_8888 = 1;
const FORMAT_RGBX_8888 = 2;

/** Parse `screencap` raw output. The header is 12 bytes (w, h, format) or 16 (plus a colour space): the length says which. */
export function parseRawScreencap(buffer: Uint8Array): RawScreen {
  if (buffer.length < 12) fail("screencap_failed", "screencap returned no frame. Is the screen off? Press power (device_key) and retry.");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const format = view.getUint32(8, true);
  if (width === 0 || height === 0 || width > 16384 || height > 16384) fail("screencap_failed", `screencap returned an implausible frame size ${width}x${height}.`);
  if (format !== FORMAT_RGBA_8888 && format !== FORMAT_RGBX_8888) fail("screencap_unsupported", `This display's framebuffer format (${format}) is not RGBA8888, which is the only raw format this pack scales.`);
  const body = buffer.length - width * height * 4;
  if (body !== 12 && body !== 16) fail("screencap_failed", `screencap returned ${buffer.length} bytes for a ${width}x${height} frame; expected a 12- or 16-byte header and ${width * height * 4} pixel bytes.`);
  return { width, height, pixels: buffer.subarray(body) };
}

const BAND_ROWS = 48;

export interface Scaled {
  readonly width: number;
  readonly height: number;
  /** output px / source px */
  readonly scale: number;
  /** RGB, row-major. */
  readonly rgb: Uint8Array;
}

/** Box-filter `screen` so its longest edge is at most `maxEdge` (never upscaled). */
export async function scaleToFit(screen: RawScreen, maxEdge: number): Promise<Scaled> {
  const scale = Math.min(1, maxEdge / Math.max(screen.width, screen.height));
  const width = Math.max(1, Math.round(screen.width * scale));
  const height = Math.max(1, Math.round(screen.height * scale));
  const rgb = new Uint8Array(width * height * 3);
  const { pixels } = screen;

  // Source column span of each output column, computed once.
  const xStart = new Int32Array(width);
  const xEnd = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    xStart[x] = Math.floor((x * screen.width) / width);
    xEnd[x] = Math.max(xStart[x] + 1, Math.floor(((x + 1) * screen.width) / width));
  }

  for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
    const y1 = Math.min(height, y0 + BAND_ROWS);
    for (let y = y0; y < y1; y++) {
      const sy0 = Math.floor((y * screen.height) / height);
      const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * screen.height) / height));
      let out = y * width * 3;
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        const sx0 = xStart[x];
        const sx1 = xEnd[x];
        for (let sy = sy0; sy < sy1; sy++) {
          let at = (sy * screen.width + sx0) * 4;
          for (let sx = sx0; sx < sx1; sx++, at += 4) {
            r += pixels[at];
            g += pixels[at + 1];
            b += pixels[at + 2];
          }
        }
        const count = (sy1 - sy0) * (sx1 - sx0);
        rgb[out++] = (r / count + 0.5) | 0;
        rgb[out++] = (g / count + 0.5) | 0;
        rgb[out++] = (b / count + 0.5) | 0;
      }
    }
    await yieldToLoop();
  }
  return { width, height, scale: width / screen.width, rgb };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGB PNG. Rows use the Up filter: UI screenshots are mostly repeated rows, which it turns into runs of zero. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Promise<Buffer> {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 2;
    const src = y * stride;
    for (let i = 0; i < stride; i++) raw[row + 1 + i] = (rgb[src + i] - (y === 0 ? 0 : rgb[src - stride + i])) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  deflate(raw, { level: 4 }, (error, compressed) => {
    if (error) reject(error);
    else resolve(Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]));
  });
  return promise;
}

export interface EncodedShot {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly source: { readonly width: number; readonly height: number };
}

/** raw screencap bytes -> a PNG whose longest edge is at most `maxEdge`. */
export async function rawToPng(raw: Uint8Array, maxEdge: number): Promise<EncodedShot> {
  const screen = parseRawScreencap(raw);
  const scaled = await scaleToFit(screen, maxEdge);
  const png = await encodePng(scaled.width, scaled.height, scaled.rgb);
  return { png, width: scaled.width, height: scaled.height, scale: scaled.scale, source: { width: screen.width, height: screen.height } };
}
