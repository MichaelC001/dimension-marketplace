import { expect, test } from "bun:test";
import { CONNECT_PATH, SlackSignInError } from "../credential";
import { createWebApiClient, SlackApiError, type WebApiClientOptions } from "../web-api";

interface Recorded {
	readonly url: string;
	readonly method: string | undefined;
	readonly headers: Headers;
	readonly form: URLSearchParams;
}

type Answer = (recorded: Recorded, count: number) => Response | Promise<Response>;

const ROOT = "https://slack.test/api";
const POST = { channel: "C0123ABC", markdown_text: "hi" };

function fakeSlack(answer: Answer) {
	const requests: Recorded[] = [];
	const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const recorded: Recorded = {
			url: String(input),
			method: init?.method,
			headers: new Headers(init?.headers),
			form: new URLSearchParams(String(init?.body)),
		};
		requests.push(recorded);
		return answer(recorded, requests.length);
	}) as typeof fetch;
	return { fetcher, requests };
}

function clientFor(fetcher: typeof fetch, renewals: string[] = [], options: Partial<WebApiClientOptions> = {}) {
	return createWebApiClient({
		fetch: fetcher,
		root: ROOT,
		accessToken: async () => "tok-1",
		renewRejected: async rejected => {
			renewals.push(rejected);
			return "tok-2";
		},
		...options,
	});
}

function honoringSignal(): typeof fetch {
	return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		if (init?.signal?.aborted) throw init.signal.reason;
		return Response.json({ ok: true });
	}) as typeof fetch;
}

test("a call posts its params as a form to the method under the root with the bearer token, keeps false and 0, drops unset params and returns Slack's body", async () => {
	const message = "a&b=c +100% é\n*bold* <https://x.test|link>";
	const { fetcher, requests } = fakeSlack(() => Response.json({ ok: true, ts: "1700000000.000100" }));

	const result = await clientFor(fetcher).call("chat.postMessage", {
		channel: "C0123ABC",
		markdown_text: message,
		reply_broadcast: false,
		post_at: 0,
		thread_ts: undefined,
	});

	expect(result).toEqual({ ok: true, ts: "1700000000.000100" });
	expect(requests).toHaveLength(1);
	const [request] = requests;
	expect(request?.url).toBe(`${ROOT}/chat.postMessage`);
	expect(request?.method).toBe("POST");
	expect(request?.headers.get("authorization")).toBe("Bearer tok-1");
	expect(request?.headers.get("content-type")).toStartWith("application/x-www-form-urlencoded");
	expect(Object.fromEntries(request?.form ?? [])).toEqual({
		channel: "C0123ABC",
		markdown_text: message,
		reply_broadcast: "false",
		post_at: "0",
	});
});

test("every call asks for the access token afresh, so a token renewed between calls is the one sent", async () => {
	const tokens = ["tok-1", "tok-2"];
	const { fetcher, requests } = fakeSlack(() => Response.json({ ok: true }));
	const client = clientFor(fetcher, [], { accessToken: async () => tokens.shift() ?? "exhausted" });

	await client.call("auth.test", {});
	await client.call("auth.test", {});

	expect(requests.map(request => request.headers.get("authorization"))).toEqual(["Bearer tok-1", "Bearer tok-2"]);
});

test.each(["invalid_auth", "not_authed", "token_expired", "token_revoked", "account_inactive"])(
	"Slack answering %s renews the sign-in once and repeats the same request with the new token",
	async code => {
		const refusing: Answer = recorded =>
			recorded.headers.get("authorization") === "Bearer tok-1"
				? Response.json({ ok: false, error: code })
				: Response.json({ ok: true, ts: "1700000000.000100" });
		const renewals: string[] = [];
		const { fetcher, requests } = fakeSlack(refusing);

		const result = await clientFor(fetcher, renewals).call("chat.postMessage", POST);

		expect(result).toEqual({ ok: true, ts: "1700000000.000100" });
		expect(renewals).toEqual(["tok-1"]);
		expect(requests.map(request => request.headers.get("authorization"))).toEqual(["Bearer tok-1", "Bearer tok-2"]);
		expect(Object.fromEntries(requests[1]?.form ?? [])).toEqual(POST);
	},
);

