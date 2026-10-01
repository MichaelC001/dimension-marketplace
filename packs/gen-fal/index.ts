// The fal.ai `generation` provider (doc 75 §3.3; character-pipeline design G1).
//
// One fal key, many 3D generators: Pixal3D, TRELLIS.2, Rodin 2.5, Meshy-6, Hunyuan
// 3.1 (image-to-3D, part splitter, smart topology) and Tripo P2. This module is the
// fal protocol and nothing else. WHICH endpoints are offered, how Dimension's inputs
// map onto their fields, how many billing units a request takes, the licences and
// the feature tags are `models.json`. Each endpoint's option schema comes from fal's
// live OpenAPI and its unit price from fal's live pricing API, so a model fal
// adds an option to, or reprices, needs no release.
//
// The engine owns the job table, the polling clock, the spend ledger and the caps;
// this provider answers typed questions. `ref` carries everything `status`,
// `fetch` and `cancel` need — fal's per-job URLs, the quote, the licence stamped at
// submit, the effective input — so a job survives a restart with no state here.
// The API key comes from the pack's connect form, is sent only to fal's hosts and
// is never logged or put in a message.
//
// Runtime imports are `node:` builtins and this pack's own files; types come from
// `@dimension/sdk/provider` and are erased.

import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import type {
	GenerationCatalogue,
	GenerationLicence,
	GenerationModel,
	GenerationProvider,
	GenerationRequest,
	GenerationStatus,
} from "@dimension/sdk/provider";
import {
	type Api,
	type Billed,
	call,
	cancelJob,
	downloadFile,
	FalError,
	failure,
	falDetail,
	fetchBilled,
	fetchCatalogue,
	fetchPrices,
	mapPool,
	parseQueueStatus,
	submitJob,
	uploadFile,
} from "./client.ts";
import { isRecord } from "./guards.ts";
import { buildBody, checkRequest, claimedFields } from "./input.ts";
import { loadPackData, type ModelEntry, type PackData } from "./models.ts";
import { type LivePrice, type PriceContext, quoteRequest } from "./pricing.ts";
import { collectFiles, makeHandle } from "./result.ts";
import { buildOptionsSchema, type OptionsSchema, schemaDefaults } from "./schema.ts";

/** MUST match `connect.configTarget` in plugin.json. */
const CONFIG_TARGET = join(homedir(), ".config", "dimension-gen-fal", "key.json");

/** How long a read of fal's catalogue and prices is trusted. A model list edit in
 *  models.json or a price change at fal shows up within this, with no restart. */
const CATALOGUE_TTL_MS = 10 * 60_000;
const CATALOGUE_TIMEOUT_MS = 60_000;

const DOWNLOADS_AT_ONCE = 4;
/** fal books a request a moment after it finishes; one patient re-read is enough. */
const BILLING_RETRY_MS = 2_000;
/** The billing query starts a little before the submit, so clock skew cannot hide the event. */
const BILLING_SKEW_MS = 60_000;
/** Results `status` fetched, kept for `fetch`: bounded, because a job nobody fetches must not leak. */
const KEPT_RESULTS = 16;
const KEPT_UPLOADS = 64;

