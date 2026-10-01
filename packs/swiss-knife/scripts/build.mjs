// Builds the one artifact the pack ships, and commits it (a pack installs with
// no build step): `dist/index.mjs`, the extension entry the host loads.
//
// `src/index.ts` imports `@dimension/sdk/presentation` at runtime (`classifyFile`,
// the item cap). An installed pack has no monorepo to resolve that from, so the
// SDK code is inlined here. Tree-shaking keeps only what `present` reaches: the
// SDK door re-exports the driver package's barrel, and everything else in it
// drops out. The host types (`@oh-my-pi/pi-coding-agent`) are erased.
//
// `buildBundle` is exported so `test/bundle.test.ts` can rebuild into memory and
// prove the committed file is what the source produces.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The bundle text, built from `src/index.ts`. Deterministic: same source, same bytes. */
export async function buildBundle() {
	const result = await build({
		entryPoints: [resolve(root, "src/index.ts")],
		// The bundle carries a comment per inlined module, relative to this directory:
		// pinned, so a rebuild from any cwd is the same bytes.
		absWorkingDir: root,
		bundle: true,
		write: false,
		platform: "node",
		format: "esm",
		target: "node22",
		sourcemap: false,
		legalComments: "none",
		logLevel: "error",
		// The driver package's tsconfig chain names an ES target esbuild does not know;
		// the bundle's own target is set above.
		tsconfigRaw: "{}",
	});
	const [output] = result.outputFiles;
	if (!output) throw new Error("esbuild produced no output for src/index.ts");
	return output.text;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outfile = resolve(root, "dist/index.mjs");
	await mkdir(dirname(outfile), { recursive: true });
	await writeFile(outfile, await buildBundle());
	console.log(`wrote ${outfile}`);
}
