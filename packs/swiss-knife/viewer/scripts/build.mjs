// Builds the two artifacts the viewer ships, both committed (a plugin installs with
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

/** The viewer's own folder: `swiss-knife/viewer/`, one level below the plugin root. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "..");

/**
 * esbuild labels inlined modules with source-path comments and uses the same
 * paths as keys in its CommonJS/ESM module map. A dependency can resolve from
 * a relative install or an absolute donor checkout (including another drive).
 * Match those generated locations only, never path-looking program strings.
 */
const DEPENDENCY_PATH = /(?:(?:[A-Za-z]:)?\/|(?:\.\.\/)+)(?:[^/\r\n"']+\/)*?node_modules\/([^\r\n"']+)/;
const MODULE_COMMENT = /^(\/\/ )(.+)$/gm;
const MODULE_KEY = /^([ \t]*")([^"\r\n]+)("\([^)\r\n]*\) \{)$/gm;

/**
 * The one spelling the committed bundle carries: this folder's distance to the
 * repository root's `node_modules`, `marketplace/packs/swiss-knife/viewer/` being four
 * levels down. Whatever install built the bundle, the bytes are the same.
 */
const CANONICAL_DEPENDENCY_PREFIX = "../../../../node_modules/";

/** Normalize only esbuild's source labels and module-map keys, not bundled program strings. */
export function normalizeServerBundle(text) {
	const canonicalize = (path) => path.replace(DEPENDENCY_PATH, (_, suffix) => `${CANONICAL_DEPENDENCY_PREFIX}${suffix}`);
	return text
		.replace(MODULE_COMMENT, (line, marker, path) => `${marker}${canonicalize(path)}`)
		.replace(MODULE_KEY, (line, before, path, after) => `${before}${canonicalize(path)}${after}`);
}

/** The server bundle text, built from `src/stdio.ts`. Same source, same bytes, from any install. */
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
	return normalizeServerBundle(output.text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { validateArtifactoryDecl } = await import("@dimension/sdk/artifactory");
	const { build: buildView } = await import("vite");
	// Agent Plugins 1.0.0 layout: the plugin id is the portable `name`; the Dimension
	// declaration lives under the `ai.insodimension.dimension` extension. The manifest
	// is the plugin's, one folder up: this viewer is one of several things it ships.
	const manifest = JSON.parse(await readFile(resolve(pluginRoot, "plugin.json"), "utf8"));
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
