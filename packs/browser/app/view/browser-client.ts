// The View's whole reach into the pack: one typed wrapper per browser tool,
// every call a standard `tools/call` proxied by the host (`App.callServerTool`).
// Nothing here knows about the runtime, the host window, or any private API —
// the shapes and engine identifiers come from the pack's own contracts module.
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { BROWSER_APPS, BROWSER_ENGINES, DIALOG_TYPES, PUBLISH_STATUSES, TASK_AGENTS } from "../../src/contracts";
import type {
	BrowserAction,
	BrowserAnnotation,
	BrowserEngine,
	BrowserFrame,
	UnchangedFrame,
	BrowserRegion,
	BrowserState,
	HandledDialog,
	FrameFormat,
	PublishField,
	PublishRecord,
	TabInfo,
	TabOp,
	TaskRun,
	TaskStatus,
} from "../../src/contracts";
import { isRecord, readNumber, readString } from "./json";

const TASK_STATUSES: readonly TaskStatus[] = ["running", "done", "blocked", "failed", "cancelled"];

/** A tool that answered `isError`, or answered a shape this View cannot read.
 *  Both are real failures and are shown to the human verbatim — the View never
 *  substitutes a plausible-looking value for an answer it did not get. */
export class BrowserToolError extends Error {
	constructor(
		readonly tool: string,
		message: string,
		/** `unknown`: dispatched, then errored — it may have taken effect. */
		readonly status: "failed" | "unknown" | null = null,
	) {
		super(message);
		this.name = "BrowserToolError";
	}
}

/** `isError` results carry their reason in the text blocks; a structured
 *  `error` string wins when the server sends one. An action that failed AFTER
 *  it was dispatched (`status: "unknown"`) says so, so nobody blindly retries. */
function toolError(tool: string, result: CallToolResult): BrowserToolError {
	const structured = result.structuredContent;
	let reason: string | undefined;
	if (isRecord(structured)) {
		const text = readString(structured, "error");
		if (text !== undefined && text.trim().length > 0) reason = text;
	}
	if (reason === undefined) {
		const text = (result.content ?? [])
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.trim();
		reason = text.length > 0 ? text : "the tool reported an error with no message";
	}
	const status = isRecord(structured) ? readString(structured, "status") : undefined;
	if (status === "unknown") return new BrowserToolError(tool, `${reason} — it may have taken effect; check the page before retrying`, "unknown");
	return new BrowserToolError(tool, reason, status === "failed" ? "failed" : null);
}

function readTask(tool: string, value: unknown): TaskRun {
	if (!isRecord(value)) throw new BrowserToolError(tool, "result carried no task run");
	const agent = TASK_AGENTS.find(candidate => candidate === readString(value, "agent"));
	const status = TASK_STATUSES.find(candidate => candidate === readString(value, "status"));
	if (!agent || !status) throw new BrowserToolError(tool, "task run carried an unknown agent or status");
	const usage = isRecord(value.usage) ? value.usage : {};
	const steps = Array.isArray(value.steps) ? value.steps.filter(isRecord) : [];
	return {
		id: readString(value, "id") ?? "",
		agent,
		task: readString(value, "task") ?? "",
		status,
		summary: readString(value, "summary") ?? "",
		steps: steps.map(step => ({
			n: readNumber(step, "n") ?? 0,
			action: readString(step, "action") ?? "",
			url: readString(step, "url") ?? "",
			elapsedMs: readNumber(step, "elapsedMs") ?? 0,
		})),
		stepCount: readNumber(value, "stepCount") ?? steps.length,
		startedAt: readString(value, "startedAt") ?? "",
		elapsedMs: readNumber(value, "elapsedMs") ?? 0,
		usage: {
			modelCalls: readNumber(usage, "modelCalls") ?? 0,
			inputTokens: readNumber(usage, "inputTokens") ?? 0,
			outputTokens: readNumber(usage, "outputTokens") ?? 0,
			costUsd: readNumber(usage, "costUsd") ?? null,
		},
	};
}

