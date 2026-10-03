// The host runs `node app/server.mjs`, never `src/`, so compare the committed
// bundle with the source rebuilt in memory by the production builder.
// Dependency versions are lockfile-pinned, but only the authored tail (starting
// at the first `// src/` comment) and banner are compared byte for byte here.
// The full committed bundle must also already be in portable canonical form.
// `app/dist/` is built separately and is not part of this assertion.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const VIEWER = join(import.meta.dir, "..");
const COMMITTED = join(VIEWER, "app", "server.mjs");
/** Where the compared tail starts: esbuild writes one `// <path>` comment per inlined module, and the viewer's own modules live under `src/`. */
const PACK_MARKER = "\n// src/";
const CANONICAL_PREFIX = "../../../../node_modules/";

/** The compared part of `bundle`: its banner line and authored tail. */
function packAuthored(bundle: string, label: string): string {
	const text = bundle.replaceAll("\r\n", "\n");
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

async function builder(): Promise<{ buildServerBundle: () => Promise<string>; normalizeServerBundle: (text: string) => string }> {
	const built: unknown = await import(pathToFileURL(join(VIEWER, "scripts", "build.mjs")).href);
	if (typeof built !== "object" || built === null || !("buildServerBundle" in built) || typeof built.buildServerBundle !== "function" ||
		!("normalizeServerBundle" in built) || typeof built.normalizeServerBundle !== "function") {
		throw new Error("scripts/build.mjs must export buildServerBundle() and normalizeServerBundle()");
	}
	return built as { buildServerBundle: () => Promise<string>; normalizeServerBundle: (text: string) => string };
}

async function rebuild(): Promise<string> {
	return (await builder()).buildServerBundle();
}

describe("the committed server bundle", () => {
	test("app/server.mjs carries exactly the pack code that src/ builds to", async () => {
		const rebuilt = packAuthored(await rebuild(), "the rebuilt bundle");
		const committed = packAuthored(await readFile(COMMITTED, "utf8"), "app/server.mjs");
		expect(
			firstDifference(committed, rebuilt),
			"app/server.mjs is stale: the host runs it, not src/. Run `bun viewer/scripts/build.mjs` in marketplace/packs/swiss-knife and commit viewer/app/server.mjs",
		).toBeUndefined();
	}, 60_000);

	test("committed dependency labels are portable, without rewriting executable strings", async () => {
		const committed = await readFile(COMMITTED, "utf8");
		const { normalizeServerBundle } = await builder();
		expect(normalizeServerBundle(committed), "app/server.mjs contains non-canonical generated dependency labels").toBe(committed);
		expect(committed).toContain(`// ${CANONICAL_PREFIX}`);
	});

	test("Windows donor paths and relative installs produce identical metadata without changing program literals", async () => {
		const { normalizeServerBundle } = await builder();
		const suffix = "zod/lib/index.js";
		const relative = "../../../../../../node_modules/";
		const absolute = "C:/Users/Sameer Pallav/.inso/wt/donor/node_modules/";
		const bundle = (label: string, literal: string) => [
			`// ${label}${suffix}`,
			`  "${label}${suffix}"() {`,
			`    const runtimePath = "${literal}${suffix}";`,
			`    return runtimePath;`,
			`  }`,
			`  "${label}zod/lib/types.js"(exports) {`,
			`    return exports;`,
			`  }`,
		].join("\n");
		for (const donor of [absolute, relative]) {
			expect(normalizeServerBundle(bundle(donor, donor))).toBe(bundle(CANONICAL_PREFIX, donor));
		}
	});
});
