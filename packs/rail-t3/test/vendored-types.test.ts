/**
 * GATE: this pack must be AUTHORABLE with no monorepo on the resolution path.
 *
 * `tsconfig.typecheck.json` already maps `@fraym/ui` at the vendored
 * declarations, but it runs INSIDE the monorepo: `../../../node_modules`
 * carries `@fraym/*`, so a leaked workspace import would still resolve and the
 * check would stay green while the claim in `types/README.md` was false.
 *
 * So this test rebuilds the pack somewhere the monorepo cannot be reached —
 * `src/` + `types/` + a generated tsconfig under the OS temp dir, with the
 * React `@types` paths rewritten absolute because React is the one dependency
 * a pack genuinely has — and typechecks it there. `skipLibCheck` is OFF on
 * purpose: skipping lib checks is exactly what would hide an unresolvable
 * import inside the vendored declarations, which is the failure this gate
 * exists to catch.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACK_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PACK_ROOT, "..", "..", "..");
const TSC = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

/** React's `@types` entries from the pack's real authoring config, rewritten to
 *  absolute paths so they still resolve from a directory outside the repo. */
function reactPaths(): Record<string, string[]> {
	const raw = readFileSync(join(PACK_ROOT, "tsconfig.typecheck.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
	const parsed = JSON.parse(raw) as { compilerOptions: { paths: Record<string, string[]> } };
	const absolute: Record<string, string[]> = {};
	for (const [specifier, targets] of Object.entries(parsed.compilerOptions.paths)) {
		if (!/^react(-dom)?(\/|$)/.test(specifier)) continue;
		absolute[specifier] = targets.map(target => resolve(PACK_ROOT, target));
	}
	return absolute;
}

const scaffold = mkdtempSync(join(tmpdir(), "rail-t3-standalone-"));
cpSync(join(PACK_ROOT, "src"), join(scaffold, "src"), { recursive: true });
cpSync(join(PACK_ROOT, "types"), join(scaffold, "types"), { recursive: true });
writeFileSync(
	join(scaffold, "tsconfig.json"),
	JSON.stringify(
		{
			compilerOptions: {
				target: "ES2024",
				module: "ESNext",
				moduleResolution: "Bundler",
				moduleDetection: "force",
				strict: true,
				noUncheckedIndexedAccess: true,
				verbatimModuleSyntax: true,
				isolatedModules: true,
				esModuleInterop: true,
				noEmit: true,
				jsx: "react-jsx",
				lib: ["ES2024", "DOM", "DOM.Iterable"],
				// An unresolvable import inside the vendored declarations is the
				// regression this gate is for; skipping lib checks would hide it.
				skipLibCheck: false,
				// Nothing is auto-discovered out here, but pin it so the result
				// cannot depend on an ambient `@types` install.
				types: [],
				paths: { "@fraym/ui": ["./types/fraym-ui.d.ts"], ...reactPaths() },
			},
			include: ["src"],
		},
		null,
		"\t",
	),
	"utf8",
);

afterAll(() => rmSync(scaffold, { recursive: true, force: true }));

describe("the pack, rebuilt outside the monorepo", () => {
	test("has no @fraym package anywhere on its resolution path", () => {
		const reachable: string[] = [];
		for (let dir = scaffold; ; dir = dirname(dir)) {
			const candidate = join(dir, "node_modules", "@fraym");
			if (existsSync(candidate)) reachable.push(candidate);
			if (dirname(dir) === dir) break;
		}
		expect(reachable).toEqual([]);
	});

	test(
		"typechecks against the vendored declarations alone",
		() => {
			const tsc = Bun.spawnSync(["bun", TSC, "-p", "tsconfig.json"], { cwd: scaffold });
			const output = (tsc.stdout.toString() + tsc.stderr.toString()).trim();
			expect({ code: tsc.exitCode, output }).toEqual({ code: 0, output: "" });
		},
		120_000,
	);
});
