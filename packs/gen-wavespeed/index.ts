// The WaveSpeed `generation` provider (doc 75 §3.3; character-pipeline design G1).
//
// One WaveSpeed key, many 3D generators: Tripo P2 and H3.1, Meshy 6 and 7.1, Rodin
// 2.5, TRELLIS.2 and Hunyuan 3D 3 / 3.1. This module is the WaveSpeed protocol and
// nothing else. WHICH models are offered, how Dimension's inputs map onto their
// fields, the licences and the feature tags are `models.json`. Each model's option
// schema comes from WaveSpeed's live catalogue and every price from WaveSpeed's live
// pricing API, so a model WaveSpeed adds an option to, or reprices, needs no release.
//
// The engine owns the job table, the polling clock, the spend ledger and the caps;
// this provider answers typed questions. `ref` carries everything `status` and
// `fetch` need — the task id, the quote, the licence stamped at submit, the
// effective input — so a job survives a restart with no state here. The API key comes
// from the pack's connect form, is sent only to api.wavespeed.ai and is never logged
// or put in a message.
//
// There is no `cancel`: WaveSpeed has no endpoint that stops a task (its delete
// endpoint skips tasks that are still created or processing, and says deletion does
// not cancel them). Leaving it off makes the engine tell the owner the truth — the
// job will finish and be billed as quoted — instead of booking a running, billing
// task as cancelled at $0.
//
// Runtime imports are `node:` builtins and this pack's own files; types come from
// `@dimension/sdk/provider` and are erased.

import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	GenerationCatalogue,
	GenerationLicence,
	GenerationModel,
	GenerationProvider,
	GenerationQuote,
	GenerationRequest,
	GenerationStatus,
} from "@dimension/sdk/provider";
import {
	type Api,
	downloadFile,
	fetchModels,
	fetchPrice,
	mapPool,
	readTask,
	submitTask,
	uploadImage,
} from "./client.ts";
import { isRecord } from "./guards.ts";
import { buildBody, claimedFields, imageCapacity } from "./input.ts";
import { loadPackData, type ModelEntry, type PackData } from "./models.ts";
import { collectFiles, type RemoteFile } from "./result.ts";
import { buildOptionsSchema, type OptionsSchema } from "./schema.ts";

/** MUST match `connect.configTarget` in plugin.json. */
const CONFIG_TARGET = join(homedir(), ".config", "dimension-gen-wavespeed", "key.json");

/** How long a read of WaveSpeed's catalogue is trusted. A model list edit in
 *  models.json or a schema change at WaveSpeed shows up within this, with no restart. */
const CATALOGUE_TTL_MS = 10 * 60_000;
const CATALOGUE_TIMEOUT_MS = 60_000;

const DOWNLOADS_AT_ONCE = 4;
/** Results `status` read, kept for `fetch`: bounded, because a job nobody fetches must not leak. */
const KEPT_RESULTS = 16;
const KEPT_UPLOADS = 64;

/** A task that ended without output, and whether WaveSpeed kept the money. Its Refund
 *  Policy refunds failed requests and system timeouts automatically; it says nothing
 *  of a task that ends `cancelled` or `deleted`, so those are held at their quote. */
const ENDED_WITHOUT_OUTPUT: Readonly<Record<string, boolean>> = { failed: false, timeout: false, cancelled: true, deleted: true };

export interface WaveSpeedProviderOptions {
	/** Where the API key comes from. Default: the connect form's config file. */
	readonly apiKey?: () => Promise<string>;
	/** Test seam. */
	readonly fetch?: typeof fetch;
	/** Location of models.json. Default: beside this file. */
	readonly modelsPath?: string;
	readonly now?: () => number;
}

/** Read the API key the connect form wrote. Every error names the problem and
 *  never the file's content. `path` is the test seam; production reads the
 *  connect form's configTarget. */
export async function readConnectKey(path: string = CONFIG_TARGET): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new Error(
			"WaveSpeed is not connected — add a WaveSpeed API key on the pack's Connect page (create one at https://wavespeed.ai/accesskey)",
		);
	}
	// A parse error quotes the offending token — which in a hand-edited file IS
	// the key — so the parse error is replaced, never passed on.
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		throw new Error("gen-wavespeed's stored key is not valid JSON — reconnect the pack");
	}
	const access = isRecord(stored) ? stored.access : undefined;
	if (typeof access !== "string" || access.trim() === "") {
		throw new Error("gen-wavespeed's stored key is empty — reconnect the pack");
	}
	return access.trim();
}

