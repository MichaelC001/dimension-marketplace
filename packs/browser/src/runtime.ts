/**
 * BrowserRuntime — shared capabilities, approval and durable claims for six engines.
 *
 * Design rules this file is built around (see also README/issue #87):
 *
 *  - The model may REQUEST a mutating action; only a human approval through
 *    `resolveAction(.., true)` (an app-only tool on the server side) executes
 *    one. There is no arbitrary-JS escape hatch: every page script here is a
 *    fixed, internal function, never caller-supplied.
 *  - A claim is journalled and fsync'd BEFORE the effect. Anything that can go
 *    wrong AFTER dispatch ends `unknown` — never retried, never auto-repaired.
 *  - `browserId` is an opaque capability minted per open. It is never returned
 *    for an already-open profile (the engine server is shared across sessions,
 *    so handing back a live token would leak the capability), never journalled
 *    and never listed; `profiles()` lists profile names only.
 *  - Persistent profiles are never deleted, foreign locks are never stolen, a
 *    profile lock is released only once the owned Chrome process is gone, and
 *    a relay (the human's own Chrome) is never closed — we own exactly the one
 *    blank tab we created.
 *
 * Deliberately NOT implemented (future work, not faked here): ABP/ad-blocking,
 * Browser4 / Jev / browser-use style autonomous agents.
 */
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
	BrowserAction,
	BrowserAnnotation,
	BrowserEngine,
	BrowserFrame,
	BrowserOpenOptions,
	BrowserRegion,
	BrowserRuntimePort,
	BrowserState,
	PendingAction,
	Viewport,
} from "./contracts";
import { cropRegion, MAX_FRAME_BYTES } from "./image";
import { fail, ProfileStore, validateProfile } from "./store";
import { BROWSER_ENGINES } from "./contracts.js";
import { createEngineDriver } from "./engines/index.js";
import type { EngineDriver, EngineState, PreparedAction } from "./engines/types.js";

// ---------------------------------------------------------------------------
// Bounds. Every unbounded thing in a long-lived runtime is a leak or a weapon.
// ---------------------------------------------------------------------------
const MAX_BROWSERS = 4;
/** Actions kept in the visible history. Idempotency records outlive these. */
const MAX_ACTIONS_RETAINED = 64;
/**
 * Idempotency tombstones kept per browser. Reaching this limit REFUSES new
 * requestIds rather than forgetting old ones — forgetting an id would let an
 * already-executed request be requested (and approved) a second time.
 */
const MAX_REQUEST_RECORDS = 4_096;
const MAX_PENDING_ACTIONS = 16;
const MAX_FRAMES_RETAINED = 8;
const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_ELEMENT_CHARS = 4_000;
const MAX_TEXT_INPUT = 4_096;
const MAX_NOTE_CHARS = 8_192;
const MAX_SELECTOR_CHARS = 512;
const MAX_URL_LENGTH = 2_048;
const MAX_SCROLL_DELTA = 5_000;
const MIN_WIDTH = 320;
const MAX_WIDTH = 2_560;
const MIN_HEIGHT = 240;
const MAX_HEIGHT = 2_000;
const DEFAULT_VIEWPORT: Viewport = { width: 1_280, height: 800 };
/**
 * Reserved slug for the chrome-relay engine. The relay is a single running
 * Chrome with a single cookie jar, so exactly one relay lease exists per
 * profile root and it is never confused with an isolated chromium profile.
 */
const RELAY_PROFILE = "relay";

const NAMED_KEYS: Record<string, true> = {
	Enter: true,
	Tab: true,
	Escape: true,
	Backspace: true,
	Delete: true,
	ArrowUp: true,
	ArrowDown: true,
	ArrowLeft: true,
	ArrowRight: true,
	Home: true,
	End: true,
	PageUp: true,
	PageDown: true,
	Space: true,
};

export interface BrowserRuntimeOptions {
	/** Profile root; defaults to `$INSO_HOME/browser` else `~/.inso/browser`. */
	rootDir?: string;
	/** Chrome/Chromium binary. Omitted → puppeteer's installed `chrome` channel. */
	executablePath?: string;
	/** chrome-relay CDP endpoint. Defaults to http://127.0.0.1:9224. */
	relayUrl?: string;
	/** Explicit browser visibility; omitted uses each engine's supported default. */
	headless?: boolean;
}

