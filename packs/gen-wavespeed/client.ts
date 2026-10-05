// WaveSpeed's HTTP surface, all of it on api.wavespeed.ai/api/v3:
//   GET  /models                    the live catalogue with every model's request schema
//   POST /model/price               what a request will be charged
//   POST /{model_id}                submit a task
//   GET  /predictions/{id}/result   poll a task and read its outputs
//   POST /media/uploads             a ticket to upload a local file
//
// Protocol only: no model ids, prices or schemas live here. The `Authorization:
// Bearer` header goes to api.wavespeed.ai and nowhere else — the upload PUT and the
// result downloads go to hosts WaveSpeed names per request, without it — and no
// message built here carries the key.
//
// Every answer from the API is an envelope `{ code, message, data }`; an HTTP
// error carries the same envelope with the reason in `message`.

import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { isRecord } from "./guards.ts";

const API_ORIGIN = "https://api.wavespeed.ai";

/** An API call that expects a short answer. Uploads and downloads set their own limits. */
const CALL_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 15 * 60_000;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

/** A task id as WaveSpeed issues it (hex, `pred_…`, `task-…`). It goes into a URL path. */
const TASK_ID = /^[A-Za-z0-9_-]{4,128}$/;

export interface Api {
	readonly fetch: typeof fetch;
	readonly key: string;
}

/** A failed call to WaveSpeed. `status` is the HTTP status, 0 when none was reached. */
export class WaveSpeedError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "WaveSpeedError";
	}
}

export interface WaveSpeedResponse {
	readonly status: number;
	readonly ok: boolean;
	readonly body: unknown;
}

interface CallOptions {
	readonly signal: AbortSignal;
	readonly body?: unknown;
	readonly timeoutMs?: number;
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

/** One call to WaveSpeed's API, with the key. `path` is under `/api/v3/`. Never throws for an HTTP status. */
export async function call(api: Api, method: string, path: string, options: CallOptions): Promise<WaveSpeedResponse> {
	const response = await api.fetch(`${API_ORIGIN}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${api.key}`,
			accept: "application/json",
			...(options.body !== undefined && { "content-type": "application/json" }),
		},
		...(options.body !== undefined && { body: JSON.stringify(options.body) }),
		signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS)]),
	});
	return { status: response.status, ok: response.ok, body: await readBody(response) };
}

/** WaveSpeed's explanation of a failure: the envelope's `message`. */
function reasonOf(body: unknown): string | undefined {
	if (typeof body === "string") return body.slice(0, 400);
	if (isRecord(body) && typeof body.message === "string" && body.message !== "") return body.message.slice(0, 400);
	return undefined;
}

/** The error for a response that was not OK, naming what was being attempted. */
export function failure(response: WaveSpeedResponse, doing: string): WaveSpeedError {
	if (response.status === 401) {
		return new WaveSpeedError(`WaveSpeed rejected the API key (401) while ${doing} — reconnect the pack with a valid key`, 401);
	}
	const reason = reasonOf(response.body);
	return new WaveSpeedError(`WaveSpeed refused ${doing} (HTTP ${response.status})${reason === undefined ? "" : `: ${reason}`}`, response.status);
}

/** The `data` of an OK envelope. An envelope whose `code` is not 200 is a failure
 *  even under HTTP 200. */
function unwrap(response: WaveSpeedResponse, doing: string): unknown {
	if (!response.ok) throw failure(response, doing);
	const { body } = response;
	if (!isRecord(body)) throw new WaveSpeedError(`WaveSpeed's answer while ${doing} is not a JSON object`, 0);
	if (typeof body.code === "number" && body.code !== 200) {
		const reason = reasonOf(body);
		throw new WaveSpeedError(`WaveSpeed refused ${doing} (code ${body.code})${reason === undefined ? "" : `: ${reason}`}`, response.status);
	}
	return body.data;
}

/** A model's entry in WaveSpeed's catalogue. */
export interface LiveModel {
	/** Where the model is submitted to, e.g. `/api/v3/tripo3d/p2/image-to-3d`. */
	readonly apiPath: string | undefined;
	/** The model's request schema, as JSON Schema. */
	readonly requestSchema: unknown;
}

/** The catalogue entries of `wanted` model ids. The catalogue is one document of every
 *  model WaveSpeed runs (about 2 MB); only the entries asked for are kept. */
