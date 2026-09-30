// A bounded thumbnail for a presented image.
//
// The card draws a picture sized by the image, so the tool hands it pixels on
// the existing `details.images` lane - never the original bytes. Everything here
// is a bound, because a thumbnail is work the tool does before the human has
// asked for anything:
//
//   * the source is read only up to `MAX_THUMB_SOURCE_BYTES`, and decoded only up
//     to `MAX_THUMB_PIXELS` (Bun refuses a bigger canvas from its header, before
//     allocating a pixel buffer);
//   * the long edge is at most `THUMB_EDGE`, and one thumbnail is at most
//     `MAX_THUMB_BYTES` (the lane the browser tool also keeps its captures under:
//     past ~256 KB a replay swaps pixels for a `blob:sha256:` ref, which the
//     thread redeems, but a card that paints on the first frame wants inline);
//   * the caller passes the bytes still unspent in this result's budget.
//
// The facility is `Bun.Image`: native decode, resize and encode off the JS
// thread, the same one OMP's own `resizeImage` uses. No dependency is added.
//
// A failure is never an error: an image that will not decode, a format without
// a decoder, a thumbnail that cannot be made small enough all answer "no
// thumbnail" and the card draws the kind's icon instead.

/** Long edge of a thumbnail, in pixels. */
export const THUMB_EDGE = 768;
/** The most bytes one encoded thumbnail may take. */
export const MAX_THUMB_BYTES = 150 * 1024;
/** Images larger than this on disk are presented without a thumbnail. */
export const MAX_THUMB_SOURCE_BYTES = 25 * 1024 * 1024;
/** Images with more pixels than this are presented without a thumbnail. */
export const MAX_THUMB_PIXELS = 50_000_000;

/** JPEG qualities tried after a lossless PNG is over budget, then the smaller edges at the last quality. */
const JPEG_QUALITIES = [75, 55] as const;
const SMALLER_EDGES = [512, 320] as const;
const SMALLER_EDGE_QUALITY = 50;

export interface Thumbnail {
	/** Base64, no `data:` prefix: the shape `details.images` entries take. */
	readonly data: string;
	readonly mimeType: "image/png" | "image/jpeg";
	/** Decoded size in bytes: what this thumbnail spends of the result's budget. */
	readonly bytes: number;
}

export interface ImageFacts {
	/** Pixel size of the image as displayed (EXIF orientation applied). */
	readonly width: number;
	readonly height: number;
	readonly thumb?: Thumbnail;
}

function thumbnail(bytes: Uint8Array, mimeType: Thumbnail["mimeType"]): Thumbnail {
	return { data: Buffer.from(bytes).toString("base64"), mimeType, bytes: bytes.length };
}

/**
 * The size of an image and, when it fits `maxBytes`, a thumbnail of it.
 * `undefined` when the bytes are not an image this runtime can decode (an ICO,
 * a corrupt file, a canvas over `MAX_THUMB_PIXELS`).
 *
 * PNG first: it is lossless and keeps transparency and the sharp text of a
 * screenshot, and a small graphic is smallest that way. Only an image whose PNG
 * is over budget (a photograph) becomes a JPEG, and only then does it get
 * smaller. The big decode happens once; every later rung starts from the small
 * PNG.
 */
export async function imageFacts(source: Uint8Array, maxBytes: number): Promise<ImageFacts | undefined> {
	if (typeof Bun === "undefined") return undefined;
	try {
		const options = { maxPixels: MAX_THUMB_PIXELS };
		const { width, height } = await new Bun.Image(source, options).metadata();
		if (!(width > 0 && height > 0)) return undefined;
		if (maxBytes <= 0) return { width, height };

		const fit = { fit: "inside", withoutEnlargement: true } as const;
		const base = await new Bun.Image(source, options).resize(THUMB_EDGE, THUMB_EDGE, fit).png().bytes();
		if (base.length <= maxBytes) return { width, height, thumb: thumbnail(base, "image/png") };
		for (const quality of JPEG_QUALITIES) {
			const jpeg = await new Bun.Image(base).jpeg({ quality }).bytes();
			if (jpeg.length <= maxBytes) return { width, height, thumb: thumbnail(jpeg, "image/jpeg") };
		}
		for (const edge of SMALLER_EDGES) {
			const jpeg = await new Bun.Image(base).resize(edge, edge, fit).jpeg({ quality: SMALLER_EDGE_QUALITY }).bytes();
			if (jpeg.length <= maxBytes) return { width, height, thumb: thumbnail(jpeg, "image/jpeg") };
		}
		return { width, height };
	} catch {
		return undefined;
	}
}