function readPublish(tool: string, value: unknown): PublishRecord {
	if (!isRecord(value)) throw new BrowserToolError(tool, "result carried no publish record");
	const publishId = readString(value, "publishId");
	const status = PUBLISH_STATUSES.find(candidate => candidate === readString(value, "status"));
	if (publishId === undefined || publishId.length === 0 || !status) throw new BrowserToolError(tool, "publish record carried no id or an unknown status");
	const fields: PublishField[] = [];
	for (const field of Array.isArray(value.fields) ? value.fields : []) {
		if (!isRecord(field)) continue;
		const selector = readString(field, "selector");
		const text = readString(field, "value");
		const label = readString(field, "label");
		if (selector !== undefined && text !== undefined) fields.push({ selector, value: text, ...(label === undefined ? {} : { label }) });
	}
	const url = readString(value, "url");
	const error = readString(value, "error");
	return {
		publishId,
		status,
		origin: readString(value, "origin") ?? "",
		composeUrl: readString(value, "composeUrl") ?? "",
		tabId: readString(value, "tabId") ?? "",
		profile: readString(value, "profile") ?? "",
		fields,
		createdAt: readString(value, "createdAt") ?? "",
		expiresAt: readString(value, "expiresAt") ?? "",
		...(url === undefined ? {} : { url }),
		...(error === undefined ? {} : { error }),
	};
}

function readTabs(value: unknown): TabInfo[] {
	if (!Array.isArray(value)) return [];
	const tabs: TabInfo[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const id = readString(entry, "id");
		if (id === undefined || id.length === 0) continue;
		const favicon = readString(entry, "favicon");
		tabs.push({
			id,
			title: readString(entry, "title") ?? "",
			url: readString(entry, "url") ?? "",
			active: entry.active === true,
			loading: entry.loading === true,
			// Only an inline image may be painted: the View never fetches.
			favicon: favicon !== undefined && favicon.startsWith("data:image/") ? favicon : null,
		});
	}
	return tabs;
}

function readDialogs(value: unknown): HandledDialog[] {
	if (!Array.isArray(value)) return [];
	const dialogs: HandledDialog[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const type = DIALOG_TYPES.find(candidate => candidate === readString(entry, "type"));
		const handled = readString(entry, "handled");
		if (type === undefined || (handled !== "accepted" && handled !== "dismissed")) continue;
		dialogs.push({ type, message: readString(entry, "message") ?? "", handled });
	}
	return dialogs;
}

function readState(tool: string, value: unknown): BrowserState {
	if (!isRecord(value)) throw new BrowserToolError(tool, "no browser state in the result");
	const browserId = readString(value, "browserId");
	if (browserId === undefined || browserId.length === 0) throw new BrowserToolError(tool, "result carried no browserId");
	const viewportValue = value.viewport;
	const viewport = isRecord(viewportValue)
		? { width: readNumber(viewportValue, "width") ?? 0, height: readNumber(viewportValue, "height") ?? 0 }
		: { width: 0, height: 0 };
	if (viewport.width <= 0 || viewport.height <= 0) throw new BrowserToolError(tool, "result carried no viewport size");
	const engine = BROWSER_ENGINES.find(candidate => candidate === readString(value, "engine"));
	if (!engine) throw new BrowserToolError(tool, "result carried an unsupported browser engine");
	const tabs = readTabs(value.tabs);
	return {
		browserId,
		profile: readString(value, "profile") ?? null,
		engine,
		app: BROWSER_APPS.find(candidate => candidate === readString(value, "app")) ?? null,
		url: readString(value, "url") ?? "",
		title: readString(value, "title") ?? "",
		revision: readNumber(value, "revision") ?? 0,
		viewport,
		task: value.task === null || value.task === undefined ? null : readTask(tool, value.task),
		tabs,
		activeTabId: readString(value, "activeTabId") ?? tabs.find(tab => tab.active)?.id ?? "",
		loading: value.loading === true,
		canGoBack: value.canGoBack === true,
		canGoForward: value.canGoForward === true,
		publish: value.publish === null || value.publish === undefined ? null : readPublish(tool, value.publish),
		dialogs: readDialogs(value.dialogs),
	};
}

/** The one structured-content door. Every browser tool answers
 *  `structuredContent`; an `isError` result is raised, never rendered as data. */
function structured(tool: string, result: CallToolResult): Record<string, unknown> {
	if (result.isError) throw toolError(tool, result);
	const structuredContent = result.structuredContent;
	if (!isRecord(structuredContent)) throw new BrowserToolError(tool, "the tool answered without structured content");
	return structuredContent;
}

/** What a host-delivered `ui/notifications/tool-result` tells this View: the
 *  browser its tool opened, or why it opened none. */
