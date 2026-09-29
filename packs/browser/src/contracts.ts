import type { ConnectionObservations } from "./connection.js";

/** What the browser IS. `abp` and `browser4` are refused with the reason (see engines/refused.ts). */
export const BROWSER_ENGINES = ["chromium", "chrome-relay", "abp", "browser4"] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
/** Who drives a whole task at its own speed: upstream agent loops, used as published. */
export const TASK_AGENTS = ["jev", "browser-use"] as const;
export type TaskAgent = (typeof TASK_AGENTS)[number];
/**
 * `signup`: the password the browser saved for this profile + origin, or a
 * strong one it mints and saves. `login`: the saved one only. See credentials.ts.
 */
export const CREDENTIAL_MODES = ["signup", "login"] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];
/** A password by REFERENCE: the caller names the origin, never the value. */
export interface CredentialRequest { origin: string; mode: CredentialMode }
/** What a task reports about the credential it used — never the value. */
export interface CredentialUse { origin: string; created: boolean }
/** Maximum encoded PNG accepted by the host's image model-context contract. */
export const MAX_ANNOTATION_BYTES = 2_097_152;
export interface Viewport { width: number; height: number }
/** What a viewport may be (CSS px): `browser_open`, the View's fit and the `resize` step clamp to these. */
export const MIN_VIEWPORT: Viewport = { width: 320, height: 240 };
export const MAX_VIEWPORT: Viewport = { width: 2_560, height: 2_000 };
export type MouseButton = "left" | "right" | "middle";
export interface BrowserAction {
  kind: "navigate" | "click" | "type" | "select" | "press" | "scroll" | "back" | "forward" | "reload" | "stop" | "insert" | "hover" | "resize";
  url?: string;
  selector?: string;
  /** `type`: replaces the field's value. `insert`: typed into whatever is focused. */
  text?: string;
  /**
   * `type`/`insert` INSTEAD of `text`: replace the password field's content
   * with the password this profile saved for that field's own frame origin (read
   * from the browser, never the page). No saved password there is an error and
   * nothing is typed. Agent-only: the View types exactly what the human typed.
   */
  useSavedPassword?: true;
  /**
   * `type`/`insert` INSTEAD of `text`, for a sign-up: as `useSavedPassword`,
   * but with nothing saved for that frame origin the browser first mints a
   * strong password and saves it there (the store `browser_task` credential
   * uses). A saved one is reused, so a retried sign-up never orphans the
   * account an earlier attempt made. Agent-only; the value is never returned.
   */
  generatePassword?: true;
  /** `select`: the option's value or visible text. */
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  /** `resize`: the viewport in CSS pixels (bounded like `browser_open`'s), for responsive checks. */
  width?: number;
  height?: number;
  /** `click` only; default "left". */
  button?: MouseButton;
  /** `click` only; 2 = double-click, 3 = triple-click. Default 1; the runtime refuses any other. */
  clickCount?: number;
}
export interface TabInfo {
  /** Stable opaque id for the tab's lifetime. */
  id: string;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  /** data: URL (≤ 32 KB, fetched server-side, cached per origin) or null. */
  favicon: string | null;
}
export type TabOp = "new" | "activate" | "close";
export interface TabRequest { op: TabOp; tabId?: string; url?: string }
/** `jpeg`: the latest live screencast frame (not annotatable). `png`: a fresh capture, retained for annotation. */
export type FrameFormat = "jpeg" | "png";
/** `failed`: provably nothing happened. `unknown`: dispatched, then errored — may have taken effect. */
export type ActionStatus = "completed" | "failed" | "unknown";
/**
 * `credential`: a `useSavedPassword`/`generatePassword` action typed this profile's password for `origin` (`created`: minted just now). Never the value.
 * `dialogs`: the JavaScript dialogs the browser answered while this action ran.
 */
