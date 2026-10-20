import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GRANTED_SPECIFIERS = ["react", "react-dom", "react/jsx-runtime", "@fraym/ui"];
const GRANTED_UI_NAMES_AT_FLOOR = ["Button", "Input"];

function importsOf(source: string): Map<string, Set<string>> {
	const byModule = new Map<string, Set<string>>();
	for (const match of source.matchAll(/import\s*(?:\{([^}]*)\}|([\w$*\s]+))?\s*from\s*["']([^"']+)["']/g)) {
		const names = byModule.get(match[3]) ?? new Set<string>();
		for (const raw of (match[1] ?? "").split(",")) {
			const name = raw.trim().split(/\s+as\s+/)[0];
			if (name !== "") names.add(name);
		}
		byModule.set(match[3], names);
	}
	return byModule;
}

describe("the committed dock bundle only asks the host for what the host grants at the pack's floor", () => {
	const bundle = readFileSync(resolve(import.meta.dir, "../dist/index.mjs"), "utf8");
	const imports = importsOf(bundle);

	test("every module it imports is one the host's loader resolves", () => {
		expect([...imports.keys()].filter(specifier => !GRANTED_SPECIFIERS.includes(specifier))).toEqual([]);
	});

	test("every name it takes from @fraym/ui was granted by the oldest host the pack declares it runs on", () => {
		const taken = [...(imports.get("@fraym/ui") ?? [])];
		expect(taken.filter(name => !GRANTED_UI_NAMES_AT_FLOOR.includes(name))).toEqual([]);
	});

	test("the parser reads multi-line, aliased and default imports the way the bundler emits them", () => {
		const parsed = importsOf(
			'import { Button as B, Select } from "@fraym/ui";\nimport {\n\tuseMemo,\n\tuseState\n} from "react";\nimport React from "react-dom";\n',
		);
		expect([...(parsed.get("@fraym/ui") ?? [])]).toEqual(["Button", "Select"]);
		expect([...(parsed.get("react") ?? [])]).toEqual(["useMemo", "useState"]);
		expect([...parsed.keys()]).toEqual(["@fraym/ui", "react", "react-dom"]);
	});
});