export type MountResult = { readonly state: BrowserState } | { readonly error: string };
/** A `MountResult` as the host delivered it; `seq` orders them so a repeat still registers. */
export type ToolMount = MountResult & { readonly seq: number };

/** The outcome of the tool that mounted the View (`browser_view`, `browser_publish`), read out of a host-delivered
 *  `ui/notifications/tool-result` — the View's ONLY source of a browserId.
 *  `null`: a result that says nothing about a browser. */
export function mountFromToolResult(result: CallToolResult): MountResult | null {
	if (result.isError) return { error: openFailureText(toolError("tool-result", result)) };
	if (!isRecord(result.structuredContent)) return null;
	const payload = result.structuredContent;
	const candidate = isRecord(payload.state) ? payload.state : payload;
	try {
		return { state: readState("tool-result", candidate) };
	} catch {
		return null;
	}
}

export interface OpenOptions {
	/** Omitted: a private browser — nothing is saved. */
	profile?: string;
	engine?: BrowserEngine;
	url?: string;
}

/** Human-readable failure text for anything a browser call threw. */
export function failureText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The runtime allows one holder per saved set of logins. Only the text of that
 *  refusal crosses the tool boundary (`profile_in_use` / `profile_locked`), so it
 *  is recognised by it. */
const SET_TAKEN = /profile "[^"]*" is already (?:open|in use)/;
const SET_TAKEN_TEXT = "That browser is already open. Use it, or open a Private one.";

/** Why an open opened nothing, as the start page says it: the runtime's own
 *  text, except a taken set of logins, which is plain language and a way out. */
export function openFailureText(cause: unknown): string {
	const text = failureText(cause);
	return SET_TAKEN.test(text) ? SET_TAKEN_TEXT : text;
}

/** The typed surface the UI calls. One instance per connected `App`. */
export class BrowserClient {
	/** The browser this View shows: a context update about any other is dropped. */
	private showing: string | null = null;
	/** The browser the human's last annotation is about, while it is still parked in the agent's context. */
	private annotated: string | null = null;
	private contextChain: Promise<unknown> | undefined;
	constructor(private readonly app: App) {}

	/**
	 * The View shows `browserId` now. Nothing about it is sent to the agent — a browser reaches the agent through its own
	 * tools — except taking back a picture the human sent about another one: it no longer describes what is on screen.
	 */
	follow(browserId: string | null): Promise<boolean> {
		this.showing = browserId;
		return this.annotated !== null && this.annotated !== browserId ? this.updateContext(browserId, []) : Promise.resolve(false);
	}

	/**
	 * The human's deliberate annotation, or `[]` to take it back. Serialized so an old image cannot overwrite a newer
	 * one; work for a browser this View no longer shows is discarded.
	 */
	updateContext(browserId: string | null, content: ContentBlock[]): Promise<boolean> {
		const previous = this.contextChain;
		const next = (async () => {
			await previous?.catch(() => undefined);
			if (this.showing !== browserId) return false;
			if (!this.app.getHostCapabilities()?.updateModelContext?.text) {
				throw new Error("This host cannot attach the Browser View to its conversation.");
			}
			await this.app.updateModelContext({ content });
			const applied = this.showing === browserId;
			if (applied) this.annotated = content.length === 0 ? null : browserId;
			return applied;
		})();
		this.contextChain = next;
		return next;
	}