/** A model WaveSpeed offers right now, with everything a request to it needs. */
interface ReadyModel {
	readonly entry: ModelEntry;
	readonly schema: OptionsSchema;
	readonly model: GenerationModel;
}

interface Catalogue {
	readonly ready: ReadonlyMap<string, ReadyModel>;
	/** Models in models.json that are not offered, and why. */
	readonly unavailable: ReadonlyMap<string, string>;
	readonly uploadRetainSeconds: number;
	readonly pricingProbeImage: string;
}

/** What `submit` hands the engine and `status`/`fetch` read back. */
interface JobRef {
	readonly v: 1;
	readonly model: string;
	readonly taskId: string;
	readonly submittedAt: number;
	readonly quoteUsd: number;
	readonly quoteBasis: string;
	readonly licence: GenerationLicence;
	/** The body WaveSpeed was sent: the effective settings, with uploaded files as URLs. */
	readonly input: Readonly<Record<string, unknown>>;
}

function decodeRef(ref: string): JobRef {
	let parsed: unknown;
	try {
		parsed = JSON.parse(ref);
	} catch {
		throw new Error("not a WaveSpeed job reference");
	}
	if (!isRecord(parsed) || parsed.v !== 1) throw new Error("not a WaveSpeed job reference");
	for (const field of ["model", "taskId", "quoteBasis"] as const) {
		if (typeof parsed[field] !== "string") throw new Error(`WaveSpeed job reference has no ${field}`);
	}
	if (typeof parsed.submittedAt !== "number" || typeof parsed.quoteUsd !== "number") {
		throw new Error("WaveSpeed job reference has no submit time or quote");
	}
	if (!isRecord(parsed.licence) || !isRecord(parsed.input)) throw new Error("WaveSpeed job reference has no licence or input");
	// Written by `submit` below; the checks above are against a hand-edited ref.
	return parsed as unknown as JobRef;
}

function describeModel(entry: ModelEntry, schema: OptionsSchema): GenerationModel {
	return {
		id: entry.modelId,
		label: entry.label,
		produces: entry.produces,
		accepts: entry.accepts,
		...(entry.inputs.images !== undefined && { maxImages: imageCapacity(entry.inputs.images) }),
		options: schema,
		priceBasis: `${entry.pricing.basis}. The price of a request is asked of WaveSpeed's pricing API before it is submitted.`,
		licence: entry.licence,
		...(entry.features !== undefined && { features: entry.features }),
	};
}

async function buildCatalogue(api: Api, data: PackData, signal: AbortSignal): Promise<Catalogue> {
	const live = await fetchModels(api, new Set(data.models.map(model => model.modelId)), signal);
	const ready = new Map<string, ReadyModel>();
	const unavailable = new Map<string, string>();
	for (const entry of data.models) {
		const found = live.get(entry.modelId);
		if (found === undefined) {
			unavailable.set(entry.modelId, "WaveSpeed's catalogue does not list it");
		} else if (found.apiPath !== `/api/v3/${entry.modelId}`) {
			unavailable.set(entry.modelId, `WaveSpeed now submits it at ${found.apiPath ?? "no path"}, not /api/v3/${entry.modelId}`);
		} else {
			try {
				const built = buildOptionsSchema(found.requestSchema, claimedFields(entry));
				if (built.missing.length > 0) {
					unavailable.set(entry.modelId, `WaveSpeed's request schema no longer has ${built.missing.join(", ")}`);
					continue;
				}
				ready.set(entry.modelId, { entry, schema: built.options, model: describeModel(entry, built.options) });
			} catch (error) {
				unavailable.set(entry.modelId, messageOf(error));
			}
		}
	}
	return { ready, unavailable, uploadRetainSeconds: data.uploadRetainSeconds, pricingProbeImage: data.pricingProbeImage };
}

/** Let one caller stop waiting on a shared promise without cancelling it for the others. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Drop the oldest entry of a Map, which iterates in insertion order. */
function evictOldest(map: Map<string, unknown>): void {
	for (const key of map.keys()) {
		map.delete(key);
		return;
	}
}

/** What `status` read from a completed task, kept for `fetch`. */
interface FinishedTask {
	readonly files: readonly RemoteFile[];
	readonly inferenceMs?: number;
}