export interface ActionResult { status: ActionStatus; error?: string; state: BrowserState; credential?: CredentialUse; dialogs?: HandledDialog[] }
/** How many steps one `actMany` call takes. */
export const MAX_BATCH_STEPS = 25;
/** A step that waits, as `browser_act` takes it beside the page actions: `WaitRequest`'s exactly-one rule and bounds. */
export interface WaitStep { kind: "wait"; selector?: string; text?: string; url?: string; timeoutMs?: number }
/** A tab step: `TabRequest` as a step, on the same lock as the others. */
export interface TabStep extends TabRequest { kind: "tab" }
/** Run `expression` in the page (its main world). Only a throwaway browser: see `runtime.actMany`. */
export interface EvalStep { kind: "eval"; expression: string }
export const MAX_EVAL_EXPRESSION_CHARS = 8_192;
/** What an eval step's JSON result may be, and what one batch's eval steps may return between them. */
export const MAX_EVAL_RESULT_CHARS = 8_000;
export type BatchStep = BrowserAction | WaitStep | TabStep | EvalStep;
/** `timeout`: a wait step's condition never held, or the batch's time budget ran out before this step. */
export type StepStatus = ActionStatus | "timeout";
/**
 * What one step did. `credential`: as `ActionResult`'s. `value`: an eval step's result as JSON text (cut at the
 * cap, `truncated: true`, when longer); absent when it returned nothing.
 */
export interface StepOutcome { kind: BatchStep["kind"]; status: StepStatus; error?: string; credential?: CredentialUse; value?: string; truncated?: true }
/**
 * One batch: `steps` are those attempted, in order (the last is the one that stopped the batch), `completed`
 * how many completed, `status`/`error` those of the step that stopped it ("completed" when none did). `state` is
 * read once, after the last step; `dialogs` are those answered during the batch (the last five). `newErrors`:
 * console errors, exceptions and failed requests logged since the last result a model was handed (never for the View).
 */
export interface ActManyResult { status: StepStatus; error?: string; completed: number; steps: StepOutcome[]; state: BrowserState; dialogs?: HandledDialog[]; newErrors?: number }
/** The most log entries kept per tab, and the longest text one holds. */
export const MAX_LOG_ENTRIES = 50;
export const MAX_LOG_TEXT_CHARS = 300;
/**
 * One thing that went wrong in a page: `console.error`/`console.warning`, an uncaught `exception`, an `http` response
 * of 400 or more, or a request that `network`-failed. `n` counts up per browser. `text` is the page's own words (untrusted),
 * urls without their query strings; never a body, header or cookie.
 */
export interface LogEntry { n: number; type: "console.error" | "console.warning" | "exception" | "http" | "network"; text: string }
/**
 * `fullPage`: the whole document, not just the viewport. `selector`: that element's box (plain CSS; `@<ref> ` reaches an iframe).
 * `scale`: 0-1, shrinks the picture further. The longest edge is at most 1024 CSS px whatever else is asked.
 */
export interface ShotRequest { fullPage?: boolean; selector?: string; scale?: number }
/** `width`/`height`: the CSS px the picture covers, `scale` how much it was shrunk (a point in it is at x/scale in the page). */
export interface ModelShot { mimeType: "image/webp"; data: string; url: string; width: number; height: number; scale: number }
/** The kinds of JavaScript dialog a page can open. */
export const DIALOG_TYPES = ["alert", "confirm", "prompt", "beforeunload"] as const;
export type DialogType = (typeof DIALOG_TYPES)[number];
/**
 * A dialog the browser answered by itself, because an open one freezes the
 * page: alert and beforeunload are accepted, confirm and prompt dismissed.
 * `message` is the page's own text (untrusted, bounded).
 */
