/**
 * BrowserRuntime — the browsers this pack holds, shared by the agent and the View.
 *
 * Design rules:
 *  - Actions execute when asked. The agent session (its permission mode, its
 *    own `ask`) decides whether to act; this runtime never second-guesses it.
 *  - One safety property is kept: an action that errors AFTER it was
 *    dispatched is reported `unknown` — it may have taken effect — and is never
 *    retried here. Only a caller that knows the page can decide to retry.
 *  - `browserId` is an opaque capability minted per open, never listed and
 *    never re-handed-out; `profiles()` lists profile names only.
 *  - Persistent profiles are never deleted, foreign locks are never stolen, a
 *    profile lock is released only once the owned Chrome process is gone, and a
 *    relay (the human's own Chrome) is never closed.
 *  - A browser opened without a profile is throwaway: its own directory under
 *    `ephemeral/`, no lock, deleted once its Chrome process is gone (and swept by
 *    the next server if this one died first). It keeps no sign-in, so whatever
 *    needs a saved profile refuses it (`profile_required`).
 *  - Whole tasks run on upstream agent loops (jev, browser-use) against the
 *    same Chrome, through `task.ts`. We keep their progress, not their logic.
 *  - Sign-in is only ever OBSERVED, never derived: a publish result that says
 *    signed-in, not-signed-in or posted is persisted per profile (never for
 *    the relay) and announced to `onConnectionsChanged` listeners, which the
 *    server turns into its connection report (connection.ts).
 */
import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { type ConnectionObservations, siteHost } from "./connection.js";
import { RELAY_PROFILE } from "./profile-name.js";
import type {
	ActionResult,
	ActManyResult,
	BatchStep,
	EvalStep,
	LogEntry,
	ModelShot,
	ShotRequest,
	TabOp,
	CredentialUse,
	HandledDialog,
	BrowserAction,
	BrowserAnnotation,
	BrowserEngine,
	BrowserFrame,
	UnchangedFrame,
	BrowserOpenOptions,
	BrowserRegion,
	BrowserRuntimePort,
	BrowserState,
	FrameFormat,
	MouseButton,
	PresetRef,
	PublishCheck,
	PublishMode,
	PublishRecipe,
	PublishExpectation,
	PublishRecord,
	ReadRequest,
	ReadResult,
	TabRequest,
	TaskRequest,
	TaskRun,
	TaskStep,
	ToolCaller,
	Viewport,
	InspectResult,
	WaitRequest,
	WaitResult,
	StepOutcome,
	StepStatus,
} from "./contracts.js";
import { BROWSER_ENGINES, MAX_BATCH_STEPS, MAX_EVAL_EXPRESSION_CHARS, MAX_EVAL_RESULT_CHARS, MAX_VIEWPORT, MAX_WAIT_MS, MIN_VIEWPORT, TASK_AGENTS } from "./contracts.js";
import { credentialOrigin, resolveCredential, savedPassword, savedPasswords } from "./credentials.js";
import { assertEngineAvailable, createEngineDriver } from "./engines/index.js";
import { launchReader } from "./engines/puppeteer.js";
import type { EngineDriver, EngineState, EvalOutcome, PageReader, PasswordSource, PerformOutcome, WaitCondition } from "./engines/types.js";
import { cropRegion, MAX_FRAME_BYTES } from "./image.js";
import { type Publication, cancel, confirm, isPending, prepare, publishRecord, requirePending, validateMode, validateRecipe, waitSettled } from "./publish.js";
import { blockedReason, DEFAULT_READ_CHARS, MAX_READ_CHARS, READ_TIMEOUT_MS, readPolicy, TIMEOUT_REASON } from "./read.js";
import { ActionNotDispatched, fail, ProfileStore, validateProfile } from "./store.js";
import { type RunningWorker, startWorker } from "./task.js";

// ---------------------------------------------------------------------------
// Bounds. Every unbounded thing in a long-lived runtime is a leak or a weapon.
// ---------------------------------------------------------------------------
const MAX_BROWSERS = 4;
/** browser_read's reader browser is closed this long after its last read. */
const READER_IDLE_MS = 60_000;
const MAX_FRAMES_RETAINED = 8;
/** A batch takes no new step after this long: a host times a tool call out (the desktop at 30 s). */
const ACT_BUDGET_MS = 20_000;
/** Dialogs a batch reports, as many as a state does. */
const MAX_BATCH_DIALOGS = 5;
const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_ELEMENT_CHARS = 4_000;
const MAX_TEXT_INPUT = 4_096;
const MAX_NOTE_CHARS = 8_192;
const MAX_SELECTOR_CHARS = 512;
const MAX_TAB_ID_CHARS = 128;
const MOUSE_BUTTONS: readonly MouseButton[] = ["left", "right", "middle"];
const MAX_URL_LENGTH = 2_048;
const MAX_SCROLL_DELTA = 5_000;
const MAX_TASK_CHARS = 8_192;
const MAX_TASK_STEPS = 200;
const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MATCH_CHARS = 2_048;
const DEFAULT_TASK_STEPS = 60;
const TASK_STEPS_RETAINED = 100;
const DEFAULT_VIEWPORT: Viewport = { width: 1_280, height: 800 };
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
/** View input that can press the site's own submit; scroll, hover and navigation cannot. */
const TOUCHING_KINDS: Partial<Record<BrowserAction["kind"], true>> = { click: true, press: true, type: true, insert: true };

export interface BrowserRuntimeOptions {
	/** Profile root; defaults to `$INSO_HOME/browser` else `~/.inso/browser`. */
	rootDir?: string;
	/** Chrome/Chromium binary. Omitted → the View picks installed Chrome, then Edge, then a Chromium (engines/launch.ts); the reader uses puppeteer's `chrome` channel. */
	executablePath?: string;
	/** chrome-relay CDP endpoint. Defaults to http://127.0.0.1:9224. */
	relayUrl?: string;
	/** Explicit browser visibility; omitted uses each engine's supported default. */
	headless?: boolean;
	/** How long a batch (`actMany`) may go on taking steps; defaults to ACT_BUDGET_MS. */
	actBudgetMs?: number;
	/**
	 * TESTS ONLY: exact hostnames browser_read may reach although they are
	 * loopback/private (the local fixture on 127.0.0.1). Never set in
	 * production; it is not reachable from any tool input.
	 */
	allowPrivateReadHosts?: readonly string[];
}

/** A wait step after `validateWait`. */
interface PlannedWait { kind: "wait"; condition: WaitCondition; timeoutMs: number }

/** What one step did, before it is filed in a result. */
interface StepDone { status: StepStatus; error?: string; credential?: CredentialUse; dialogs?: HandledDialog[]; value?: string; truncated?: boolean }

/** A dispatched action either completed or was reported `failed`/`unknown`, never a throw. */
type Dispatched = { status: "completed"; credential?: CredentialUse; dialogs?: HandledDialog[] } | { status: "failed" | "unknown"; error: string };

/** A tab step after `admitTab`: `url`, when given, is already canonical. */
interface PlannedTab { kind: "tab"; op: TabOp; tabId?: string; url?: string }

/** An eval step that was admitted: the browser is a throwaway one. */
interface PlannedEval { kind: "eval"; expression: string }

type PlannedStep = BrowserAction | PlannedWait | PlannedTab | PlannedEval;

interface FrameRecord {
	id: string;
	bytes: Buffer;
	url: string;
	revision: number;
	viewport: Viewport;
	capturedAt: string;
}

