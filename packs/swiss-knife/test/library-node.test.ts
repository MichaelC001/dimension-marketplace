import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { makeTempDir, removeTree } from "./fixtures";

const PACK = join(import.meta.dir, "..");
const runFile = promisify(execFile);

const nodeHasSqlite = spawnSync("node", ["-e", 'require("node:sqlite")'], { stdio: "ignore" }).status === 0;

const SCENARIO = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLibrary } from ${JSON.stringify(join(PACK, "src", "library", "library.ts"))};

const root = process.argv[2];
const files = join(root, "files");
await mkdir(files, { recursive: true });
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
await writeFile(join(files, "16-locomotion-slice.mp4"), mp4);
await writeFile(join(files, "notes.txt"), "notes");
await writeFile(join(files, "Notes Two.txt"), "two");
const library = await createLibrary({ home: join(root, "home"), revokeRemote: async () => undefined, trash: async () => undefined });
const names = page => page.items.map(item => item.name);
for (const name of ["16-locomotion-slice.mp4", "notes.txt", "Notes Two.txt"]) {
	await library.stamp({ path: join(files, name), source: "present", workspace: root });
}
const paged = [];
let cursor;
do {
	const page = library.query({ sort: "name", limit: 1, ...(cursor ? { cursor } : {}) });
	paged.push(...names(page));
	cursor = page.next;
} while (cursor);
const slice = library.query({ q: "locom" }).items[0];
const discarded = await library.discard(slice.id, { trash: false });
const afterDiscard = library.query({ q: "locom" }).total;
library.restore(slice.id);
library.update(slice.id, { title: "Hero cut", tags: ["demo"] });
const result = {
	runtime: typeof Bun === "undefined" ? "node" : "bun",
	substring: names(library.query({ q: "LOCOMOTION" })),
	prefix: names(library.query({ q: "no", sort: "name" })),
	relevance: library.query({ q: "notes", sort: "relevance" }).total,
	paged,
	facets: library.facets({}).kinds,
	discarded: discarded.item.state,
	afterDiscard,
	restored: library.query({ q: "hero" }).total,
	lent: library.isLent(join(files, "notes.txt")),
};
library.close();
console.log(JSON.stringify(result));
`;

let root: string;
let bundle: string;

beforeAll(async () => {
	root = await makeTempDir();
	await mkdir(join(root, "bundle"), { recursive: true });
	const entry = join(root, "bundle", "scenario.ts");
	bundle = join(root, "bundle", "scenario.mjs");
	await writeFile(entry, SCENARIO);
	await build({
		entryPoints: [entry],
		outfile: bundle,
		absWorkingDir: PACK,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		tsconfigRaw: "{}",
		logLevel: "error",
		external: ["bun:sqlite", "node:sqlite"],
	});
});

afterAll(() => removeTree(root));

test.skipIf(!nodeHasSqlite)("the Viewer server's runtime, Node on node:sqlite, runs the same library: search, paging, discard, restore", async () => {
	const { stdout } = await runFile("node", [bundle, root], { cwd: PACK });
	expect(JSON.parse(stdout)).toEqual({
		runtime: "node",
		substring: ["16-locomotion-slice.mp4"],
		prefix: ["Notes Two.txt", "notes.txt"],
		relevance: 2,
		paged: ["16-locomotion-slice.mp4", "Notes Two.txt", "notes.txt"],
		facets: { video: 1, text: 2 },
		discarded: "discarded",
		afterDiscard: 0,
		restored: 1,
		lent: true,
	});
}, 60_000);