export interface HandledDialog { type: DialogType; message: string; handled: "accepted" | "dismissed" }
/** The longest a `wait` step (or `WaitRequest`) waits. */
export const MAX_WAIT_MS = 15_000;
/** Exactly one of `selector` (visible), `text` (on the page) or `url` (a substring of the current URL). */
export interface WaitRequest { selector?: string; text?: string; url?: string; timeoutMs?: number }
/** `completed`: the condition held. `timeout`: it did not within `timeoutMs`; `state` is what the browser shows now. */
export interface WaitResult { status: "completed" | "timeout"; state: BrowserState }
/** browser_inspect: the layout facts of the first element a selector matches, in the page's CSS pixels (an iframe's in main-viewport pixels, as a snapshot lists them). */
export interface ElementInspection {
  found: true;
  rect: BrowserRegion;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** A fixed allowlist of computed styles; see INSPECT_STYLES in engines/page-scripts.ts. */
  styles: Record<string, string>;
  /** The parent element's box; null for the root. */
  parent: BrowserRegion | null;
}
export type InspectResult = { found: false } | ElementInspection;
export interface TaskStep { n: number; action: string; url: string; elapsedMs: number }
export interface TaskUsage { modelCalls: number; inputTokens: number; outputTokens: number; costUsd: number | null }
export type TaskStatus = "running" | "done" | "blocked" | "failed" | "cancelled";
export interface TaskRun {
  id: string;
  agent: TaskAgent;
  task: string;
  status: TaskStatus;
  /** The agent's final message, or the failure reason. */
  summary: string;
  /** The most recent steps (bounded); `stepCount` is the total. */
  steps: TaskStep[];
  stepCount: number;
  startedAt: string;
  elapsedMs: number;
  usage: TaskUsage;
  /** Which saved password the browser used for this task, and whether it minted it. */
  credential?: CredentialUse;
}
/**
 * `credential`: the browser fills that origin's password fields itself (jev
 * never reads or types password inputs). The value is held by the browser and
 * never passes through a tool argument, a result or a model call.
 */
export interface TaskRequest { agent: TaskAgent; task: string; maxSteps?: number; credential?: CredentialRequest }
/** One field of a publish recipe: where to type, exactly what, and an optional caption shown in the View. */
export interface PublishField {
  selector: string;
  value: string;
  /** Shown above the value in the confirm bar (≤ 40 characters); the View falls back to "Field N". */
  label?: string;
}
/**
 * Who made a tool call, as the host stamped it in request `_meta`: "model"
 * (an agent turn) or "app" (the Browser View, i.e. the human). A call with no
 * stamp did not come through the host and is treated as not-the-human.
 */
export type ToolCaller = "model" | "app";
/**
 * How to post on one site, supplied by the caller as data — the pack itself is
 * platform-agnostic. See publish.ts for the bounds every field is held to.
 */
export interface PublishRecipe {
  /** `https://…`; `http://` only for 127.0.0.1 and localhost. */
  origin: string;
  /** On `origin`. */
  composeUrl: string;
  /** CSS selector present only when the profile is signed in. */
  signedIn: string;
  /**
   * Optional CSS selector whose text names the signed-in account, read only
   * once signed in: its last "@handle" ("Jane (CEO @acme) @jane" → "@jane";
   * an email's "@domain" is not one), else its text. It goes into the
   * connection report (connection.ts).
   */
  account?: string;
  /** 1-8 fields, each value at most 10 000 characters. */
  fields: PublishField[];
  /** CSS selector clicked exactly once, only on confirm. */
  submit: string;
  receipt: {
    /**
     * Template matched against the receipt URL's PATHNAME (the origin is checked
     * separately; query and hash are ignored): literal text plus `{segment}`
     * (one path segment) and `{digits}` (one or more 0-9), at most one
     * placeholder per segment. Starts with "/", at most 256 characters.
     * Example: "/{segment}/status/{digits}".
     */
    path: string;
    /** Receipt is the href of the first matching element whose href matches; else the active tab's URL. */
    linkSelector?: string;
  };
}
/** Which shipped preset a publish was resolved from, as the record shows it. */
export interface PresetRef {
  name: string;
  /** False until a real post was observed through the preset: the View says "Recipe not yet proven on the live site. Check the filled-in post before you press Post.". */
  verified: boolean;
}
export const PUBLISH_MODES = ["check", "post"] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];
export const PUBLISH_STATUSES = ["awaiting-confirmation", "posted", "unknown", "failed", "cancelled", "expired"] as const;
/**
 * `unknown`: submit was dispatched and then errored, or no receipt appeared —
 * it may have posted; never retried. `failed`: provably nothing was submitted.
 */
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];
/** The browser's current or most recent publish. `url` is read from the page only. */
export interface PublishRecord {
  publishId: string;
  status: PublishStatus;
  origin: string;
  /** Where the post goes: the compose page URL the fields were typed into and read back on (confirm requires the tab still there). */
  composeUrl: string;
  /** The tab the fields were read back on: confirm submits only there, and the View holds Tab/Enter only while it is active. */
  tabId: string;
  profile: string;
  fields: PublishField[];
  createdAt: string;
  expiresAt: string;
  /** The posted URL, read from the page after submit. */
  url?: string;
  error?: string;
  /** Set when the recipe came from a named preset (`browser_publish`'s `preset`). */
  preset?: PresetRef;
}
/**
 * What a confirm says it is posting: the pending record's `origin`, `profile`
 * and every field's `value` in field order, exactly as the record showed them.
 * The host's Allow card shows these args, so the human approves exactly this.
 */