export async function fetchModels(api: Api, wanted: ReadonlySet<string>, signal: AbortSignal): Promise<Map<string, LiveModel>> {
	const response = await call(api, "GET", "/api/v3/models", { signal, timeoutMs: 60_000 });
	const data = unwrap(response, "reading the model catalogue");
	if (!Array.isArray(data)) throw new WaveSpeedError("WaveSpeed's model catalogue is not a list", 0);
	const live = new Map<string, LiveModel>();
	for (const entry of data) {
		if (!isRecord(entry) || typeof entry.model_id !== "string" || !wanted.has(entry.model_id)) continue;
		const schemas = isRecord(entry.api_schema) && Array.isArray(entry.api_schema.api_schemas) ? entry.api_schema.api_schemas : [];
		const run = schemas.find(schema => isRecord(schema) && schema.type === "model_run" && isRecord(schema.request_schema));
		if (isRecord(run)) {
			live.set(entry.model_id, {
				apiPath: typeof run.api_path === "string" ? run.api_path : undefined,
				requestSchema: run.request_schema,
			});
		}
	}
	return live;
}

/** What WaveSpeed will charge for a request, in USD. */
export interface Price {
	/** The model's price before the account's discount. */
	readonly listUsd: number;
	/** What the account pays. */
	readonly payableUsd: number;
}

/** Ask WaveSpeed's pricing API what `inputs` costs. Always sent with `inputs`: without
 *  them WaveSpeed answers the model's base price, which for several models is below
 *  what a default request is charged. */
export async function fetchPrice(api: Api, modelId: string, inputs: Record<string, unknown>, signal: AbortSignal): Promise<Price> {
	const response = await call(api, "POST", "/api/v3/model/price", { body: { model_id: modelId, inputs }, signal });
	const data = unwrap(response, `pricing a ${modelId} request`);
	if (!isRecord(data) || typeof data.price !== "number" || typeof data.discounted_price !== "number") {
		throw new WaveSpeedError(`WaveSpeed's price for ${modelId} has no price`, 0);
	}
	if (!(data.price >= 0) || !(data.discounted_price >= 0)) {
		throw new WaveSpeedError(`WaveSpeed's price for ${modelId} is not a non-negative amount`, 0);
	}
	if (data.currency !== undefined && data.currency !== "USD") {
		throw new WaveSpeedError(`WaveSpeed prices ${modelId} in ${String(data.currency)}, not USD`, 0);
	}
	return { listUsd: data.price, payableUsd: data.discounted_price };
}

/** Put a task on WaveSpeed's queue and return its id. Never retried: a submit whose
 *  answer was lost may still have been charged, and a second one would charge again. */
export async function submitTask(api: Api, modelId: string, body: Record<string, unknown>, signal: AbortSignal): Promise<string> {
	const response = await call(api, "POST", `/api/v3/${modelId}`, { body, signal });
	const data = unwrap(response, `submitting a task to ${modelId}`);
	if (!isRecord(data) || typeof data.id !== "string" || !TASK_ID.test(data.id)) {
		throw new WaveSpeedError("WaveSpeed's submit response has no usable task id", 0);
	}
	return data.id;
}

/** A task as `GET /predictions/{id}/result` reports it. */
export interface Task {
	/** created · processing · completed · failed · cancelled · timeout · deleted */
	readonly status: string;
	/** WaveSpeed's reason, with its error code, when the task did not succeed. */
	readonly error?: string;
	/** URLs, text, or structured values, depending on the model. */
	readonly outputs: readonly unknown[];
	readonly inferenceMs?: number;
}

/** Read a task. A task id WaveSpeed does not know is a 404 and throws. */
export async function readTask(api: Api, id: string, signal: AbortSignal): Promise<Task> {
	if (!TASK_ID.test(id)) throw new WaveSpeedError("not a WaveSpeed task id", 0);
	const response = await call(api, "GET", `/api/v3/predictions/${id}/result`, { signal });
	const data = unwrap(response, "reading the task's result");
	if (!isRecord(data) || typeof data.status !== "string") throw new WaveSpeedError("WaveSpeed's result has no status", 0);
	// `data.code` is the task's own error code (0 on success), separate from the envelope's.
	const reason = typeof data.error === "string" ? data.error : "";
	const code = typeof data.code === "number" && data.code !== 0 ? `${data.code}: ` : "";
	const timings = isRecord(data.timings) ? data.timings : {};
	return {
		status: data.status,
		...(reason !== "" && { error: `${code}${reason}`.slice(0, 400) }),
		outputs: Array.isArray(data.outputs) ? data.outputs : [],
		...(typeof timings.inference === "number" && { inferenceMs: timings.inference }),
	};
}

