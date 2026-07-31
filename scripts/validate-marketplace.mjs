// Standalone catalog validator - no dependencies, runs on bare node/bun.
// The monorepo runs each pack's tests; THIS repo's CI can only see itself,
// so it validates what is checkable standalone: the catalog and pack layout.
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, ".omp-plugin", "marketplace.json");
const errors = [];

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

if (typeof catalog.name !== "string" || !/^[a-z0-9-]+$/.test(catalog.name)) {
	errors.push("catalog.name must be a kebab-case string");
}
if (typeof catalog.owner?.name !== "string" || catalog.owner.name.length === 0) {
	errors.push("catalog.owner.name is required");
}
if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
	errors.push("catalog.plugins must be a non-empty array");
}

const seen = new Set();
for (const plugin of catalog.plugins ?? []) {
	const label = plugin?.name ?? "<unnamed>";
	if (typeof plugin.name !== "string" || !/^[a-z0-9-]+$/.test(plugin.name)) {
		errors.push(`plugin "${label}": name must be kebab-case`);
	}
	if (seen.has(plugin.name)) errors.push(`plugin "${label}": duplicate name`);
	seen.add(plugin.name);
	if (typeof plugin.source === "string") {
		if (!plugin.source.startsWith("./")) {
			errors.push(`plugin "${label}": relative source must start with ./`);
		} else {
			const packDir = join(root, plugin.source);
			if (!existsSync(packDir) || !statSync(packDir).isDirectory()) {
				errors.push(`plugin "${label}": source directory ${plugin.source} does not exist`);
			} else if (!existsSync(join(packDir, "package.json"))) {
				errors.push(`plugin "${label}": ${plugin.source}/package.json is missing`);
			}
		}
	} else if (typeof plugin.source !== "object" || plugin.source === null) {
		errors.push(`plugin "${label}": source must be a relative path or a source object`);
	}
	if (typeof plugin.description !== "string" || plugin.description.length < 10) {
		errors.push(`plugin "${label}": a real description is required`);
	}
	if (typeof plugin.license !== "string" || plugin.license.length === 0) {
		errors.push(`plugin "${label}": license is required`);
	}
}

if (errors.length > 0) {
	console.error(`marketplace.json: ${errors.length} problem(s)`);
	for (const error of errors) console.error(`  - ${error}`);
	process.exit(1);
}
console.log(`marketplace.json OK - ${catalog.plugins.length} pack(s) validated`);
