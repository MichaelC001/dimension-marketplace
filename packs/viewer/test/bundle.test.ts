// The host runs `node app/server.mjs`, never `src/`, so a fence or server change
// that was not rebuilt does not exist for the user. This pins the committed
// bundle to the source: the server is rebuilt in memory by `buildServerBundle()`
// (the very function `scripts/build.mjs` writes the file with) and the
// tail of it (see below), and its first line, must equal the committed file byte for byte.
//
// What is and is not pinned:
//   - Pinned: everything from the first `// src/` comment to the end of the file.
//     That is the fence, the path rules, the chunk reader, the server and the stdio
//     entry, plus the one SDK constant the fence imports: the code that decides
//     what the viewer opens. esbuild emits that first comment where `src/server.ts`
//     hoists its imports, so the tail also carries the third-party modules it
//     places after them (zod, the MCP server); a dependency bump not rebuilt fails
//     here too. The first line is the `require` shim banner the build sets.
//   - NOT pinned: the third-party code above that comment (the rest of the MCP
//     SDK, zod, ext-apps; most of the file). Its bytes belong to the installed
//     dependency versions, which the lockfile pins. Its module comments and
//     module-map keys spell the path to `node_modules`, and that spelling depends
//     on where the dependencies are installed (a worktree resolves them into
//     another checkout), so on BOTH sides any such prefix is rewritten to one
//     canonical spelling before comparing. The second test holds the COMMITTED
//     file to that spelling, so a bundle built in an overlay cannot be committed
//     unnoticed.
//   - NOT pinned: `app/dist/`, the View. Vite names its chunks by content hash.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PACK = join(import.meta.dir, "..");
const COMMITTED = join(PACK, "app", "server.mjs");
/** Where the compared tail starts: esbuild writes one `// <path>` comment per inlined module, and the pack's own modules live under `src/`. */
const PACK_MARKER = "\n// src/";
/** How a bundle spells the way to `node_modules`: any number of `../`, then optionally the directories of an install elsewhere, then `node_modules/`. */
const DEPENDENCY_PREFIX = /(?:\.\.\/)+(?:[^/\s"']+\/)*?node_modules\//g;
const CANONICAL_PREFIX = "../../../node_modules/";

/** The compared part of `bundle`: its banner line and its tail, with the install layout and the line endings taken out. */
function packAuthored(bundle: string, label: string): string {
	const text = bundle.replaceAll("\r\n", "\n").replace(DEPENDENCY_PREFIX, CANONICAL_PREFIX);
	const at = text.indexOf(PACK_MARKER);
	if (at < 0) throw new Error(`${label} has no "// src/" module comment, so the pack's own code cannot be found in it`);
	return `${text.slice(0, text.indexOf("\n"))}${text.slice(at)}`;
}

/** "line N" (of the compared text) plus both lines, for the first line where the two differ, or `undefined` when they are equal. */
function firstDifference(committed: string, rebuilt: string): string | undefined {
	if (committed === rebuilt) return undefined;
	const left = committed.split("\n");
	const right = rebuilt.split("\n");
	for (let line = 0; line < Math.max(left.length, right.length); line++) {
		if (left[line] !== right[line]) {
			return `line ${line + 1} of the compared text\n  committed: ${left[line] ?? "(end of file)"}\n  rebuilt:   ${right[line] ?? "(end of file)"}`;
		}
	}
	return "the texts differ";
}

async function rebuild(): Promise<string> {
	// The build script is plain untyped JS outside the TypeScript project; load it by path.
	const built: unknown = await import(pathToFileURL(join(PACK, "scripts", "build.mjs")).href);
	if (typeof built !== "object" || built === null || !("buildServerBundle" in built) || typeof built.buildServerBundle !== "function") {
		throw new Error("scripts/build.mjs does not export buildServerBundle()");
	}
	const text: unknown = await built.buildServerBundle();
	if (typeof text !== "string") throw new Error("buildServerBundle() did not return the bundle text");
	return text;
}

describe("the committed server bundle", () => {
	test("app/server.mjs carries exactly the pack code that src/ builds to", async () => {
		const rebuilt = packAuthored(await rebuild(), "the rebuilt bundle");
		const committed = packAuthored(await readFile(COMMITTED, "utf8"), "app/server.mjs");
		expect(
			firstDifference(committed, rebuilt),
			"app/server.mjs is stale: the host runs it, not src/. Run `bun scripts/build.mjs` in marketplace/packs/viewer (in a canonical install, or restore the `../../../node_modules/` comment prefix) and commit app/server.mjs",
		).toBeUndefined();
	}, 60_000);

	test("every dependency path in it is the canonical one, not the layout of whoever built it", async () => {
		const committed = (await readFile(COMMITTED, "utf8")).replaceAll("\r\n", "\n");
		const odd = [...new Set(committed.match(DEPENDENCY_PREFIX) ?? [])].filter(prefix => prefix !== CANONICAL_PREFIX);
		expect(odd, `app/server.mjs was built in a non-canonical install; rewrite these prefixes to ${CANONICAL_PREFIX}`).toEqual([]);
		// And the canonical one really is in use: a file with no dependency paths at all would pass the check above for free.
		expect(committed).toContain(`// ${CANONICAL_PREFIX}`);
	});
});