interface Entry {
	/** Opaque capability. Never listed, never re-handed-out. */
	browserId: string;
	/** null: a throwaway browser (no saved profile). */
	profile: string | null;
	engine: BrowserEngine;
	viewport: Viewport;
	driver: EngineDriver;
	documentId: string;
	release(): void;
	revision: number;
	frames: FrameRecord[];
	/** Per-browser serializer: page reads and actions run in order. */
	queue: Promise<unknown>;
	closed: boolean;
	/** The running or most recent task. */
	task: TaskRun | null;
	/** The live task worker, while one runs. */
	worker: { process: RunningWorker; finished: Promise<TaskRun> } | null;
	/** The current or most recent publish (publish.ts). */
	publish: Publication | null;
	/**
	 * Saved passwords this browser typed or handed a task worker. With every
	 * password the profile holds on disk, they are replaced in every page read
	 * handed back (snapshot, state, act results, annotation context), so a page
	 * that reveals or copies one — a show-password toggle flipping the field to
	 * text — never returns it. Kept in memory too: a deleted or unreadable
	 * credentials file must not un-redact a password already typed.
	 */
	secrets: Set<string>;
	/**
	 * The newest log entry (`LogEntry.n`) a model has read (browser_state) and the newest one it was told the count
	 * of (`newErrors`), so each is reported once; the View reads neither.
	 */
	logRead: number;
	logNoticed: number;
}

export class BrowserRuntime implements BrowserRuntimePort {
	private readonly store: ProfileStore;
	private readonly options: BrowserRuntimeOptions;
	private readonly byId = new Map<string, Entry>();
	private readonly byProfile = new Map<string, Entry>();
	/**
	 * The browser the human opened or is viewing in each session, by the session id the HOST stamped on the call
	 * (never one a caller passed). It lets that session's model find a browser it was never handed an id for;
	 * an entry goes when its browser does.
	 */
	private readonly viewBySession = new Map<string, string>();
	/** In-flight launches, so a second open cannot race a first one. */
	private readonly opening = new Map<string, Promise<Entry>>();
	/**
	 * browser_read's headless reader (no profile; a fresh incognito context per
	 * read). It takes one slot of MAX_BROWSERS while it lives, closes after
	 * READER_IDLE_MS without a read, and is evicted for a Browser View open when
	 * the pool is full. Its launch, its reads and its close run in order on
	 * `readerQueue`.
	 */
	private pageReader: PageReader | null = null;
	private readerLaunching = false;
	private readerQueue: Promise<unknown> = Promise.resolve();
	private readerIdle: NodeJS.Timeout | undefined;
	/**
	 * Drivers whose rollback close failed during launch. Their shutdown is
	 * unconfirmed, so their profile lock is deliberately retained; keeping the
	 * driver here is what makes that close retryable instead of orphaning a
	 * process the runtime can no longer name.
	 */
	private readonly stranded = new Set<{ driver: EngineDriver; release: () => void }>();
	/** Throwaway directories being deleted; `close` and `dispose` wait for them. */
	private readonly removals = new Set<Promise<void>>();
	private disposed = false;
	private readonly connectionListeners = new Set<() => void>();
	/** Profiles with persisted observations, so a deleted one is noticed and reported gone. */
	private readonly observedProfiles = new Set<string>();
	/** Watches the profile root for deletions while anyone listens for connection changes. */
	private profileWatcher: FSWatcher | undefined;

