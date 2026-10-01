// fal's HTTP surface: the queue (queue.fal.run), the Platform API (api.fal.ai:
// catalogue, pricing, billing events) and the CDN upload protocol (rest.fal.ai).
//
// Protocol only: no model ids, prices or schemas live here. The `Authorization:
// Key` header goes to fal's own hosts and nowhere else — result files are
// downloaded and CDN parts are uploaded without it — and no message built here
// carries the key.

import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { isRecord } from "./guards.ts";
import type { LivePrice } from "./pricing.ts";

export const QUEUE_ORIGIN = "https://queue.fal.run";
export const API_ORIGIN = "https://api.fal.ai";
export const REST_ORIGIN = "https://rest.fal.ai";

/** An API call that expects a short answer. Uploads and downloads set their own limits. */
const CALL_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 15 * 60_000;

/** fal's JS client switches to a multipart upload above this size. */
const MULTIPART_THRESHOLD = 90 * 1024 * 1024;
const MULTIPART_CHUNK = 10 * 1024 * 1024;
const MULTIPART_PART_ATTEMPTS = 3;

/** The catalogue endpoint refuses `limit` above a small number when it expands
 *  OpenAPI schemas (50 returned 400; 8 works), so endpoints are asked for in groups. */
const CATALOGUE_GROUP = 8;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	glb: "model/gltf-binary",
	gltf: "model/gltf+json",
	obj: "model/obj",
	stl: "model/stl",
	usdz: "model/vnd.usdz+zip",
};

export interface Api {
	readonly fetch: typeof fetch;
	readonly key: string;
}

/** A failed call to fal. `status` is the HTTP status, 0 when none was reached. */
export class FalError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "FalError";
	}
}

export interface FalResponse {
	readonly status: number;
	readonly ok: boolean;
	readonly body: unknown;
}

interface CallOptions {
	readonly signal: AbortSignal;
	readonly body?: unknown;
	readonly headers?: Readonly<Record<string, string>>;
}

async function readBody(response: Response): Promise<unknown> {
	const text = await response.text().catch(() => "");
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text.slice(0, 400);
	}
}