export interface PublishExpectation {
  origin: string;
  profile: string;
  values: string[];
}
/** A `browser_publish` that stopped before anything was parked for confirmation. */
export interface PublishCheck {
  status: "not-signed-in" | "signed-in" | "failed";
  url: string;
  profile: string;
  /** The account the recipe's `account` selector read, when signed in and it could. */
  account?: string;
  error?: string;
}
/** Which browser a `chromium` View launched: the installed Chrome, else Edge, else a Chromium; `custom` is DIMENSION_BROWSER_EXECUTABLE. */
export const BROWSER_APPS = ["chrome", "msedge", "chromium", "custom"] as const;
export type BrowserApp = (typeof BROWSER_APPS)[number];
export interface BrowserState {
  browserId: string;
  /**
   * The saved profile this browser runs on; `null` for a throwaway browser
   * (opened without a profile), whose data is deleted when it closes. A
   * chrome-relay browser is always "relay".
   */
  profile: string | null;
  engine: BrowserEngine;
  /** The browser application behind this View; null on chrome-relay (the human's own Chrome). */
  app: BrowserApp | null;
  url: string;
  title: string;
  revision: number;
  viewport: Viewport;
  /** The running or most recent task on this browser. */
  task: TaskRun | null;
  /** Every page tab this browser owns, in opening order. */
  tabs: TabInfo[];
  activeTabId: string;
  /** The active tab is loading. */
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The current or most recent publish; the View renders its confirm bar from this. */
  publish: PublishRecord | null;
  /** The last five JavaScript dialogs the browser answered on the active tab, oldest first. */
  dialogs: HandledDialog[];
}
export interface BrowserFrame {
  state: BrowserState;
  frameId: string;
  mimeType: "image/png" | "image/jpeg";
  data: string;
  capturedAt: string;
}
/** The live frame is still the one the caller named in `since`: no pixels are resent. */
export interface UnchangedFrame {
  state: BrowserState;
  frameId: string;
  unchanged: true;
}
export interface BrowserRegion { x: number; y: number; width: number; height: number }
export interface BrowserAnnotation {
  url: string;
  note: string;
  region: BrowserRegion;
  capturedAt: string;
  mimeType: "image/png";
  data: string;
  elements: string;
}
export interface BrowserOpenOptions {
  /** Omitted: a throwaway browser, nothing saved, no sign-in kept. Named: the persistent profile of that name. */
  profile?: string;
  engine?: BrowserEngine;
  viewport?: Viewport;
}
/**
 * browser_read: one logged-out read of a public page (see read.ts). There is
 * no profile: every read runs in a fresh incognito context.
 */
export interface ReadRequest {
  url: string;
  /** Default 20 000, max 100 000. */
  maxChars?: number;
}
/**
 * `ok`: the final URL, title and readable text (`truncated` when cut at maxChars).
 * `blocked`: the page will not serve a logged-out reader, or the target is a
 * mirror/proxy host or a private address; `reason` says which. A blocked read
 * is final, never worked around.
 */
export type ReadResult =
  | { status: "ok"; url: string; title: string; text: string; truncated?: true }
  | { status: "blocked"; url: string; reason: string };
