import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type } from "arktype";
import { dimension, packRoot } from "./support/pack";

const packageSchema = type({ main: "string", files: "string[]", dimension: { extensions: "string[]" } });
const pack = packageSchema.assert(await Bun.file(join(packRoot, "package.json")).json());
const transpiler = new Bun.Transpiler({ loader: "ts" });

const shippedAs = (path: string) => relative(packRoot, path).replaceAll("\\", "/");
const isListed = (path: string) =>
	pack.files.some(entry => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));

function localFile(from: string, specifier: string): string {
	const base = join(dirname(from), specifier);
	const found = [base, `${base}.ts`, join(base, "index.ts")].find(
		candidate => existsSync(candidate) && statSync(candidate).isFile(),
	);
	if (!found) throw new Error(`${shippedAs(from)} imports ${specifier}, which resolves to no file`);
	return found;
}

function importedSources(entries: readonly string[]): string[] {
	const reached = new Set<string>();
	const pending = entries.map(entry => join(packRoot, entry));
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (reached.has(file)) continue;
		reached.add(file);
		for (const found of transpiler.scanImports(readFileSync(file, "utf-8"))) {
			if (found.path.startsWith(".")) pending.push(localFile(file, found.path));
		}
	}
	return [...reached].map(shippedAs).sort();
}

test("every path package.json lists exists, and a listed directory is not empty", () => {
	const missing = pack.files.filter(entry => !existsSync(join(packRoot, entry)));
	const emptyDirectories = pack.files.filter(
		entry =>
			entry.endsWith("/") && existsSync(join(packRoot, entry)) && readdirSync(join(packRoot, entry)).length === 0,
	);

	expect(missing).toEqual([]);
	expect(emptyDirectories).toEqual([]);
});

test("every source file the extension imports at run time is listed in package.json, so an installed copy can load", () => {
	const imported = importedSources([pack.main, ...pack.dimension.extensions]);

	expect(imported).toContain("bot.ts");
	expect(imported).toContain("user.ts");
	expect(imported.filter(path => !isListed(path))).toEqual([]);
});

test("the icon and the bot Connect template plugin.json points at ship with the pack", () => {
	const referenced = [dimension.icon, ...dimension.connect.methods.flatMap(method => method.configTemplate ?? [])];

	expect(referenced.length).toBeGreaterThan(1);
	expect(referenced.filter(path => !existsSync(join(packRoot, path)))).toEqual([]);
	expect(referenced.filter(path => !isListed(path))).toEqual([]);
});
