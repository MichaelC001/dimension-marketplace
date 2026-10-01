// The matte guard (cutout.ts): is this PNG a real cutout of its subject?
//
// The CLI reads "has an alpha channel" as "already cut out", so a generator's
// noise-alpha PNG sails through and the backdrop becomes geometry. The guard
// reads the alpha's CONTENTS. These cases build PNGs in every encoding the guard
// must decode (the PNG filters, 8/16 bit, grey+alpha, palette+tRNS, Adam7) from a
// pixel function, and compare what the guard measures with an independent count
// of that function's transparent pixels.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureTransparency, requireCutout } from "../cutout.ts";
import models from "../models.json";
import { chunk, type Encoding, encodePng, labCutout, type PixelAt } from "./png.ts";

const rule = models.cutout;

const W = 137;
const H = 91;

function expectedShare(pixel: PixelAt, width: number, height: number): number {
	let transparent = 0;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if ((pixel(x, y)[3] as number) < rule.transparentBelow) transparent++;
	return transparent / (width * height);
}

describe("measuring transparency in every encoding the guard must read", () => {
	const ENCODINGS: readonly { name: string; encoding: Encoding; interlaced?: boolean; filter?: (row: number) => number; shortTrns?: boolean }[] = [
		{ name: "8-bit RGBA, every PNG filter in turn", encoding: { kind: "rgba", depth: 8 } },
		{ name: "8-bit RGBA, no filtering", encoding: { kind: "rgba", depth: 8 }, filter: () => 0 },
		{ name: "8-bit RGBA, Paeth on every row", encoding: { kind: "rgba", depth: 8 }, filter: () => 4 },
		{ name: "8-bit RGBA, Average on every row", encoding: { kind: "rgba", depth: 8 }, filter: () => 3 },
		{ name: "16-bit RGBA", encoding: { kind: "rgba", depth: 16 } },
		{ name: "8-bit grey + alpha", encoding: { kind: "grey-alpha", depth: 8 } },
		{ name: "16-bit grey + alpha", encoding: { kind: "grey-alpha", depth: 16 } },
		{ name: "8-bit palette with tRNS", encoding: { kind: "palette", depth: 8 } },
		{ name: "4-bit palette with tRNS (two pixels a byte, odd width)", encoding: { kind: "palette", depth: 4 } },
		{ name: "Adam7-interlaced 8-bit RGBA", encoding: { kind: "rgba", depth: 8 }, interlaced: true },
		{ name: "Adam7-interlaced 16-bit RGBA", encoding: { kind: "rgba", depth: 16 }, interlaced: true },
		{ name: "Adam7-interlaced 4-bit palette", encoding: { kind: "palette", depth: 4 }, interlaced: true },
		{ name: "8-bit palette whose tRNS names only the first entry (the rest are opaque)", encoding: { kind: "palette", depth: 8 }, shortTrns: true },
	];

	for (const { name, encoding, interlaced, filter, shortTrns } of ENCODINGS) {
		test(`${name}: the guard counts the same transparent pixels an independent count does`, () => {
			const png = encodePng({ width: W, height: H, encoding, pixel: labCutout, interlaced, filter, shortTrns });
			const measured = measureTransparency(png, rule.transparentBelow);
			expect(measured.width).toBe(W);
			expect(measured.height).toBe(H);
			expect(measured.transparentShare).toBeCloseTo(expectedShare(labCutout, W, H), 12);
		});
	}

	test("an image smaller than an Adam7 block still decodes: the passes that would be empty are skipped", () => {
		const tiny: PixelAt = (x, y) => [0, 0, 0, (x + y) % 2 === 0 ? 0 : 255];
		for (const [width, height] of [[1, 1], [2, 3], [5, 1], [9, 2]] as const) {
			const png = encodePng({ width, height, encoding: { kind: "rgba", depth: 8 }, pixel: tiny, interlaced: true });
			expect(measureTransparency(png, 16).transparentShare).toBeCloseTo(expectedShare(tiny, width, height), 12);
		}
	});

	test("only alpha below the threshold counts: 15 is transparent, 16 and a half-transparent subject are not", () => {
		const uniform = (alpha: number): PixelAt => () => [10, 20, 30, alpha];
		const share = (alpha: number): number =>
			measureTransparency(encodePng({ width: 8, height: 8, encoding: { kind: "rgba", depth: 8 }, pixel: uniform(alpha) }), 16).transparentShare;
		expect(share(15)).toBe(1);
		expect(share(16)).toBe(0);
		expect(share(128)).toBe(0);
	});
});

