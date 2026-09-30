import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flatPng, loadTools, makeTempDir } from "./fixtures";

const PACK = join(import.meta.dir, "..");
const DIST = join(PACK, "dist", "index.mjs");
const DIMENSION_KEY = "ai.insodimension.dimension";

/** Plain objects only: the manifests are read as data and narrowed, never cast. */
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`);
	return Object.fromEntries(Object.entries(value));
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error(`expected an array, got ${JSON.stringify(value)}`);
	return value.map(entry => {
		if (typeof entry !== "string") throw new Error(`expected a string, got ${JSON.stringify(entry)}`);
		return entry;
	});
}

async function readJson(name: string): Promise<Record<string, unknown>> {
	return record(JSON.parse(await readFile(join(PACK, name), "utf8")));
}

describe("the committed bundle", () => {
	test("dist/index.mjs is exactly what scripts/build.mjs produces from src/", async () => {
		// The build script is plain untyped JS outside the TypeScript project; load it by path.
		const built: unknown = await import(pathToFileURL(join(PACK, "scripts", "build.mjs")).href);
		if (typeof built !== "object" || built === null || !("buildBundle" in built) || typeof built.buildBundle !== "function") {
			throw new Error("scripts/build.mjs does not export buildBundle()");
		}
		const rebuilt: unknown = await built.buildBundle();
		if (typeof rebuilt !== "string") throw new Error("buildBundle() did not return the bundle text");

		// A checkout with core.autocrlf rewrites line endings; the bytes that matter are the code.
		const committed = (await readFile(DIST, "utf8")).replaceAll("\r\n", "\n");
		expect(
			committed === rebuilt.replaceAll("\r\n", "\n"),
			"dist/index.mjs is stale: the host loads it, not src/. Run `node scripts/build.mjs` in marketplace/packs/swiss-knife and commit dist/index.mjs",
		).toBe(true);
	}, 60_000);
});

describe("the shipped bundle end to end", () => {
	let base: string;
	beforeAll(async () => {
		base = await makeTempDir();
		await writeFile(join(base, "shot.png"), await flatPng(3000, 2000));
	});
	afterAll(() => rm(base, { recursive: true, force: true }));

	test("registers `present` as a read-tier tool: showing a file never prompts", async () => {
		const { tools } = await loadTools(DIST);
		expect(tools.map(tool => tool.name)).toEqual(["present"]);
		expect(tools[0]?.approval).toBe("read");
	});

	test("presents a file on disk: the result line, and a thumbnail on the pixel lane", async () => {
		const { tools } = await loadTools(DIST);
		const file = join(base, "shot.png");
		const result = await tools[0]?.execute("t1", { path: file }, undefined, undefined, { cwd: base });

		expect(result?.content).toHaveLength(1);
		expect(result?.content[0]?.text).toMatch(/^Presented shot\.png \(image, \d+(\.\d)? [KM]?B\)\.$/);
		const [item] = result?.details.presentation.items ?? [];
		expect(item).toMatchObject({ name: "shot.png", kind: "image", width: 3000, height: 2000, thumb: 0 });
		expect(result?.details.images).toHaveLength(1);
		expect(result?.details.images?.[0]?.data.length).toBeGreaterThan(0);
	});
});

describe("the manifest matches what the bundle registers", () => {
	test("every declared extension exists, and the host's entry is the committed bundle", async () => {
		const pkg = await readJson("package.json");
		const extensions = strings(record(pkg.dimension).extensions);
		expect(extensions).toContain("dist/index.mjs");
		for (const extension of extensions) {
			const found = await stat(join(PACK, extension)).then(
				info => info.isFile(),
				() => false,
			);
			expect(found, `package.json dimension.extensions names ${extension}, which is not a file`).toBe(true);
		}
	});

	test("every toolRenderer matches a tool the extensions register: a renamed tool must not leave a generic card", async () => {
		const pkg = await readJson("package.json");
		const manifest = await readJson("plugin.json");
		const registered = new Set<string>();
		for (const extension of strings(record(pkg.dimension).extensions)) {
			for (const tool of (await loadTools(join(PACK, extension))).tools) registered.add(tool.name);
		}

		const renderers = record(record(manifest.extensions)[DIMENSION_KEY]).toolRenderer;
		if (!Array.isArray(renderers) || renderers.length === 0) throw new Error("plugin.json declares no toolRenderer");
		for (const renderer of renderers) {
			const match = record(renderer).match;
			expect(typeof match === "string" && registered.has(match), `toolRenderer match ${JSON.stringify(match)} is not a registered tool (${[...registered].join(", ")})`).toBe(true);
		}
	});

	test("the plugin and the package agree on the pack's name", async () => {
		const pkg = await readJson("package.json");
		const manifest = await readJson("plugin.json");
		expect(manifest.name).toBe(record(pkg.dimension).name);
	});
});