/** One call to a fal host, with the key. Never throws for an HTTP status. */
export async function call(api: Api, method: string, url: string, options: CallOptions): Promise<FalResponse> {
	const trusted = [QUEUE_ORIGIN, API_ORIGIN, REST_ORIGIN].some(origin => url.startsWith(`${origin}/`));
	if (!trusted) throw new FalError("refusing to send the fal API key to a host that is not fal's", 0);
	const response = await api.fetch(url, {
		method,
		headers: {
			authorization: `Key ${api.key}`,
			accept: "application/json",
			...(options.body !== undefined && { "content-type": "application/json" }),
			...options.headers,
		},
		...(options.body !== undefined && { body: JSON.stringify(options.body) }),
		signal: AbortSignal.any([options.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
	});
	return { status: response.status, ok: response.ok, body: await readBody(response) };
}

/** fal's explanation of a failure, whichever of its error shapes carried it. */
export function falDetail(body: unknown): string | undefined {
	if (typeof body === "string") return body.slice(0, 400);
	if (!isRecord(body)) return undefined;
	let detail: string | undefined;
	if (typeof body.detail === "string") {
		detail = body.detail;
	} else if (Array.isArray(body.detail)) {
		detail = body.detail
			.map(item => {
				if (!isRecord(item)) return String(item);
				const where = Array.isArray(item.loc) ? item.loc.filter(part => part !== "body").join(".") : "";
				const message = typeof item.msg === "string" ? item.msg : "invalid";
				return `${where === "" ? "" : `${where}: `}${message}${typeof item.type === "string" ? ` (${item.type})` : ""}`;
			})
			.join("; ");
	} else if (isRecord(body.error) && typeof body.error.message === "string") {
		detail = body.error.message;
	} else if (typeof body.error === "string") {
		detail = body.error;
	}
	if (detail === undefined || detail === "") return undefined;
	return `${typeof body.error_type === "string" ? `${body.error_type}: ` : ""}${detail}`.slice(0, 400);
}

/** The error for a response that was not OK, naming what was being attempted. */
export function failure(response: FalResponse, doing: string): FalError {
	if (response.status === 401) {
		return new FalError(`fal rejected the API key (401) while ${doing} — reconnect the pack with a valid key`, 401);
	}
	const detail = falDetail(response.body);
	return new FalError(`fal refused ${doing} (HTTP ${response.status})${detail === undefined ? "" : `: ${detail}`}`, response.status);
}

export interface Submitted {
	readonly requestId: string;
	readonly statusUrl: string;
	readonly responseUrl: string;
	readonly cancelUrl: string;
}

/** A queue URL fal handed back, checked before the key is ever sent to it. */
function queueUrl(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || !value.startsWith(`${QUEUE_ORIGIN}/`)) {
		throw new FalError(`fal's submit response has no usable ${field}`, 0);
	}
	return value;
}

/** Put a job on fal's queue. fal returns the URLs to poll, fetch and cancel it with:
 *  they are used as given, because fal names them after the app behind an endpoint
 *  (`tripo3d/p2/image-to-3d` is polled at `fal-ai/tripo3d`), not after the endpoint id. */
export async function submitJob(
	api: Api,
	endpoint: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
): Promise<Submitted> {
	const response = await call(api, "POST", `${QUEUE_ORIGIN}/${endpoint}`, { body, signal });
	if (!response.ok) throw failure(response, `submitting a job to ${endpoint}`);
	if (!isRecord(response.body) || typeof response.body.request_id !== "string") {
		throw new FalError("fal's submit response has no request_id", 0);
	}
	return {
		requestId: response.body.request_id,
		statusUrl: queueUrl(response.body, "status_url"),
		responseUrl: queueUrl(response.body, "response_url"),
		cancelUrl: queueUrl(response.body, "cancel_url"),
	};
}

export type QueueStatus =
	| { readonly state: "IN_QUEUE"; readonly position?: number }
	| { readonly state: "IN_PROGRESS"; readonly lastLog?: string }
	| {
			readonly state: "COMPLETED";
			readonly inferenceSeconds?: number;
			/** Present when the request failed: fal's `error_type: error`. */
			readonly error?: string;
	  }
	| { readonly state: "UNKNOWN"; readonly raw: string };

/** Read fal's status JSON. A state this pack does not know reads as UNKNOWN, never as done. */
export function parseQueueStatus(body: unknown): QueueStatus {
	if (!isRecord(body) || typeof body.status !== "string") throw new FalError("fal's status response has no status", 0);
	if (body.status === "IN_QUEUE") {
		return { state: "IN_QUEUE", ...(typeof body.queue_position === "number" && { position: body.queue_position }) };
	}
	if (body.status === "IN_PROGRESS") {
		const logs = Array.isArray(body.logs) ? body.logs : [];
		const last = logs.at(-1);
		const lastLog = isRecord(last) && typeof last.message === "string" ? last.message.slice(0, 200) : undefined;
		return { state: "IN_PROGRESS", ...(lastLog !== undefined && { lastLog }) };
	}
	if (body.status === "COMPLETED") {
		const metrics = isRecord(body.metrics) ? body.metrics : {};
		const reason = typeof body.error === "string" ? body.error : "";
		const kind = typeof body.error_type === "string" ? `${body.error_type}: ` : "";
		return {
			state: "COMPLETED",
			...(typeof metrics.inference_time === "number" && { inferenceSeconds: metrics.inference_time }),
			...(reason !== "" && { error: `${kind}${reason}`.slice(0, 400) }),
		};
	}
	return { state: "UNKNOWN", raw: body.status };
}

/** Ask fal to cancel. A job already done, or one fal no longer knows, has nothing
 *  left to cancel: the engine's next status poll tells it which. Anything else is an error. */
export async function cancelJob(api: Api, cancelUrl: string, signal: AbortSignal): Promise<void> {
	const response = await call(api, "PUT", cancelUrl, { signal });
	if (response.ok || response.status === 404) return;
	if (response.status === 400 && isRecord(response.body) && response.body.status === "ALREADY_COMPLETED") return;
	throw failure(response, "cancelling the job");
}

/** The catalogue entry of one endpoint. `openapi` is fal's OpenAPI 3.0 document. */
export interface LiveModel {
	readonly status: string | undefined;
	readonly licenseType: string | undefined;
	readonly openapi: unknown;
}

/** fal's catalogue entries, with their OpenAPI schemas, for these endpoints. */
export async function fetchCatalogue(api: Api, endpoints: readonly string[], signal: AbortSignal): Promise<Map<string, LiveModel>> {
	const live = new Map<string, LiveModel>();
	for (let from = 0; from < endpoints.length; from += CATALOGUE_GROUP) {
		const group = endpoints.slice(from, from + CATALOGUE_GROUP);
		const query = [
			...group.map(endpoint => `endpoint_id=${encodeURIComponent(endpoint)}`),
			"expand=openapi-3.0",
			`limit=${group.length}`,
		].join("&");
		const response = await call(api, "GET", `${API_ORIGIN}/v1/models?${query}`, { signal });
		if (!response.ok) throw failure(response, "reading fal's model catalogue");
		const models = isRecord(response.body) && Array.isArray(response.body.models) ? response.body.models : [];
		for (const model of models) {
			if (!isRecord(model) || typeof model.endpoint_id !== "string") continue;
			const metadata = isRecord(model.metadata) ? model.metadata : {};
			const openapi = isRecord(model.openapi) && typeof model.openapi.openapi === "string" ? model.openapi : undefined;
			live.set(model.endpoint_id, {
				status: typeof metadata.status === "string" ? metadata.status : undefined,
				licenseType: typeof metadata.license_type === "string" ? metadata.license_type : undefined,
				openapi,
			});
		}
	}
	return live;
}

/** fal's unit price for each endpoint. An endpoint missing from the answer is
 *  missing from the map. */
export async function fetchPrices(api: Api, endpoints: readonly string[], signal: AbortSignal): Promise<Map<string, LivePrice>> {
	const query = endpoints.map(endpoint => `endpoint_id=${encodeURIComponent(endpoint)}`).join("&");
	const response = await call(api, "GET", `${API_ORIGIN}/v1/models/pricing?${query}`, { signal });
	if (!response.ok) throw failure(response, "reading fal's prices");
	const prices = new Map<string, LivePrice>();
	const rows = isRecord(response.body) && Array.isArray(response.body.prices) ? response.body.prices : [];
	for (const row of rows) {
		if (!isRecord(row) || typeof row.endpoint_id !== "string") continue;
		if (typeof row.unit_price !== "number" || typeof row.unit !== "string") continue;
		if (row.currency !== undefined && row.currency !== "USD") continue;
		prices.set(row.endpoint_id, { unitPrice: row.unit_price, unit: row.unit });
	}
	return prices;
}

/** What fal actually charged for a request, or why that is not known. `pending`
 *  marks the one reason worth asking again for: fal had not booked the request yet. */
export type Billed =
	| { readonly usd: number; readonly units?: number }
	| { readonly unavailable: string; readonly pending?: true };

/** fal's billing event for a request: the amount charged after discounts. */
export async function fetchBilled(api: Api, requestId: string, since: Date, signal: AbortSignal): Promise<Billed> {
	const query = `request_id=${encodeURIComponent(requestId)}&start=${encodeURIComponent(since.toISOString())}`;
	const response = await call(api, "GET", `${API_ORIGIN}/v1/models/billing-events?${query}`, { signal });
	if (response.status === 401 || response.status === 403) {
		return { unavailable: `fal's billing events refused this key (HTTP ${response.status}); an admin-scope key can read them` };
	}
	if (!response.ok) return { unavailable: `fal's billing events failed (HTTP ${response.status})` };
	const events = isRecord(response.body) && Array.isArray(response.body.billing_events) ? response.body.billing_events : [];
	let usd = 0;
	let units = 0;
	let counted = 0;
	for (const event of events) {
		if (!isRecord(event) || typeof event.cost_total !== "number") continue;
		usd += event.cost_total;
		units += typeof event.output_units === "number" ? event.output_units : 0;
		counted++;
	}
	if (counted === 0) return { unavailable: "fal had not recorded a billing event for the request yet", pending: true };
	return { usd: Math.round(usd * 1e9) / 1e9, ...(units > 0 && { units }) };
}

function contentTypeOf(path: string): string {
	return CONTENT_TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

interface UploadTarget {
	readonly uploadUrl: string;
	readonly fileUrl: string;
}

async function initiateUpload(
	api: Api,
	endpoint: "initiate" | "initiate-multipart",
	path: string,
	expireSeconds: number,
	signal: AbortSignal,
): Promise<UploadTarget> {
	const response = await call(api, "POST", `${REST_ORIGIN}/storage/upload/${endpoint}?storage_type=fal-cdn-v3`, {
		body: { content_type: contentTypeOf(path), file_name: basename(path) },
		headers: { "x-fal-object-lifecycle": JSON.stringify({ expiration_duration_seconds: expireSeconds }) },
		signal,
	});
	if (!response.ok) throw failure(response, `starting an upload of ${basename(path)}`);
	const body = response.body;
	if (!isRecord(body) || typeof body.upload_url !== "string" || typeof body.file_url !== "string") {
		throw new FalError("fal's upload response has no upload_url and file_url", 0);
	}
	return { uploadUrl: body.upload_url, fileUrl: body.file_url };
}

/** A part PUT to the CDN, answered with its etag (in the body, repeated as a header). */
async function putPart(
	api: Api,
	url: string,
	chunk: Buffer<ArrayBuffer>,
	partNumber: number,
	signal: AbortSignal,
): Promise<string> {
	let last: unknown;
	for (let attempt = 1; attempt <= MULTIPART_PART_ATTEMPTS; attempt++) {
		try {
			const response = await api.fetch(url, {
				method: "PUT",
				body: chunk,
				signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)]),
			});
			if (response.ok) {
				const body = await readBody(response);
				const etag = (isRecord(body) && typeof body.etag === "string" ? body.etag : undefined) ?? response.headers.get("etag");
				if (etag) return etag;
				throw new FalError(`fal's CDN acknowledged part ${partNumber} without an etag`, response.status);
			}
			last = new FalError(`fal's CDN refused part ${partNumber} (HTTP ${response.status})`, response.status);
			// A client error will not succeed on a repeat; a 429 or a 5xx may.
			if (response.status < 500 && response.status !== 429) break;
		} catch (error) {
			if (signal.aborted) throw error;
			last = error;
		}
	}
	throw last instanceof Error ? last : new FalError(`uploading part ${partNumber} failed`, 0);
}

