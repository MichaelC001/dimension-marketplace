import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runArtifacts } from "../src/artifacts";
import { openDriver } from "../src/library/driver";
import { createLibrary } from "../src/library/library";
import type { Library } from "../src/library/types";
import { addWorktree, git, initRepo, loadTools, makeTempDir, recordWorktreeOwner, registerProjects, removeTree, TINY_PNG, toolContext } from "./fixtures";

const PACK = join(import.meta.dir, "..");
const GIT_TIMEOUT_MS = 60_000;
const DOCS = "docs";

let base: string;
let main: string;
let worktrees = 0;
let homes = 0;
let libraries: Library[] = [];

beforeAll(async () => {
	base = await makeTempDir();
	main = await initRepo(join(base, "inso"), { [join("assets", "shot.png")]: TINY_PNG, [join(DOCS, "notes.md")]: "# notes\n" });
}, GIT_TIMEOUT_MS);

afterAll(() => removeTree(base));

beforeEach(() => {
	libraries = [];
});

afterEach(() => {
	for (const library of libraries) library.close();
});

async function registeredHome(): Promise<string> {
	homes += 1;
	const home = join(base, "homes", `home-${homes}`);
	await registerProjects(join(home, "projects.json"), [main]);
	return home;
}

async function openLibrary(home: string): Promise<Library> {
	const library = await createLibrary({ home });
	libraries.push(library);
	return library;
}

async function newWorktree(): Promise<string> {
	worktrees += 1;
	return addWorktree(main, join(base, "wt", `inso-task-${worktrees}`));
}

async function setUserVersion(home: string, version: number): Promise<void> {
	const db = await openDriver(join(home, "artifacts", "library.db"));
	try {
		db.exec(`PRAGMA user_version = ${version}`);
	} finally {
		db.close();
	}
}

describe("the Library files what a session in a linked worktree makes under the registered workspace", () => {
	test(
		"files presented from a worktree folder and from the main checkout are one workspace",
		async () => {
			const library = await openLibrary(await registeredHome());
			const worktree = await newWorktree();
			const { tools } = await loadTools(join(PACK, "src", "index.ts"), { library: async () => library });
			const present = tools.find(tool => tool.name === "present");
			await present?.execute("t1", { path: join(worktree, "assets", "shot.png") }, undefined, undefined, toolContext(join(worktree, DOCS)));
			await present?.execute("t2", { path: join(main, "assets", "shot.png") }, undefined, undefined, toolContext(join(main, DOCS)));

			expect(library.facets({}).workspaces).toEqual([{ path: main, count: 2 }]);
			expect(library.query({ workspace: main }).total).toBe(2);
		},
		GIT_TIMEOUT_MS,
	);

	test(
		"the artifacts tool run from a worktree folder stamps into, and searches, the registered workspace and nothing else",
		async () => {
			const library = await openLibrary(await registeredHome());
			const worktree = await newWorktree();
			const context = { cwd: join(worktree, DOCS), now: Date.now(), sessionId: "s1" };
			const presentedInMain = await library.stamp({ path: join(main, "assets", "shot.png"), source: "present", workspace: main });
			const otherFile = join(base, "files", "other.txt");
			await mkdir(join(base, "files"), { recursive: true });
			await writeFile(otherFile, "other");
			const elsewhere = await library.stamp({ path: otherFile, source: "present", workspace: join(base, "elsewhere") });
			expect(await runArtifacts(library, { op: "search", query: "shot" }, context)).toStartWith(presentedInMain.id);

			expect(await runArtifacts(library, { op: "stamp", path: "notes.md" }, context)).toStartWith("Added ");
			const stamped = library.getByPath(join(worktree, DOCS, "notes.md"));
			expect(stamped?.workspace).toBe(main);

			const listing = await runArtifacts(library, { op: "search" }, context);
			expect(listing.split("\n").map(line => line.split(" · ")[0]).sort()).toEqual([stamped?.id ?? "", presentedInMain.id].sort());
			expect(listing).not.toContain(elsewhere.id);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("library.db schema 2 to 3: rows stamped with a worktree folder are re-homed once", () => {
	test(
		"the upgrade moves the rows the registry and the ledger place, leaves every other label alone, and does not run again",
		async () => {
			const home = await registeredHome();
			const live = await newWorktree();
			const removed = await newWorktree();
			const orphan = await newWorktree();
			const plain = join(base, "plain-workspace");
			const rows = [
				{ name: "from-live.txt", workspace: live, expected: main },
				{ name: "from-removed.txt", workspace: removed, expected: main },
				{ name: "from-orphan.txt", workspace: orphan, expected: orphan },
				{ name: "from-main.txt", workspace: main, expected: main },
				{ name: "from-plain.txt", workspace: plain, expected: plain },
				{ name: "from-nowhere.txt", workspace: undefined, expected: undefined },
			];
			const files = join(base, "files-upgrade");
			await mkdir(files, { recursive: true });
			const stampFile = async (library: Library, name: string, workspace: string | undefined): Promise<string> => {
				const file = join(files, name);
				await writeFile(file, name);
				return (await library.stamp({ path: file, source: "present", ...(workspace === undefined ? {} : { workspace }) })).id;
			};

			const legacy = await openLibrary(home);
			const ids: string[] = [];
			for (const { name, workspace } of rows) ids.push(await stampFile(legacy, name, workspace));
			legacy.close();
			await setUserVersion(home, 2);
			await git(main, "worktree", "remove", "--force", removed);
			await git(main, "worktree", "remove", "--force", orphan);
			await recordWorktreeOwner(home, { root: removed, origin: main, mapsSubpaths: true });

			const upgraded = await openLibrary(home);
			const expected = rows.map(row => row.expected);
			expect(ids.map(id => upgraded.get(id)?.workspace)).toEqual(expected);
			const laterId = await stampFile(upgraded, "stamped-after-upgrade.txt", live);
			upgraded.close();

			const reopened = await openLibrary(home);
			expect(ids.map(id => reopened.get(id)?.workspace)).toEqual(expected);
			expect(reopened.get(laterId)?.workspace).toBe(live);
		},
		GIT_TIMEOUT_MS,
	);
});