	constructor(options: BrowserRuntimeOptions = {}) {
		this.options = options;
		this.store = new ProfileStore(options.rootDir);
		// Only what a dead server abandoned: a live server's throwaway browsers are never touched.
		this.store.sweepEphemeral();
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Open a browser and mint a fresh capability for it.
	 *
	 * With a `profile` it runs on that persistent profile. A profile that is
	 * already open — or in the middle of opening — is REFUSED. One engine server
	 * serves many sessions, so returning the live browserId of somebody else's
	 * browser would hand out their capability; and launching a second Chrome on
	 * the same user-data dir would fork the cookie jar. The holder of the
	 * existing capability closes it, or the caller picks another profile.
	 *
	 * Without a `profile` it is a throwaway browser: a directory of its own that
	 * is deleted when it closes, so it can never collide with another browser.
	 */
	async open(options: BrowserOpenOptions): Promise<BrowserState> {
		if (this.disposed) fail("disposed", "runtime has been disposed");
		// browser_read's reader never keeps the human from a browser: when it
		// holds the last slot it is closed (after any read in progress) first.
		if (this.byId.size + this.opening.size >= MAX_BROWSERS - 1 && this.readerHeld()) await this.closeReader();
		if (this.disposed) fail("disposed", "runtime has been disposed");
		const named = options.profile === undefined ? undefined : validateProfile(options.profile);
		const engine = normalizeEngine(options.engine);
		const viewport = normalizeViewport(options.viewport);
		// The relay is the human's own Chrome: there is nothing to make throwaway,
		// so no profile means the one it has.
		const profile = named ?? (engine === "chrome-relay" ? RELAY_PROFILE : null);

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
		if (profile !== null && (this.byProfile.has(profile) || this.opening.has(profile))) {
			fail(
				"profile_in_use",
				`profile "${profile}" is already open in this runtime; close that browser before opening it again`,
			);
		}
		// Count launches in flight too: four concurrent opens must not slip past
		// the bound just because none of them has finished launching yet.
		if (this.byId.size + this.opening.size + (this.readerHeld() ? 1 : 0) >= MAX_BROWSERS) {
			fail("too_many_browsers", `at most ${MAX_BROWSERS} browsers may be open at once; close one first`);
		}

		assertEngineAvailable(engine);
		// A throwaway browser has no name to guard; its slot only counts against the bound. `:` is not a slug character.
		const slot = profile ?? `ephemeral:${randomBytes(8).toString("hex")}`;
		const started = this.launch(profile, engine, viewport).finally(() => this.opening.delete(slot));
		this.opening.set(slot, started);
		const entry = await started;
		return this.redact(entry, await this.buildState(entry));
	}

	private async launch(profile: string | null, engine: BrowserEngine, viewport: Viewport): Promise<Entry> {
		// A saved profile is locked while its browser runs; a throwaway one gets a
		// directory of its own that goes with the browser.
		let directory: string;
		let free: () => void;
		if (profile === null) {
			const ephemeral = this.store.createEphemeral();
			directory = ephemeral.userDataDir;
			free = () => this.discard(ephemeral.dir);
		} else {
			const lock = this.store.acquireLock(profile);
			// Native backends never reuse an incompatible engine's cookie store.
			directory = engine === "chromium" ? this.store.userDataDir(profile) : join(this.store.profileDir(profile), engine);
			free = () => this.store.releaseLock(lock);
		}
		let released = false;
		let entry: Entry | undefined;
		let driver: EngineDriver | undefined;
		const release = (): void => {
			if (released) return;
			free();
			released = true;
			if (entry) this.detach(entry);
		};
		try {
			driver = await createEngineDriver(engine, {
				profileDirectory: directory, viewport, onClosed: release,
				...(this.options.headless === undefined ? {} : { headless: this.options.headless }),
				...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
				...(this.options.relayUrl && engine === "chrome-relay" ? { relayUrl: this.options.relayUrl } : {}),
			});
			const initial = await driver.state();
			if (released) fail("browser_closed", "The browser closed during initialization.");
			entry = {
				browserId: randomBytes(24).toString("base64url"),
				profile, engine, viewport: initial.viewport, documentId: initial.documentId,
				driver, release, revision: 1, frames: [], queue: Promise.resolve(), closed: false,
				task: null, worker: null, publish: null, secrets: new Set(), logRead: 0, logNoticed: 0,
			};
			this.byId.set(entry.browserId, entry);
			if (profile !== null) this.byProfile.set(profile, entry);
			return entry;
		} catch (error) {
			// A factory owns rollback until it returns; only its confirmed-close
			// callback may release a failed launch. Never infer exit from failure.
			if (driver) {
				const orphan = driver;
				try {
					await orphan.close();
					release();
				} catch {
					// Shutdown unconfirmed: keep the lock, and keep the driver
					// reachable so dispose() retries instead of losing a process
					// that may still hold the profile. The launch error is what
					// the caller needs; the close failure is ours to retry.
					this.stranded.add({ driver: orphan, release });
				}
			}
			// A failed throwaway launch leaves nothing behind by the time the caller hears of it.
			await Promise.allSettled(this.removals);
			throw error;
		}
	}

	/** Delete a throwaway browser's directory in the background; `close` and `dispose` wait for it. */
	private discard(dir: string): void {
		const removal: Promise<void> = this.store.removeEphemeral(dir).finally(() => this.removals.delete(removal));
		this.removals.add(removal);
	}

	/** Refused (`publish_pending`) while a publish awaits confirmation, unless `caller` is "app". */
	async close(browserId: string, caller?: ToolCaller): Promise<void> {
		// A failed close revokes reads/actions but remains retryable for cleanup.
		const entry = this.byId.get(browserId);
		if (!entry) fail("unknown_browser", "Unknown or already closed browserId.");
		await this.serialize(entry, async () => {
			if (!entry.closed) refuseWhilePublishing(entry, caller);
			await this.teardown(entry);
		}, { evenIfClosed: true });
		// A throwaway browser's data is gone by the time its close resolves.
		await Promise.allSettled(this.removals);
	}

	/** Retain ownership and the lock until the driver confirms shutdown. */
	private async teardown(entry: Entry): Promise<void> {
		if (this.byId.get(entry.browserId) !== entry) return;
		settleOnClose(entry);
		entry.closed = true;
		entry.frames.length = 0;
		// A task agent drives this Chrome; it stops before the browser does.
		await this.stopTask(entry);
		await entry.driver.close();
		entry.release();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.connectionListeners.clear();
		this.profileWatcher?.close();
		this.profileWatcher = undefined;
		// Let in-flight launches finish first: a browser born after we started
		// disposing would otherwise outlive the runtime holding its lock.
		await Promise.allSettled(this.opening.values());
		const errors: string[] = [];
		// Queued behind any read in flight, so the reader is not closed under it.
		await this.closeReader().catch((err) => errors.push(describe(err)));
		for (const entry of [...this.byId.values()]) {
			await this.serialize(entry, () => this.teardown(entry), { evenIfClosed: true }).catch((err) =>
				errors.push(describe(err)),
			);
		}
		for (const orphan of [...this.stranded]) {
			try {
				await orphan.driver.close();
				orphan.release();
				this.stranded.delete(orphan);
			} catch (err) {
				errors.push(describe(err));
			}
		}
		await Promise.allSettled(this.removals);
		if (errors.length > 0) fail("dispose_incomplete", `some browsers did not shut down cleanly: ${errors.join("; ")}`);
	}

	/** Drop in-memory state and make the capability dead. Does NOT free the lock. */
	private detach(entry: Entry): void {
		settleOnClose(entry);
		entry.closed = true;
		entry.frames.length = 0;
		entry.worker?.process.cancel();
		this.byId.delete(entry.browserId);
		if (entry.profile !== null && this.byProfile.get(entry.profile) === entry) this.byProfile.delete(entry.profile);
		for (const [session, browserId] of this.viewBySession) if (browserId === entry.browserId) this.viewBySession.delete(session);
	}

	bindView(session: string, browserId: string): void {
		const entry = this.byId.get(browserId);
		if (entry && !entry.closed) this.viewBySession.set(session, browserId);
	}

	viewOf(session: string): string | undefined {
		return this.viewBySession.get(session);
	}

	// -----------------------------------------------------------------------
	// Read paths
	// -----------------------------------------------------------------------

	async state(browserId: string): Promise<BrowserState> {
		return await this.serialize(this.require(browserId), async (entry) => this.redact(entry, await this.buildState(entry)));
	}

	/**
	 * `png` (default): a fresh capture, retained so it can be annotated.
	 * `jpeg`: the live screencast's newest frame, straight from memory. It is
	 * deliberately NOT queued behind page work — the live view keeps moving
	 * while a navigation or action is in flight — and is not annotatable.
	 * `since`: the frameId the caller already shows; while it is still the
	 * newest, only the state comes back — a still page costs no pixels.
	 */
	async frame(browserId: string, format?: FrameFormat): Promise<BrowserFrame>;
	async frame(browserId: string, format: "jpeg", since: string | undefined): Promise<BrowserFrame | UnchangedFrame>;
	async frame(browserId: string, format: FrameFormat = "png", since?: string): Promise<BrowserFrame | UnchangedFrame> {
		if (format === "jpeg") {
			const entry = this.require(browserId);
			const live = await entry.driver.liveFrame();
			const state = this.redact(entry, await this.buildState(entry));
			if (since !== undefined && since === live.id) return { state, frameId: live.id, unchanged: true };
			return { state, frameId: live.id, mimeType: "image/jpeg", data: live.data, capturedAt: live.capturedAt };
		}
		if (format !== "png") fail("bad_format", `format must be "jpeg" or "png"`);
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
				state: this.redact(entry, state),
				frameId: record.id,
				mimeType: "image/png" as const,
				data: bytes.toString("base64"),
				capturedAt: record.capturedAt,
			};
		});
	}

	/** A read like `snapshot`; the picture is for a model, so nothing of it is kept (`entry.frames` holds annotatable frames only). */
	async shot(browserId: string, request: ShotRequest = {}): Promise<ModelShot> {
		const scale = request.scale;
		if (scale !== undefined && !(Number.isFinite(scale) && scale > 0 && scale <= 1)) fail("bad_shot", "scale must be above 0 and at most 1");
		if (request.fullPage && request.selector !== undefined) fail("bad_shot", "pass fullPage or selector, not both");
		const selector = request.selector === undefined ? undefined : requireReadSelector(request.selector);
		return await this.serialize(this.require(browserId), async (entry) => {
			const state = await this.refreshState(entry);
			const picture = await entry.driver.shotForModel({
				...(request.fullPage ? { fullPage: true } : {}),
				...(selector === undefined ? {} : { selector }),
				...(scale === undefined ? {} : { scale }),
			});
			return { ...picture, url: this.redact(entry, state.url) };
		});
	}

	async logs(browserId: string): Promise<LogEntry[]> {
		const entry = this.require(browserId);
		const fresh = entry.driver.logs().filter((log) => log.n > entry.logRead);
		entry.logRead = Math.max(entry.logRead, fresh.at(-1)?.n ?? 0);
		return this.redact(entry, fresh);
	}

	/** How many log entries are newer than anything a model was told or shown; they count as told from now on. */
	private noticeLogs(entry: Entry): number {
		const told = Math.max(entry.logRead, entry.logNoticed);
		const entries = entry.driver.logs();
		entry.logNoticed = Math.max(told, entries.at(-1)?.n ?? 0);
		return entries.filter((log) => log.n > told).length;
	}

	async snapshot(browserId: string): Promise<{ state: BrowserState; text: string }> {
		return await this.serialize(this.require(browserId), async (entry) => {
			// A page that swaps its document under the read gets one more try; a second swap is reported.
			for (let attempt = 1; ; attempt += 1) {
				await this.refreshState(entry);
				const revision = entry.revision;
				const text = await entry.driver.snapshot(MAX_SNAPSHOT_CHARS);
				const state = await this.buildState(entry);
				if (entry.revision === revision) return this.redact(entry, { state, text });
				if (attempt === 2) fail("stale_snapshot", "The document changed during inspection.");
			}
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
					`${this.redact(entry, elements)}\n\n[live DOM read at ${new Date().toISOString()}, revision ${entry.revision}; ` +
					`the image is the frame captured at ${record.capturedAt} — a dynamic page may have changed between them]`,
			};
		});
	}

	async profiles(): Promise<string[]> {
		return this.store.list();
	}

	async connections(): Promise<ConnectionObservations> {
		return this.store.allConnections();
	}

	onConnectionsChanged(listener: () => void): () => void {
		this.connectionListeners.add(listener);
		if (this.profileWatcher === undefined && !this.disposed) {
			for (const profile of Object.keys(this.store.allConnections())) this.observedProfiles.add(profile);
			try {
				// A deleted profile directory takes its observations with it; say so.
				this.profileWatcher = watch(this.store.profilesRoot, { persistent: false }, () => {
					const gone = [...this.observedProfiles].filter((profile) => !existsSync(this.store.profileDir(profile)));
					if (gone.length === 0) return;
					for (const profile of gone) this.observedProfiles.delete(profile);
					this.connectionsChanged();
				});
				this.profileWatcher.on("error", () => {
					this.profileWatcher?.close();
					this.profileWatcher = undefined;
				});
			} catch (error) {
				console.error("Browser profile watch failed; a deleted profile is reported at the next observation:", describe(error));
			}
		}
		return () => {
			this.connectionListeners.delete(listener);
			if (this.connectionListeners.size > 0) return;
			this.profileWatcher?.close();
			this.profileWatcher = undefined;
		};
	}

	/**
	 * Persist what a publish just saw about `origin`'s sign-in on this profile
	 * and tell the listeners. Never throws: a report is never worth failing
	 * the publish that observed it.
	 */
	private observeConnection(profile: string, origin: string, signedIn: boolean, account: string | undefined): void {
		const host = siteHost(origin);
		if (profile === RELAY_PROFILE || host === null) return;
		try {
			this.store.recordConnection(profile, host, { signedIn, observedAt: Date.now(), ...(signedIn && account !== undefined ? { account } : {}) });
		} catch (error) {
			console.error("Browser sign-in observation was not saved:", describe(error));
			return;
		}
		this.observedProfiles.add(profile);
		this.connectionsChanged();
	}

	private connectionsChanged(): void {
		for (const listener of this.connectionListeners) {
			try {
				listener();
			} catch (error) {
				console.error("Browser connection listener failed:", describe(error));
			}
		}
	}

	// -----------------------------------------------------------------------
	// Tabs
	// -----------------------------------------------------------------------

	/** Fit the page to the View's size and pixel ratio (bounded like open's viewport; ratio 1-2). */
	async resize(browserId: string, viewport: Viewport, scale = 1): Promise<BrowserState> {
		const entry = this.require(browserId);
		const size = normalizeViewport(viewport);
		const ratio = Number.isFinite(scale) ? Math.min(2, Math.max(1, Math.round(scale * 4) / 4)) : 1;
		return await this.serialize(entry, async () => {
			await entry.driver.resize(size, ratio);
			return this.redact(entry, await this.buildState(entry));
		});
	}

	/**
	 * Open, show or close a tab. Every read and action works on the active tab.
	 * Refused while a task runs: switching away from the agent's tab hides it,
	 * and a hidden tab renders no frames, so the agent would stall.
	 */
	async tab(browserId: string, request: TabRequest, caller?: ToolCaller): Promise<BrowserState> {
		const entry = this.require(browserId);
		const planned = admitTab(request);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			await this.applyTab(entry, planned);
			return this.redact(entry, await this.buildState(entry));
		});
	}

	/** One admitted tab operation, under the caller's lock. */
	private async applyTab(entry: Entry, tab: PlannedTab): Promise<void> {
		switch (tab.op) {
			case "new":
				try {
					await entry.driver.openTab(tab.url);
				} catch (error) {
					fail("tab_failed", `opening a new tab${tab.url ? ` at ${tab.url}` : ""} failed: ${describe(error)}`);
				}
				break;
			case "activate":
				await entry.driver.activateTab(tab.tabId as string);
				break;
			case "close":
				await entry.driver.closeTab(tab.tabId as string);
				break;
		}
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	async act(browserId: string, input: BrowserAction, caller?: ToolCaller): Promise<ActionResult> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			const done = await this.dispatch(entry, this.admit(entry, input, caller), caller);
			if (done.status !== "completed") {
				return this.redact(entry, { status: done.status, error: done.error, state: await this.buildState(entry).catch(() => this.staleState(entry)) });
			}
			return this.redact(entry, {
				status: "completed" as const,
				state: await this.buildState(entry),
				...(done.credential ? { credential: done.credential } : {}),
				...(done.dialogs ? { dialogs: done.dialogs } : {}),
			});
		});
	}

	/**
	 * A batch of steps under the one per-browser lock (a loop of `act` would take it once per step and let another
	 * caller's action land between two of them). Refused once; every step is checked before the first reaches the
	 * page; steps run in order until one is not `completed` or the time budget is spent (a host times a call out, and a
	 * caller that never heard back would send the same submit again). The state is read once, at the end.
	 */
	async actMany(browserId: string, steps: readonly BatchStep[], caller?: ToolCaller): Promise<ActManyResult> {
		const entry = this.require(browserId);
		if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_BATCH_STEPS) fail("bad_action", `actions must be 1-${MAX_BATCH_STEPS} steps`);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			const plan = steps.map((step) => this.admitStep(entry, step, caller));
			const budget = this.options.actBudgetMs ?? ACT_BUDGET_MS;
			const deadline = Date.now() + budget;
			const outcomes: StepOutcome[] = [];
			const dialogs: HandledDialog[] = [];
			// What the batch's eval steps may still return between them.
			let valueChars = MAX_EVAL_RESULT_CHARS;
			let stopped: StepDone | undefined;
			for (const [index, step] of plan.entries()) {
				if (index > 0 && Date.now() >= deadline) {
					stopped = { status: "timeout", error: `the batch's time budget (${budget} ms) ran out after ${index} of ${plan.length} steps; send the remaining steps in a new call` };
					break;
				}
				const done = await this.runStep(entry, step, caller, valueChars);
				valueChars -= done.value?.length ?? 0;
				outcomes.push({
					kind: step.kind,
					status: done.status,
					...(done.error === undefined ? {} : { error: done.error }),
					...(done.credential ? { credential: done.credential } : {}),
					...(done.value === undefined ? {} : { value: done.value }),
					...(done.truncated ? { truncated: true as const } : {}),
				});
				if (done.dialogs) dialogs.push(...done.dialogs);
				if (done.status !== "completed") {
					stopped = done;
					break;
				}
			}
			const state = stopped ? await this.buildState(entry).catch(() => this.staleState(entry)) : await this.buildState(entry);
			const completed = outcomes.filter((outcome) => outcome.status === "completed").length;
			const newErrors = caller === "app" ? 0 : this.noticeLogs(entry);
			return this.redact(entry, {
				status: stopped?.status ?? "completed",
				...(stopped?.error === undefined ? {} : { error: stopped.error }),
				completed,
				steps: outcomes,
				state,
				...(dialogs.length === 0 ? {} : { dialogs: dialogs.slice(-MAX_BATCH_DIALOGS) }),
				...(newErrors === 0 ? {} : { newErrors }),
			});
		});
	}

	private runStep(entry: Entry, step: PlannedStep, caller: ToolCaller | undefined, valueChars: number): Promise<StepDone> {
		switch (step.kind) {
			case "wait":
				return this.waitStep(entry, step);
			case "tab":
				return this.tabStep(entry, step);
			case "eval":
				return this.evalStep(entry, step, valueChars);
			default:
				return this.dispatch(entry, step, caller);
		}
	}

	/**
	 * What about one action needs no page: its shape, and who may use a saved password where. Throws before
	 * anything of a batch is dispatched, so an action that cannot run never leaves its predecessors half done.
	 */
	private admit(entry: Entry, input: BrowserAction, caller: ToolCaller | undefined): BrowserAction {
		const action = normalizeAction(input);
		if (action.useSavedPassword || action.generatePassword) {
			// Opt-in only, and never for the View: the human's keystrokes and
			// pastes arrive as insert and must type exactly what they typed.
			if (caller === "app") fail("bad_action", "useSavedPassword and generatePassword are for the agent; the Browser View types exactly what the human typed");
			this.savedProfile(entry, "typing a saved password");
		}
		return action;
	}

	private admitStep(entry: Entry, step: BatchStep, caller: ToolCaller | undefined): PlannedStep {
		if (!step || typeof step !== "object") fail("bad_action", "each step must be an object");
		switch (step.kind) {
			case "wait":
				return { kind: "wait", ...validateWait(step) };
			case "tab":
				return admitTab(step);
			case "eval":
				return this.admitEval(entry, step);
			default:
				return this.admit(entry, step, caller);
		}
	}

	/** Model-written JavaScript runs only where nothing of the person's is in reach. */
	private admitEval(entry: Entry, step: EvalStep): PlannedEval {
		if (typeof step.expression !== "string" || step.expression.length === 0 || step.expression.length > MAX_EVAL_EXPRESSION_CHARS) {
			fail("bad_action", `eval.expression must be a string of 1-${MAX_EVAL_EXPRESSION_CHARS} characters`);
		}
		if (entry.profile !== null || entry.engine !== "chromium") {
			fail("eval_needs_throwaway", "eval runs your JavaScript in the page, so it only runs in a throwaway browser (no profile, engine chromium); this one holds a saved profile or is the user's own Chrome. Open a throwaway browser with browser_open and eval there.");
		}
		return { kind: "eval", expression: step.expression };
	}

	/** One admitted action, dispatched once on the active tab. A failure is a status, never a throw: earlier steps of a batch stay accounted for. */
	private async dispatch(entry: Entry, action: BrowserAction, caller: ToolCaller | undefined): Promise<Dispatched> {
		// The human driving the pinned page while waiting may hit the site's own submit.
		const pinned = caller === "app" && TOUCHING_KINDS[action.kind] && isPending(entry.publish) ? entry.publish : null;
		// Another tab is not the page being confirmed; an unreadable state counts as the pinned one.
		const touching = pinned !== null && ((await entry.driver.state().catch(() => null))?.activeTabId ?? pinned.record.tabId) === pinned.record.tabId ? pinned : null;
		let created = false;
		let password: PasswordSource | undefined;
		if (action.generatePassword || action.useSavedPassword) {
			const profileDir = this.store.profileDir(this.savedProfile(entry, "typing a saved password"));
			password = action.generatePassword
				? (origin: string) => {
					// The signup rule the task credential uses: the saved one, else mint and save.
					const credential = resolveCredential(profileDir, { origin, mode: "signup" });
					created = credential.created;
					entry.secrets.add(credential.password);
					return credential.password;
				}
				: (origin: string) => {
					const value = savedPassword(profileDir, origin);
					if (value) entry.secrets.add(value);
					return value;
				};
		}
		let outcome: PerformOutcome;
		try {
			outcome = await entry.driver.perform(action, password);
			if (touching) touching.touchedWhilePending = true;
		} catch (error) {
			const dispatched = !(error instanceof ActionNotDispatched);
			if (dispatched && touching) touching.touchedWhilePending = true;
			if (dispatched) entry.revision += 1;
			return {
				status: dispatched ? "unknown" : "failed",
				error: dispatched
					? `The action was sent to the page, then failed; it may or may not have taken effect. Check the page before retrying. (${describe(error)})`
					: describe(error),
			};
		}
		return {
			status: "completed",
			...(outcome.passwordOrigin ? { credential: { origin: outcome.passwordOrigin, created } } : {}),
			...(outcome.dialogs ? { dialogs: outcome.dialogs } : {}),
		};
	}

	/** One admitted wait, run like `wait()`: the masked condition, and a timeout is a status. */
	private async waitStep(entry: Entry, step: PlannedWait): Promise<StepDone> {
		const held = await entry.driver.waitFor(step.condition, step.timeoutMs, (value) => this.redact(entry, value));
		return held ? { status: "completed" } : { status: "timeout", error: `wait timed out after ${step.timeoutMs} ms` };
	}

	/** One admitted tab operation: a failure is a status, as for an action. */
	private async tabStep(entry: Entry, step: PlannedTab): Promise<StepDone> {
		try {
			await this.applyTab(entry, step);
		} catch (error) {
			return { status: error instanceof ActionNotDispatched ? "failed" : "unknown", error: describe(error) };
		}
		return { status: "completed" };
	}

	/** One admitted eval: its value as JSON text (at most `limit` characters), or what it threw. */
	private async evalStep(entry: Entry, step: PlannedEval, limit: number): Promise<StepDone> {
		let outcome: EvalOutcome;
		try {
			outcome = await entry.driver.evaluate(step.expression, limit);
		} catch (error) {
			entry.revision += 1;
			return { status: "unknown", error: `The script was sent to the page, then failed; it may or may not have taken effect. (${describe(error)})` };
		}
		if (!outcome.ok) return { status: outcome.ran ? "unknown" : "failed", error: outcome.error };
		return { status: "completed", ...(outcome.value === undefined ? {} : { value: outcome.value }), ...(outcome.truncated ? { truncated: true } : {}) };
	}

	/**
	 * Wait until the page shows what the caller is waiting for, or `timeoutMs`
	 * passes. Queued and refused exactly like `act`, so a wait never runs beside
	 * a task or a pending publish. A timeout is a result, not an error: the state
	 * is what the browser shows now.
	 */
	async wait(browserId: string, request: WaitRequest, caller?: ToolCaller): Promise<WaitResult> {
		const entry = this.require(browserId);
		const { condition, timeoutMs } = validateWait(request);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			const held = await entry.driver.waitFor(condition, timeoutMs, (value) => this.redact(entry, value));
			return this.redact(entry, { status: held ? ("completed" as const) : ("timeout" as const), state: await this.buildState(entry) });
		});
	}

	/** A read like `snapshot`: the page is not touched, and no task or publish stops it. */
	async inspect(browserId: string, selector: string): Promise<InspectResult> {
		const entry = this.require(browserId);
		const css = requireReadSelector(selector);
		return await this.serialize(entry, async () => this.redact(entry, (await entry.driver.inspect(css)) ?? { found: false as const }));
	}

	// -----------------------------------------------------------------------
	// Tasks — upstream agent loops on this browser
	// -----------------------------------------------------------------------

	/**
	 * Run a whole task on an upstream agent loop. The agent attaches to this
	 * browser's Chrome; tabs it opens become the active tab, so frames show the
	 * agent working. Resolves with the finished run.
	 */
	async runTask(browserId: string, request: TaskRequest, onStep?: (step: TaskStep, run: TaskRun) => void): Promise<TaskRun> {
		const entry = this.require(browserId);
		return this.redact(entry, cloneTask(await (await this.beginTask(browserId, request, onStep)).finished));
	}

	/** Start a task and return as soon as it runs; follow it with `waitTask`. */
	async startTask(browserId: string, request: TaskRequest, caller?: ToolCaller): Promise<TaskRun> {
		const entry = this.require(browserId);
		const { run } = await this.beginTask(browserId, request, undefined, caller);
		return this.redact(entry, cloneTask(run));
	}

	private async beginTask(
		browserId: string,
		request: TaskRequest,
		onStep?: (step: TaskStep, run: TaskRun) => void,
		caller?: ToolCaller,
	): Promise<{ run: TaskRun; finished: Promise<TaskRun> }> {
		const entry = this.require(browserId);
		if (!TASK_AGENTS.includes(request.agent)) fail("bad_agent", `agent must be one of: ${TASK_AGENTS.join(", ")}`);
		// The task agents take a browser-level CDP endpoint and act on the whole
		// browser (browser-use focuses the oldest tab). On the relay that is the
		// human's own Chrome, which this pack owns only one tab of.
		if (entry.engine === "chrome-relay") {
			fail("task_unsupported_engine", "task agents drive a whole browser, and chrome-relay is your own Chrome — open a chromium profile for browser_task");
		}
		const task = typeof request.task === "string" ? request.task.trim() : "";
		if (task.length === 0 || task.length > MAX_TASK_CHARS) fail("bad_task", `task must be 1-${MAX_TASK_CHARS} characters`);
		const maxSteps = Math.min(MAX_TASK_STEPS, Math.max(1, Math.floor(request.maxSteps ?? DEFAULT_TASK_STEPS)));
		if (request.credential !== undefined) {
			// browser-use reads password fields like any other and would put a
			// filled value in front of its model; only jev never reads them.
			if (request.agent !== "jev") fail("credential_unsupported", "credential is supported with agent jev only; browser-use reads password fields, so give it the password in task or log in with browser_act");
			credentialOrigin(request.credential?.origin);
		}

		return await this.serialize(entry, async () => {
			if (entry.worker) fail("task_running", `a ${entry.task?.agent} task is already running on this browser`);
			refuseWhilePublishing(entry, caller);
			const state = await this.refreshState(entry);
			// Resolved (and, for a sign-up, minted) only once the task will run.
			const credential = request.credential ? resolveCredential(this.store.profileDir(this.savedProfile(entry, "a task credential")), request.credential) : undefined;
			if (credential) entry.secrets.add(credential.password);
			const run: TaskRun = {
				id: randomBytes(8).toString("hex"), agent: request.agent, task, status: "running", summary: "",
				steps: [], stepCount: 0, startedAt: new Date().toISOString(), elapsedMs: 0,
				usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
				...(credential ? { credential: { origin: credential.origin, created: credential.created } } : {}),
			};
			const worker: RunningWorker = startWorker(
				{ agent: request.agent, cdpUrl: entry.driver.cdpEndpoint(), task, maxSteps, startUrl: state.url, ...(credential ? { credential: { origin: credential.origin, password: credential.password } } : {}) },
				(step) => {
					const record: TaskStep = { n: step.n, action: step.action, url: step.url, elapsedMs: step.elapsedMs };
					run.steps.push(record);
					if (run.steps.length > TASK_STEPS_RETAINED) run.steps.shift();
					run.stepCount = Math.max(run.stepCount, step.n);
					run.elapsedMs = step.elapsedMs;
					run.usage = step.usage;
					if (onStep) onStep(this.redact(entry, record), this.redact(entry, cloneTask(run)));
				},
			);
			const finished = worker.done.then((result) => {
				Object.assign(run, {
					status: result.status,
					summary: result.summary,
					stepCount: Math.max(run.stepCount, result.steps),
					elapsedMs: result.elapsedMs || Date.now() - Date.parse(run.startedAt),
					usage: result.usage.modelCalls > 0 || result.usage.inputTokens > 0 ? result.usage : run.usage,
				});
				// The agent navigated this Chrome: whatever frame was retained is stale.
				entry.revision += 1;
				entry.worker = null;
				return run;
			});
			entry.task = run;
			entry.worker = { process: worker, finished };
			// Returned wrapped so the serializer is released now: the task runs
			// outside the page queue, and frames keep flowing while it works.
			return { run, finished };
		});
	}

	/**
	 * The current task, once it has finished or `ms` has passed — whichever is
	 * first. Lets a caller follow a long task in bounded calls instead of one
	 * call a host may time out.
	 */
	async waitTask(browserId: string, ms: number): Promise<TaskRun> {
		const entry = this.require(browserId);
		if (!entry.task) fail("no_task", "no task has run on this browser");
		const worker = entry.worker;
		if (worker) {
			const { promise: elapsed, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, Math.max(0, ms));
			await Promise.race([worker.finished, elapsed]);
			clearTimeout(timer);
		}
		return this.redact(entry, cloneTask(entry.task));
	}

	async cancelTask(browserId: string): Promise<TaskRun> {
		const entry = this.require(browserId);
		const worker = entry.worker;
		if (!worker) {
			if (!entry.task) fail("no_task", "no task has run on this browser");
			return this.redact(entry, cloneTask(entry.task));
		}
		worker.process.cancel();
		return this.redact(entry, cloneTask(await worker.finished));
	}

	/** Stop a running task and wait for its worker to exit. */
	private async stopTask(entry: Entry): Promise<void> {
		const worker = entry.worker;
		if (!worker) return;
		worker.process.cancel();
		await worker.finished;
	}

	// -----------------------------------------------------------------------
	// Publishing — fill, park for a confirm, submit once (publish.ts)
	// -----------------------------------------------------------------------

	async publish(browserId: string, recipe: PublishRecipe, mode: PublishMode, caller?: ToolCaller, preset?: PresetRef): Promise<PublishCheck | PublishRecord> {
		const entry = this.require(browserId);
		const profile = this.savedProfile(entry, "publishing");
		const valid = validateRecipe(recipe);
		const selected = validateMode(mode);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			// Even from the View: a check or a second post would navigate away from the page awaiting confirmation.
			if (isPending(entry.publish)) {
				fail("publish_pending", "a publish is already awaiting confirmation; it must be posted, cancelled or expire first");
			}
			const outcome = await prepare(entry.driver, profile, valid, selected);
			if (!("record" in outcome)) {
				// The account is page text: scrubbed like every other page read before it is persisted or reported.
				const shown = this.redact(entry, outcome);
				if (shown.status !== "failed") this.observeConnection(profile, valid.origin, shown.status === "signed-in", shown.account);
				return shown;
			}
			// The relay is the human's own Chrome: they can use this page without the runtime seeing it.
			outcome.sharedPage = entry.engine === "chrome-relay";
			if (preset !== undefined) outcome.record.preset = { name: preset.name, verified: preset.verified };
			entry.publish = outcome;
			return this.redact(entry, publishRecord(outcome));
		});
	}

	async confirmPublish(browserId: string, publishId: string, caller?: ToolCaller, expect?: PublishExpectation): Promise<PublishRecord> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			const publication = requirePending(entry.publish, publishId);
			// Before any page interaction: a refusal here leaves the publish pending and nothing clicked.
			requireExpected(this.redact(entry, publishRecord(publication)), caller, expect);
			if (entry.task?.status === "running") {
				fail("task_running", `a browser_task (${entry.task.agent}) owns this page; wait for it or cancel it`);
			}
			await confirm(entry.driver, publication);
			if (publication.record.status === "posted") this.observeConnection(publication.record.profile, publication.recipe.origin, true, this.redact(entry, publication.account));
			return this.redact(entry, publishRecord(publication));
		});
	}

	async cancelPublish(browserId: string, publishId: string): Promise<PublishRecord> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			const publication = requirePending(entry.publish, publishId);
			cancel(publication);
			return this.redact(entry, publishRecord(publication));
		});
	}

	/** Not queued: it only reads the record, and must not wait behind a confirm. */
	async waitPublish(browserId: string, publishId: string, ms: number): Promise<PublishRecord> {
		const entry = this.require(browserId);
		const publication = entry.publish;
		if (!publication || publication.record.publishId !== publishId) fail("unknown_publish", "no such publish on this browser");
		await waitSettled(publication, ms);
		return this.redact(entry, publishRecord(publication));
	}

	// -----------------------------------------------------------------------
	// Reading — one logged-out read on this runtime's own headless reader (read.ts)
	// -----------------------------------------------------------------------

	/**
	 * Read `url` in a fresh incognito context of the reader browser. A mirror
	 * or private-address target is refused before anything launches or
	 * navigates, and every request of the read (redirects included) goes
	 * through the same policy; a page that will not serve a logged-out reader
	 * comes back `blocked` with the reason, never retried. No profile and no
	 * Browser View browser is ever involved.
	 */
	async read(request: ReadRequest): Promise<ReadResult> {
		if (this.disposed) fail("disposed", "runtime has been disposed");
		if (!request || typeof request !== "object") fail("bad_read", "read request must be an object");
		const url = navigationUrl(request.url, "url", "bad_url");
		const maxChars = request.maxChars ?? DEFAULT_READ_CHARS;
		if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_READ_CHARS) {
			fail("bad_read", `maxChars must be an integer from 1 to ${MAX_READ_CHARS}`);
		}
		const policy = readPolicy(this.options.allowPrivateReadHosts);
		const refused = await policy.navigation(url);
		if (refused !== null) return { status: "blocked", url, reason: refused };
		return await this.onReader(async () => {
			if (this.disposed) fail("disposed", "runtime has been disposed");
			clearTimeout(this.readerIdle);
			try {
				const reader = await this.liveReader();
				const outcome = await reader.read(url, maxChars, READ_TIMEOUT_MS, policy);
				if (outcome.kind === "timeout") return { status: "blocked", url, reason: TIMEOUT_REASON };
				if (outcome.kind === "refused") return { status: "blocked", url: outcome.url, reason: outcome.reason };
				const seen = outcome.page;
				// The mirror check again, on where the page landed: a redirect the
				// policy did not see (a same-document URL change) is still a mirror.
				const landed = await policy.navigation(seen.url);
				const reason = landed ?? blockedReason(seen);
				if (reason !== null) return { status: "blocked", url: seen.url, reason };
				return { status: "ok", url: seen.url, title: seen.title, text: seen.text, ...(seen.truncated ? { truncated: true as const } : {}) };
			} finally {
				this.readerIdle = setTimeout(() => void this.closeReader().catch((err) => console.error("browser_read reader close failed:", describe(err))), READER_IDLE_MS);
				this.readerIdle.unref();
			}
		});
	}

	/** The reader, launched when there is none (or the last one died). Runs on `readerQueue`. */
	private async liveReader(): Promise<PageReader> {
		const current = this.pageReader;
		if (current?.usable) return current;
		if (current) {
			await current.close();
			this.pageReader = null;
		}
		if (this.byId.size + this.opening.size >= MAX_BROWSERS) {
			fail("too_many_browsers", `at most ${MAX_BROWSERS} browsers may be open at once; close one first`);
		}
		this.readerLaunching = true;
		try {
			this.pageReader = await launchReader(this.options.executablePath ? { executablePath: this.options.executablePath } : {});
		} finally {
			this.readerLaunching = false;
		}
		return this.pageReader;
	}

	/** Whether the reader holds (or is taking) a browser slot. */
	private readerHeld(): boolean {
		return this.pageReader !== null || this.readerLaunching;
	}

	/** Close the reader after any read in flight; a failed close keeps it, to be retried. */
	private closeReader(): Promise<void> {
		return this.onReader(async () => {
			clearTimeout(this.readerIdle);
			const reader = this.pageReader;
			if (!reader) return;
			await reader.close();
			this.pageReader = null;
		});
	}

	/** The reader's launch, reads and close run strictly in order. */
	private onReader<T>(work: () => Promise<T>): Promise<T> {
		const next = this.readerQueue.then(work, work);
		this.readerQueue = next.catch(() => undefined);
		return next;
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
	 * All page work for one browser runs strictly in order, never concurrently.
	 * The closed check is re-taken when the work actually starts: the browser
	 * may have been closed (or have crashed) while this call sat in the queue.
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

	private async buildState(entry: Entry): Promise<BrowserState> {
		const state = await this.refreshState(entry);
		return {
			browserId: entry.browserId, profile: entry.profile, engine: entry.engine, app: entry.driver.app,
			url: state.url, title: state.title, revision: entry.revision,
			viewport: state.viewport, task: entry.task ? cloneTask(entry.task) : null,
			tabs: state.tabs, activeTabId: state.activeTabId, loading: state.loading,
			canGoBack: state.canGoBack, canGoForward: state.canGoForward,
			publish: entry.publish ? publishRecord(entry.publish) : null,
			dialogs: state.dialogs,
		};
	}

	/** State when the page cannot be read (it may be mid-navigation after a failed action). */
	private staleState(entry: Entry): BrowserState {
		return {
			browserId: entry.browserId, profile: entry.profile, engine: entry.engine, app: entry.driver.app, url: "", title: "",
			revision: entry.revision, viewport: entry.viewport, task: entry.task ? cloneTask(entry.task) : null,
			tabs: [], activeTabId: "", loading: false, canGoBack: false, canGoForward: false,
			publish: entry.publish ? publishRecord(entry.publish) : null,
			dialogs: [],
		};
	}

	/**
	 * `value` with every saved password of this profile (on disk, plus any this
	 * browser used) scrubbed out. An unreadable credentials file still scrubs
	 * the ones in memory.
	 */
	private redact<T>(entry: Entry, value: T): T {
		const secrets = new Set(entry.secrets);
		if (entry.profile !== null) {
			try {
				for (const secret of savedPasswords(this.store.profileDir(entry.profile))) secrets.add(secret);
			} catch {
				// credentials_unreadable: the in-memory set is all there is to scrub.
			}
		}
		return secrets.size === 0 ? value : scrub(value, secrets);
	}

	/**
	 * The saved profile behind `entry`. A throwaway browser keeps nothing, so a
	 * sign-in, a saved password or a credential has no home on it: refused
	 * before anything reaches the page, naming the fix.
	 */
	private savedProfile(entry: Entry, needing: string): string {
		if (entry.profile === null) {
			fail("profile_required", `${needing} needs a saved profile, and this browser is a throwaway one (opened without a profile). Close it and open it again with a profile name to keep logins.`);
		}
		return entry.profile;
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A tab request checked before anything runs: its shape, its op, and the tabId that activate and close need. */
function admitTab(request: TabRequest): PlannedTab {
	if (!request || typeof request !== "object") fail("bad_tab", "tab request must be an object");
	if (request.op !== "new" && request.op !== "activate" && request.op !== "close") fail("bad_tab", "op must be one of: new, activate, close");
	if (request.op !== "new" && (typeof request.tabId !== "string" || request.tabId.length === 0 || request.tabId.length > MAX_TAB_ID_CHARS)) {
		fail("bad_tab", `${request.op} needs the tabId from state.tabs`);
	}
	const url = request.op === "new" && request.url !== undefined ? normalizeAction({ kind: "navigate", url: request.url }).url : undefined;
	return { kind: "tab", op: request.op, ...(request.tabId === undefined ? {} : { tabId: request.tabId }), ...(url === undefined ? {} : { url }) };
}

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
		width: Math.min(MAX_VIEWPORT.width, Math.max(MIN_VIEWPORT.width, Math.floor(width))),
		height: Math.min(MAX_VIEWPORT.height, Math.max(MIN_VIEWPORT.height, Math.floor(height))),
	};
}

