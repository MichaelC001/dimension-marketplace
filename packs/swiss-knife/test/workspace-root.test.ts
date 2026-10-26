import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceResolver, type WorkspaceResolver } from "../src/library/workspace-root";
import { addWorktree, git, initRepo, makeTempDir, recordWorktreeOwner, registerProjects, removeTree, type WorktreeOwnerRecord, worktreeGitDir } from "./fixtures";

const GIT_TIMEOUT_MS = 60_000;
const ORIGIN_MARKER = "inso-session-origin";
const APP = join("packages", "app");
const PLACES: readonly (readonly [string, string])[] = [
	["the worktree root", ""],
	["a worktree subfolder", APP],
];

let base: string;
let main: string;
let shared: string;
let gone: string;
let worktrees = 0;
let homes = 0;

beforeAll(async () => {
	base = await makeTempDir();
	main = await initRepo(join(base, "inso"), { [join(APP, "index.ts")]: "export {};\n", "README.md": "# inso\n" });
	shared = await newWorktree();
	gone = await newWorktree();
	await git(main, "worktree", "remove", "--force", gone);
}, GIT_TIMEOUT_MS);

afterAll(() => removeTree(base));

async function newWorktree(): Promise<string> {
	worktrees += 1;
	return addWorktree(main, join(base, "wt", `inso-task-${worktrees}`));
}

async function markOrigin(worktree: string, contents: string): Promise<void> {
	await writeFile(join(await worktreeGitDir(worktree), ORIGIN_MARKER), contents);
}

function freshHome(): string {
	homes += 1;
	return join(base, "homes", `home-${homes}`);
}

async function resolverFor(registered: readonly string[], owner?: WorktreeOwnerRecord): Promise<WorkspaceResolver> {
	const home = freshHome();
	await registerProjects(join(home, "projects.json"), registered);
	if (owner !== undefined) await recordWorktreeOwner(home, owner);
	return createWorkspaceResolver({ home });
}

describe("createWorkspaceResolver: a linked worktree belongs to the registered workspace of its main checkout", () => {
	for (const [place, sub] of PLACES) {
		test(`${place} resolves to the registered main checkout, not to a folder inside it`, async () => {
			const workspaceOf = await resolverFor([main]);
			expect(workspaceOf(join(shared, sub))).toBe(main);
		});
	}

	const listings: readonly (readonly [string, (outer: string, inner: string) => string[]])[] = [
		["outer listed first", (outer, inner) => [outer, inner]],
		["inner listed first", (outer, inner) => [inner, outer]],
	];

	for (const [listing, order] of listings) {
		test(`the most specific of nested registered roots claims the folder, ${listing}`, async () => {
			const inner = join(main, "packages");
			const workspaceOf = await resolverFor(order(main, inner));
			expect(workspaceOf(join(shared, APP))).toBe(inner);
			expect(workspaceOf(join(main, APP))).toBe(inner);
			expect(workspaceOf(shared)).toBe(main);
		});
	}

	test("a linked worktree that is registered itself stays its own workspace, beside its registered main checkout", async () => {
		const workspaceOf = await resolverFor([main, shared]);
		expect(workspaceOf(shared)).toBe(shared);
		expect(workspaceOf(join(shared, APP))).toBe(shared);
		expect(workspaceOf(join(main, APP))).toBe(main);
	});

	test("a registered folder that merely holds the worktree on disk does not take it from its main checkout", async () => {
		const workspaceOf = await resolverFor([base, main]);
		expect(workspaceOf(join(shared, APP))).toBe(main);
	});
});

