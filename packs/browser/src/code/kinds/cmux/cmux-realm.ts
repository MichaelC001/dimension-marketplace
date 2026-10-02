// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-supervisor.ts:508-585 (acquireCmuxTab), :587-700 (the cmux branch of runInTab) and :766-911 (releaseTab for a cmux surface) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../../third-party/omp/LICENSE.
// Changed for the Browser pack (matrix F6): OMP's supervisor, its process-global tab map and idle clocks are not here (the code host owns lifetime); this is only what a cmux surface needs beside the puppeteer tab realm: open a split or attach to a surface, run a cell or a call chain on it, and close what it opened.

/**
 * The tabs of a cmux browser, by name. A cmux surface is not a Chrome page (there is no CDP, no engine, no puppeteer): it is driven over the cmux daemon's
 * socket by {@link CmuxTab}, so it has its own small realm beside the one for Chrome pages. It answers the same questions the code worker asks of
 * any realm (`run`, `call`, `release`, `end`, `dispose`, `names`) with the same texts for a tab that is gone or busy.
 */
import type { CodeEvaluator, RunResult, WaitUntil } from "../../contracts.js";
import { renderFunctionRun } from "../../cell/run-code.js";
import { ToolAbortError, ToolError } from "../../errors.js";
import { renderTabCall, type TabCallStep } from "../../worker/tab-call.js";
import { CmuxTab, type CmuxRunSettings, type ReadyInfo, runCmuxCode } from "./cmux-tab.js";
import { mapWaitUntil } from "./rpc.js";
import type { CmuxSocketClient } from "./socket-client.js";

/** The names a function run receives (OMP `BROWSER_RUN_SCOPE`). */
const RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

export interface CmuxRealmOptions {
	/** One evaluator per tab NAME, so a tab's top-level names persist per tab as they do in OMP. */
	evaluator: () => CodeEvaluator;
	/** What a run needs of its session: the screenshot folder, the working folder for `uploadFile`, the picture format. */
	settings: () => CmuxRunSettings;
}

/** What opening a cmux tab needs. `surface` attaches to an existing surface (a UUID); without it a split is opened. */
export interface CmuxOpenOptions {
	client: CmuxSocketClient;
	surface?: string;
	url?: string;
	waitUntil?: WaitUntil;
	timeoutMs: number;
	signal?: AbortSignal;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

interface Session {
	name: string;
	tab: CmuxTab;
	client: CmuxSocketClient;
	surfaceId: string;
	/** The surface was opened by this realm (a split), so closing the tab closes it; an attached surface is the person's and stays. */
	ownsSurface: boolean;
	evaluator: CodeEvaluator | undefined;
	/** The run in flight on this tab, if any. */
	active: AbortController | null;
	done: Promise<void> | null;
}

export class CmuxRealm {
	readonly #options: CmuxRealmOptions;
	readonly #sessions = new Map<string, Session>();

	constructor(options: CmuxRealmOptions) {
		this.#options = options;
	}

	names(): string[] {
		return [...this.#sessions.keys()];
	}

	/** Open (or attach to) a surface as the tab `name`. Resolves with what the surface reports of itself. */
	async open(name: string, o: CmuxOpenOptions): Promise<ReadyInfo> {
		const attached = o.surface;
		if (attached?.startsWith("surface:")) {
			throw new ToolError("app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split");
		}
		let surfaceId = attached;
		let initialUrl = o.url;
		let ownsSurface = false;
		try {
			if (!surfaceId) {
				const params: Record<string, unknown> = { url: o.url ?? "about:blank", focus: false };
				if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
				if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
				const result = await o.client.request("browser.open_split", params, { timeoutMs: o.timeoutMs });
				if (typeof result.surface_id !== "string" || result.surface_id.length === 0) throw new ToolError("cmux browser.open_split did not return a surface_id");
				surfaceId = result.surface_id;
				ownsSurface = true;
				if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
				if (o.url) {
					await o.client.request(
						"browser.wait",
						{ surface_id: surfaceId, load_state: mapWaitUntil(o.waitUntil ?? "load"), timeout_ms: o.timeoutMs },
						{ timeoutMs: o.timeoutMs },
					);
				}
			}
			const tab = new CmuxTab({ client: o.client, surfaceId, ...(initialUrl === undefined ? {} : { url: initialUrl }) });
			if (attached && o.url) await tab.goto(o.url, { waitUntil: o.waitUntil ?? "load", timeoutMs: o.timeoutMs });
			const info = await tab.readyInfo(o.viewport);
			// A caller that gave up while the surface was opening gets nothing, and what we opened is closed again.
			if (o.signal?.aborted) throw new ToolAbortError("Browser tab open aborted");
			const held = this.#sessions.get(name);
			this.#sessions.set(name, { name, tab, client: o.client, surfaceId, ownsSurface, evaluator: undefined, active: null, done: null });
			if (held) await this.#close(held);
			return info;
		} catch (error) {
			if (ownsSurface && surfaceId) await o.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
			throw error;
		}
	}

	async run(r: { name: string; code?: string; fn?: string; args?: unknown[]; timeoutMs: number; signal: AbortSignal }): Promise<RunResult> {
		const hasCode = r.code !== undefined && r.code.trim().length > 0;
		const hasFn = r.fn !== undefined && r.fn.trim().length > 0;
		if (hasCode === hasFn) throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
		const code = hasFn ? renderFunctionRun(r.fn!.trim(), RUN_SCOPE, r.args ?? []) : r.code!.trim();
		return await this.#execute(this.#alive(r.name), code, r.timeoutMs, r.signal);
	}

	async call(r: { name: string; chain: Array<{ method: string; args: unknown[] }>; timeoutMs: number; signal: AbortSignal }): Promise<RunResult> {
		return await this.#execute(this.#alive(r.name), renderTabCall(r.chain as readonly TabCallStep[]), r.timeoutMs, r.signal);
	}

	/** Release the tab `name`: a split this realm opened is closed, a surface it attached to is left alone. */
	async release(name: string): Promise<boolean> {
		const session = this.#sessions.get(name);
		if (!session) return false;
		this.#sessions.delete(name);
		await this.#close(session);
		return true;
	}

	async dispose(): Promise<void> {
		for (const name of [...this.#sessions.keys()]) await this.release(name);
	}

	#alive(name: string): Session {
		const session = this.#sessions.get(name);
		if (!session) throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`);
		return session;
	}

	async #execute(session: Session, code: string, timeoutMs: number, hostSignal: AbortSignal): Promise<RunResult> {
		if (session.active) throw new ToolError(`Tab ${JSON.stringify(session.name)} is busy`);
		if (hostSignal.aborted) throw new ToolAbortError();
		// A tab closed under a run ends the run at once, not at its budget: the run's signal carries that abort.
		const closeAc = new AbortController();
		const finished = Promise.withResolvers<void>();
		session.active = closeAc;
		session.done = finished.promise;
		try {
			const evaluator = (session.evaluator ??= this.#options.evaluator());
			return await runCmuxCode(session.tab, { code, timeoutMs, signal: AbortSignal.any([hostSignal, closeAc.signal]), settings: this.#options.settings(), evaluator });
		} finally {
			if (session.active === closeAc) session.active = null;
			finished.resolve();
		}
	}

	async #close(session: Session): Promise<void> {
		session.active?.abort(new ToolError(`Tab "${session.name}" was closed`));
		await session.done?.catch(() => undefined);
		if (session.ownsSurface) await session.client.request("surface.close", { surface_id: session.surfaceId }).catch(() => undefined);
	}
}
