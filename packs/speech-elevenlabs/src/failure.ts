import { isRecord } from "./protocol.js";

export type Capability = "speak" | "listen" | "converse";

export const AGENTS_PERMISSION_DETAIL = "the key needs the ElevenLabs Agents permissions (convai read + write)";

const PERMISSION_DETAIL: Readonly<Record<Capability, string>> = {
	speak: "the key needs the Text to Speech permission",
	listen: "the key needs the Speech to Text permission",
	converse: AGENTS_PERMISSION_DETAIL,
};

const REQUEST_NOUN: Readonly<Record<Capability, string>> = {
	speak: "the voice request",
	listen: "the listening request",
	converse: "the Agents call",
};

const REQUEST_HINT: Readonly<Record<Capability, string>> = {
	speak: "check the model and the voice id",
	listen: "check the model and the language",
	converse: "",
};

export type Verdict = "key" | "permission" | "limit" | "server" | "rejected";

export interface FailureFields {
	readonly status?: number;
	readonly unreachable?: true;
	readonly code?: string;
}

export class ElevenLabsError extends Error {
	readonly status?: number;
	readonly unreachable?: true;
	readonly code?: string;

	constructor(message: string, fields: FailureFields = {}) {
		super(message);
		this.name = "ElevenLabsError";
		if (fields.status !== undefined) this.status = fields.status;
		if (fields.unreachable) this.unreachable = true;
		if (fields.code !== undefined) this.code = fields.code;
	}
}

export function sentenceFor(verdict: Verdict, capability: Capability): string {
	switch (verdict) {
		case "key":
			return "ElevenLabs rejected the API key";
		case "permission":
			return `ElevenLabs refused ${REQUEST_NOUN[capability]}: ${PERMISSION_DETAIL[capability]}`;
		case "limit":
			return "ElevenLabs is busy, or the key has reached its limit";
		case "server":
			return "ElevenLabs had a problem on its side";
		case "rejected": {
			const hint = REQUEST_HINT[capability];
			return `ElevenLabs did not accept ${REQUEST_NOUN[capability]}${hint ? ` (${hint})` : ""}`;
		}
	}
}

export function ambiguousKeySentence(capability: Capability): string {
	return `ElevenLabs rejected the API key (${PERMISSION_DETAIL[capability]})`;
}

function parseJson(text: string): unknown {
	try {
		return text ? JSON.parse(text) : undefined;
	} catch {
		return undefined;
	}
}

export function verdictOf(status: number | undefined, reason: string | undefined, message = ""): Verdict {
	if (reason === "quota_exceeded") return "limit";
	if (reason === "invalid_api_key") return "key";
	if (reason === "missing_permissions") return "permission";
	if (status === 401 || status === 403) return status === 403 || /permission/i.test(message) ? "permission" : "key";
	if (status === 429) return "limit";
	if (status !== undefined && status >= 500) return "server";
	return "rejected";
}

function verdictOfBody(status: number, bodyText: string): Verdict {
	const body = parseJson(bodyText);
	const detail = isRecord(body) && isRecord(body.detail) ? body.detail : undefined;
	const reason = typeof detail?.status === "string" ? detail.status : undefined;
	return verdictOf(status, reason, typeof detail?.message === "string" ? detail.message : "");
}

export function httpFailure(status: number, bodyText: string, capability: Capability): ElevenLabsError {
	return new ElevenLabsError(sentenceFor(verdictOfBody(status, bodyText), capability), { status });
}

export function handshakeFailureMessage(status: number, bodyText: string): string {
	const permissionOnly = bodyText.includes("missing_permissions");
	if ((status === 401 || status === 403) && !permissionOnly) return "ElevenLabs rejected the API key";
	if ((status >= 200 && status < 300) || permissionOnly) {
		return "ElevenLabs refused the voice connection (check the model, the voice id and the key's Text to Speech permission)";
	}
	return sentenceFor(verdictOfBody(status, bodyText), "speak");
}

export function unreachableFailure(what: string, error?: unknown): ElevenLabsError {
	const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
	return new ElevenLabsError(`Could not reach ${what}`, {
		unreachable: true,
		...(code === undefined ? {} : { code }),
	});
}

export async function reachFetch(doFetch: typeof fetch, url: string, init: RequestInit): Promise<Response> {
	try {
		return await doFetch(url, init);
	} catch (error) {
		const timedOut = error instanceof DOMException && error.name === "TimeoutError";
		if (init.signal?.aborted && !timedOut) throw error;
		throw unreachableFailure("ElevenLabs", error);
	}
}

export function plainMessage(error: unknown, fallback: string): string {
	return error instanceof ElevenLabsError ? error.message : fallback;
}
