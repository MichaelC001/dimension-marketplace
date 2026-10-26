import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runArtifacts } from "../src/artifacts";
import { createLibrary } from "../src/library/library";
import type { Library } from "../src/library/types";
import { addWorktree, git, initRepo, loadTools, makeTempDir, removeTree, TINY_PNG, toolContext } from "./fixtures";

const PACK = join(import.meta.dir, "..");
const GIT_TIMEOUT_MS = 60_000;

let base: string;
let main: string;
let worktrees = 0;
let libraries: Library[] = [];

beforeAll(async () => {
	base = await makeTempDir();
	main = await initRepo(join(base, "inso"), { [join("assets", "shot.png")]: TINY_PNG, [join("docs", "notes.md")]: "# notes\n" });
}, GIT_TIMEOUT_MS);

afterAll(() => removeTree(base));

beforeEach(() => {
	libraries = [];
});

afterEach(() => {
	for (const library of libraries) library.close();
});

async function openLibrary(home: string): Promise<Library> {
	const library = await createLibrary({ home });
	libraries.push(library);
	return library;
}

async function newWorktree(): Promise<string> {
	worktrees += 1;
	return addWorktree(main, join(base, "wt", `inso-task-${worktrees}`));
}

describe("the Library files what a linked worktree makes under the workspace it was cut from", () => {
	test(
		"files presented from a worktree and from its main checkout are one workspace",
		async () => {
			const library = await openLibrary(join(base, "home-present"));
			const worktree = await newWorktree();
			const { tools } = await loadTools(join(PACK, "src", "index.ts"), { library: async () => library });
			const present = tools.find(tool => tool.name === "present");
			await present?.execute("t1", { path: join(worktree, "assets", "shot.png") }, undefined, undefined, toolContext(worktree));
			await present?.execute("t2", { path: join(main, "assets", "shot.png") }, undefined, undefined, toolContext(main));

			expect(library.facets({}).workspaces).toEqual([{ path: main, count: 2 }]);
			expect(library.query({ workspace: main }).total).toBe(2);
		},
		GIT_TIMEOUT_MS,
	);

	test(
		"the artifacts tool run from a worktree stamps into, and searches, the main checkout's workspace",
		async () => {
			const library = await openLibrary(join(base, "home-artifacts"));
			const worktree = await newWorktree();
			const context = { cwd: worktree, now: Date.now(), sessionId: "s1" };
			const presentedInMain = await library.stamp({ path: join(main, "assets", "shot.png"), source: "present", workspace: main });
			expect(await runArtifacts(library, { op: "search", query: "shot" }, context)).toStartWith(presentedInMain.id);

			expect(await runArtifacts(library, { op: "stamp", path: join("docs", "notes.md") }, context)).toStartWith("Added ");
			expect(library.getByPath(join(worktree, "docs", "notes.md"))?.workspace).toBe(main);
		},
		GIT_TIMEOUT_MS,
	);

	test(
		"opening a library re-homes rows stamped with a live worktree and leaves every other label alone",
		async () => {
			const home = join(base, "home-rehome");
			const live = await newWorktree();
			const gone = await newWorktree();
			const plain = join(base, "plain-workspace");
			const rows = [
				{ name: "from-live.txt", workspace: live, expected: main },
				{ name: "from-gone.txt", workspace: gone, expected: gone },
				{ name: "from-main.txt", workspace: main, expected: main },
				{ name: "from-plain.txt", workspace: plain, expected: plain },
				{ name: "from-nowhere.txt", workspace: undefined, expected: undefined },
			];
			await mkdir(join(base, "files"), { recursive: true });

			const legacy = await openLibrary(home);
			const ids: string[] = [];
			for (const { name, workspace } of rows) {
				const file = join(base, "files", name);
				await writeFile(file, name);
				ids.push((await legacy.stamp({ path: file, source: "present", ...(workspace === undefined ? {} : { workspace }) })).id);
			}
			legacy.close();
			await git(main, "worktree", "remove", "--force", gone);

			const reopened = await openLibrary(home);
			expect(ids.map(id => reopened.get(id)?.workspace)).toEqual(rows.map(row => row.expected));
			expect(
				reopened
					.facets({})
					.workspaces.map(workspace => workspace.path)
					.sort(),
			).toEqual([main, gone, plain].sort());
		},
		GIT_TIMEOUT_MS,
	);
});
