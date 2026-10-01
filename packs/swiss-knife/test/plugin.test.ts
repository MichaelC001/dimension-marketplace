import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// What the plugin is made of: a tool, an MCP App and two rules in one folder. Each part lives
// at a different depth and ships from a different place, so a file moved, a `files` entry
// dropped or a manifest that stops agreeing with its package is the way this plugin breaks.
const PLUGIN = join(import.meta.dir, "..");

async function readJson(name: string): Promise<unknown> {
	return JSON.parse(await readFile(join(PLUGIN, name), "utf8"));
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) throw new Error(`expected a list of strings, got ${JSON.stringify(value)}`);
	return value;
}

/** Whether npm's `files` list, which names files and folders, takes `path` into the package. */
function shipped(files: readonly string[], path: string): boolean {
	return files.some(entry => path === entry || path.startsWith(`${entry.replace(/\/$/, "")}/`));
}

describe("the plugin's two manifests", () => {
	test("plugin.json and package.json carry the same version: the host caches an install by it", async () => {
		expect(field(await readJson("plugin.json"), "version")).toBe(field(await readJson("package.json"), "version"));
	});

	test("the app floor is at least 0.10.24, the first engine that honours the rules' `except:` field", async () => {
		const requires = field(field(field(await readJson("plugin.json"), "extensions"), "ai.insodimension.dimension"), "requires");
		const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(String(field(requires, "dimension")));
		if (floor === null) throw new Error(`requires.dimension is not a >=X.Y.Z floor: ${JSON.stringify(requires)}`);
		const got = floor.slice(1).map(Number);
		const want = [0, 10, 24];
		const firstDifference = got.findIndex((part, index) => part !== want[index]);
		const atLeast = firstDifference === -1 || (got[firstDifference] ?? 0) > (want[firstDifference] ?? 0);
		expect(atLeast, `requires.dimension is >=${got.join(".")}, below 0.10.24: an older engine files the rules as resident prompt rules`).toBe(true);
	});
});

describe("what the package ships", () => {
	test("every file the plugin runs or the host reads is in `files`", async () => {
		const pkg = await readJson("package.json");
		const files = strings(field(pkg, "files"));
		const mcp = await readJson("ai.insodimension.dimension/mcp.json");
		const scripts = Object.values(Object(field(mcp, "mcpServers"))).flatMap(server => strings(field(server, "args")));
		const rules = (await readdir(join(PLUGIN, "rules"))).map(file => `rules/${file}`);
		expect(rules.length, "the plugin has rules to ship").toBeGreaterThan(0);

		const runtime = [
			"README.md",
			"plugin.json",
			"ai.insodimension.dimension/mcp.json",
			...strings(field(field(pkg, "dimension"), "extensions")),
			...scripts,
			"viewer/app/dist/index.html",
			...rules,
		];
		for (const path of runtime) {
			const found = await stat(join(PLUGIN, path)).then(
				info => info.isFile(),
				() => false,
			);
			expect(found, `${path} is a file of the plugin`).toBe(true);
			expect(shipped(files, path), `${path} is not in package.json files, so an install would not have it`).toBe(true);
		}
	});

	test("the sources and tests of the parts are not shipped: the bundles are what runs", async () => {
		const files = strings(field(await readJson("package.json"), "files"));
		for (const path of ["src/present.ts", "test/plugin.test.ts", "scripts/build.mjs", "viewer/src/server.ts", "viewer/test/manifest.test.ts", "viewer/app/view/main.tsx"]) {
			expect(shipped(files, path), `${path} would ship`).toBe(false);
		}
	});
});
