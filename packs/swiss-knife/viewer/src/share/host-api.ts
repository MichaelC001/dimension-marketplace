import { type Audience, type HostDiscovery, parseDiscovery } from "@dimension/sdk/artifact-share";
import { z } from "zod";
import { errorMessage } from "../../../src/library/errors";
import { type RetryOptions, withRetry } from "./retry";

export const DEFAULT_RETRY: RetryOptions = { attempts: 5, baseMs: 400, maxMs: 15_000 };
const JSON_TIMEOUT_MS = 30_000;
const BLOB_TIMEOUT_MS = 120_000;

const errorBodySchema = z.object({
	error: z.string().optional(),
	message: z.string().optional(),
	missing: z.array(z.number().int().nonnegative()).optional(),
});

const createdShareSchema = z.object({
	id: z.string().min(1),
	ownerToken: z.string().min(1),
	version: z.number().int().positive(),
	expiresAt: z.number().int().positive().optional(),
});
export type CreatedShare = z.infer<typeof createdShareSchema>;

const createdVersionSchema = z.object({ version: z.number().int().positive() });
const patchedShareSchema = z.object({ expiresAt: z.number().int().nonnegative().nullable().optional() });

const sealedCommentSchema = z.object({ id: z.string().min(1), at: z.number().int().nonnegative(), sealed: z.string().min(1) });
export type SealedComment = z.infer<typeof sealedCommentSchema>;

const postedCommentSchema = z.object({ id: z.string().min(1), at: z.number().int().nonnegative() });
export type PostedComment = z.infer<typeof postedCommentSchema>;

export class HostRequestError extends Error {
	override readonly name = "HostRequestError";
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		readonly retryAfterMs?: number,
		readonly missing?: readonly number[],
	) {
		super(message);
	}

	get retryable(): boolean {
		return this.status === 0 || this.status === 408 || this.status === 425 || this.status === 429 || this.status >= 500;
	}
}

export interface HostClientOptions {
	readonly fetch?: typeof fetch;
	readonly retry?: RetryOptions;
}

interface CallInit {
	readonly bearer?: string;
	readonly json?: unknown;
	readonly body?: Uint8Array;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly accept?: string;
}

export interface NewShareRequest {
	readonly audience: Audience;
	readonly expiresAt?: number;
	readonly allowComments: boolean;
	readonly chunks: number;
	readonly sealedBytes: number;
}

export interface SharePatch {
	readonly audience?: Audience;
	readonly expiresAt?: number | null;
	readonly allowComments?: boolean;
}

export class HostClient {
	readonly baseUrl: string;
	readonly #fetch: typeof fetch;
	readonly #retry: RetryOptions;