async function multipartUpload(api: Api, path: string, size: number, expireSeconds: number, signal: AbortSignal): Promise<string> {
	const { uploadUrl, fileUrl } = await initiateUpload(api, "initiate-multipart", path, expireSeconds, signal);
	const target = new URL(uploadUrl);
	const at = (suffix: string): string => `${target.origin}${target.pathname}${suffix}${target.search}`;
	const parts: { partNumber: number; etag: string }[] = [];
	const handle = await open(path, "r");
	try {
		for (let offset = 0, partNumber = 1; offset < size; offset += MULTIPART_CHUNK, partNumber++) {
			const chunk = Buffer.allocUnsafe(Math.min(MULTIPART_CHUNK, size - offset));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
			if (bytesRead !== chunk.length) throw new FalError(`${basename(path)} changed size while it was being uploaded`, 0);
			parts.push({ partNumber, etag: await putPart(api, at(`/${partNumber}`), chunk, partNumber, signal) });
		}
	} finally {
		await handle.close();
	}
	const done = await api.fetch(at("/complete"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ parts }),
		signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
	});
	if (!done.ok) throw new FalError(`fal's CDN would not complete the upload of ${basename(path)} (HTTP ${done.status})`, done.status);
	return fileUrl;
}

/** Upload a local file to fal's CDN and return its URL — the form every fal
 *  endpoint accepts for a file (data URIs are not recommended beyond a few KB). */