/** An http(s) URL to navigate to, canonicalized; refused (`code`) as anything else. */
function navigationUrl(url: unknown, name: string, code: string): string {
	if (typeof url !== "string" || url.length > MAX_URL_LENGTH) {
		fail(code, `${name} must be a string of at most ${MAX_URL_LENGTH} characters`);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		fail(code, `${name} ${JSON.stringify(url)} is not an absolute URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		// javascript:, file:, data:, blob:, chrome: are all refused — a
		// navigation must never become script execution or local file reads.
		fail(code, `only http and https navigations are allowed, got ${parsed.protocol}`);
	}
	if (parsed.username || parsed.password) {
		fail(code, "Credentials in navigation URLs are not supported; sign in through the browser.");
	}
	return parsed.toString();
}

/**
 * `value` with every one of `secrets` replaced by `[saved password]` in every
 * string it holds (keys untouched), raw and as a URL carries it: percent-
 * encoded (`encodeURIComponent`, and with `+` for spaces), and form-encoded
 * the way a GET form puts `?pass=…` in the page's URL (which also encodes
 * `!'()~`, left alone by `encodeURIComponent`).
 */
function scrub<T>(value: T, secrets: ReadonlySet<string>): T {
	const forms = new Set<string>();
	for (const secret of secrets) {
		if (secret.length === 0) continue;
		const encoded = encodeURIComponent(secret);
		forms.add(secret).add(encoded).add(encoded.replace(/%20/g, "+")).add(new URLSearchParams([["", secret]]).toString().slice(1));
	}
	return scrubForms(value, [...forms]);
}

function scrubForms<T>(value: T, forms: readonly string[]): T {
	if (typeof value === "string") {
		let out: string = value;
		for (const form of forms) out = out.replaceAll(form, "[saved password]");
		return out as T;
	}
	if (Array.isArray(value)) return value.map((item) => scrubForms(item, forms)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubForms(item, forms)])) as T;
	}
	return value;
}