interface FrameRecord {
	id: string;
	bytes: Buffer;
	url: string;
	revision: number;
	viewport: Viewport;
	capturedAt: string;
}

/** Idempotency record. Survives history pruning; holds no secret payload. */
interface RequestRecord {
	action: PendingAction;
	fingerprint: string;
}


interface Entry {
	/** Opaque capability. Never journalled, never listed, never re-handed-out. */
	browserId: string;
	/** Non-secret id used in durable records in place of the capability. */
	sessionId: string;
	profile: string;
	engine: BrowserEngine;
	viewport: Viewport;
	driver: EngineDriver;
	documentId: string;
	release(): void;
	revision: number;
	actions: PendingAction[];
	/** Memory-only executable payloads (may contain typed secrets), by action id. */
	payloads: Map<string, BrowserAction>;
	byRequest: Map<string, RequestRecord>;
	frames: FrameRecord[];
	/** Per-browser serializer: all page work and all approvals run in order. */
	queue: Promise<unknown>;
	closed: boolean;
}

export class BrowserRuntime implements BrowserRuntimePort {
	private readonly store: ProfileStore;
	private readonly options: BrowserRuntimeOptions;
	private readonly byId = new Map<string, Entry>();
	private readonly byProfile = new Map<string, Entry>();
	/** In-flight launches, so a second open cannot race a first one. */
	private readonly opening = new Map<string, Promise<Entry>>();
	/**
	 * Per-runtime HMAC key for action fingerprints. Keyed so a fingerprint is
	 * never a guessable digest of a typed password, and process-local so it
	 * never reaches disk.
	 */
	private readonly fingerprintKey = randomBytes(32);
	private disposed = false;