export async function uploadFile(api: Api, path: string, expireSeconds: number, signal: AbortSignal): Promise<string> {
	const { size } = await stat(path).catch(() => {
		throw new FalError(`cannot read ${path} to upload it to fal`, 0);
	});
	if (size === 0) throw new FalError(`${path} is empty`, 0);
	if (size > MULTIPART_THRESHOLD) return multipartUpload(api, path, size, expireSeconds, signal);
	const { uploadUrl, fileUrl } = await initiateUpload(api, "initiate", path, expireSeconds, signal);
	const bytes = await readFile(path);
	const response = await api.fetch(uploadUrl, {
		method: "PUT",
		headers: { "content-type": contentTypeOf(path) },
		body: bytes,
		signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new FalError(`fal's CDN refused ${basename(path)} (HTTP ${response.status})`, response.status);
	return fileUrl;
}

/** Stream a result file to `dest`, through a temporary name so a failed download
 *  never leaves something that looks like the file. Fetched without the key. */
export async function downloadFile(doFetch: typeof fetch, url: string, dest: string, signal: AbortSignal): Promise<number> {
	const partial = `${dest}.part`;
	try {
		const response = await doFetch(url, { signal });
		if (!response.ok || response.body === null) {
			throw new FalError(`downloading ${basename(dest)} from fal failed (HTTP ${response.status})`, response.status);
		}
		// Chunk by chunk, so a 100 MB GLB is never held in memory and a stream that dies
		// mid-body surfaces here as an error instead of a hang.
		const file = await open(partial, "w");
		try {
			for await (const chunk of response.body) {
				for (let written = 0; written < chunk.length; ) {
					written += (await file.write(chunk, written, chunk.length - written)).bytesWritten;
				}
			}
		} finally {
			await file.close();
		}
		await rename(partial, dest);
		return (await stat(dest)).size;
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
}

/** Run `work` over `items`, at most `limit` at a time, keeping result order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (let index = next++; index < items.length; index = next++) {
			results[index] = await work(items[index] as T, index);
		}
	});
	await Promise.all(lanes);
	return results;
}