/** `useSavedPassword` or `generatePassword` is `true` and stands in for `text`: exactly one of the three. */
function passwordFlag(action: BrowserAction): { useSavedPassword: true } | { generatePassword: true } {
	const given = [action.text !== undefined, action.useSavedPassword !== undefined, action.generatePassword !== undefined].filter(Boolean).length;
	if (given !== 1) fail("bad_action", `${action.kind}: pass exactly one of text, useSavedPassword: true or generatePassword: true`);
	if (action.useSavedPassword === true) return { useSavedPassword: true };
	if (action.generatePassword === true) return { generatePassword: true };
	return fail("bad_action", `${action.kind}: useSavedPassword and generatePassword can only be true`);
}

/** Validate and canonicalize an action before anything touches the page. */
function normalizeAction(action: BrowserAction): BrowserAction {
	if (!action || typeof action !== "object") fail("bad_action", "action must be an object");
	switch (action.kind) {
		case "navigate":
			return { kind: "navigate", url: navigationUrl(action.url, "navigate.url", "bad_action") };
		case "click": {
			const button = action.button ?? "left";
			if (!MOUSE_BUTTONS.includes(button)) fail("bad_action", `click.button must be one of: ${MOUSE_BUTTONS.join(", ")}`);
			const clickCount = action.clickCount ?? 1;
			if (clickCount !== 1 && clickCount !== 2 && clickCount !== 3) fail("bad_action", "click.clickCount must be 1, 2 or 3");
			const options = { ...(button === "left" ? {} : { button }), ...(clickCount === 1 ? {} : { clickCount }) };
			if (typeof action.selector === "string") {
				return { kind: "click", selector: requireSelector(action.selector), ...options };
			}
			const x = requireCoordinate(action.x, "click", "x");
			const y = requireCoordinate(action.y, "click", "y");
			return { kind: "click", x, y, ...options };
		}
		case "hover": {
			const x = requireCoordinate(action.x, "hover", "x");
			const y = requireCoordinate(action.y, "hover", "y");
			return { kind: "hover", x, y };
		}
		case "insert": {
			if (action.useSavedPassword !== undefined || action.generatePassword !== undefined) return { kind: "insert", ...passwordFlag(action) };
			if (typeof action.text !== "string" || action.text.length === 0 || action.text.length > MAX_TEXT_INPUT) {
				fail("bad_action", `insert.text must be a string of 1-${MAX_TEXT_INPUT} characters`);
			}
			return { kind: "insert", text: action.text };
		}
		case "back":
		case "forward":
		case "reload":
		case "stop":
			return { kind: action.kind };
		case "type": {
			if (action.useSavedPassword !== undefined || action.generatePassword !== undefined) return { kind: "type", selector: requireSelector(action.selector), ...passwordFlag(action) };
			// An empty string is legal and means "clear the field".
			if (typeof action.text !== "string" || action.text.length > MAX_TEXT_INPUT) {
				fail("bad_action", `type.text must be a string of at most ${MAX_TEXT_INPUT} characters`);
			}
			return { kind: "type", selector: requireSelector(action.selector), text: action.text };
		}
		case "select": {
			if (typeof action.value !== "string" || action.value.length > MAX_TEXT_INPUT) {
				fail("bad_action", `select.value must be a string of at most ${MAX_TEXT_INPUT} characters`);
			}
			return { kind: "select", selector: requireSelector(action.selector), value: action.value };
		}
		case "press": {
			const key = action.key;
			if (typeof key !== "string" || (!NAMED_KEYS[key] && [...key].length !== 1)) {
				fail("bad_action", `press.key must be a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}`);
			}
			return { kind: "press", key };
		}
		case "resize": {
			if (typeof action.width !== "number" || typeof action.height !== "number") fail("bad_action", "resize needs a numeric width and height");
			return { kind: "resize", ...normalizeViewport({ width: action.width, height: action.height }) };
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

/**
 * The selector of a read that answers "is it there?": plain CSS only. Puppeteer's
 * `text/`, `xpath/`, `aria/`, `pierce/` handlers and `::-p-*` selectors match on
 * page text, which would let a caller probe text the runtime masks, a guess at a time.
 */
function requireReadSelector(selector: unknown): string {
	const css = requireSelector(selector);
	if (/::-p-/i.test(css) || /^(?:@\S+\s+)?(?:aria|text|xpath|pierce|p)\//i.test(css)) {
		fail("bad_action", "selector must be plain CSS: text/, xpath/, aria/, pierce/ and ::-p-* query handlers are not allowed here");
	}
	return css;
}

/** A finite coordinate. Whether it lies inside the viewport is the driver's to say: it is a failed action (`off_viewport`), not a malformed one. */
function requireCoordinate(value: unknown, kind: string, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail("bad_action", `${kind} needs ${kind === "click" ? "a selector or " : ""}a finite ${name} coordinate`);
	}
	return Math.floor(value);
}

/** Exactly one condition, and a timeout inside the cap. */
function validateWait(request: WaitRequest): { condition: WaitCondition; timeoutMs: number } {
	if (!request || typeof request !== "object") fail("bad_wait", "wait request must be an object");
	if ([request.selector, request.text, request.url].filter((given) => given !== undefined).length !== 1) {
		fail("bad_wait", "pass exactly one of selector, text or url");
	}
	const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) fail("bad_wait", `timeoutMs must be between 0 and ${MAX_WAIT_MS}`);
	if (request.selector !== undefined) return { condition: { selector: requireReadSelector(request.selector) }, timeoutMs };
	const value = request.text ?? request.url;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_WAIT_MATCH_CHARS) {
		fail("bad_wait", `text and url must be strings of 1-${MAX_WAIT_MATCH_CHARS} characters`);
	}
	return { condition: request.text !== undefined ? { text: value } : { url: value }, timeoutMs };
}

