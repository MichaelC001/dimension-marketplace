import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/**
 * The workspace a session's cwd belongs to, for stamping and scoping library rows.
 *
 * A session in a linked worktree (`~/.inso/wt/<repo>-<task>`) works on the repository
 * the worktree was cut from, and the rail lists it under that workspace. The library
 * follows the same rule as the engine's `worktreeOwner` (packages/engine/src/cwd-workspace.ts):
 * the engine's origin marker when it names somewhere other than the main checkout,
 * else the same subpath of git's main checkout, resolved again while that still sits
 * in a linked worktree. File reads only, never throws, memoised per cwd.
 *
 * A pack cannot import the engine, so this mirrors OMP's `linkedWorktreeOf`
 * (packages/coding-agent/src/registry/agent-scope.ts). Keep the two in step.
 */

/** The marker a session worktree records its origin in, inside its private git dir. */
const SESSION_ORIGIN_FILE = "inso-session-origin";
/** The same bound as the engine's ownership chain: a hand-edited cycle ends here. */
const MAX_HOPS = 4;

interface LinkedWorktree {
	readonly root: string;
	readonly gitDir: string;
	readonly mainCheckout: string;
}

const owners = new Map<string, string>();

export function workspaceRoot(cwd: string): string {
	const start = resolve(cwd);
	const known = owners.get(start);
	if (known !== undefined) return known;
	let home = start;
	for (let hops = MAX_HOPS; hops > 0; hops -= 1) {
		const linked = linkedWorktreeOf(home);
		if (linked === undefined) break;
		const origin = readText(join(linked.gitDir, SESSION_ORIGIN_FILE))?.trim();
		const mapsSubpath = !origin || sameFolder(origin, linked.mainCheckout);
		home = mapsSubpath ? join(linked.mainCheckout, relative(linked.root, home)) : resolve(origin);
	}
	owners.set(start, home);
	return home;
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

/** A gitlink FILE read as a linked worktree: the worktree, `undefined` for a worktree with
 *  no main checkout (bare repository), or `"not-linked"` for a gitlink with no `commondir`
 *  (a submodule checkout, or an unreadable one). */
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

function entryAt(path: string): "file" | "directory" | undefined {
	try {
		const entry = statSync(path, { throwIfNoEntry: false });
		return entry?.isDirectory() ? "directory" : entry ? "file" : undefined;
	} catch {
		return undefined;
	}
}

/** `core.worktree` from a git config file's text: a section-aware line scan. */
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

function sameFolder(left: string, right: string): boolean {
	const fold = (path: string) => {
		const slashed = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
		return process.platform === "win32" || process.platform === "darwin" ? slashed.toLowerCase() : slashed;
	};
	return fold(left) === fold(right);
}

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}
