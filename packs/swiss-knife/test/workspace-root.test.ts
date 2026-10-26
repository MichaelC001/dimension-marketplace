import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceRoot } from "../src/library/workspace-root";
import { addWorktree, git, initRepo, makeTempDir, removeTree, worktreeGitDir } from "./fixtures";

const GIT_TIMEOUT_MS = 60_000;
const ORIGIN_MARKER = "inso-session-origin";
const APP = join("packages", "app");
const PLACES: readonly (readonly [string, string])[] = [
	["the worktree root", ""],
	["a worktree subfolder", APP],
];

let base: string;
let main: string;
let worktrees = 0;

beforeAll(async () => {
	base = await makeTempDir();
	main = await initRepo(join(base, "inso"), { [join(APP, "index.ts")]: "export {};\n", "README.md": "# inso\n" });
}, GIT_TIMEOUT_MS);

afterAll(() => removeTree(base));

async function newWorktree(): Promise<string> {
	worktrees += 1;
	return addWorktree(main, join(base, "wt", `inso-task-${worktrees}`));
}

async function markOrigin(worktree: string, contents: string): Promise<void> {
	await writeFile(join(await worktreeGitDir(worktree), ORIGIN_MARKER), contents);
}

describe("workspaceRoot: a linked worktree belongs to the checkout it was cut from", () => {
	for (const [place, sub] of PLACES) {
		test(
			`${place} resolves to the same folder of the main checkout`,
			async () => {
				const worktree = await newWorktree();
				expect(workspaceRoot(join(worktree, sub))).toBe(join(main, sub));
			},
			GIT_TIMEOUT_MS,
		);
	}

	test("a main checkout, a plain folder and a folder that does not exist are their own workspace", async () => {
		const plain = join(base, "plain");
		await mkdir(join(plain, "deep"), { recursive: true });
		const own = [main, join(main, APP), plain, join(plain, "deep"), join(base, "missing", "dir")];
		expect(own.map(cwd => workspaceRoot(cwd))).toEqual(own);
	});

	test(
		"a worktree of a bare repository has no main checkout and is its own workspace",
		async () => {
			const bare = join(base, "inso.git");
			await git(base, "clone", "-q", "--bare", main, bare);
			const worktree = await addWorktree(bare, join(base, "wt", "bare-task"));
			expect(workspaceRoot(worktree)).toBe(worktree);
		},
		GIT_TIMEOUT_MS,
	);

	test(
		"a submodule is its own workspace, and inside a linked worktree it is the main checkout's copy",
		async () => {
			const vendored = await initRepo(join(base, "vendored"), { "lib.txt": "lib\n" });
			const host = await initRepo(join(base, "host"), { "README.md": "# host\n" });
			await git(host, "submodule", "add", "-q", vendored, "vendor/lib");
			await git(host, "commit", "-q", "-m", "vendor lib");
			const submodule = join(host, "vendor", "lib");
			expect(workspaceRoot(submodule)).toBe(submodule);

			const worktree = await addWorktree(host, join(base, "wt", "host-task"));
			await git(worktree, "submodule", "update", "--init", "-q");
			expect(await readFile(join(worktree, "vendor", "lib", ".git"), "utf8")).toStartWith("gitdir:");
			expect(workspaceRoot(join(worktree, "vendor", "lib"))).toBe(submodule);
		},
		GIT_TIMEOUT_MS,
	);
});

describe("workspaceRoot: the session origin marker in the worktree's git dir", () => {
	for (const [place, sub] of PLACES) {
		test(
			`a marker naming another folder wins over the main checkout, from ${place}`,
			async () => {
				const elsewhere = join(base, "elsewhere");
				await mkdir(elsewhere, { recursive: true });
				const worktree = await newWorktree();
				await markOrigin(worktree, `${elsewhere}\n`);
				expect(workspaceRoot(join(worktree, sub))).toBe(elsewhere);
			},
			GIT_TIMEOUT_MS,
		);
	}

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
				expect(workspaceRoot(join(worktree, APP))).toBe(join(main, APP));
			},
			GIT_TIMEOUT_MS,
		);
	}

	test(
		"a marker naming another linked worktree is followed on to that worktree's main checkout",
		async () => {
			const from = await newWorktree();
			const to = await newWorktree();
			await markOrigin(from, to);
			expect(workspaceRoot(from)).toBe(main);
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
			expect([first, second]).toContain(workspaceRoot(first));
		},
		GIT_TIMEOUT_MS,
	);
});
