import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

const SESSION_ORIGIN_FILE = "inso-session-origin";
const MAX_HOPS = 4;
const RELOAD_MIN_MS = 5_000;

const ProjectsFile = z.object({ projects: z.array(z.object({ path: z.string().trim().min(1) }).loose()) }).loose();
const OwnersFile = z
	.object({
		owners: z.record(z.string(), z.object({ root: z.string().min(1), origin: z.string().min(1), mapsSubpaths: z.boolean().optional() }).loose()),
	})
	.loose();

interface LinkedWorktree {
	readonly root: string;
	readonly gitDir: string;
	readonly mainCheckout: string;
}

interface ChainLink {
	readonly path: string;
	readonly at: string;
	readonly worktree?: string;
}

interface RecordedOwner {
	readonly root: string;
	readonly origin: string;
	readonly mapsSubpaths: boolean;
}

interface Root {
	readonly path: string;
	readonly base: string;
}

export interface WorkspaceResolverOptions {
	readonly home: string;
	readonly projectsFile?: string;
	readonly now?: () => number;
}

export type WorkspaceResolver = (cwd: string) => string;

export function createWorkspaceResolver(options: WorkspaceResolverOptions): WorkspaceResolver {
	const projectsFile = options.projectsFile ?? join(options.home, "projects.json");
	const ledgerFile = join(options.home, "worktree-owners.json");
	const now = options.now ?? Date.now;
	const placed = new Map<string, string>();
	let roots: readonly Root[] = [];
	let owners: ReadonlyMap<string, RecordedOwner> = new Map();
	let stamps: string | undefined;
	let checkedAt = Number.NEGATIVE_INFINITY;

	function refresh(): void {
		const moment = now();
		if (moment - checkedAt < RELOAD_MIN_MS) return;
		checkedAt = moment;
		const next = `${fileStamp(projectsFile)}|${fileStamp(ledgerFile)}`;
		if (next === stamps) return;
		stamps = next;
		roots = readRoots(projectsFile);
		owners = readOwners(ledgerFile);
		placed.clear();
	}

	return cwd => {
		refresh();
		const start = resolve(cwd);
		const known = placed.get(start);
		if (known !== undefined) return known;
		const chain = ownershipChain(start, owners);
		let claimed: string | undefined;
		for (const { at, worktree } of chain) {
			claimed = roots.find(({ base }) => within(at, base) && (worktree === undefined || within(base, worktree)))?.path;
			if (claimed !== undefined) break;
		}
		const answer = claimed ?? chain[chain.length - 1]?.path ?? start;
		placed.set(start, answer);
		return answer;
	};
}

function ownershipChain(start: string, owners: ReadonlyMap<string, RecordedOwner>): readonly ChainLink[] {
	const chain: ChainLink[] = [];
	let home = start;
	for (let hops = MAX_HOPS; hops > 0; hops -= 1) {
		const linked = linkedWorktreeOf(home);
		if (linked === undefined) {
			const gone = recordedOwnerOf(owners, home);
			if (gone === undefined || existsSync(gone.root)) break;
			chain.push({ path: home, at: comparable(home), worktree: comparable(gone.root) });
			home = gone.mapsSubpaths ? join(gone.origin, relative(gone.root, home)) : resolve(gone.origin);
			continue;
		}
		chain.push({ path: home, at: comparable(home), worktree: comparable(linked.root) });
		const origin = readText(join(linked.gitDir, SESSION_ORIGIN_FILE))?.trim();
		const mapsSubpaths = !origin || comparable(origin) === comparable(linked.mainCheckout);
		home = mapsSubpaths ? join(linked.mainCheckout, relative(linked.root, home)) : resolve(origin);
	}
	chain.push({ path: home, at: comparable(home) });
	return chain;
}

function recordedOwnerOf(owners: ReadonlyMap<string, RecordedOwner>, cwd: string): RecordedOwner | undefined {
	let at = comparable(cwd);
	for (;;) {
		const hit = owners.get(at);
		if (hit !== undefined) return hit;
		const cut = at.lastIndexOf("/");
		if (cut <= 0 || /^[a-z]:$/i.test(at.slice(0, cut))) return undefined;
		at = at.slice(0, cut);
	}
}

function linkedWorktreeOf(cwd: string): LinkedWorktree | undefined {
	let dir = cwd;
	for (;;) {
		const dotGit = join(dir, ".git");
		const entry = entryAt(dotGit);
		if (entry === "directory") return undefined;
		if (entry === "file") {
			const linked = readLinkedWorktree(dir, dotGit);
			if (linked !== "not-linked") return linked;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function readLinkedWorktree(root: string, dotGit: string): LinkedWorktree | undefined | "not-linked" {
	const gitDirRef = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
	if (!gitDirRef) return "not-linked";
	const gitDir = resolve(root, gitDirRef);
	const commonRef = readText(join(gitDir, "commondir"))?.trim();
	if (!commonRef) return "not-linked";
	const commonDir = resolve(gitDir, commonRef);
	const configured = coreWorktree(readText(join(commonDir, "config")));
	const mainCheckout = configured ? resolve(commonDir, configured) : basename(commonDir) === ".git" ? dirname(commonDir) : undefined;
	return mainCheckout ? { root, gitDir, mainCheckout } : undefined;
}

function coreWorktree(config: string | undefined): string | undefined {
	if (!config) return undefined;
	let inCore = false;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inCore = /^\[\s*core\s*\]/i.test(line);
			continue;
		}
		if (!inCore) continue;
		const value = /^worktree\s*=\s*(.*)$/i.exec(line)?.[1]?.trim();
		if (value) return value.replace(/^"(.*)"$/, "$1");
	}
	return undefined;
}

function readRoots(file: string): readonly Root[] {
	const parsed = ProjectsFile.safeParse(readJson(file));
	if (!parsed.success) return [];
	return parsed.data.projects
		.map(({ path }) => ({ path: resolve(path), base: comparable(path) }))
		.sort((left, right) => right.base.length - left.base.length);
}

function readOwners(file: string): ReadonlyMap<string, RecordedOwner> {
	const parsed = OwnersFile.safeParse(readJson(file));
	if (!parsed.success) return new Map();
	return new Map(Object.entries(parsed.data.owners).map(([key, { root, origin, mapsSubpaths }]) => [key, { root, origin, mapsSubpaths: mapsSubpaths === true }]));
}

function comparable(value: string): string {
	const flat = resolve(value).replaceAll("\\", "/").replace(/\/+$/, "");
	return process.platform === "win32" || process.platform === "darwin" ? flat.toLowerCase() : flat;
}

function within(inner: string, outer: string): boolean {
	return inner === outer || inner.startsWith(`${outer}/`);
}

function entryAt(path: string): "file" | "directory" | undefined {
	try {
		const entry = statSync(path, { throwIfNoEntry: false });
		return entry?.isDirectory() ? "directory" : entry ? "file" : undefined;
	} catch {
		return undefined;
	}
}

function fileStamp(file: string): string {
	try {
		const stat = statSync(file);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "";
	}
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}
