// Lift each pack's SPACE LISTINGS into the catalog so a store can browse this
// marketplace by fetching ONE file.
//
// WHY THIS EXISTS (owner ruling 2026-08-29): a store reads the index, it does
// not clone the mall. Listing a space must never require the pack tree — at
// tens of thousands of packs that is absurd, and even at fifteen it is the
// wrong shape. `marketplace.json` is KBs at any scale, so every fact the
// browse grid needs (label, tagline, screenshots, dependency count) lives in
// the catalog entry; the pack tree is fetched only when something is actually
// installed.
//
// The catalog is a DERIVED index, never hand-authored: each pack's
// `dimension.plugin.json` `spaces[]` is the single source of truth, and this
// script projects the LISTING subset of it. `validate-marketplace.mjs --check`
// (run in CI) fails when the projection drifts from the manifests.
//
// Screenshot paths are rewritten CATALOG-ROOT-RELATIVE (`packs/x/assets/…`),
// because the origin that serves the catalog serves its images — whatever that
// origin turns out to be (raw repo host, CDN, a local path). A data-URI
// screenshot is carried through untouched.
//
// No dependencies — runs on bare node or bun, like its sibling validator.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, ".omp-plugin", "marketplace.json");

/** The listing projection of one `dimension.plugin.json` space declaration.
 *  Deliberately NOT the whole space: a listing answers "what is this and what
 *  does it look like", never "how does it mount". Field order is fixed so a
 *  no-change run is a no-diff run. */
function spaceListing(space, packSource) {
	// `packSource` is the catalog's own `./packs/<name>` — strip the leading
	// "./" and join with posix separators so the emitted path is a URL path on
	// every platform (this repo is cloned on Windows too).
	const base = packSource.replace(/^\.\//, "");
	const asCatalogPath = value =>
		typeof value === "string" && value.startsWith("data:") ? value : posix.join(base, value);

	const listing = { id: space.id, label: space.label };
	const tagline = space.preview?.tagline ?? space.description;
	if (typeof tagline === "string" && tagline.length > 0) listing.tagline = tagline;
	const screenshots = space.preview?.screenshots;
	if (Array.isArray(screenshots) && screenshots.length > 0) {
		listing.screenshots = screenshots.map(asCatalogPath);
	}
	if (typeof space.icon === "string" && space.icon.length > 0) listing.icon = space.icon;
	if (typeof space.mark?.accent === "string") listing.accent = space.mark.accent;
	// The dependency closure the install plan will walk. Carried in the index so
	// a card can say "installs 7 components" BEFORE anything is fetched.
	const requires = space.requires?.plugins;
	if (Array.isArray(requires) && requires.length > 0) listing.requires = [...requires];
	return listing;
}

/** Every space listing a pack contributes, or undefined when it contributes none. */
function listingsFor(plugin) {
	if (typeof plugin.source !== "string") return undefined; // typed sources carry no local tree here
	const manifestPath = join(root, plugin.source, "dimension.plugin.json");
	if (!existsSync(manifestPath)) return undefined;
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return undefined; // the validator is what reports an unparseable manifest
	}
	if (!Array.isArray(manifest.spaces) || manifest.spaces.length === 0) return undefined;
	const listings = manifest.spaces
		.filter(space => typeof space?.id === "string" && typeof space?.label === "string")
		.map(space => spaceListing(space, plugin.source));
	return listings.length > 0 ? listings : undefined;
}

/** The catalog as it SHOULD be, given the pack manifests on disk. Pure: takes
 *  the parsed catalog, returns a new one — so `--check` can diff without
 *  writing anything. */
export function projectedCatalog(catalog) {
	return {
		...catalog,
		plugins: catalog.plugins.map(plugin => {
			const spaces = listingsFor(plugin);
			// Rebuilt without the old key so a pack that STOPS declaring spaces
			// drops its stale listing instead of keeping it forever.
			const { spaces: _previous, ...rest } = plugin;
			return spaces ? { ...rest, spaces } : rest;
		}),
	};
}

function serialize(catalog) {
	return `${JSON.stringify(catalog, null, "\t")}\n`;
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const next = serialize(projectedCatalog(catalog));
const current = readFileSync(catalogPath, "utf8");

if (process.argv.includes("--check")) {
	if (next !== current) {
		console.error(
			"marketplace.json: space listings are STALE — a pack manifest changed without the catalog being synced.\n" +
				"  Run `node scripts/sync-catalog.mjs` and commit the result.",
		);
		process.exit(1);
	}
	console.log("marketplace.json: space listings in sync");
} else {
	if (next === current) {
		console.log("marketplace.json: space listings already in sync - no change");
	} else {
		writeFileSync(catalogPath, next);
		const count = projectedCatalog(catalog).plugins.filter(plugin => plugin.spaces).length;
		console.log(`marketplace.json: synced space listings for ${count} pack(s)`);
	}
}
