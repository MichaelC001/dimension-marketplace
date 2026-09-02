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
// script projects the LISTING subset of it. This script's own `--check` mode
// (run in CI) fails when the projection drifts from the manifests.
//
// Screenshot paths are rewritten CATALOG-ROOT-RELATIVE (`packs/x/assets/…`),
// because the origin that serves the catalog serves its images — whatever that
// origin turns out to be (raw repo host, CDN, a local path). A data-URI
// screenshot is carried through untouched.
//
// The catalog is written TWICE: to `.dimension-plugin/marketplace.json` (the
// namespace this shelf publishes under since 2026-09) and, byte-identical, to
// the pre-rename `.omp-plugin/marketplace.json`. Every Dimension built before
// oh-my-pi #158 looks only at the second path, so dropping it now would make
// this shelf disappear for every already-installed client. `--check` covers
// BOTH files, so the copy can never silently rot. Delete the copy (and this
// paragraph) when the `omp` read fallback is dropped — CHANGELOG `[Unreleased]`.
//
// No dependencies — runs on bare node or bun, like its sibling validator.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, ".dimension-plugin", "marketplace.json");
/** One-release compatibility copy for clients that only know `.omp-plugin`. */
const legacyCatalogPath = join(root, ".omp-plugin", "marketplace.json");

/** The listing projection of one `dimension.plugin.json` space declaration.
 *  Deliberately NOT the whole space: a listing answers "what is this and what
 *  does it look like", never "how does it mount". Field order is fixed so a
 *  no-change run is a no-diff run. */
function spaceListing(space, packSource) {
	// `packSource` is the catalog's own `./packs/<name>` — strip the leading
	// "./" and join with posix separators so the emitted path is a URL path on
	// every platform (this repo is cloned on Windows too).
	const base = packSource.replace(/^\.\//, "");
	// A screenshot is a data-URI or a PACK-RELATIVE path, and nothing else (the
	// engine's own contract, `space-contributions.ts` `parsePreview`). Anything
	// else is refused BY NAME here rather than silently mangled: an absolute URL
	// used to project to `packs/x/https:/cdn…/a.png`, and a non-string threw a
	// bare TypeError out of `posix.join` naming neither the pack nor the space.
	const asCatalogPath = value => {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`${space.id}: a preview screenshot must be a non-empty string, got ${typeof value}`);
		}
		if (value.startsWith("data:")) return value;
		if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || value.startsWith("/")) {
			throw new Error(`${space.id}: preview screenshot "${value}" must be pack-relative, not an absolute URL or path`);
		}
		const catalogPath = posix.join(base, value);
		// The gate CI actually needs: a manifest edit must not be able to leave the
		// store pointing at an image that is not there. `--check` compares text, so
		// without this a deleted screenshot ships green and the card paints a broken
		// tile (proven in review by deleting start.webp — both scripts exited 0).
		if (!existsSync(join(root, catalogPath))) {
			throw new Error(`${space.id}: preview screenshot "${catalogPath}" does not exist`);
		}
		return catalogPath;
	};

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

/** The pack's manifest on disk, or undefined when this entry has no local tree
 *  (a typed/remote source) or the file is unreadable — the validator is what
 *  reports an unparseable manifest, not this projector. */
function manifestOf(plugin) {
	if (typeof plugin.source !== "string") return undefined;
	const manifestPath = join(root, plugin.source, "dimension.plugin.json");
	if (!existsSync(manifestPath)) return undefined;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return undefined;
	}
}

/** Every space listing a pack contributes, or undefined when it contributes none. */
function listingsFor(manifest, packSource) {
	if (!Array.isArray(manifest.spaces) || manifest.spaces.length === 0) return undefined;
	const listings = manifest.spaces
		.filter(space => typeof space?.id === "string" && typeof space?.label === "string")
		.map(space => spaceListing(space, packSource));
	return listings.length > 0 ? listings : undefined;
}

/** The catalog as it SHOULD be, given the pack manifests on disk. Pure: takes
 *  the parsed catalog, returns a new one — so `--check` can diff without
 *  writing anything. */
export function projectedCatalog(catalog) {
	return {
		...catalog,
		plugins: catalog.plugins.map(plugin => {
			const manifest = manifestOf(plugin);
			// No local tree (a typed/remote source): there is nothing to project
			// FROM, so the entry's OWN listing stands. Clearing it instead deleted a
			// hand-authored remote listing on every run, and `--check` then failed CI
			// forever, because re-adding the listing is exactly what the projector
			// undid. Latent today (no remote entry in this catalog), fixed anyway.
			if (!manifest && typeof plugin.source !== "string") return plugin;
			const spaces = manifest ? listingsFor(manifest, plugin.source) : undefined;
			// A space declares its dependencies by PLUGIN ID, but the engine installs
			// by pack NAME — so an installer that cannot read the id off the index has
			// to guess that the two match. Stating it here removes the guess.
			const pluginId = typeof manifest?.plugin === "string" ? manifest.plugin : undefined;
			// Rebuilt without the old keys so a pack that STOPS declaring spaces
			// drops its stale listing instead of keeping it forever.
			const { spaces: _previousSpaces, pluginId: _previousId, ...rest } = plugin;
			return {
				...rest,
				...(pluginId ? { pluginId } : {}),
				...(spaces ? { spaces } : {}),
			};
		}),
	};
}

function serialize(catalog) {
	return `${JSON.stringify(catalog, null, "\t")}\n`;
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
// A refused projection is a CONTENT error a contributor must fix (a screenshot
// that is not there, a path that is not pack-relative), so it is reported as one
// sentence and an exit code — not a stack trace CI readers have to decode.
let next;
try {
	next = serialize(projectedCatalog(catalog));
} catch (error) {
	console.error(`marketplace.json: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
const current = readFileSync(catalogPath, "utf8");
const legacyCurrent = existsSync(legacyCatalogPath) ? readFileSync(legacyCatalogPath, "utf8") : undefined;

if (process.argv.includes("--check")) {
	if (next !== current) {
		console.error(
			"marketplace.json: space listings are STALE — a pack manifest changed without the catalog being synced.\n" +
				"  Run `node scripts/sync-catalog.mjs` and commit the result.",
		);
		process.exit(1);
	}
	// The compatibility copy is load-bearing for pre-#158 clients, so a drifted
	// or missing copy is the same failure as a stale catalog, not a warning.
	if (legacyCurrent !== next) {
		console.error(
			`.omp-plugin/marketplace.json: compatibility copy is ${legacyCurrent === undefined ? "MISSING" : "STALE"} — pre-#158 clients read only this path.\n` +
				"  Run \`node scripts/sync-catalog.mjs\` and commit the result.",
		);
		process.exit(1);
	}
	console.log("marketplace.json: space listings in sync (+ .omp-plugin compatibility copy)");
} else {
	if (next === current && legacyCurrent === next) {
		console.log("marketplace.json: space listings already in sync - no change");
	} else {
		writeFileSync(catalogPath, next);
		writeFileSync(legacyCatalogPath, next);
		const count = projectedCatalog(catalog).plugins.filter(plugin => plugin.spaces).length;
		console.log(`marketplace.json: synced space listings for ${count} pack(s) (+ .omp-plugin compatibility copy)`);
	}
}