describe("createWorkspaceResolver: without a registered root the end of the ownership chain is the workspace", () => {
	const registries: readonly (readonly [string, () => Promise<WorkspaceResolver>])[] = [
		["no registry file", async () => createWorkspaceResolver({ home: freshHome() })],
		["a registry naming only unrelated folders", () => resolverFor([join(base, "elsewhere")])],
	];

	for (const [registry, open] of registries) {
		for (const [place, sub] of PLACES) {
			test(`${place} resolves to the same folder of the main checkout, with ${registry}`, async () => {
				const workspaceOf = await open();
				expect(workspaceOf(join(shared, sub))).toBe(join(main, sub));
			});
		}
	}

	test("a main checkout, a plain folder and a folder that does not exist are their own workspace", async () => {
		const plain = join(base, "plain");
		await mkdir(join(plain, "deep"), { recursive: true });
		const workspaceOf = await resolverFor([join(base, "elsewhere")]);
		const own = [main, join(main, APP), plain, join(plain, "deep"), join(base, "missing", "dir")];
		expect(own.map(cwd => workspaceOf(cwd))).toEqual(own);
	});

	test("a registered root claims only folders inside it, not a sibling whose name starts with its name", async () => {
		const sibling = join(`${main}-extras`, "lib");
		await mkdir(sibling, { recursive: true });
		const workspaceOf = await resolverFor([main]);
		expect(workspaceOf(join(main, APP))).toBe(main);
		expect(workspaceOf(sibling)).toBe(sibling);
	});

	test(
		"a worktree of a bare repository has no main checkout and is its own workspace",
		async () => {
			const bare = join(base, "inso.git");
			await git(base, "clone", "-q", "--bare", main, bare);
			const worktree = await addWorktree(bare, join(base, "wt", "bare-task"));
			const workspaceOf = await resolverFor([join(base, "elsewhere")]);
			expect(workspaceOf(worktree)).toBe(worktree);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("createWorkspaceResolver: a submodule", () => {
	let host: string;
	let hostWorktree: string;

	beforeAll(async () => {
		const vendored = await initRepo(join(base, "vendored"), { "lib.txt": "lib\n" });
		host = await initRepo(join(base, "host"), { "README.md": "# host\n" });
		await git(host, "submodule", "add", "-q", vendored, "vendor/lib");
		await git(host, "commit", "-q", "-m", "vendor lib");
		hostWorktree = await addWorktree(host, join(base, "wt", "host-task"));
		await git(hostWorktree, "submodule", "update", "--init", "-q");
	}, GIT_TIMEOUT_MS);

	test("is its own workspace, and inside a linked worktree it is the main checkout's copy, when nothing is registered", async () => {
		const submodule = join(host, "vendor", "lib");
		expect(await readFile(join(hostWorktree, "vendor", "lib", ".git"), "utf8")).toStartWith("gitdir:");
		const workspaceOf = await resolverFor([]);
		expect(workspaceOf(submodule)).toBe(submodule);
		expect(workspaceOf(join(hostWorktree, "vendor", "lib"))).toBe(submodule);
	});

	test("inside a linked worktree belongs to the registered main checkout of its host", async () => {
		const workspaceOf = await resolverFor([host]);
		expect(workspaceOf(join(hostWorktree, "vendor", "lib"))).toBe(host);
	});
});

describe("createWorkspaceResolver: the session origin marker in the worktree's git dir", () => {
	test(
		"a marker naming another folder wins over the registered main checkout, without the worktree's subfolder",
		async () => {
			const elsewhere = join(base, "elsewhere");
			await mkdir(elsewhere, { recursive: true });
			const worktree = await newWorktree();
			await markOrigin(worktree, `${elsewhere}\n`);
			const workspaceOf = await resolverFor([main]);
			expect(workspaceOf(join(worktree, APP))).toBe(elsewhere);
		},
		GIT_TIMEOUT_MS,
	);

	const harmless: readonly (readonly [string, () => string])[] = [
		["blank", () => "\n"],
		["naming the main checkout with a trailing slash", () => `${main}/`],
	];

	for (const [marker, contents] of harmless) {
		test(
			`a marker ${marker} leaves the worktree mapped to the same subfolder of the main checkout`,
			async () => {
				const worktree = await newWorktree();
				await markOrigin(worktree, contents());
				const workspaceOf = await resolverFor([]);
				expect(workspaceOf(join(worktree, APP))).toBe(join(main, APP));
			},
			GIT_TIMEOUT_MS,
		);
	}

	test(
		"a marker naming another linked worktree is followed on to that worktree's registered main checkout",
		async () => {
			const from = await newWorktree();
			const to = await newWorktree();
			await markOrigin(from, to);
			const workspaceOf = await resolverFor([main]);
			expect(workspaceOf(from)).toBe(main);
		},
		GIT_TIMEOUT_MS,
	);

	test(
		"two worktrees whose markers name each other still resolve, to one of the two",
		async () => {
			const first = await newWorktree();
			const second = await newWorktree();
			await markOrigin(first, second);
			await markOrigin(second, first);
			const workspaceOf = await resolverFor([main]);
			expect([first, second]).toContain(workspaceOf(first));
		},
		GIT_TIMEOUT_MS,
	);
});

describe("createWorkspaceResolver: a removed worktree is placed by the engine's owner ledger", () => {
	const mapping = (mapsSubpaths: boolean): WorktreeOwnerRecord => ({ root: gone, origin: main, mapsSubpaths });

	test("an owner that maps subpaths puts the removed worktree's folders at the same folder of its origin, and at its registered workspace", async () => {
		const unregistered = await resolverFor([], mapping(true));
		expect(unregistered(join(gone, APP))).toBe(join(main, APP));
		const registered = await resolverFor([main], mapping(true));
		expect(registered(join(gone, APP))).toBe(main);
	});

	test("an owner that does not map subpaths puts every folder of the removed worktree at its origin", async () => {
		const workspaceOf = await resolverFor([], mapping(false));
		expect(workspaceOf(join(gone, APP))).toBe(main);
	});

	test("a removed worktree with no ledger entry is kept as it is, even beside a registered main checkout", async () => {
		const workspaceOf = await resolverFor([main]);
		expect(workspaceOf(join(gone, APP))).toBe(join(gone, APP));
		expect(workspaceOf(gone)).toBe(gone);
	});

	test("a recorded root that still exists is not remapped", async () => {
		const kept = join(base, "kept");
		await mkdir(join(kept, "sub"), { recursive: true });
		const workspaceOf = await resolverFor([main], { root: kept, origin: main, mapsSubpaths: true });
		expect(workspaceOf(join(kept, "sub"))).toBe(join(kept, "sub"));
	});
});

describe("createWorkspaceResolver: the registry and the ledger are re-read when they change, at most every few seconds", () => {
	const WITHIN_WINDOW_MS = 1_000;
	const PAST_WINDOW_MS = 10_000;

	test("a root registered after the first answer claims the folder only once the reload window has passed", async () => {
		let clock = 0;
		const home = freshHome();
		const registry = join(home, "projects.json");
		await registerProjects(registry, [join(base, "elsewhere")]);
		const workspaceOf = createWorkspaceResolver({ home, now: () => clock });
		const cwd = join(shared, APP);
		expect(workspaceOf(cwd)).toBe(join(main, APP));

		await registerProjects(registry, [join(base, "elsewhere"), main]);
		clock += WITHIN_WINDOW_MS;
		expect(workspaceOf(cwd)).toBe(join(main, APP));
		clock += PAST_WINDOW_MS;
		expect(workspaceOf(cwd)).toBe(main);
	});

	test("an owner recorded after the first answer places a removed worktree only once the reload window has passed", async () => {
		let clock = 0;
		const home = freshHome();
		await registerProjects(join(home, "projects.json"), [main]);
		const workspaceOf = createWorkspaceResolver({ home, now: () => clock });
		const cwd = join(gone, APP);
		expect(workspaceOf(cwd)).toBe(cwd);

		await recordWorktreeOwner(home, { root: gone, origin: main, mapsSubpaths: true });
		clock += WITHIN_WINDOW_MS;
		expect(workspaceOf(cwd)).toBe(cwd);
		clock += PAST_WINDOW_MS;
		expect(workspaceOf(cwd)).toBe(main);
	});

	test("an explicit registry file is read in place of the one in the home", async () => {
		const home = freshHome();
		const registry = join(base, "custom", "projects.json");
		await registerProjects(join(home, "projects.json"), [main]);
		await registerProjects(registry, [join(main, "packages")]);
		const workspaceOf = createWorkspaceResolver({ home, projectsFile: registry });
		expect(workspaceOf(join(shared, APP))).toBe(join(main, "packages"));
	});
});
