/**
 * Per-profile filesystem state for the browser runtime.
 *
 * Owns two things and nothing else:
 *   1. Profile directory layout + filesystem-safe slug validation.
 *   2. The per-profile process lock (atomic create, owner-token release,
 *      NEVER steals a stale lock and NEVER kills a foreign process).
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Matches the server's input schema exactly: 1-48 chars, no dots. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export class BrowserRuntimeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "BrowserRuntimeError";
		this.code = code;
	}
}

export function fail(code: string, message: string): never {
	throw new BrowserRuntimeError(code, message);
}

/** Thrown by a driver when provably nothing reached the page (no target, bad input). */
export class ActionNotDispatched extends BrowserRuntimeError {}

/**
 * Validate a profile name into a filesystem-safe slug. Rejects (never rewrites)
 * anything that could escape the profile root: separators, `..`, drive letters,
 * NUL, or anything outside the conservative charset.
 */
export function validateProfile(raw: unknown): string {
	if (typeof raw !== "string") fail("bad_profile", "profile must be a string");
	const slug = raw.trim().toLowerCase();
	if (!SLUG_RE.test(slug)) {
		fail(
			"bad_profile",
			`profile ${JSON.stringify(raw)} is not a valid slug: use 1-48 chars of [a-z0-9_-] starting alphanumeric`,
		);
	}
	return slug;
}

export interface LockHandle {
	readonly path: string;
	readonly token: string;
}

export class ProfileStore {
	readonly rootDir: string;
	constructor(rootDir?: string) {
		this.rootDir = resolve(rootDir ?? defaultRootDir());
		mkdirSync(this.profilesRoot, { recursive: true, mode: 0o700 });
	}

	get profilesRoot(): string {
		return join(this.rootDir, "profiles");
	}

	profileDir(slug: string): string {
		return join(this.profilesRoot, slug);
	}

	/** Chrome `userDataDir` for a persistent, isolated profile. */
	userDataDir(slug: string): string {
		return join(this.profileDir(slug), "chrome");
	}

	ensureProfile(slug: string): string {
		const dir = this.profileDir(slug);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	/** Profiles that have ever been materialized on disk, sorted, bounded. */
	list(): string[] {
		let entries: string[];
		try {
			entries = readdirSync(this.profilesRoot);
		} catch {
			return [];
		}
		return entries
			.filter((name) => SLUG_RE.test(name))
			.filter((name) => {
				try {
					return statSync(join(this.profilesRoot, name)).isDirectory();
				} catch {
					return false;
				}
			})
			.sort()
			.slice(0, 256);
	}

	/**
	 * Acquire the per-profile lock atomically (`O_CREAT | O_EXCL`). A pre-existing
	 * lock is ALWAYS honoured: we never probe-and-kill the recorded pid and never
	 * auto-steal a lock we believe is stale — a human removes the file. The only
	 * reclaim is a lock this very process wrote and still owns in memory, which
	 * callers handle by reusing the live browser entry rather than re-locking.
	 */
	acquireLock(slug: string): LockHandle {
		this.ensureProfile(slug);
		const path = join(this.profileDir(slug), "runtime.lock");
		const token = randomBytes(16).toString("hex");
		const body = `${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`;
		let fd: number;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (err) {
			const existing = readLock(path);
			const who = existing
				? `pid ${existing.pid} since ${existing.at}`
				: `code ${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
			fail(
				"profile_locked",
				`profile "${slug}" is already in use (${who}). This runtime never steals locks or kills the owning process; ` +
					`close the other session, or remove ${path} by hand once you have verified nothing is using it.`,
			);
		}
		try {
			writeSync(fd, body);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return { path, token };
	}

	/** Release only if the on-disk token still matches ours. Never throws. */
	releaseLock(lock: LockHandle): void {
		const existing = readLock(lock.path);
		if (!existing || existing.token !== lock.token) return;
		try {
			unlinkSync(lock.path);
		} catch {
			/* already gone */
		}
	}
}

function readLock(path: string): { pid?: number; token?: string; at?: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
			token: typeof parsed.token === "string" ? parsed.token : undefined,
			at: typeof parsed.at === "string" ? parsed.at : undefined,
		};
	} catch {
		return undefined;
	}
}

export function defaultRootDir(): string {
	const insoHome = process.env.INSO_HOME?.trim();
	if (insoHome) return join(insoHome, "browser");
	return join(homedir(), ".inso", "browser");
}
