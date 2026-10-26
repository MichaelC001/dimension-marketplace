import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";

export const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.user.access";
export const TOKEN_PATH = join(homedir(), ".config", "dimension-slack-user", "token.json");
export const CONNECT_PATH = "Plugins, Slack, Connect, As you";

const REFRESH_SKEW_MS = 60_000;
const DEFAULT_ACCESS_LIFETIME_SECONDS = 43_200;
const RENEWAL_TIMEOUT_MS = 15_000;
const RENEWED_REJECTED_COOLDOWN_MS = 60_000;
const CREDENTIAL_FILE_MODE = 0o600;
const RECONNECT_ERRORS: Record<string, true> = {
	invalid_refresh_token: true,
	expired_refresh_token: true,
	token_expired: true,
	token_revoked: true,
	invalid_grant: true,
	invalid_client_id: true,
	bad_client_secret: true,
};

export class SlackSignInError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SlackSignInError";
	}
}

const storedCredential = type({
	access: "string > 0",
	"provider?": "string",
	"refresh?": "string",
	"expires?": "number",
	"clientId?": "string",
	"clientSecret?": "string",
	"scopes?": "string[]",
});

export type StoredCredential = typeof storedCredential.infer;

const renewalResponse = type({
	ok: "boolean",
	"error?": "string",
	"access_token?": "string",
	"refresh_token?": "string",
	"expires_in?": "number",
});

type RenewalResponse = typeof renewalResponse.infer;

export interface CredentialStoreOptions {
	readonly path: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

export interface CredentialStore {
	peek(): StoredCredential | null;
	accessToken(): Promise<string>;
	renewRejected(rejectedAccess: string): Promise<string>;
}

function parseCredential(raw: string, path: string): StoredCredential {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		json = null;
	}
	const parsed = storedCredential(json);
	if (parsed instanceof type.errors) {
		throw new SlackSignInError(
			`The saved Slack sign-in at ${path} is unreadable. Reconnect Slack as you under ${CONNECT_PATH}.`,
		);
	}
	return parsed;
}

function renewalFailure(status: number, body: RenewalResponse | null): SlackSignInError {
	const code = body?.error;
	if (code && RECONNECT_ERRORS[code] === true) {
		return new SlackSignInError(
			`Slack refused to renew the sign-in (${code}). It was revoked or has been unused too long. Reconnect Slack as you under ${CONNECT_PATH}.`,
		);
	}
	return new SlackSignInError(
		`Slack could not renew the sign-in (${code ?? `HTTP ${status}`}). Try again, or reconnect Slack as you under ${CONNECT_PATH}.`,
	);
}

export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
	const { path } = options;
	const http = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	let renewing: Promise<StoredCredential> | null = null;
	let lastRenewal: { readonly access: string; readonly at: number } | null = null;

	async function read(): Promise<StoredCredential> {
		let raw: string;
		try {
			raw = await readFile(path, "utf-8");
		} catch {
			throw new SlackSignInError(`Slack as you isn't connected yet. Connect it under ${CONNECT_PATH}.`);
		}
		return parseCredential(raw, path);
	}

	function peek(): StoredCredential | null {
		try {
			return parseCredential(readFileSync(path, "utf-8"), path);
		} catch {
			return null;
		}
	}

	async function persist(credential: StoredCredential): Promise<void> {
		const staging = `${path}.${randomUUID()}.tmp`;
		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(staging, JSON.stringify(credential, null, 2), { mode: CREDENTIAL_FILE_MODE });
			await rename(staging, path);
		} catch (cause) {
			await rm(staging, { force: true });
			throw new SlackSignInError(
				`Slack renewed the sign-in but it could not be saved to ${path} (${cause instanceof Error ? cause.message : String(cause)}). Reconnect Slack as you under ${CONNECT_PATH}.`,
			);
		}
	}

	async function renew(stale: StoredCredential): Promise<StoredCredential> {
		const current = await read();
		if (current.access !== stale.access) return current;
		if (!current.refresh || !current.clientId) {
			throw new SlackSignInError(
				`Slack no longer accepts the saved sign-in and it cannot renew itself. Reconnect Slack as you under ${CONNECT_PATH}.`,
			);
		}
		const form = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: current.refresh,
			client_id: current.clientId,
		});
		if (current.clientSecret) form.set("client_secret", current.clientSecret);
		let response: Response;
		try {
			response = await http(TOKEN_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
				body: form,
				signal: AbortSignal.timeout(RENEWAL_TIMEOUT_MS),
			});
		} catch (cause) {
			throw new SlackSignInError(
				`Slack did not answer the sign-in renewal (${cause instanceof Error ? cause.message : String(cause)}). Try again.`,
			);
		}
		const body = renewalResponse(await response.json().catch(() => null));
		if (body instanceof type.errors || !body.ok || !body.access_token) {
			throw renewalFailure(response.status, body instanceof type.errors ? null : body);
		}
		const renewed: StoredCredential = {
			...current,
			access: body.access_token,
			refresh: body.refresh_token ?? current.refresh,
			expires: now() + (body.expires_in ?? DEFAULT_ACCESS_LIFETIME_SECONDS) * 1000,
		};
		await persist(renewed);
		lastRenewal = { access: renewed.access, at: now() };
		return renewed;
	}

	function renewShared(stale: StoredCredential): Promise<StoredCredential> {
		renewing ??= renew(stale).finally(() => {
			renewing = null;
		});
		return renewing;
	}

	async function accessToken(): Promise<string> {
		const credential = await read();
		const due =
			Boolean(credential.refresh) &&
			typeof credential.expires === "number" &&
			credential.expires <= now() + REFRESH_SKEW_MS;
		if (!due) return credential.access;
		return (await renewShared(credential)).access;
	}

	async function renewRejected(rejectedAccess: string): Promise<string> {
		const credential = await read();
		if (credential.access !== rejectedAccess) return credential.access;
		if (!credential.refresh) {
			throw new SlackSignInError(
				`Slack rejected the saved sign-in (revoked or expired). Reconnect Slack as you under ${CONNECT_PATH}.`,
			);
		}
		if (lastRenewal?.access === rejectedAccess) {
			const elapsed = now() - lastRenewal.at;
			if (elapsed >= 0 && elapsed < RENEWED_REJECTED_COOLDOWN_MS) return rejectedAccess;
		}
		return (await renewShared(credential)).access;
	}

	return { peek, accessToken, renewRejected };
}