function requireDelta(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail("bad_action", `scroll.${name} must be a number`);
	return Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A task's page is its own, and a pending publish pins the page: neither takes another caller's page work. */
function refuseWhileBusy(entry: Entry, caller: ToolCaller | undefined): void {
	if (entry.task?.status === "running") {
		fail("task_running", `a browser_task (${entry.task.agent}) owns this page; wait for it or cancel it`);
	}
	refuseWhilePublishing(entry, caller);
}

/**
 * While a post awaits confirmation the page is pinned: only the Browser View's
 * own input ("app") may drive it. Anything else could change what is being
 * confirmed between the fill and the Post. Confirm and cancel are not gated
 * here; any caller may settle the publish.
 */
function refuseWhilePublishing(entry: Entry, caller: ToolCaller | undefined): void {
	if (caller !== "app" && isPending(entry.publish)) {
		fail("publish_pending", "a post awaits confirmation on this browser; confirm or cancel it (browser_publish_confirm / browser_publish_cancel) or wait with browser_publish_wait");
	}
}

/**
 * The confirm must name what it posts. A model (or unstamped) confirm must
 * carry `expect`; any `expect` must match the record the caller was shown —
 * redacted, as every reported record is — exactly: origin, profile, and every
 * field value in field order. The View's Post ("app") is the human's own
 * click on the bar that shows the record, so it may omit `expect`.
 */
function requireExpected(shown: PublishRecord, caller: ToolCaller | undefined, expect: PublishExpectation | undefined): void {
	if (expect === undefined) {
		if (caller !== "app") fail("expect_required", "expect_required: pass expect: { origin, profile, values } copied exactly from the pending publish record (values: every field's value, in field order); nothing was clicked");
		return;
	}
	const values = shown.fields.map((field) => field.value);
	const differs = [
		...(expect.origin === shown.origin ? [] : ["origin"]),
		...(expect.profile === shown.profile ? [] : ["profile"]),
		...(expect.values.length === values.length ? [] : [`values (expected ${values.length}, got ${expect.values.length})`]),
		...values.flatMap((value, index) => (index < expect.values.length && expect.values[index] !== value ? [`values[${index}]`] : [])),
	];
	if (differs.length > 0) {
		fail("publish_mismatch", `publish_mismatch: expect does not match the pending publish (mismatched: ${differs.join(", ")}); nothing was clicked and the publish is still pending. Read it with browser_publish_wait and confirm what it actually holds, or cancel it`);
	}
}

/**
 * The browser is going away under a pending publish: settle it first, so a
 * `browser_publish_wait` hears the outcome instead of waiting out the expiry.
 * A confirm already under way settles itself.
 */
function settleOnClose(entry: Entry): void {
	if (entry.publish && !entry.publish.confirming && isPending(entry.publish)) {
		cancel(entry.publish, "The browser was closed. Nothing was submitted.");
	}
}

function cloneTask(run: TaskRun): TaskRun {
	return { ...run, steps: run.steps.map((step) => ({ ...step })), usage: { ...run.usage } };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
