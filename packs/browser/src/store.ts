/**
 * Durable, per-profile filesystem state for the browser runtime.
 *
 * Owns three things and nothing else:
 *   1. Profile directory layout + filesystem-safe slug validation.
 *   2. The per-profile process lock (atomic create, owner-token release,
 *      NEVER steals a stale lock and NEVER kills a foreign process).
 *   3. The append-only action journal, serialized per profile and fsync'd
 *      before the caller is allowed to cause the real-world effect.
 *
 * No puppeteer here — this module is pure Node fs/path/crypto so the durable
 * write-path can be reasoned about (and unit-tested) without a browser.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { open, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Max bytes of a single journal file before it is rotated to `.1`. */
const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/** Max bytes of a single journal record; an oversized record is refused. */
const JOURNAL_MAX_RECORD = 8 * 1024;

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

/**
 * One durable line of the action journal.
 *
 * Credential boundary: this record NEVER carries the opaque `browserId`
 * capability (a non-secret per-browser `session` id stands in for it) and
 * NEVER carries action payloads or browser exception strings.
 */
export interface JournalRecord {
	at: string;
	/** Non-secret per-browser id; deliberately NOT the browserId capability. */
	session: string;
	actionId: string;
	requestId: string;
	status: string;
	revision: number;
	kind: string;
}

export class ProfileStore {
	readonly rootDir: string;
	/** One serialization chain per profile so journal writes never interleave. */
	private readonly journalQueues = new Map<string, Promise<void>>();

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

	/**
	 * Append one journal record, fsync'd, serialized per profile. Resolves only
	 * after the bytes are durable — callers MUST await this before performing a
	 * mutating browser action so a crash can never hide a claimed write.
	 */
	journal(slug: string, record: JournalRecord): Promise<void> {
		const path = join(this.profileDir(slug), "actions.jsonl");
		const prev = this.journalQueues.get(slug) ?? Promise.resolve();
		const next = prev.then(
			() => this.writeJournal(path, record),
			() => this.writeJournal(path, record),
		);
		this.journalQueues.set(
			slug,
			next.catch(() => undefined),
		);
		return next;
	}

	/**
	 * Async throughout: an fsync is a multi-millisecond disk stall, and doing it
	 * synchronously would block every other profile's event-loop work on one
	 * profile's claim.
	 */
	private async writeJournal(path: string, record: JournalRecord): Promise<void> {
		const line = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(line) > JOURNAL_MAX_RECORD) {
			throw new Error("Browser action receipt exceeds the journal record limit");
		}
		let size = 0;
		try {
			size = (await stat(path)).size;
		} catch (err) {
			// ENOENT is the first write. Anything else means we cannot reason about
			// this file's size, and we do not claim a durable bound we did not check.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (size + line.length > JOURNAL_MAX_BYTES) {
			// A failed rotation is reported, not swallowed: the caller is about to
			// rely on this file for a claim.
			await rename(path, `${path}.1`);
		}
		const handle = await open(path, "a", 0o600);
		try {
			await handle.appendFile(line);
			await handle.sync();
		} finally {
			await handle.close();
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
