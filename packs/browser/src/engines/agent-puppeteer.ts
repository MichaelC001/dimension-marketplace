/**
 * The puppeteer-core a THROWAWAY AGENT browser is driven with.
 *
 * Stock puppeteer-core turns on CDP `Runtime` in every page, frame and worker
 * (a page can tell: `agent-browser.ts`), runs its own DOM reads in the page's
 * own JavaScript world (a hook a site put on `document.getElementById` sees
 * every one), and names its scripts in V8 stacks. For an agent browser that is
 * the most-probed automation tell, so it is driven with the same library with
 * `patches/puppeteer-core-25.11.0-agent.patch` applied while bundling
 * (`scripts/agent-puppeteer.mjs`): no `Runtime.enable`, DOM work in the
 * utility world, no script names.
 *
 * The View and every saved profile import the stock `puppeteer-core` and never
 * this module (`puppeteer.ts` picks by `EngineOptions.agent`), so nothing here
 * can reach a browser a person signs in to.
 *
 * The build writes `app/puppeteer-agent.mjs` next to `app/server.mjs`. Run
 * from source (tests, `bun src/stdio.ts`) there is no such file, so it is
 * bundled once into `.cache/` beside the pack (where its package imports
 * resolve) under a name that carries a hash of the patch and the builder.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type StockPuppeteer from "puppeteer-core";

export type PuppeteerModule = typeof StockPuppeteer;

/** Where the build puts it: beside the running bundle. */
const SHIPPED = fileURLToPath(new URL("./puppeteer-agent.mjs", import.meta.url));
let loading: Promise<PuppeteerModule> | undefined;

/** The patched puppeteer-core, loaded once per process. */
export function agentPuppeteer(): Promise<PuppeteerModule> {
	loading ??= load();
	return loading;
}

async function load(): Promise<PuppeteerModule> {
	const file = existsSync(SHIPPED) ? SHIPPED : await bundleFromSource();
	// Dynamic by necessity: the patched library is a build output, not a module the source tree can name.
	const bundled: { default: PuppeteerModule } = await import(pathToFileURL(file).href);
	return bundled.default;
}

/** The build step's own module (scripts/agent-puppeteer.mjs). */
interface Builder {
	PATCH_FILE: string;
	buildAgentPuppeteer(options: { outfile: string }): Promise<unknown>;
}

async function bundleFromSource(): Promise<string> {
	const pack = fileURLToPath(new URL("../../", import.meta.url));
	// A computed specifier, dynamic by necessity: the server bundle must not follow it into the build script (and esbuild).
	const builderPath = join(pack, "scripts", "agent-puppeteer.mjs");
	const builder: Builder = await import(pathToFileURL(builderPath).href);
	const hash = createHash("sha256").update(readFileSync(builder.PATCH_FILE)).update(readFileSync(builderPath)).digest("hex").slice(0, 12);
	const outfile = join(pack, ".cache", `puppeteer-agent-${hash}.mjs`);
	if (existsSync(outfile)) return outfile;
	mkdirSync(dirname(outfile), { recursive: true });
	// Written beside its final name and moved into place, so two processes starting together never import half a file.
	const partial = `${outfile}.${process.pid}.tmp`;
	await builder.buildAgentPuppeteer({ outfile: partial });
	renameSync(partial, outfile);
	return outfile;
}