export interface FalProviderOptions {
	/** Where the API key comes from. Default: the connect form's config file. */
	readonly apiKey?: () => Promise<string>;
	/** Test seam. */
	readonly fetch?: typeof fetch;
	/** Location of models.json. Default: beside this file. */
	readonly modelsPath?: string;
	readonly now?: () => number;
	/** Test seam: the wait before asking fal's billing events a second time. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
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
			"fal is not connected — add a fal API key on the pack's Connect page (create one at https://fal.ai/dashboard/keys)",
		);
	}
	// A parse error quotes the offending token — which in a hand-edited file IS
	// the key — so the parse error is replaced, never passed on.
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		throw new Error("gen-fal's stored key is not valid JSON — reconnect the pack");
	}
	const access = isRecord(stored) ? stored.access : undefined;
	if (typeof access !== "string" || access.trim() === "") {
		throw new Error("gen-fal's stored key is empty — reconnect the pack");
	}
	return access.trim();
}

/** A model fal offers right now, with everything a request to it needs. */
interface ReadyModel {
	readonly entry: ModelEntry;
	readonly schema: OptionsSchema;
	readonly price: LivePrice | undefined;
	readonly licence: GenerationLicence;
	readonly model: GenerationModel;
}

interface Catalogue {
	readonly ready: ReadonlyMap<string, ReadyModel>;
	/** Endpoints in models.json that are not offered, and why. */
	readonly unavailable: ReadonlyMap<string, string>;
	/** Facts about the catalogue as a whole, e.g. that live prices could not be read. */
	readonly notes: readonly string[];
	readonly uploadExpireSeconds: number;
}

/** What `submit` hands the engine and `status`/`fetch`/`cancel` read back. */
interface JobRef {
	readonly v: 1;
	readonly endpoint: string;
	readonly requestId: string;
	readonly statusUrl: string;
	readonly responseUrl: string;
	readonly cancelUrl: string;
	readonly submittedAt: number;
	readonly quoteUsd: number;
	readonly quoteBasis: string;
	readonly licence: GenerationLicence;
	/** The body fal was sent: the effective settings, with uploaded files as URLs. */
	readonly input: Readonly<Record<string, unknown>>;
}

function decodeRef(ref: string): JobRef {
	let parsed: unknown;
	try {
		parsed = JSON.parse(ref);
	} catch {
		throw new Error("not a fal job reference");
	}
	if (!isRecord(parsed) || parsed.v !== 1) throw new Error("not a fal job reference");
	for (const field of ["endpoint", "requestId", "statusUrl", "responseUrl", "cancelUrl", "quoteBasis"] as const) {
		if (typeof parsed[field] !== "string") throw new Error(`fal job reference has no ${field}`);
	}
	if (typeof parsed.submittedAt !== "number" || typeof parsed.quoteUsd !== "number") {
		throw new Error("fal job reference has no submit time or quote");
	}
	if (!isRecord(parsed.licence) || !isRecord(parsed.input)) throw new Error("fal job reference has no licence or input");
	// Written by `submit` below; the checks above are against a hand-edited ref.
	return parsed as unknown as JobRef;
}

/** The licence a model's output carries. A "commercial" answer recorded in models.json
 *  is withdrawn when fal's own catalogue stops listing the endpoint as commercial. */
function reconcileLicence(recorded: GenerationLicence, liveType: string | undefined): GenerationLicence {
	if (recorded.commercialUse !== "yes" || liveType === undefined || liveType === "commercial") return recorded;
	return {
		...recorded,
		commercialUse: "unknown",
		note: `${recorded.note ?? ""} fal's catalogue now lists this endpoint as license_type=${liveType}, not commercial, so the recorded commercial-use answer is withdrawn until it is reviewed.`.trim(),
	};
}

function describeModel(
	entry: ModelEntry,
	schema: OptionsSchema,
	price: LivePrice | undefined,
	licence: GenerationLicence,
): GenerationModel {
	const { pricing } = entry;
	const live = price !== undefined && price.unit === pricing.unit;
	const unitPrice = live ? price.unitPrice : pricing.unitPrice;
	return {
		id: entry.endpoint,
		label: entry.label,
		produces: entry.produces,
		accepts: entry.accepts,
		...(entry.maxImages !== undefined && { maxImages: entry.maxImages }),
		options: schema,
		priceBasis: `${pricing.basis}. Billed as ${pricing.unit} at $${unitPrice} each (${live ? "fal's live price" : "recorded in models.json"}).`,
		licence,
		...(entry.features !== undefined && { features: entry.features }),
	};
}

async function buildCatalogue(api: Api, data: PackData, signal: AbortSignal): Promise<Catalogue> {
	const endpoints = data.models.map(model => model.endpoint);
	const live = await fetchCatalogue(api, endpoints, signal);
	const notes: string[] = [];
	let prices: Map<string, LivePrice> | undefined;
	try {
		prices = await fetchPrices(api, endpoints, signal);
	} catch (error) {
		// The catalogue answers without a key, the pricing API does not: a 401 here is the key.
		if (error instanceof FalError && error.status === 401) throw error;
		notes.push(`fal's pricing API was unavailable (${messageOf(error)}): quotes use the prices recorded in models.json`);
	}
	const ready = new Map<string, ReadyModel>();
	const unavailable = new Map<string, string>();
	for (const entry of data.models) {
		const found = live.get(entry.endpoint);
		if (found === undefined) {
			unavailable.set(entry.endpoint, "fal's catalogue does not list it");
		} else if (found.status === "deprecated") {
			unavailable.set(entry.endpoint, "fal lists it as deprecated");
		} else if (found.openapi === undefined) {
			unavailable.set(entry.endpoint, "fal returned no input schema for it");
		} else {
			try {
				const built = buildOptionsSchema(found.openapi, claimedFields(entry));
				if (built.missing.length > 0) {
					unavailable.set(entry.endpoint, `fal's input schema no longer has ${built.missing.join(", ")}`);
					continue;
				}
				const price = prices?.get(entry.endpoint);
				if (price !== undefined && price.unit !== entry.pricing.unit) {
					notes.push(
						`${entry.endpoint} now bills in "${price.unit}", not "${entry.pricing.unit}": its quotes use the price recorded in models.json`,
					);
				}
				const licence = reconcileLicence(entry.licence, found.licenseType);
				ready.set(entry.endpoint, {
					entry,
					schema: built.options,
					price,
					licence,
					model: describeModel(entry, built.options, price, licence),
				});
			} catch (error) {
				unavailable.set(entry.endpoint, messageOf(error));
			}
		}
	}
	return { ready, unavailable, notes, uploadExpireSeconds: data.uploadExpireSeconds };
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

/** fal bills only successful outputs and never a server error (fal's pricing docs),
 *  so a failed job is not billed. */
function failed(error: string): GenerationStatus {
	return { state: "failed", error, billed: false };
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

/** A finished job's result as fal gave it, or the reason fal's app rejected the request. */
type ResultRead = { readonly result: Record<string, unknown> } | { readonly rejected: string };

export function createFalProvider(options: FalProviderOptions = {}): GenerationProvider {
	const readKey = options.apiKey ?? (() => readConnectKey());
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const wait = options.sleep ?? ((ms: number, signal: AbortSignal) => sleepFor(ms, undefined, { signal }));

	let cached: { readonly at: number; readonly value: Catalogue } | undefined;
	let building: Promise<Catalogue> | undefined;
	const uploads = new Map<string, { readonly url: string; readonly at: number }>();
	const finished = new Map<string, { readonly result: Record<string, unknown>; readonly inferenceSeconds?: number }>();

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

	async function findModel(
		api: Api,
		id: string,
		signal: AbortSignal,
	): Promise<{ model: ReadyModel; uploadExpireSeconds: number }> {
		const offered = await catalogue(api, signal);
		const model = offered.ready.get(id);
		if (model !== undefined) return { model, uploadExpireSeconds: offered.uploadExpireSeconds };
		const why = offered.unavailable.get(id);
		throw new Error(
			why === undefined
				? `fal model "${id}" is not one this pack offers (offered: ${[...offered.ready.keys()].join(", ") || "none"})`
				: `fal model "${id}" is unavailable: ${why}`,
		);
	}

	function priceContext(model: ReadyModel, request: GenerationRequest): PriceContext {
		const provided = request.options ?? {};
		return {
			provided,
			effective: { ...schemaDefaults(model.schema), ...provided },
			images: request.input.images?.length ?? 0,
		};
	}

	/** Upload once per file and CDN lifetime: a best-of-N run sends one reference image to many models. */
	async function upload(api: Api, path: string, expireSeconds: number, signal: AbortSignal): Promise<string> {
		const info = await stat(path).catch(() => undefined);
		const key = info === undefined ? undefined : `${path}|${info.size}|${info.mtimeMs}`;
		const hit = key === undefined ? undefined : uploads.get(key);
		// Half the expiry, so a reused URL always has most of its life left.
		if (hit !== undefined && now() - hit.at < expireSeconds * 500) return hit.url;
		const url = await uploadFile(api, path, expireSeconds, signal);
		if (key !== undefined) {
			if (uploads.size >= KEPT_UPLOADS) evictOldest(uploads);
			uploads.set(key, { url, at: now() });
		}
		return url;
	}

	async function readResult(api: Api, job: JobRef, signal: AbortSignal): Promise<ResultRead> {
		const response = await call(api, "GET", job.responseUrl, { signal });
		if (!response.ok) {
			// fal reports a request its app rejected through the result's HTTP status. Auth, rate
			// limits and server errors are not the request's failure and are the engine's to retry.
			const ownFailure = response.status >= 400 && response.status < 500 && ![401, 403, 408, 429].includes(response.status);
			if (ownFailure) return { rejected: falDetail(response.body) ?? `fal rejected the request (HTTP ${response.status})` };
			throw failure(response, "fetching the job's result");
		}
		if (!isRecord(response.body)) throw new FalError("fal's result is not a JSON object", 0);
		return { result: response.body };
	}

	async function billedFor(api: Api, job: JobRef, signal: AbortSignal): Promise<Billed> {
		const since = new Date(job.submittedAt - BILLING_SKEW_MS);
		const ask = (): Promise<Billed> =>
			fetchBilled(api, job.requestId, since, signal).catch((error): Billed => {
				if (signal.aborted) throw error;
				return { unavailable: messageOf(error) };
			});
		const first = await ask();
		if (!("pending" in first)) return first;
		await wait(BILLING_RETRY_MS, signal);
		return ask();
	}

	return {
		id: "fal",

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
			const problems = [...offered.unavailable].map(([id, why]) => `${id}: ${why}`).concat(offered.notes);
			if (offered.ready.size === 0) {
				return { ready: false, reason: `fal offers none of this pack's models (${problems.join("; ")})`, models: [] };
			}
			return {
				ready: true,
				...(problems.length > 0 && { reason: problems.join("; ") }),
				models: [...offered.ready.values()].map(ready => ready.model),
			};
		},

		async quote(request, { signal }) {
			const api = await connect();
			const { model } = await findModel(api, request.model, signal);
			checkRequest(model.entry, model.schema, request);
			return quoteRequest(model.entry.pricing, priceContext(model, request), model.price);
		},

		async submit(request, { signal }) {
			const api = await connect();
			const { model, uploadExpireSeconds } = await findModel(api, request.model, signal);
			const quote = quoteRequest(model.entry.pricing, priceContext(model, request), model.price);
			const body = await buildBody(model.entry, model.schema, request, path =>
				upload(api, path, uploadExpireSeconds, signal),
			);
			const sent = await submitJob(api, model.entry.endpoint, body, signal);
			const job: JobRef = {
				v: 1,
				endpoint: model.entry.endpoint,
				requestId: sent.requestId,
				statusUrl: sent.statusUrl,
				responseUrl: sent.responseUrl,
				cancelUrl: sent.cancelUrl,
				submittedAt: now(),
				quoteUsd: quote.usd,
				quoteBasis: quote.basis,
				licence: model.licence,
				input: body,
			};
			return { ref: JSON.stringify(job) };
		},

		async status(ref, { signal }): Promise<GenerationStatus> {
			const job = decodeRef(ref);
			const api = await connect();
			const response = await call(api, "GET", `${job.statusUrl}?logs=1`, { signal });
			if (response.status === 404) return failed(`fal no longer has request ${job.requestId} (HTTP 404)`);
			if (!response.ok) throw failure(response, "reading the job's status");
			const status = parseQueueStatus(response.body);
			switch (status.state) {
				case "IN_QUEUE":
					return {
						state: "queued",
						message: status.position === undefined ? "waiting in fal's queue" : `position ${status.position} in fal's queue`,
					};
				case "IN_PROGRESS":
					return { state: "running", ...(status.lastLog !== undefined && { message: status.lastLog }) };
				case "UNKNOWN":
					throw new FalError(`fal reported the job in a state this pack does not know: "${status.raw}"`, 0);
				case "COMPLETED": {
					if (status.error !== undefined) return failed(status.error);
					if (finished.has(job.requestId)) return { state: "succeeded" };
					// COMPLETED is not "succeeded": a request fal's app rejected is completed too, and
					// says so only through the result. Reading it here keeps that out of `fetch`.
					const read = await readResult(api, job, signal);
					if ("rejected" in read) return failed(read.rejected);
					if (finished.size >= KEPT_RESULTS) evictOldest(finished);
					finished.set(job.requestId, {
						result: read.result,
						...(status.inferenceSeconds !== undefined && { inferenceSeconds: status.inferenceSeconds }),
					});
					return { state: "succeeded" };
				}
			}
		},

		async fetch(ref, { outDir, signal }) {
			const job = decodeRef(ref);
			const api = await connect();
			let known = finished.get(job.requestId);
			if (known === undefined) {
				// After a restart `status` has not run in this process: read the result again.
				const read = await readResult(api, job, signal);
				if ("rejected" in read) throw new Error(`fal job ${job.requestId} failed: ${read.rejected}`);
				const timing = await call(api, "GET", job.statusUrl, { signal })
					.then(response => (response.ok ? parseQueueStatus(response.body) : undefined))
					.catch(() => undefined);
				known = {
					result: read.result,
					...(timing?.state === "COMPLETED" &&
						timing.inferenceSeconds !== undefined && { inferenceSeconds: timing.inferenceSeconds }),
				};
			}
			finished.delete(job.requestId);

			const data = await loadPackData(options.modelsPath);
			const entry = data.models.find(model => model.endpoint === job.endpoint);
			const files = collectFiles(known.result, [...(entry?.outputRoles ?? []), ...data.outputRoles]);
			if (files.length === 0) {
				throw new Error(`fal's result for ${job.endpoint} (request ${job.requestId}) contains no files`);
			}

			// The engine fails a job whose file paths are not absolute and inside the outDir it passed.
			const dir = resolve(outDir);
			await mkdir(dir, { recursive: true });
			const group = new AbortController();
			const stop = AbortSignal.any([signal, group.signal]);
			let bytes: number[];
			try {
				bytes = await mapPool(files, DOWNLOADS_AT_ONCE, file =>
					downloadFile(doFetch, file.url, join(dir, file.name), stop),
				);
			} catch (error) {
				group.abort();
				throw error;
			}

			const billed = await billedFor(api, job, signal);
			const handle = makeHandle(files);
			return {
				files: files.map(file => ({
					path: join(dir, file.name),
					role: file.role,
					format: file.format,
					label: file.label,
				})),
				costUsd: "usd" in billed ? billed.usd : job.quoteUsd,
				licence: job.licence,
				...(handle !== undefined && { handle }),
				meta: {
					vendor: "fal",
					endpoint: job.endpoint,
					requestId: job.requestId,
					input: job.input,
					// fal's own scalar answers: the seed it used, vendor task ids.
					output: Object.fromEntries(
						Object.entries(known.result).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)),
					),
					quote: { usd: job.quoteUsd, basis: job.quoteBasis },
					cost:
						"usd" in billed
							? { source: "fal-billing-events", usd: billed.usd, ...(billed.units !== undefined && { units: billed.units }) }
							: { source: "quote", usd: job.quoteUsd, reason: billed.unavailable },
					timings: {
						submittedAt: new Date(job.submittedAt).toISOString(),
						fetchedAt: new Date(now()).toISOString(),
						...(known.inferenceSeconds !== undefined && { inferenceSeconds: known.inferenceSeconds }),
					},
					files: files.map((file, index) => ({ label: file.label, name: file.name, url: file.url, bytes: bytes[index] })),
				},
			};
		},

		async cancel(ref, { signal }) {
			const job = decodeRef(ref);
			await cancelJob(await connect(), job.cancelUrl, signal);
		},
	};
}

export { parseQueueStatus } from "./client.ts";
export { buildBody, checkRequest, claimedFields } from "./input.ts";
export { loadPackData, parsePackData } from "./models.ts";
export { priceUnits, quoteRequest } from "./pricing.ts";
export { chainedFile, collectFiles, makeHandle } from "./result.ts";
export { buildOptionsSchema, validateOptions } from "./schema.ts";

/** The factory the engine's provider lane imports (doc 75 §2). */
export function createGenerationProvider(): GenerationProvider {
	return createFalProvider();
}