test("a sign-in Slack still refuses after renewing is reported as a reconnect instruction instead of looping", async () => {
	const renewals: string[] = [];
	const { fetcher, requests } = fakeSlack(() => Response.json({ ok: false, error: "invalid_auth" }));

	const call = clientFor(fetcher, renewals).call("chat.postMessage", POST);

	await expect(call).rejects.toBeInstanceOf(SlackSignInError);
	await expect(call).rejects.toThrow(`Reconnect Slack as you under ${CONNECT_PATH}`);
	expect(renewals).toHaveLength(1);
	expect(requests).toHaveLength(2);
});

test("an ordinary Slack error on the request retried after a renewal is reported as that error, not as a lost sign-in", async () => {
	const answer: Answer = recorded =>
		Response.json({
			ok: false,
			error: recorded.headers.get("authorization") === "Bearer tok-1" ? "token_expired" : "channel_not_found",
		});
	const { fetcher } = fakeSlack(answer);

	const call = clientFor(fetcher).call("chat.postMessage", POST);

	await expect(call).rejects.toBeInstanceOf(SlackApiError);
	await expect(call).rejects.toMatchObject({ code: "channel_not_found" });
});

test("a Slack refusal other than a lost sign-in is reported with its code and never renews the token", async () => {
	const renewals: string[] = [];
	const { fetcher } = fakeSlack(() => Response.json({ ok: false, error: "channel_not_found" }));

	const call = clientFor(fetcher, renewals).call("chat.postMessage", POST);

	await expect(call).rejects.toBeInstanceOf(SlackApiError);
	await expect(call).rejects.toMatchObject({ code: "channel_not_found", needed: undefined });
	await expect(call).rejects.toThrow("Slack chat.postMessage failed: channel_not_found");
	expect(renewals).toEqual([]);
});

test("a missing scope names the scope Slack says is needed", async () => {
	const { fetcher } = fakeSlack(() =>
		Response.json({ ok: false, error: "missing_scope", needed: "chat:write", provided: "search:read" }),
	);

	const call = clientFor(fetcher).call("chat.postMessage", POST);

	await expect(call).rejects.toMatchObject({ code: "missing_scope", needed: "chat:write" });
	await expect(call).rejects.toThrow("Slack chat.postMessage failed: missing_scope (needs the chat:write scope)");
});

test("an HTTP 429 is a rate limit even when the body is not Slack's JSON", async () => {
	const { fetcher } = fakeSlack(() => new Response("slow down", { status: 429, headers: { "Retry-After": "17" } }));

	await expect(clientFor(fetcher).call("chat.postMessage", POST)).rejects.toMatchObject({
		name: "SlackApiError",
		code: "ratelimited",
	});
});

test.each([
	["a gateway error page", 502, "<html>Bad gateway</html>"],
	["a proxy page served with 200", 200, "<html>Sign in to the network</html>"],
] as const)("%s instead of JSON is reported by its HTTP status", async (_name, status, body) => {
	const renewals: string[] = [];
	const { fetcher } = fakeSlack(() => new Response(body, { status }));

	await expect(clientFor(fetcher, renewals).call("chat.postMessage", POST)).rejects.toMatchObject({
		name: "SlackApiError",
		code: `http_${status}`,
	});
	expect(renewals).toEqual([]);
});

test("a call the caller already cancelled is cancelled on the wire too instead of being sent", async () => {
	const cancelled = new Error("cancelled");
	const controller = new AbortController();
	controller.abort(cancelled);
	const renewals: string[] = [];

	const pending = clientFor(honoringSignal(), renewals).call("chat.postMessage", POST, controller.signal);

	await expect(pending).rejects.toBe(cancelled);
	expect(renewals).toEqual([]);
});