	constructor(baseUrl: string, options: HostClientOptions = {}) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.#fetch = options.fetch ?? fetch;
		this.#retry = options.retry ?? DEFAULT_RETRY;
	}

	async call(method: string, path: string, init: CallInit = {}): Promise<Response> {
		const headers: Record<string, string> = {};
		if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
		if (init.accept !== undefined) headers.accept = init.accept;
		let body: BodyInit | undefined;
		if (init.json !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(init.json);
		} else if (init.body !== undefined) {
			headers["content-type"] = "application/octet-stream";
			body = init.body as Uint8Array<ArrayBuffer>;
		}
		const timeout = AbortSignal.timeout(init.timeoutMs ?? (init.body === undefined ? JSON_TIMEOUT_MS : BLOB_TIMEOUT_MS));
		const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
		let response: Response;
		try {
			response = await this.#fetch(`${this.baseUrl}${path}`, { method, headers, signal, ...(body === undefined ? {} : { body }) });
		} catch (error) {
			if (init.signal?.aborted) throw error;
			throw new HostRequestError(`could not reach ${new URL(this.baseUrl).host}: ${timeout.aborted ? "the request timed out" : errorMessage(error)}`, 0);
		}
		if (response.ok) return response;
		throw await this.#failure(response);
	}

	async #failure(response: Response): Promise<HostRequestError> {
		const parsed = errorBodySchema.safeParse(await response.json().catch(() => undefined));
		const detail: z.infer<typeof errorBodySchema> = parsed.success ? parsed.data : {};
		const retryAfter = Number(response.headers.get("retry-after"));
		return new HostRequestError(
			detail.message ?? `the server answered ${response.status}`,
			response.status,
			detail.error,
			Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
			detail.missing,
		);
	}

	async #json<S extends z.ZodType>(schema: S, response: Response, what: string): Promise<z.infer<S>> {
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new HostRequestError(`the server's ${what} answer is not JSON`, 502);
		}
		const parsed = schema.safeParse(payload);
		if (!parsed.success) throw new HostRequestError(`the server's ${what} answer is not what a share server sends`, 502);
		return parsed.data;
	}

	async discovery(signal?: AbortSignal): Promise<HostDiscovery> {
		const response = await this.call("GET", "/.well-known/dimension-artifacts", { accept: "application/json", timeoutMs: 8000, ...(signal === undefined ? {} : { signal }) });
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new HostRequestError("this address does not answer like a Dimension share server", 502);
		}
		const discovery = parseDiscovery(payload);
		if (discovery === undefined) throw new HostRequestError("this address does not answer like a Dimension share server", 502);
		return discovery;
	}

	async ping(token: string | undefined, signal?: AbortSignal): Promise<void> {
		await this.call("GET", "/api/v1/ping", { timeoutMs: 8000, ...(token === undefined ? {} : { bearer: token }), ...(signal === undefined ? {} : { signal }) });
	}

	async createShare(token: string | undefined, request: NewShareRequest, signal?: AbortSignal): Promise<CreatedShare> {
		const response = await this.call("POST", "/api/v1/shares", { json: request, ...(token === undefined ? {} : { bearer: token }), ...(signal === undefined ? {} : { signal }) });
		return this.#json(createdShareSchema, response, "create");
	}

	async createVersion(ownerToken: string, shareId: string, request: { chunks: number; sealedBytes: number }, signal?: AbortSignal): Promise<number> {
		const response = await this.call("POST", `/api/v1/shares/${shareId}/versions`, { bearer: ownerToken, json: request, ...(signal === undefined ? {} : { signal }) });
		return (await this.#json(createdVersionSchema, response, "version")).version;
	}

	putManifest(ownerToken: string, shareId: string, version: number, sealed: Uint8Array, signal: AbortSignal): Promise<void> {
		return withRetry(
			async () => {
				await this.call("PUT", `/api/v1/shares/${shareId}/v/${version}/manifest`, { bearer: ownerToken, body: sealed, signal });
			},
			this.#retry,
			signal,
		);
	}

	putChunk(ownerToken: string, shareId: string, version: number, index: number, sealed: Uint8Array, signal: AbortSignal): Promise<void> {
		return withRetry(
			async () => {
				await this.call("PUT", `/api/v1/shares/${shareId}/v/${version}/chunks/${index}`, { bearer: ownerToken, body: sealed, signal });
			},
			this.#retry,
			signal,
		);
	}

	commit(ownerToken: string, shareId: string, version: number, signal: AbortSignal): Promise<void> {
		return withRetry(
			async () => {
				await this.call("POST", `/api/v1/shares/${shareId}/v/${version}/commit`, { bearer: ownerToken, signal });
			},
			this.#retry,
			signal,
		);
	}

	async patch(ownerToken: string, shareId: string, patch: SharePatch, signal?: AbortSignal): Promise<{ readonly expiresAt?: number }> {
		const response = await this.call("PATCH", `/api/v1/shares/${shareId}`, { bearer: ownerToken, json: patch, ...(signal === undefined ? {} : { signal }) });
		const patched = await this.#json(patchedShareSchema, response, "update");
		return patched.expiresAt === null || patched.expiresAt === undefined ? {} : { expiresAt: patched.expiresAt };
	}

	async comments(ownerToken: string, shareId: string, after: string | undefined, signal?: AbortSignal): Promise<readonly SealedComment[]> {
		const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
		const response = await this.call("GET", `/api/v1/shares/${shareId}/comments${query}`, {
			bearer: ownerToken,
			accept: "application/json",
			...(signal === undefined ? {} : { signal }),
		});
		return this.#json(z.array(sealedCommentSchema), response, "comments");
	}

	async postComment(ownerToken: string, shareId: string, sealed: string, signal?: AbortSignal): Promise<PostedComment> {
		const response = await this.call("POST", `/api/v1/shares/${shareId}/comments`, {
			bearer: ownerToken,
			json: { sealed },
			...(signal === undefined ? {} : { signal }),
		});
		return this.#json(postedCommentSchema, response, "comment");
	}
}