describe("requireCutout", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "gen-local-cutout-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const save = async (name: string, content: Buffer): Promise<string> => {
		const path = join(dir, name);
		await writeFile(path, content);
		return path;
	};
	const refusalOf = async (path: string): Promise<string> => {
		const failure = await requireCutout(path, rule).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		return (failure as Error).message;
	};

	test("accepts a lab-style RGBA cutout and reports what it measured", async () => {
		const path = await save("cutout.png", encodePng({ width: W, height: H, encoding: { kind: "rgba", depth: 8 }, pixel: labCutout }));
		const report = await requireCutout(path, rule);
		expect(report).toMatchObject({ width: W, height: H });
		expect(report.transparentShare).toBeGreaterThanOrEqual(rule.minTransparentShare);
	});

	test("accepts a cutout in the other encodings a matting tool writes", async () => {
		for (const encoding of [{ kind: "rgba", depth: 16 }, { kind: "grey-alpha", depth: 8 }, { kind: "palette", depth: 8 }] as const) {
			const path = await save(`cutout-${encoding.kind}-${encoding.depth}.png`, encodePng({ width: W, height: H, encoding, pixel: labCutout, interlaced: true }));
			expect((await requireCutout(path, rule)).transparentShare).toBeGreaterThanOrEqual(rule.minTransparentShare);
		}
	});

	test("refuses an RGB image: no alpha channel, so nothing is cut out", async () => {
		const path = await save("flat.png", encodePng({ width: W, height: H, encoding: { kind: "rgb", depth: 8 }, pixel: () => [9, 9, 9, 255] }));
		const message = await refusalOf(path);
		expect(message).toContain("flat.png");
		expect(message).toContain("no alpha channel");
		expect(message).toContain("Remove the background");
	});

	test("refuses an RGBA image whose alpha is opaque noise: a generator's fake cutout, naming how much is transparent", async () => {
		const noise: PixelAt = (x, y) => [(x * 13) & 255, 120, 30, 219 + ((x * 31 + y * 17) % 37)];
		const path = await save("noise-alpha.png", encodePng({ width: W, height: H, encoding: { kind: "rgba", depth: 8 }, pixel: noise }));
		const message = await refusalOf(path);
		expect(message).toContain("noise-alpha.png is not a cutout");
		expect(message).toContain("0.0% of its pixels are transparent");
		expect(message).toContain("background would be built as geometry");
	});

	test("refuses a fully opaque RGBA image", async () => {
		expect(await refusalOf(await save("opaque.png", encodePng({ width: 20, height: 20, encoding: { kind: "rgba", depth: 8 }, pixel: () => [9, 9, 9, 255] })))).toContain("is not a cutout");
	});

	test("the minimum share is inclusive: exactly 2% transparent passes, one pixel fewer does not", async () => {
		const withTransparent = (count: number): PixelAt => (x, y) => [0, 0, 0, y * 100 + x < count ? 0 : 255];
		const at = await save("at-min.png", encodePng({ width: 100, height: 100, encoding: { kind: "rgba", depth: 8 }, pixel: withTransparent(200) }));
		expect((await requireCutout(at, rule)).transparentShare).toBeCloseTo(0.02, 12);
		const below = await save("below-min.png", encodePng({ width: 100, height: 100, encoding: { kind: "rgba", depth: 8 }, pixel: withTransparent(199) }));
		expect(await refusalOf(below)).toContain("only 2.0% of its pixels are transparent");
	});

	test("refuses a file that is not a PNG, a truncated one, and one whose image data is corrupt, each naming the file", async () => {
		expect(await refusalOf(await save("photo.png", Buffer.from("\xff\xd8\xff\xe0 pretend jpeg", "latin1")))).toContain("it is not a PNG");
		const whole = encodePng({ width: W, height: H, encoding: { kind: "rgba", depth: 8 }, pixel: labCutout });
		expect(await refusalOf(await save("truncated.png", whole.subarray(0, 40)))).toContain("truncated.png");
		const header = encodePng({ width: 4, height: 4, encoding: { kind: "rgba", depth: 8 }, pixel: labCutout }).subarray(0, 8 + 25);
		const corrupt = Buffer.concat([header, chunk("IDAT", Buffer.from("not deflate data")), chunk("IEND", Buffer.alloc(0))]);
		expect(await refusalOf(await save("corrupt.png", corrupt))).toContain("image data is corrupt");
	});

	test("refuses a file that does not exist, naming it", async () => {
		expect(await refusalOf(join(dir, "absent.png"))).toContain("absent.png");
	});
});
