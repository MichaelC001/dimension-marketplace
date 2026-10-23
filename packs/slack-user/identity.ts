import { type } from "arktype";
import type { CredentialStore } from "./credential";

const AUTH_TEST_URL = "https://slack.com/api/auth.test";

const IDENTITY_TIMEOUT_MS = 10_000;

const authTestResponse = type({
	ok: "boolean",
	"user?": "string",
	"user_id?": "string",
	"team?": "string",
});

export interface SlackIdentity {
	label(): string | undefined;
	warm(): Promise<void>;
}

export interface IdentityOptions {
	readonly store: CredentialStore;
	readonly fetch?: typeof fetch;
}

export function createIdentity(options: IdentityOptions): SlackIdentity {
	const http = options.fetch ?? fetch;
	let known: { readonly clientId: string | undefined; readonly text: string } | null = null;
	let loading: Promise<void> | null = null;

	function label(): string | undefined {
		return known && known.clientId === options.store.peek()?.clientId ? known.text : undefined;
	}

	async function load(): Promise<void> {
		const token = await options.store.accessToken();
		const response = await http(AUTH_TEST_URL, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
		});
		const body = authTestResponse(await response.json().catch(() => null));
		if (body instanceof type.errors || !body.ok) return;
		known = {
			clientId: options.store.peek()?.clientId,
			text: `${body.user ?? body.user_id ?? "you"} in ${body.team ?? "your workspace"}`,
		};
	}

	function warm(): Promise<void> {
		if (label()) return Promise.resolve();
		loading ??= load()
			.catch(() => undefined)
			.finally(() => {
				loading = null;
			});
		return loading;
	}

	return { label, warm };
}
