// puppeteer-core for a throwaway agent browser: the stock library with `patches/puppeteer-core-25.11.0-agent.patch`
// applied while it is bundled. Nothing is installed or edited in node_modules; the View and every saved profile keep
// importing the stock `puppeteer-core` (see src/engines/agent-puppeteer.ts for how the two are told apart).
//
// The patch is derived from oh-my-pi's (MIT; its notice is in the patch file). It is applied by exact context, one
// match per hunk: a puppeteer upgrade that moves a hunk fails the build, never ships half a patch.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PATCH_FILE = resolve(here, "../patches/puppeteer-core-25.11.0-agent.patch");
/** The one puppeteer-core the patch was made against. */
export const PATCHED_VERSION = "25.11.0";

/**
 * The files of a unified diff and, per file, its hunks as {search, replace}: `search` is the hunk's context and removed
 * lines, `replace` its context and added lines. Text before the first `diff --git` is the patch's own notes.
 * @returns {Map<string, Array<{ search: string, replace: string, line: number }>>} by path inside the package (`lib/puppeteer/...`)
 */
export function parsePatch(text) {
	const files = new Map();
	let hunks;
	let hunk;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const close = () => {
		if (hunk) hunks.push({ search: hunk.search.join("\n"), replace: hunk.replace.join("\n"), line: hunk.line });
		hunk = undefined;
	};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.startsWith("diff --git ")) {
			close();
			const path = /^diff --git a\/(\S+) b\//.exec(line)?.[1];
			if (!path) throw new Error(`patch line ${i + 1}: cannot read a path from "${line}"`);
			hunks = [];
			files.set(path, hunks);
		} else if (line.startsWith("@@")) {
			close();
			hunk = { search: [], replace: [], line: i + 1 };
		} else if (hunk && line.startsWith("\\")) {
			continue; // "\ No newline at end of file"
		} else if (hunk && (line.startsWith(" ") || line === "")) {
			// A blank context line may have lost its leading space; the file's last line break leaves one trailing "".
			if (line === "" && i === lines.length - 1) continue;
			hunk.search.push(line.slice(1));
			hunk.replace.push(line.slice(1));
		} else if (hunk && line.startsWith("-")) {
			hunk.search.push(line.slice(1));
		} else if (hunk && line.startsWith("+")) {
			hunk.replace.push(line.slice(1));
		} else if (hunk) {
			throw new Error(`patch line ${i + 1}: unexpected "${line.slice(0, 40)}" inside a hunk`);
		}
	}
	close();
	return files;
}

/** `source` with every hunk applied; each must match exactly once. */
export function applyHunks(path, source, hunks) {
	let out = source.replace(/\r\n/g, "\n");
	for (const { search, replace, line } of hunks) {
		const first = out.indexOf(search);
		if (first < 0) throw new Error(`${path}: the hunk at patch line ${line} no longer matches puppeteer-core ${PATCHED_VERSION}; re-base patches/puppeteer-core-25.11.0-agent.patch`);
		if (out.indexOf(search, first + 1) >= 0) throw new Error(`${path}: the hunk at patch line ${line} matches more than once`);
		out = out.slice(0, first) + replace + out.slice(first + search.length);
	}
	return out;
}

/** The pinned puppeteer-core as this pack resolves it: its entry file, and its package root. */
function locatePuppeteer() {
	const require = createRequire(import.meta.url);
	const entry = require.resolve("puppeteer-core");
	const root = dirname(require.resolve("puppeteer-core/package.json"));
	const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	if (version !== PATCHED_VERSION) throw new Error(`puppeteer-core ${version} is installed; the agent patch is for ${PATCHED_VERSION}. Re-base patches/puppeteer-core-25.11.0-agent.patch first.`);
	return { entry, root: root.replace(/\\/g, "/") };
}

/**
 * Bundle the patched puppeteer-core to `outfile` (ESM). Its own files are inlined; every other package it imports (ws,
 * debug, chromium-bidi, ...) stays an import, resolved beside the file as the stock library's are.
 */
export async function buildAgentPuppeteer({ outfile }) {
	const { build } = await import("esbuild");
	const { entry, root } = locatePuppeteer();
	const patch = parsePatch(readFileSync(PATCH_FILE, "utf8"));
	const applied = new Set();
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		packages: "external",
		sourcemap: false,
		logLevel: "error",
		plugins: [
			{
				name: "agent-puppeteer-patch",
				setup(host) {
					host.onLoad({ filter: /puppeteer-core[\\/]lib[\\/]puppeteer[\\/].*\.js$/ }, (args) => {
						const path = args.path.replace(/\\/g, "/");
						const inside = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
						const hunks = inside === undefined ? undefined : patch.get(inside);
						if (!hunks) return undefined;
						applied.add(inside);
						return { contents: applyHunks(inside, readFileSync(args.path, "utf8"), hunks), loader: "js", resolveDir: dirname(args.path) };
					});
				},
			},
		],
	});
	const missed = [...patch.keys()].filter((path) => !applied.has(path));
	if (missed.length > 0) throw new Error(`the bundle never loaded ${missed.join(", ")}, which the agent patch changes`);
	return { files: [...applied].sort() };
}