/** Capability is the opaque browserId; it must never appear in global listings. */
export interface BrowserRuntimePort {
  open(options: BrowserOpenOptions): Promise<BrowserState>;
  state(browserId: string): Promise<BrowserState>;
  frame(browserId: string, format?: FrameFormat): Promise<BrowserFrame>;
  frame(browserId: string, format: "jpeg", since: string | undefined): Promise<BrowserFrame | UnchangedFrame>;
  tab(browserId: string, request: TabRequest, caller?: ToolCaller): Promise<BrowserState>;
  resize(browserId: string, viewport: Viewport, scale?: number): Promise<BrowserState>;
  snapshot(browserId: string): Promise<{ state: BrowserState; text: string }>;
  /** Refused (`publish_pending`) while a publish awaits confirmation, unless `caller` is "app". */
  act(browserId: string, action: BrowserAction, caller?: ToolCaller): Promise<ActionResult>;
  /**
   * 1..MAX_BATCH_STEPS steps under ONE lock: refused once (`task_running`, `publish_pending`, as `act`), every step
   * validated before the first runs (`bad_action`/`bad_wait`), then run in order until one is not `completed`.
   */
  actMany(browserId: string, steps: readonly BatchStep[], caller?: ToolCaller): Promise<ActManyResult>;
  /** A picture for a model: webp, at most 1024 CSS px on its longest edge, never retained (so never annotatable). Read like `snapshot`. */
  shot(browserId: string, request?: ShotRequest): Promise<ModelShot>;
  /** The active tab's log entries since the last call (which marks them read); `[]` when nothing is new. For a model's reads, never the View's. */
  logs(browserId: string): Promise<LogEntry[]>;
  /**
   * Remember `browserId` as the browser `session` — the id the HOST stamped on a call, never one a caller passed — has
   * open in its View: what the human opened or is viewing. Forgotten when that browser closes.
   */
  bindView(session: string, browserId: string): void;
  /** The browser the human opened or is viewing in `session`, while it is open. */
  viewOf(session: string): string | undefined;
  /** Serialized and refused (`task_running`, `publish_pending`) like `act`; nothing is changed on the page. `timeout` is a result, not an error. */
  wait(browserId: string, request: WaitRequest, caller?: ToolCaller): Promise<WaitResult>;
  /** Read-only: a fixed page script measures the first match of `selector` (`@<ref> ` prefix reaches an iframe). Nothing the caller wrote runs in the page. */
  inspect(browserId: string, selector: string): Promise<InspectResult>;
  runTask(browserId: string, request: TaskRequest, onStep?: (step: TaskStep, run: TaskRun) => void): Promise<TaskRun>;
  cancelTask(browserId: string): Promise<TaskRun>;
  annotate(browserId: string, frameId: string, region: BrowserRegion, note: string): Promise<BrowserAnnotation>;
  /** Every on-disk profile's persisted sign-in observations (connection.ts). */
  connections(): Promise<ConnectionObservations>;
  /** `listener` runs after each new observation is persisted and after a profile with observations is deleted. Returns the unsubscribe. */
  onConnectionsChanged(listener: () => void): () => void;
  profiles(): Promise<string[]>;
  /** Settles a pending publish first. Refused (`publish_pending`) while one awaits confirmation, unless `caller` is "app". */
  close(browserId: string, caller?: ToolCaller): Promise<void>;
  waitTask(browserId: string, ms: number): Promise<TaskRun>;
  startTask(browserId: string, request: TaskRequest, caller?: ToolCaller): Promise<TaskRun>;
  /** `check`: signed in? `post`: fill, verify and park for a confirm. Never submits. `preset` labels the record with the preset the recipe was resolved from. */
  publish(browserId: string, recipe: PublishRecipe, mode: PublishMode, caller?: ToolCaller, preset?: PresetRef): Promise<PublishCheck | PublishRecord>;
  /**
   * The Post (the model's confirm or the View's button): re-verify, click submit exactly once, read the receipt from the page.
   * `expect` binds the confirm to what the caller was shown: REQUIRED unless `caller` is "app", and when given (from any
   * caller) it must equal the pending record's origin, profile and field values exactly, else nothing is clicked.
   */
  confirmPublish(browserId: string, publishId: string, caller?: ToolCaller, expect?: PublishExpectation): Promise<PublishRecord>;
  cancelPublish(browserId: string, publishId: string): Promise<PublishRecord>;
  /** The publish's record once it is terminal or `ms` has passed, whichever is first. */
  waitPublish(browserId: string, publishId: string, ms: number): Promise<PublishRecord>;
  /** Read a public page in this server's own headless reader: a fresh incognito context, never a profile or a Browser View browser. */
  read(request: ReadRequest): Promise<ReadResult>;
  dispose(): Promise<void>;
}