	constructor(options: BrowserRuntimeOptions = {}) {
		this.options = options;
		this.store = new ProfileStore(options.rootDir);
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Open a browser for `profile` and mint a fresh capability for it.
	 *
	 * A profile that is already open — or in the middle of opening — is REFUSED.
	 * One engine server serves many sessions, so returning the live browserId of
	 * somebody else's browser would hand out their capability; and launching a
	 * second Chrome on the same user-data dir would fork the cookie jar. The
	 * holder of the existing capability closes it, or the caller picks another
	 * profile.
	 */
	async open(options: BrowserOpenOptions): Promise<BrowserState> {
		if (this.disposed) fail("disposed", "runtime has been disposed");
		const profile = validateProfile(options.profile);
		const engine = normalizeEngine(options.engine);
		const viewport = normalizeViewport(options.viewport);

		// The relay is ONE already-running Chrome with ONE cookie jar, chosen by
		// the human inside Chrome. Named relay profiles would imply an isolation
		// that does not exist, so the slug "relay" is reserved for it and is the
		// only slug it accepts. Other engines own their persistent profile data.
		if (engine === "chrome-relay" && profile !== RELAY_PROFILE) {
			fail(
				"bad_profile",
				`the chrome-relay engine attaches to the one Chrome already running, so it always uses the reserved profile "${RELAY_PROFILE}"; ` +
					`choose another engine for separate, isolated profiles`,
			);
		}
		if (engine !== "chrome-relay" && profile === RELAY_PROFILE) {
			fail("bad_profile", `profile "${RELAY_PROFILE}" is reserved for the chrome-relay engine`);
		}
		const live = this.byProfile.get(profile);
		if (live || this.opening.has(profile)) {
			fail(
				"profile_in_use",
				`profile "${profile}" is already open in this runtime; close that browser before opening it again`,
			);
		}
		// Count launches in flight too: four concurrent opens must not slip past
		// the bound just because none of them has finished launching yet.
		if (this.byId.size + this.opening.size >= MAX_BROWSERS) {
			fail("too_many_browsers", `at most ${MAX_BROWSERS} browsers may be open at once; close one first`);
		}

		const started = this.launch(profile, engine, viewport).finally(() => this.opening.delete(profile));
		this.opening.set(profile, started);
		const entry = await started;
		return await this.buildState(entry);
	}

	private async launch(profile: string, engine: BrowserEngine, viewport: Viewport): Promise<Entry> {
		const lock = this.store.acquireLock(profile);
		let released = false;
		let entry: Entry | undefined;
		let driver: EngineDriver | undefined;
		const release = (): void => {
			if (released) return;
			this.store.releaseLock(lock);
			released = true;
			if (entry) this.detach(entry);
		};
		try {
			// Native backends never reuse an incompatible engine's cookie store.
			const profileDirectory = engine === "chromium" ? this.store.userDataDir(profile)
				: engine === "abp" ? this.store.profileDir(profile)
				: join(this.store.profileDir(profile), engine);
			driver = await createEngineDriver(engine, {
				profileDirectory, viewport, onClosed: release,
				...(this.options.headless === undefined ? {} : { headless: this.options.headless }),
				...(this.options.executablePath && engine !== "abp" ? { executablePath: this.options.executablePath } : {}),
				...(this.options.relayUrl && engine === "chrome-relay" ? { relayUrl: this.options.relayUrl } : {}),
			});
			const initial = await driver.state();
			if (released) fail("browser_closed", "The browser closed during initialization.");
			entry = {
				browserId: randomBytes(24).toString("base64url"),
				sessionId: randomBytes(8).toString("hex"),
				profile, engine, viewport: initial.viewport, documentId: initial.documentId,
				driver, release, revision: 1, actions: [], payloads: new Map(),
				byRequest: new Map(), frames: [], queue: Promise.resolve(), closed: false,
			};
			this.byId.set(entry.browserId, entry);
			this.byProfile.set(profile, entry);
			return entry;
		} catch (error) {
			// A factory owns rollback until it returns; only its confirmed-close
			// callback may release a failed launch. Never infer exit from failure.
			if (driver) {
				await driver.close();
				release();
			}
			throw error;
		}
	}


	async close(browserId: string): Promise<void> {
		// A failed close revokes reads/actions but remains retryable for cleanup.
		const entry = this.byId.get(browserId);
		if (!entry) fail("unknown_browser", "Unknown or already closed browserId.");
		await this.serialize(entry, () => this.teardown(entry), { evenIfClosed: true });
	}

	/** Retain ownership and the lock until the driver confirms shutdown. */
	private async teardown(entry: Entry): Promise<void> {
		if (this.byId.get(entry.browserId) !== entry) return;
		entry.closed = true;
		entry.frames.length = 0;
		entry.payloads.clear();
		await entry.driver.close();
		entry.release();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		// Let in-flight launches finish first: a browser born after we started
		// disposing would otherwise outlive the runtime holding its lock.
		await Promise.allSettled([...this.opening.values()]);
		const errors: string[] = [];
		for (const entry of [...this.byId.values()]) {
			await this.serialize(entry, () => this.teardown(entry), { evenIfClosed: true }).catch((err) =>
				errors.push(describe(err)),
			);
		}
		if (errors.length > 0) fail("dispose_incomplete", `some browsers did not shut down cleanly: ${errors.join("; ")}`);
	}

	/** Drop in-memory state and make the capability dead. Does NOT free the lock. */
	private detach(entry: Entry): void {
		entry.closed = true;
		entry.frames.length = 0;
		// Any still-unapproved typed text dies with the browser; it is memory-only
		// and there is nothing on disk to reconstruct it from.
		entry.payloads.clear();
		this.byId.delete(entry.browserId);
		if (this.byProfile.get(entry.profile) === entry) this.byProfile.delete(entry.profile);
	}


	// -----------------------------------------------------------------------
	// Read paths
	// -----------------------------------------------------------------------

	async state(browserId: string): Promise<BrowserState> {
		return await this.serialize(this.require(browserId), (entry) => this.buildState(entry));
	}

	async frame(browserId: string): Promise<BrowserFrame> {
		return await this.serialize(this.require(browserId), async (entry) => {
			const before = await this.refreshState(entry);
			const revision = entry.revision;
			const url = before.url;
			const shot = await entry.driver.screenshot();
			const capturedAt = new Date().toISOString();
			const state = await this.buildState(entry);
			if (entry.revision !== revision || state.url !== url) {
				fail("stale_frame", "The page navigated during capture; request a new frame.");
			}
			const bytes = Buffer.from(shot.buffer, shot.byteOffset, shot.byteLength);
			if (bytes.length > MAX_FRAME_BYTES) {
				fail("frame_too_large", `screenshot is ${bytes.length} bytes, above the ${MAX_FRAME_BYTES} byte limit`);
			}
			const record: FrameRecord = {
				id: randomBytes(12).toString("hex"),
				bytes,
				url,
				revision,
				viewport: entry.viewport,
				capturedAt,
			};
			entry.frames.push(record);
			while (entry.frames.length > MAX_FRAMES_RETAINED) entry.frames.shift();
			return {
				state,
				frameId: record.id,
				mimeType: "image/png" as const,
				data: bytes.toString("base64"),
				capturedAt: record.capturedAt,
			};
		});
	}

	async snapshot(browserId: string): Promise<{ state: BrowserState; text: string }> {
		return await this.serialize(this.require(browserId), async (entry) => {
			await this.refreshState(entry);
			const revision = entry.revision;
			const text = await entry.driver.snapshot(MAX_SNAPSHOT_CHARS);
			const state = await this.buildState(entry);
			if (entry.revision !== revision) fail("stale_snapshot", "The document changed during inspection.");
			return { state, text };
		});
	}

	/**
	 * Crop the STORED bytes of `frameId` and attach bounded live element context.
	 *
	 * Honesty note baked into the returned payload: the crop is the captured
	 * frame, while the element list is read from the page as it is NOW. On a
	 * dynamic page those can disagree even at the same revision; we never claim
	 * they are the same instant.
	 */
	async annotate(
		browserId: string,
		frameId: string,
		region: BrowserRegion,
		note: string,
	): Promise<BrowserAnnotation> {
		const entry = this.require(browserId);
		const text = note ?? "";
		if (typeof text !== "string" || text.length > MAX_NOTE_CHARS) {
			fail("bad_note", `note must be a string of at most ${MAX_NOTE_CHARS} characters`);
		}
		return await this.serialize(entry, async () => {
			await this.refreshState(entry);
			const record = entry.frames.find((f) => f.id === frameId);
			if (!record) {
				fail("unknown_frame", `frame ${frameId} is not retained (only the last ${MAX_FRAMES_RETAINED} frames are)`);
			}
			if (record.revision !== entry.revision) {
				fail(
					"stale_frame",
					`frame ${frameId} was captured at revision ${record.revision}; the page is now at revision ${entry.revision}. Capture a new frame.`,
				);
			}
			const { png, region: clamped } = cropRegion(record.bytes, region);
			const elements = await entry.driver.elements(clamped, MAX_ELEMENT_CHARS);
			await this.refreshState(entry);
			if (record.revision !== entry.revision) fail("stale_frame", "The document changed while reading annotation context.");
			return {
				url: record.url,
				note: text,
				region: clamped,
				capturedAt: record.capturedAt,
				mimeType: "image/png" as const,
				data: png.toString("base64"),
				elements:
					`${elements}\n\n[live DOM read at ${new Date().toISOString()}, revision ${entry.revision}; ` +
					`the image is the frame captured at ${record.capturedAt} — a dynamic page may have changed between them]`,
			};
		});
	}

	async profiles(): Promise<string[]> {
		return this.store.list();
	}

	// -----------------------------------------------------------------------
	// Action ledger
	// -----------------------------------------------------------------------

	async requestAction(browserId: string, requestId: string, action: BrowserAction): Promise<PendingAction> {
		const entry = this.require(browserId);
		if (typeof requestId !== "string" || !/^[\w:.-]{1,128}$/.test(requestId)) {
			fail("bad_request_id", "requestId must be 1-128 chars of [A-Za-z0-9_:.-]");
		}

		// Same serializer as approvals: a request must not interleave with the
		// approval that is currently mutating this browser's ledger.
		return await this.serialize(entry, async () => {
		const normalized = normalizeAction(action, entry.viewport);
		// Keyed fingerprint, memory-only: never a bare digest of typed text, never
		// persisted, and useless to anyone who did not launch this process.
		const fingerprint = createHmac("sha256", this.fingerprintKey).update(JSON.stringify(normalized)).digest("hex");
			// Idempotency is scoped to this browser: same requestId + same payload is
			// the same action; same requestId + different payload is a bug, not a new
			// request, and is refused rather than silently queued twice.
			const prior = entry.byRequest.get(requestId);
			if (prior) {
				if (prior.fingerprint !== fingerprint) {
					fail("request_conflict", `requestId ${requestId} was already used with a different action payload`);
				}
				return clone(prior.action);
			}
			await this.refreshState(entry);
			if (entry.byRequest.size >= MAX_REQUEST_RECORDS) {
				// Refusing is the safe end of this road. Forgetting an id instead would
				// let an already-executed request be re-requested and re-approved.
				fail(
					"request_ledger_full",
					`this browser has recorded ${MAX_REQUEST_RECORDS} request ids; close it and open a new one`,
				);
			}
			const pendingCount = entry.actions.filter((a) => a.status === "pending").length;
			if (pendingCount >= MAX_PENDING_ACTIONS) {
				fail("too_many_pending", `at most ${MAX_PENDING_ACTIONS} pending actions per browser; resolve some first`);
			}

			const pending: PendingAction = {
				id: randomBytes(12).toString("hex"),
				requestId,
				// The ledger — and therefore every state/receipt the caller ever sees —
				// holds the REDACTED action. The UI already knows what the human typed;
				// the receipt intentionally does not repeat it.
				action: redact(normalized),
				status: "pending",
				revision: entry.revision,
			};
			// The executable payload stays in memory, keyed by action id, and is
			// discarded the moment the action reaches a terminal status.
			entry.payloads.set(pending.id, normalized);
			entry.actions.push(pending);
			entry.byRequest.set(requestId, { action: pending, fingerprint });
			this.prune(entry);
			await this.store.journal(entry.profile, {
				at: new Date().toISOString(),
				session: entry.sessionId,
				actionId: pending.id,
				requestId,
				status: "pending",
				revision: pending.revision,
				kind: normalized.kind,
			});
			return clone(pending);
		});
	}

	async previewAction(browserId: string, actionId: string): Promise<BrowserAction> {
		return this.serialize(this.require(browserId), async entry => {
			await this.refreshState(entry);
			const pending = entry.actions.find(action => action.id === actionId) ?? this.tombstone(entry, actionId);
			if (!pending) fail("unknown_action", "The action does not belong to this browser.");
			if (pending.status !== "pending") fail("action_settled", "The action is no longer pending.");
			if (pending.revision !== entry.revision) fail("stale_action", "The page changed after this action was requested.");
			const payload = entry.payloads.get(actionId);
			if (!payload) fail("missing_payload", "The pending action payload is unavailable.");
			return { ...payload };
		});
	}

	/**
	 * Approve or deny a pending action. Approval is the ONLY path that touches
	 * the page, runs exactly once, and is serialized per browser.
	 */
	async resolveAction(browserId: string, actionId: string, approve: boolean, signal?: AbortSignal): Promise<PendingAction> {
		return this.serialize(this.require(browserId), async entry => {
			const pending = entry.actions.find(action => action.id === actionId) ?? this.tombstone(entry, actionId);
			if (!pending) fail("unknown_action", `No action ${actionId} on this browser.`);
			if (pending.status !== "pending") fail("action_settled", `Action ${actionId} is already ${pending.status}.`);
			if (!approve) {
				pending.status = "denied";
				entry.payloads.delete(pending.id);
				await this.record(entry, pending, "denied");
				return clone(pending);
			}

			let prepared: PreparedAction | undefined;
			let dispatched = false;
			try {
				signal?.throwIfAborted();
				await this.assertRevision(entry, pending.revision);
				const payload = entry.payloads.get(pending.id);
				if (!payload) fail("missing_payload", "The executable action payload is no longer held in memory.");
				prepared = await entry.driver.prepare(payload, entry.documentId);
				signal?.throwIfAborted();
				await this.assertRevision(entry, pending.revision);
				// Persist the claim before any input. Page-originated navigation can
				// happen during either preparation or fsync, despite our serializer.
				pending.status = "claimed";
				await this.record(entry, pending, "claimed");
				await this.assertRevision(entry, pending.revision);
				signal?.throwIfAborted();
				dispatched = true;
				await prepared.dispatch();
				pending.status = "completed";
			} catch (error) {
				// Backend errors can echo the entire input (including passwords).
				// Keep execution status, never publish third-party details for typing.
				const detail = entry.payloads.get(pending.id)?.kind === "type"
					? "Typed-input error details withheld to protect the entered text."
					: describe(error);
				pending.status = dispatched ? "unknown" : "failed";
				pending.error = dispatched
					? `Dispatched, then failed; the effect may or may not have occurred: ${detail}`
					: `Not dispatched: ${detail}`;
			} finally {
				if (dispatched) entry.revision += 1;
				entry.payloads.delete(pending.id);
				await prepared?.dispose?.().catch(() => undefined);
			}
			await this.record(entry, pending, pending.status);
			return clone(pending);
		});
	}


	private async record(entry: Entry, pending: PendingAction, status: string): Promise<void> {
		await this.store.journal(entry.profile, {
			at: new Date().toISOString(),
			session: entry.sessionId,
			actionId: pending.id,
			requestId: pending.requestId,
			status,
			revision: entry.revision,
			kind: pending.action.kind,
		});
	}

	/** An action pruned from the visible history but still known by requestId. */
	private tombstone(entry: Entry, actionId: string): PendingAction | undefined {
		for (const record of entry.byRequest.values()) {
			if (record.action.id === actionId) return record.action;
		}
		return undefined;
	}

	/**
	 * Keep the VISIBLE history bounded by dropping the oldest settled actions.
	 * Their idempotency records stay in `byRequest`, so a pruned requestId is
	 * still recognized and can never be executed a second time.
	 */
	private prune(entry: Entry): void {
		while (entry.actions.length > MAX_ACTIONS_RETAINED) {
			const index = entry.actions.findIndex((a) => a.status !== "pending" && a.status !== "claimed");
			if (index < 0) return;
			const [dropped] = entry.actions.splice(index, 1);
			entry.payloads.delete(dropped.id);
		}
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private require(browserId: string): Entry {
		const entry = typeof browserId === "string" ? this.byId.get(browserId) : undefined;
		// Same error for "never existed" and "closed": the id is a capability and
		// the difference is not something an unauthorized caller should learn.
		if (!entry || entry.closed) fail("unknown_browser", "unknown or already closed browserId");
		return entry;
	}

	/**
	 * All work for one browser runs strictly in order, never concurrently. The
	 * closed check is re-taken when the work actually starts: the browser may
	 * have been closed (or have crashed) while this call sat in the queue.
	 */
	private serialize<T>(
		entry: Entry,
		work: (entry: Entry) => Promise<T>,
		options: { evenIfClosed?: boolean } = {},
	): Promise<T> {
		const run = async (): Promise<T> => {
			if (entry.closed && !options.evenIfClosed) fail("unknown_browser", "unknown or already closed browserId");
			return await work(entry);
		};
		const next = entry.queue.then(run, run);
		entry.queue = next.catch(() => undefined);
		return next;
	}

	private async refreshState(entry: Entry): Promise<EngineState> {
		if (entry.closed) fail("unknown_browser", "Unknown or already closed browserId.");
		const state = await entry.driver.state();
		if (entry.closed) fail("unknown_browser", "The browser closed during inspection.");
		if (state.documentId !== entry.documentId || state.viewport.width !== entry.viewport.width || state.viewport.height !== entry.viewport.height) {
			entry.revision += 1;
			entry.documentId = state.documentId;
			entry.viewport = state.viewport;
		}
		return state;
	}

	private async assertRevision(entry: Entry, expected: number): Promise<void> {
		await this.refreshState(entry);
		if (entry.revision !== expected) fail("stale_action", `Stale approval: requested at revision ${expected}, page is at ${entry.revision}`);
	}

	private async buildState(entry: Entry): Promise<BrowserState> {
		const state = await this.refreshState(entry);
		return {
			browserId: entry.browserId, profile: entry.profile, engine: entry.engine,
			url: state.url, title: state.title, revision: entry.revision,
			viewport: state.viewport, actions: entry.actions.map(clone),
		};
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeEngine(engine: BrowserEngine | undefined): BrowserEngine {
	const selected = engine ?? "chromium";
	if (BROWSER_ENGINES.includes(selected)) return selected;
	fail("bad_engine", `Unsupported engine ${JSON.stringify(engine)}`);
}

function normalizeViewport(viewport: Viewport | undefined): Viewport {
	if (!viewport) return DEFAULT_VIEWPORT;
	const { width, height } = viewport;
	if (!Number.isFinite(width) || !Number.isFinite(height)) fail("bad_viewport", "viewport dimensions must be numbers");
	return {
		width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(width))),
		height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.floor(height))),
	};
}

