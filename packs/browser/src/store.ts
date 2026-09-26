/**
 * Per-profile filesystem state for the browser runtime.
 *
 * Owns three things and nothing else:
 *   1. Profile directory layout + filesystem-safe slug validation.
 *   2. The per-profile process lock (atomic create, owner-token release,
 *      NEVER steals a stale lock and NEVER kills a foreign process).
 *   3. Each profile's sign-in observations (`connections.json`, see
 *      connection.ts), kept in the profile's own directory so a deleted
 *      profile takes them with it and a restart can report them again.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ConnectionObservations, SiteObservation, SiteObservations } from "./connection.js";

const CONNECTIONS_FILE = "connections.json";
/** Sites remembered per profile; the oldest observation goes first. */
const MAX_SITES_PER_PROFILE = 64;
const MAX_ACCOUNT_CHARS = 1_024;

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
	 * Acquire the per-profile lock atomically (`O_CREAT | O_EXCL`). A lock held
	 * by a LIVE process is always honoured: we never kill its owner. A lock whose
	 * owning process is provably gone (the engine was killed, the machine
	 * restarted) is reclaimed once — otherwise every hard stop would strand the
	 * profile until a human deleted a file. A Chrome that outlived its runtime
	 * still holds Chrome's own profile lock, so the launch that follows fails
	 * rather than forking the profile.
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
			if (existing?.pid !== undefined && existing.pid !== process.pid && !processAlive(existing.pid)) {
				unlinkSync(path);
				return this.acquireLock(slug);
			}
			const who = existing
				? `pid ${existing.pid} since ${existing.at}`
				: `code ${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
			fail(
				"profile_locked",
				`profile "${slug}" is already in use (${who}). Close that browser first (browser_close), or use another profile.`,
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

	/** This profile's persisted sign-in observations; none when it was never observed or the file is unreadable. */
	connections(slug: string): SiteObservations {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(this.profileDir(slug), CONNECTIONS_FILE), "utf8"));
		} catch {
			return {};
		}
		const sites: SiteObservations = {};
		const stored = (parsed as { sites?: unknown } | null)?.sites;
		if (typeof stored !== "object" || stored === null) return sites;
		for (const [host, value] of Object.entries(stored as Record<string, unknown>)) {
			const site = value as Partial<SiteObservation> | null;
			if (typeof site?.signedIn !== "boolean" || typeof site.observedAt !== "number" || !Number.isFinite(site.observedAt)) continue;
			const valid: SiteObservation = { signedIn: site.signedIn, observedAt: site.observedAt };
			if (typeof site.account === "string" && site.account.length <= MAX_ACCOUNT_CHARS) valid.account = site.account;
			sites[host] = valid;
		}
		return sites;
	}

	/**
	 * Persist one observation of `host`, replacing that host's last one. Atomic
	 * and durable: the staging file is fsynced before the rename, so a crash or
	 * power loss leaves the old file or the new one; a failure at any step
	 * removes the staging file.
	 */
	recordConnection(slug: string, host: string, observation: SiteObservation): void {
		const sites = { ...this.connections(slug), [host]: observation };
		const kept = Object.entries(sites).sort(([, a], [, b]) => b.observedAt - a.observedAt).slice(0, MAX_SITES_PER_PROFILE);
		const dir = this.ensureProfile(slug);
		const path = join(dir, CONNECTIONS_FILE);
		const staging = `${path}.${randomBytes(6).toString("hex")}.tmp`;
		let fd: number | undefined;
		try {
			fd = openSync(staging, "w", 0o600);
			writeSync(fd, `${JSON.stringify({ sites: Object.fromEntries(kept) })}\n`);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			renameSync(staging, path);
		} catch (error) {
			if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
			try { unlinkSync(staging); } catch { /* never created, or already gone */ }
			throw error;
		}
	}

	/** Every on-disk profile that has observations. A deleted profile directory is simply not here. */
	allConnections(): ConnectionObservations {
		const all: ConnectionObservations = {};
		for (const slug of this.list()) {
			const sites = this.connections(slug);
			if (Object.keys(sites).length > 0) all[slug] = sites;
		}
		return all;
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

/** Signal 0 probes existence only. EPERM means it exists but is not ours to signal. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function defaultRootDir(): string {
	const insoHome = process.env.INSO_HOME?.trim();
	if (insoHome) return join(insoHome, "browser");
	return join(homedir(), ".inso", "browser");
}