/** The URL WaveSpeed's models read an uploaded file from, and the one-shot target it
 *  is uploaded to. */
interface UploadTicket {
	readonly downloadUrl: string;
	readonly uploadUrl: string;
	readonly method: string;
	readonly headers: Record<string, string>;
}

function httpsUrlOf(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		return new URL(value).protocol === "https:" ? value : undefined;
	} catch {
		return undefined;
	}
}

async function createUpload(api: Api, filename: string, size: number, contentType: string, signal: AbortSignal): Promise<UploadTicket> {
	const response = await call(api, "POST", "/api/v3/media/uploads", {
		body: { filename, size, content_type: contentType },
		signal,
	});
	const data = unwrap(response, "creating an upload");
	const upload = isRecord(data) ? data.upload : undefined;
	const downloadUrl = isRecord(data) ? httpsUrlOf(data.download_url) : undefined;
	const uploadUrl = isRecord(upload) ? httpsUrlOf(upload.url) : undefined;
	if (!isRecord(upload) || upload.method !== "PUT" || downloadUrl === undefined || uploadUrl === undefined || !isRecord(upload.headers)) {
		throw new WaveSpeedError("WaveSpeed's upload ticket is not an https PUT target with a download URL", 0);
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(upload.headers)) {
		if (typeof value !== "string") throw new WaveSpeedError("WaveSpeed's upload ticket has a header that is not text", 0);
		headers[name] = value;
	}
	return { downloadUrl, uploadUrl, method: upload.method, headers };
}

/** Upload a local image to WaveSpeed's storage and return the URL its models read it
 *  from. The file goes to the target the ticket names — a host WaveSpeed picks per
 *  upload — with the ticket's own headers and never with the API key. The name sent
 *  is generated: a local file name does not leave the machine. */
export async function uploadImage(api: Api, path: string, signal: AbortSignal): Promise<string> {
	const extension = extname(path).slice(1).toLowerCase();
	const contentType = CONTENT_TYPES[extension];
	if (contentType === undefined) throw new WaveSpeedError(`${basename(path)} is not an image type this pack uploads`, 0);
	const { size } = await stat(path).catch(() => {
		throw new WaveSpeedError(`cannot read ${basename(path)} to upload it to WaveSpeed`, 0);
	});
	if (size === 0) throw new WaveSpeedError(`${basename(path)} is empty`, 0);
	const bytes = await readFile(path);
	// The ticket fixes the size; a file that changed since it was checked would be refused by storage.
	if (bytes.length !== size) throw new WaveSpeedError(`${basename(path)} changed while it was being read`, 0);
	const ticket = await createUpload(api, `ref-${randomUUID().slice(0, 8)}.${extension}`, size, contentType, signal);
	const response = await api.fetch(ticket.uploadUrl, {
		method: ticket.method,
		headers: ticket.headers,
		body: bytes,
		signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new WaveSpeedError(`WaveSpeed's storage refused ${basename(path)} (HTTP ${response.status})`, response.status);
	return ticket.downloadUrl;
}

/** Stream a result file to `dest`, through a temporary name so a failed download
 *  never leaves something that looks like the file. Fetched without the key, and only
 *  from https: a redirect that lands anywhere else is refused. */
export async function downloadFile(doFetch: typeof fetch, url: string, dest: string, signal: AbortSignal): Promise<number> {
	const partial = `${dest}.part`;
	try {
		const response = await doFetch(url, { signal });
		if (response.url !== "" && !response.url.startsWith("https://")) {
			throw new WaveSpeedError(`downloading ${basename(dest)} from WaveSpeed was redirected off https`, 0);
		}
		if (!response.ok || response.body === null) {
			throw new WaveSpeedError(`downloading ${basename(dest)} from WaveSpeed failed (HTTP ${response.status})`, response.status);
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