/**
 * Validate and canonicalize an action. Everything the ledger stores is already
 * checked; the dispatch path re-validates nothing and invents nothing.
 */
function normalizeAction(action: BrowserAction, viewport: Viewport): BrowserAction {
	if (!action || typeof action !== "object") fail("bad_action", "action must be an object");
	switch (action.kind) {
		case "navigate": {
			if (typeof action.url !== "string" || action.url.length > MAX_URL_LENGTH) {
				fail("bad_action", `navigate.url must be a string of at most ${MAX_URL_LENGTH} characters`);
			}
			let parsed: URL;
			try {
				parsed = new URL(action.url);
			} catch {
				fail("bad_action", `navigate.url ${JSON.stringify(action.url)} is not an absolute URL`);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				// javascript:, file:, data:, blob:, chrome: are all refused — a
				// navigation must never become script execution or local file reads.
				fail("bad_action", `only http and https navigations are allowed, got ${parsed.protocol}`);
			}
			if (parsed.username || parsed.password) {
				fail("bad_action", "Credentials in navigation URLs are not supported; sign in through the browser.");
			}
			return { kind: "navigate", url: parsed.toString() };
		}
		case "click": {
			if (typeof action.selector === "string") {
				return { kind: "click", selector: requireSelector(action.selector) };
			}
			const x = requireCoordinate(action.x, "x", viewport.width);
			const y = requireCoordinate(action.y, "y", viewport.height);
			return { kind: "click", x, y };
		}
		case "type": {
			// An empty string is legal and means "clear the field".
			if (typeof action.text !== "string" || action.text.length > MAX_TEXT_INPUT) {
				fail("bad_action", `type.text must be a string of at most ${MAX_TEXT_INPUT} characters`);
			}
			return { kind: "type", selector: requireSelector(action.selector), text: action.text };
		}
		case "press": {
			const key = action.key;
			if (typeof key !== "string" || (!NAMED_KEYS[key] && [...key].length !== 1)) {
				fail("bad_action", `press.key must be a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}`);
			}
			return { kind: "press", key };
		}
		case "scroll": {
			const deltaX = requireDelta(action.deltaX ?? 0, "deltaX");
			const deltaY = requireDelta(action.deltaY ?? 0, "deltaY");
			if (deltaX === 0 && deltaY === 0) fail("bad_action", "scroll needs a non-zero deltaX or deltaY");
			return { kind: "scroll", deltaX, deltaY };
		}
		default:
			fail("bad_action", `unsupported action kind ${JSON.stringify((action as BrowserAction).kind)}`);
	}
}

