// Builds the two artifacts the pack ships, both committed (a pack installs with
// no build step): `app/server.mjs` (the MCP server, fully bundled so an installed
// copy needs no node_modules) and `app/dist/` (the View, chunked by the kit's
// `defineAppViteConfig`).
//
// `buildServerBundle` is exported so `test/bundle.test.ts` rebuilds the server
// from the SAME options the build uses and proves the committed file is what the
// source produces. Importing this module builds nothing: the build runs only when
// the file is the entry point.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildServer } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The server bundle text, built from `src/stdio.ts`. Same source, same bytes. */
export async function buildServerBundle() {
	const result = await buildServer({
		entryPoints: [resolve(root, "src/stdio.ts")],
		// The bundle carries a comment per inlined module, relative to this directory:
		// pinned, so a rebuild from any cwd is the same bytes.
		absWorkingDir: root,
		write: false,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		sourcemap: false,
		// The SDK's tsconfig chain names an ES target esbuild does not know, and esbuild
		// warns on every build; the bundle's own target is set above.
		tsconfigRaw: "{}",
		// A bundled CommonJS dependency may `require` a Node built-in; ESM has no `require`.
		banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
	});
	const [output] = result.outputFiles;
	if (!output) throw new Error("esbuild produced no output for src/stdio.ts");
	return output.text;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { validateArtifactoryDecl } = await import("@dimension/sdk/artifactory");
	const { build: buildView } = await import("vite");
	// Agent Plugins 1.0.0 layout: the pack id is the portable `name`; the Dimension
	// declaration lives under the `ai.insodimension.dimension` extension.
	const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
	const declared = manifest.extensions?.["ai.insodimension.dimension"]?.artifactories;
	if (!Array.isArray(declared) || declared.length === 0) throw new Error("plugin.json declares no artifactories");
	for (const declaration of declared) {
		const issues = validateArtifactoryDecl({ ...declaration, plugin: manifest.name, type: "artifactory" });
		if (issues.length) throw new Error(issues.map(issue => issue.message).join("\n"));
	}

	await mkdir(resolve(root, "app"), { recursive: true });
	await writeFile(resolve(root, "app/server.mjs"), await buildServerBundle());
	await buildView({ configFile: resolve(root, "app/vite.config.ts") });
}
