import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildBundle() {
	const result = await build({
		entryPoints: [resolve(root, "src/index.ts")],
		absWorkingDir: root,
		bundle: true,
		write: false,
		platform: "node",
		format: "esm",
		target: "node22",
		sourcemap: false,
		legalComments: "none",
		logLevel: "error",
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