	private async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		let result: CallToolResult;
		try {
			result = await this.app.callServerTool({ name: tool, arguments: args });
		} catch (cause) {
			throw new BrowserToolError(tool, failureText(cause));
		}
		return structured(tool, result);
	}

	/** The names of the saved profiles: `browser_profiles` answers the View with each one's label, colour and sites too. */
	async profiles(): Promise<string[]> {
		const payload = await this.call("browser_profiles", {});
		const profiles = payload.profiles;
		if (!Array.isArray(profiles)) throw new BrowserToolError("browser_profiles", "result carried no profiles array");
		return profiles.flatMap((profile) => (isRecord(profile) && typeof profile.name === "string" ? [profile.name] : []));
	}

	async open(options: OpenOptions): Promise<BrowserState> {
		const args: Record<string, unknown> = {};
		if (options.profile !== undefined) args.profile = options.profile;
		if (options.engine) args.engine = options.engine;
		if (options.url !== undefined && options.url.length > 0) args.url = options.url;
		return readState("browser_open", await this.call("browser_open", args));
	}

	async state(browserId: string): Promise<BrowserState> {
		return readState("browser_state", await this.call("browser_state", { browserId }));
	}

	/** `jpeg`: the latest live screencast frame, answered from memory; with `since`
	 *  (the frameId on screen) a still page answers `unchanged` and sends no pixels.
	 *  `png`: a fresh full-quality capture whose frameId can be annotated. */
	async frame(browserId: string, format: "png"): Promise<BrowserFrame>;
	async frame(browserId: string, format: "jpeg", since?: string): Promise<BrowserFrame | UnchangedFrame>;
	async frame(browserId: string, format: FrameFormat, since?: string): Promise<BrowserFrame | UnchangedFrame> {
		const tool = "browser_frame";
		const payload = await this.call(tool, since ? { browserId, format, since } : { browserId, format });
		const frameId = readString(payload, "frameId");
		if (frameId === undefined) throw new BrowserToolError(tool, "frame carried no frameId");
		const state = readState(tool, payload.state);
		if (payload.unchanged === true) return { state, frameId, unchanged: true };
		const data = readString(payload, "data");
		if (data === undefined || data.length === 0) throw new BrowserToolError(tool, "frame carried no image data");
		return {
			state,
			frameId,
			mimeType: readString(payload, "mimeType") === "image/png" ? "image/png" : "image/jpeg",
			data,
			capturedAt: readString(payload, "capturedAt") ?? new Date().toISOString(),
		};
	}

	/** Sizes every tab's viewport (CSS px) so the page fills the seat 1:1, rendered at
	 *  this screen's pixel ratio so the live view is crisp. Coordinates stay CSS px. */
	async viewport(browserId: string, width: number, height: number): Promise<BrowserState> {
		const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
		return readState("browser_viewport", await this.call("browser_viewport", { browserId, width, height, scale }));
	}

	/** A tab step of `browser_act` (there is no separate tab tool): answers the state after it. */
	async tab(browserId: string, op: TabOp, options: { tabId?: string; url?: string } = {}): Promise<BrowserState> {
		const step: Record<string, unknown> = { kind: "tab", op };
		if (options.tabId !== undefined) step.tabId = options.tabId;
		if (options.url !== undefined && options.url.length > 0) step.url = options.url;
		const tool = "browser_act";
		return readState(tool, (await this.call(tool, { browserId, actions: [step] })).state);
	}

	/** Runs one action now and answers the browser's state after it. */
	async act(browserId: string, action: BrowserAction): Promise<BrowserState> {
		const tool = "browser_act";
		return readState(tool, (await this.call(tool, { browserId, actions: [action] })).state);
	}

	/** Asks the running task to stop; answers once it has. */
	async cancelTask(browserId: string): Promise<TaskRun> {
		const tool = "browser_task_cancel";
		return readTask(tool, await this.call(tool, { browserId }));
	}

	async annotate(browserId: string, frameId: string, region: BrowserRegion, note: string): Promise<BrowserAnnotation> {
		const tool = "browser_annotate";
		const payload = await this.call(tool, { browserId, frameId, region, note });
		const data = readString(payload, "data");
		if (data === undefined || data.length === 0) throw new BrowserToolError(tool, "annotation carried no image data");
		const regionValue = isRecord(payload.region) ? payload.region : {};
		return {
			url: readString(payload, "url") ?? "",
			note: readString(payload, "note") ?? note,
			region: {
				x: readNumber(regionValue, "x") ?? region.x,
				y: readNumber(regionValue, "y") ?? region.y,
				width: readNumber(regionValue, "width") ?? region.width,
				height: readNumber(regionValue, "height") ?? region.height,
			},
			capturedAt: readString(payload, "capturedAt") ?? new Date().toISOString(),
			mimeType: "image/png",
			data,
			elements: readString(payload, "elements") ?? "",
		};
	}

	/** The bar's Post. Answers the settled record: posted, failed or unknown. */
	async confirmPublish(browserId: string, publishId: string): Promise<PublishRecord> {
		const tool = "browser_publish_confirm";
		return readPublish(tool, await this.call(tool, { browserId, publishId }));
	}

	async cancelPublish(browserId: string, publishId: string): Promise<PublishRecord> {
		const tool = "browser_publish_cancel";
		return readPublish(tool, await this.call(tool, { browserId, publishId }));
	}

	async close(browserId: string): Promise<void> {
		await this.call("browser_close", { browserId });
	}
}