export function createWaveSpeedProvider(options: WaveSpeedProviderOptions = {}): GenerationProvider {
	const readKey = options.apiKey ?? (() => readConnectKey());
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now;

	let cached: { readonly at: number; readonly value: Catalogue } | undefined;
	let building: Promise<Catalogue> | undefined;
	const uploads = new Map<string, { readonly url: string; readonly at: number }>();
	const finished = new Map<string, FinishedTask>();

	async function connect(): Promise<Api> {
		return { fetch: doFetch, key: await readKey() };
	}

	async function catalogue(api: Api, signal: AbortSignal): Promise<Catalogue> {
		if (cached !== undefined && now() - cached.at < CATALOGUE_TTL_MS) return cached.value;
		building ??= (async () => {
			try {
				const data = await loadPackData(options.modelsPath);
				const value = await buildCatalogue(api, data, AbortSignal.timeout(CATALOGUE_TIMEOUT_MS));
				cached = { at: now(), value };
				return value;
			} finally {
				building = undefined;
			}
		})();
		return abortable(building, signal);
	}

	async function findModel(api: Api, id: string, signal: AbortSignal): Promise<{ model: ReadyModel; offered: Catalogue }> {
		const offered = await catalogue(api, signal);
		const model = offered.ready.get(id);
		if (model !== undefined) return { model, offered };
		const why = offered.unavailable.get(id);
		throw new Error(
			why === undefined
				? `WaveSpeed model "${id}" is not one this pack offers (offered: ${[...offered.ready.keys()].join(", ") || "none"})`
				: `WaveSpeed model "${id}" is unavailable: ${why}`,
		);
	}

	/** Upload once per file and storage lifetime: a best-of-N run sends one reference image to many models. */
	async function upload(api: Api, path: string, retainSeconds: number, signal: AbortSignal): Promise<string> {
		const info = await stat(path).catch(() => undefined);
		const key = info === undefined ? undefined : `${path}|${info.size}|${info.mtimeMs}`;
		const hit = key === undefined ? undefined : uploads.get(key);
		// Half the retention, so a reused URL always has most of its life left.
		if (hit !== undefined && now() - hit.at < retainSeconds * 500) return hit.url;
		const url = await uploadImage(api, path, signal);
		if (key !== undefined) {
			if (uploads.size >= KEPT_UPLOADS) evictOldest(uploads);
			uploads.set(key, { url, at: now() });
		}
		return url;
	}

	/** What WaveSpeed charges for `body`, as the engine's quote. The price is WaveSpeed's
	 *  own: the same formula that charges the task once it is submitted. */
	async function quoteBody(api: Api, model: ReadyModel, body: Record<string, unknown>, signal: AbortSignal): Promise<GenerationQuote> {
		const price = await fetchPrice(api, model.entry.modelId, body, signal);
		const usd = Math.round(price.payableUsd * 1e6) / 1e6;
		const discount = price.listUsd === price.payableUsd ? "" : ` (list price $${price.listUsd}, before this account's discount)`;
		return { usd, basis: `$${usd} from WaveSpeed's pricing API${discount}; ${model.entry.pricing.basis}` };
	}

	return {
		id: "wavespeed",

		async describe({ signal }): Promise<GenerationCatalogue> {
			let api: Api;
			try {
				api = await connect();
			} catch (error) {
				return { ready: false, reason: messageOf(error), models: [] };
			}
			let offered: Catalogue;
			try {
				offered = await catalogue(api, signal);
			} catch (error) {
				if (signal.aborted) throw error;
				return { ready: false, reason: messageOf(error), models: [] };
			}
			const problems = [...offered.unavailable].map(([id, why]) => `${id}: ${why}`);
			if (offered.ready.size === 0) {
				return { ready: false, reason: `WaveSpeed offers none of this pack's models (${problems.join("; ")})`, models: [] };
			}
			return {
				ready: true,
				...(problems.length > 0 && { reason: problems.join("; ") }),
				models: [...offered.ready.values()].map(ready => ready.model),
			};
		},

		async quote(request, { signal }) {
			const api = await connect();
			const { model, offered } = await findModel(api, request.model, signal);
			// The files are not uploaded for a quote: WaveSpeed's formulas read which image
			// fields are present, so a stand-in URL in each prices the request exactly.
			const body = await buildBody(model.entry, model.schema, request, async () => offered.pricingProbeImage);
			return quoteBody(api, model, body, signal);
		},

		async submit(request: GenerationRequest, { signal }) {
			const api = await connect();
			const { model, offered } = await findModel(api, request.model, signal);
			const body = await buildBody(model.entry, model.schema, request, path =>
				upload(api, path, offered.uploadRetainSeconds, signal),
			);
			const quote = await quoteBody(api, model, body, signal);
			const taskId = await submitTask(api, model.entry.modelId, body, signal);
			const job: JobRef = {
				v: 1,
				model: model.entry.modelId,
				taskId,
				submittedAt: now(),
				quoteUsd: quote.usd,
				quoteBasis: quote.basis,
				licence: model.entry.licence,
				input: body,
			};
			return { ref: JSON.stringify(job) };
		},

		async status(ref, { signal }): Promise<GenerationStatus> {
			const job = decodeRef(ref);
			const task = await readTask(await connect(), job.taskId, signal);
			if (Object.hasOwn(ENDED_WITHOUT_OUTPUT, task.status)) {
				return {
					state: "failed",
					billed: ENDED_WITHOUT_OUTPUT[task.status] === true,
					error: `WaveSpeed task ${task.status}${task.error === undefined ? "" : `: ${task.error}`}`,
				};
			}
			switch (task.status) {
				case "created":
					return { state: "queued", message: "waiting in WaveSpeed's queue" };
				case "processing":
					return { state: "running" };
				case "completed": {
					if (finished.has(job.taskId)) return { state: "succeeded" };
					// `completed` is the only success, and WaveSpeed charged for it: a result that
					// carries no usable file is a billed failure, not something to poll again.
					let files: RemoteFile[];
					try {
						files = collectFiles(task.outputs);
					} catch (error) {
						return { state: "failed", billed: true, error: messageOf(error) };
					}
					if (files.length === 0) {
						return { state: "failed", billed: true, error: "WaveSpeed completed the task but its result contains no files" };
					}
					if (finished.size >= KEPT_RESULTS) evictOldest(finished);
					finished.set(job.taskId, { files, ...(task.inferenceMs !== undefined && { inferenceMs: task.inferenceMs }) });
					return { state: "succeeded" };
				}
				default:
					// WaveSpeed's docs: every status other than the terminal ones means keep polling.
					return { state: "running", message: `WaveSpeed status "${task.status}"` };
			}
		},

		async fetch(ref, { outDir, signal }) {
			const job = decodeRef(ref);
			let known = finished.get(job.taskId);
			if (known === undefined) {
				// After a restart `status` has not run in this process: read the result again.
				const task = await readTask(await connect(), job.taskId, signal);
				if (task.status !== "completed") throw new Error(`WaveSpeed task ${job.taskId} is ${task.status}, not completed`);
				const files = collectFiles(task.outputs);
				if (files.length === 0) throw new Error(`WaveSpeed's result for ${job.model} (task ${job.taskId}) contains no files`);
				known = { files, ...(task.inferenceMs !== undefined && { inferenceMs: task.inferenceMs }) };
			}
			finished.delete(job.taskId);

			// The engine fails a job whose file paths are not absolute and inside the outDir it passed.
			const dir = resolve(outDir);
			await mkdir(dir, { recursive: true });
			const group = new AbortController();
			const stop = AbortSignal.any([signal, group.signal]);
			let bytes: number[];
			try {
				bytes = await mapPool(known.files, DOWNLOADS_AT_ONCE, file => downloadFile(doFetch, file.url, join(dir, file.name), stop));
			} catch (error) {
				group.abort();
				throw error;
			}

			return {
				files: known.files.map(file => ({ path: join(dir, file.name), role: file.role, format: file.format, label: file.label })),
				// WaveSpeed charges what its pricing API said at submit; there is no cheaper read of the charge.
				costUsd: job.quoteUsd,
				licence: job.licence,
				meta: {
					vendor: "wavespeed",
					model: job.model,
					taskId: job.taskId,
					input: job.input,
					quote: { usd: job.quoteUsd, basis: job.quoteBasis },
					cost: { source: "wavespeed-pricing-api", usd: job.quoteUsd },
					timings: {
						submittedAt: new Date(job.submittedAt).toISOString(),
						fetchedAt: new Date(now()).toISOString(),
						...(known.inferenceMs !== undefined && { inferenceMs: known.inferenceMs }),
					},
					files: known.files.map((file, index) => ({ label: file.label, name: file.name, url: file.url, bytes: bytes[index] })),
				},
			};
		},
	};
}

export { buildBody, checkRequest, claimedFields } from "./input.ts";
export { loadPackData, parsePackData } from "./models.ts";
export { collectFiles } from "./result.ts";
export { buildOptionsSchema, validateOptions } from "./schema.ts";

/** The factory the engine's provider lane imports (doc 75 §2). */
export function createGenerationProvider(): GenerationProvider {
	return createWaveSpeedProvider();
}
