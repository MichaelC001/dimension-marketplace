import { CONNECT_PATH, SlackSignInError } from "./credential";
import { isRecord } from "./type-guards";

const API_ROOT = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 30_000;
const SIGN_IN_FAILURES: Readonly<Record<string, true>> = {
	invalid_auth: true,
	not_authed: true,
	token_expired: true,
	token_revoked: true,
	account_inactive: true,
};

export type WebApiParams = Readonly<Record<string, string | number | boolean | undefined>>;

export class SlackApiError extends Error {
	readonly code: string;
	readonly needed: string | undefined;

	constructor(method: string, code: string, needed?: string) {
		super(
			needed ? `Slack ${method} failed: ${code} (needs the ${needed} scope)` : `Slack ${method} failed: ${code}`,
		);
		this.name = "SlackApiError";
		this.code = code;
		this.needed = needed;
	}
}

export interface WebApiClient {
	call(method: string, params: WebApiParams, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export interface WebApiClientOptions {
	readonly accessToken: () => Promise<string>;
	readonly renewRejected: (rejectedAccess: string) => Promise<string>;
	readonly fetch?: typeof fetch;
	readonly root?: string;
	readonly timeoutMs?: number;
}

interface Outcome {
	readonly status: number;
	readonly body: Record<string, unknown> | null;
}

function signInRefused(outcome: Outcome): boolean {
	const code = outcome.body?.ok === false ? outcome.body.error : undefined;
	return typeof code === "string" && SIGN_IN_FAILURES[code] === true;
}

export function createWebApiClient(options: WebApiClientOptions): WebApiClient {
	const http = options.fetch ?? fetch;
	const root = options.root ?? API_ROOT;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

	async function send(method: string, params: WebApiParams, token: string, signal?: AbortSignal): Promise<Outcome> {
		const form = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) form.set(key, String(value));
		}
		const timeout = AbortSignal.timeout(timeoutMs);
		const response = await http(`${root}/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
				Accept: "application/json",
			},
			body: form,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const body: unknown = await response.json().catch(() => null);
		return { status: response.status, body: isRecord(body) ? body : null };
	}

	async function call(
		method: string,
		params: WebApiParams,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const token = await options.accessToken();
		let outcome = await send(method, params, token, signal);
		if (signInRefused(outcome)) {
			outcome = await send(method, params, await options.renewRejected(token), signal);
			if (signInRefused(outcome)) {
				throw new SlackSignInError(
					`Slack rejected the saved sign-in even after renewing it. Reconnect Slack as you under ${CONNECT_PATH}.`,
				);
			}
		}
		const { body } = outcome;
		if (outcome.status === 429) throw new SlackApiError(method, "ratelimited");
		if (!body) throw new SlackApiError(method, `http_${outcome.status}`);
		if (body.ok !== true) {
			throw new SlackApiError(
				method,
				typeof body.error === "string" ? body.error : "unknown_error",
				typeof body.needed === "string" ? body.needed : undefined,
			);
		}
		return body;
	}

	return { call };
}