function requireSelector(selector: unknown): string {
	if (typeof selector !== "string" || selector.trim().length === 0 || selector.length > MAX_SELECTOR_CHARS) {
		fail("bad_action", `selector must be a non-empty CSS selector of at most ${MAX_SELECTOR_CHARS} characters`);
	}
	return selector.trim();
}

function requireCoordinate(value: unknown, name: string, bound: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail("bad_action", `click needs a selector or finite ${name} coordinate`);
	}
	const rounded = Math.floor(value);
	if (rounded < 0 || rounded >= bound) {
		fail("bad_action", `click.${name}=${rounded} is outside the ${bound}px viewport`);
	}
	return rounded;
}

function requireDelta(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail("bad_action", `scroll.${name} must be a number`);
	return Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, Math.floor(value)));
}


// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clone(action: PendingAction): PendingAction {
	return { ...action, action: { ...action.action } };
}

/**
 * The ledger copy of an action, safe to persist and to hand back in state or a
 * receipt. Typed text is a credential boundary: the UI already showed the human
 * what they typed, so the receipt deliberately does not repeat it, and no hash
 * of it is stored either (an offline guessing target).
 */
function redact(action: BrowserAction): BrowserAction {
	if (action.kind !== "type") return { ...action };
	return { ...action, text: "[redacted]" };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

