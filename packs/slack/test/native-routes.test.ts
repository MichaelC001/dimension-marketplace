import { expect, test } from "bun:test";
import { CONNECT_PATH, SlackSignInError } from "../credential";
import { createNativeRoutes } from "../native-routes";
import { SlackApiError, type WebApiClient, type WebApiParams } from "../web-api";

interface Call {
	readonly method: string;
	readonly params: WebApiParams;
}

type Answers = Readonly<Record<string, (params: WebApiParams) => Record<string, unknown>>>;

const SEND = "slack_send_message";
const SCHEDULE = "slack_schedule_message";
const POSTED_TS = "1700000000.000100";
const PERMALINK = "https://acme.slack.com/archives/C0123ABC/p1700000000000100";
const POST_AT = 1_900_000_000;
const POST_AT_ISO = "2030-03-17T17:46:40.000Z";

const ROUTES = [
	{ tool: SEND, write: "chat.postMessage", base: { channel_id: "C0123ABC", message: "hello" } },
	{
		tool: SCHEDULE,
		write: "chat.scheduleMessage",
		base: { channel_id: "C0123ABC", message: "hello", post_at: POST_AT },
	},
] as const;

const workspace: Answers = {
	"users.info": params => ({ ok: true, user: { id: params.user, is_stranger: false } }),
	"conversations.info": params => ({
		ok: true,
		channel: { id: params.channel, is_ext_shared: false, is_pending_ext_shared: false },
	}),
	"chat.postMessage": params => ({ ok: true, channel: params.channel, ts: POSTED_TS }),
	"chat.scheduleMessage": params => ({ ok: true, channel: params.channel, scheduled_message_id: "Q0123ABC" }),
	"chat.getPermalink": () => ({ ok: true, permalink: PERMALINK }),
};

function fakeSlack(overrides: Answers = {}) {
	const calls: Call[] = [];
	const answers: Answers = { ...workspace, ...overrides };
	const api: WebApiClient = {
		async call(method, params) {
			calls.push({ method, params });
			const answer = answers[method];
			if (!answer) throw new Error(`unexpected Web API call ${method}`);
			return answer(params);
		},
	};
	return { api, calls, methods: () => calls.map(call => call.method) };
}

function run(tool: string, args: Record<string, unknown>, api: WebApiClient) {
	const route = createNativeRoutes().get(tool);
	if (!route) throw new Error(`no native route for ${tool}`);
	return route.run(args, api);
}

async function failure(pending: Promise<unknown>): Promise<Error> {
	try {
		await pending;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("expected the call to be refused");
}

function throwing(error: Error): Answers[string] {
	return () => {
		throw error;
	};
}

test("a message is posted verbatim as markdown with nothing appended and no plain-text twin", async () => {
	const message = "Ship *it* — see <https://x.test|the doc>\n\n- one\n- two  \n\n";
	const { api, calls } = fakeSlack();

	await run(SEND, { channel_id: "C0123ABC", message }, api);

	const posted = calls.find(call => call.method === "chat.postMessage");
	expect(posted?.params).toEqual({ channel: "C0123ABC", markdown_text: message, unfurl_app_links: false });
});

test("a sent message is reported with its channel, timestamp and permalink", async () => {
	const { api } = fakeSlack();

	const result = await run(SEND, { channel_id: "C0123ABC", message: "hello" }, api);

	expect(result.isError).toBe(false);
	expect(result.text).toContain("Message sent.");
	expect(result.text).toContain("Channel: C0123ABC");
	expect(result.text).toContain(`Message TS: ${POSTED_TS}`);
	expect(result.text).toContain(`Link: ${PERMALINK}`);
});

test("a permalink Slack cannot produce does not turn a delivered message into a failure", async () => {
	const { api } = fakeSlack({
		"chat.getPermalink": throwing(new SlackApiError("chat.getPermalink", "message_not_found")),
	});

	const result = await run(SEND, { channel_id: "C0123ABC", message: "hello" }, api);

	expect(result.isError).toBe(false);
	expect(result.text).toContain("Message sent.");
	expect(result.text).toContain(`Message TS: ${POSTED_TS}`);
	expect(result.text).not.toContain("Link:");
});

test.each([
	["a network failure", new Error("fetch failed")],
	["a timeout", new DOMException("The operation timed out", "TimeoutError")],
	["a lost sign-in", new SlackSignInError("Reconnect Slack as you.")],
] as const)(
	"%s on the permalink lookup after the post does not turn a delivered message into a failure",
	async (_name, error) => {
		const { api } = fakeSlack({ "chat.getPermalink": throwing(error) });

		const result = await run(SEND, { channel_id: "C0123ABC", message: "hello" }, api);

		expect(result.isError).toBe(false);
		expect(result.text).toContain("Message sent.");
		expect(result.text).toContain("Channel: C0123ABC");
		expect(result.text).toContain(`Message TS: ${POSTED_TS}`);
		expect(result.text).not.toContain("Link:");
	},
);

test.each([
	["left out", {}, false],
	["true", { unfurl_app_links: true }, true],
	["false", { unfurl_app_links: false }, false],
] as const)(
	"link previews for app links are only asked for when unfurl_app_links is %s",
	async (_name, extra, asked) => {
		const { api, calls } = fakeSlack();

		await run(SEND, { channel_id: "C0123ABC", message: "see https://x.test", ...extra }, api);

		expect(calls.find(call => call.method === "chat.postMessage")?.params.unfurl_app_links).toBe(asked);
	},
);

test("a reply into a thread carries thread_ts and the broadcast flag to Slack", async () => {
	const { api, calls } = fakeSlack();

	await run(
		SEND,
		{ channel_id: "C0123ABC", message: "on it", thread_ts: "1700000000.000200", reply_broadcast: true },
		api,
	);

	expect(calls.find(call => call.method === "chat.postMessage")?.params).toMatchObject({
		thread_ts: "1700000000.000200",
		reply_broadcast: true,
	});
});

test.each([
	["a plain-text twin the MCP tool never had", { text: "hi" }, 'does not support "text"'],
	["a delivery time (it would send now instead of scheduling)", { post_at: POST_AT }, 'does not support "post_at"'],
	["every unsupported key, named together", { blocks: [], attachments: [] }, '"blocks", "attachments"'],
	["a draft to delete", { draft_id: "Dr0123" }, "Send without draft_id"],
] as const)("sending with %s is refused before Slack is called", async (_name, extra, wording) => {
	const { api, calls } = fakeSlack();

	const refusal = await failure(run(SEND, { channel_id: "C0123ABC", message: "hello", ...extra }, api));

	expect(refusal.message).toContain(wording);
	expect(calls).toEqual([]);
});

test("a scheduled message is stored verbatim as markdown for its delivery time, and the time is read as Unix seconds", async () => {
	const message = "Standup in *5*  \nnotes: <https://x.test|doc>\n";
	const { api, calls } = fakeSlack();

	const result = await run(SCHEDULE, { channel_id: "C0123ABC", message, post_at: POST_AT }, api);

	const scheduled = calls.find(call => call.method === "chat.scheduleMessage");
	expect(scheduled?.params).toEqual({ channel: "C0123ABC", markdown_text: message, post_at: POST_AT });
	expect(calls.some(call => call.method === "chat.postMessage")).toBe(false);
	expect(result.isError).toBe(false);
	expect(result.text).toContain("Message scheduled.");
	expect(result.text).toContain("Channel: C0123ABC");
	expect(result.text).toContain(`Scheduled for: ${POST_AT_ISO}`);
	expect(result.text).toContain("Scheduled message id: Q0123ABC");
});

test("a scheduled thread reply carries thread_ts and the broadcast flag to Slack", async () => {
	const { api, calls } = fakeSlack();

	await run(
		SCHEDULE,
		{
			channel_id: "C0123ABC",
			message: "later",
			post_at: POST_AT,
			thread_ts: "1700000000.000200",
			reply_broadcast: true,
		},
		api,
	);

	expect(calls.find(call => call.method === "chat.scheduleMessage")?.params).toMatchObject({
		thread_ts: "1700000000.000200",
		reply_broadcast: true,
	});
});

test.each([
	["a fractional time", 1_900_000_000.5],
	["a numeric string", "1900000000"],
	["a missing time", undefined],
	["null", null],
	["NaN", Number.NaN],
] as const)("scheduling with %s as post_at is refused before Slack is called", async (_name, postAt) => {
	const { api, calls } = fakeSlack();

	const refusal = await failure(run(SCHEDULE, { channel_id: "C0123ABC", message: "later", post_at: postAt }, api));

	expect(refusal.message).toContain("post_at");
	expect(calls).toEqual([]);
});

test.each([
	[
		"a link preview setting scheduling does not have",
		{ unfurl_app_links: true },
		'does not support "unfurl_app_links"',
	],
	["a draft to delete", { draft_id: "Dr0123" }, "Send without draft_id"],
	["an unknown key", { icon_emoji: ":tada:" }, 'does not support "icon_emoji"'],
] as const)("scheduling with %s is refused before Slack is called", async (_name, extra, wording) => {
	const { api, calls } = fakeSlack();

	const refusal = await failure(run(SCHEDULE, { ...ROUTES[1].base, ...extra }, api));

	expect(refusal.message).toContain(wording);
	expect(calls).toEqual([]);
});

for (const route of ROUTES) {
	const args = (extra: Record<string, unknown> = {}) => ({ ...route.base, ...extra });

	test.each([
		["a channel name with a hash", "#general"],
		["a bare channel name", "general"],
		["a user handle", "@ada"],
		["a lowercase id", "c0123abc"],
		["an id with an unknown prefix", "X0123ABC"],
		["an empty id", ""],
	] as const)(`${route.tool} refuses %s as channel_id before Slack is called`, async (_name, channelId) => {
		const { api, calls } = fakeSlack();

		const refusal = await failure(run(route.tool, args({ channel_id: channelId }), api));

		expect(refusal.message).toContain("channel_id");
		expect(calls).toEqual([]);
	});

	test.each([
		["no message", { message: undefined }],
		["an empty message", { message: "" }],
		["a blank message", { message: "  \n " }],
		["a message that is not text", { message: 5 }],
		["a broadcast flag that is the string true", { reply_broadcast: "true" }],
	] as const)(`${route.tool} refuses %s before Slack is called`, async (_name, extra) => {
		const { api, calls } = fakeSlack();

		await failure(run(route.tool, args(extra), api));

		expect(calls).toEqual([]);
	});

	test.each([
		["a channel", "C0123ABC"],
		["a private channel", "G0123ABC"],
		["a direct message", "D0123ABC"],
	] as const)(
		`${route.tool} to %s checks that conversation and writes to it without looking anyone up`,
		async (_name, id) => {
			const { api, calls, methods } = fakeSlack();

			await run(route.tool, args({ channel_id: id }), api);

			expect(calls[0]).toEqual({ method: "conversations.info", params: { channel: id } });
			expect(calls[1]?.method).toBe(route.write);
			expect(calls[1]?.params.channel).toBe(id);
			expect(methods()).not.toContain("users.info");
			expect(methods()).not.toContain("conversations.open");
		},
	);

	test.each([
		["a user id", "U0123ABC"],
		["an enterprise user id", "W0123ABC"],
	] as const)(
		`${route.tool} to %s checks the person and writes to the user id, without opening or looking up a conversation`,
		async (_name, userId) => {
			const { api, calls, methods } = fakeSlack();

			await run(route.tool, args({ channel_id: userId }), api);

			expect(calls.slice(0, 2)).toEqual([
				{ method: "users.info", params: { user: userId } },
				{ method: route.write, params: expect.objectContaining({ channel: userId }) },
			]);
			expect(methods()).not.toContain("conversations.open");
			expect(methods()).not.toContain("conversations.info");
		},
	);

	test.each([
		["has the stranger flag false", { is_stranger: false }],
		["has no stranger flag", {}],
	] as const)(`${route.tool} messages a person who %s`, async (_name, flags) => {
		const { api, methods } = fakeSlack({
			"users.info": params => ({ ok: true, user: { id: params.user, ...flags } }),
		});

		await run(route.tool, args({ channel_id: "U0123ABC" }), api);

		expect(methods()).toContain(route.write);
	});

	test(`${route.tool} to a person outside the workspace is refused as Slack Connect and nothing is written`, async () => {
		const { api, methods } = fakeSlack({
			"users.info": params => ({ ok: true, user: { id: params.user, is_stranger: true } }),
		});

		const refusal = await failure(run(route.tool, args({ channel_id: "U0123ABC" }), api));

		expect(refusal.message).toContain("Slack Connect");
		expect(methods()).not.toContain(route.write);
	});

	test.each([
		["no user", {}],
		["a user that is only an id string", { user: "U0123ABC" }],
		["a null user", { user: null }],
	] as const)(
		`${route.tool} to a person Slack answers with %s is refused instead of assumed to be inside the workspace`,
		async (_name, answer) => {
			const { api, methods } = fakeSlack({ "users.info": () => ({ ok: true, ...answer }) });

			const refusal = await failure(run(route.tool, args({ channel_id: "U0123ABC" }), api));

			expect(refusal.message).toStartWith("Slack did not describe U0123ABC");
			expect(methods()).not.toContain(route.write);
		},
	);

	test.each([
		["no channel", {}],
		["a channel that is only an id string", { channel: "C0123ABC" }],
		["a null channel", { channel: null }],
	] as const)(
		`${route.tool} to a conversation Slack answers with %s is refused instead of assumed to be inside the workspace`,
		async (_name, answer) => {
			const { api, methods } = fakeSlack({ "conversations.info": () => ({ ok: true, ...answer }) });

			const refusal = await failure(run(route.tool, args({ channel_id: "C0123ABC" }), api));

			expect(refusal.message).toStartWith("Slack did not describe C0123ABC");
			expect(methods()).not.toContain(route.write);
		},
	);

	test.each([
		["a channel shared outside the workspace", "C0123ABC", { is_ext_shared: true }],
		["a channel with a Slack Connect invite pending", "C0123ABC", { is_pending_ext_shared: true }],
		["a direct message shared outside the workspace", "D0123ABC", { is_ext_shared: true }],
	] as const)(
		`${route.tool} to %s is refused as Slack Connect and never reaches the write call`,
		async (_name, id, flags) => {
			const { api, methods } = fakeSlack({
				"conversations.info": params => ({ ok: true, channel: { id: params.channel, ...flags } }),
			});

			const refusal = await failure(run(route.tool, args({ channel_id: id }), api));

			expect(refusal.message).toContain("Slack Connect");
			expect(methods()).not.toContain(route.write);
		},
	);

	const directMessageWith = (counterpart: string, describe: (user: string) => Record<string, unknown>) =>
		fakeSlack({
			"conversations.info": params => ({
				ok: true,
				channel: { id: params.channel, is_im: true, user: counterpart },
			}),
			"users.info": params => describe(String(params.user)),
		});

	test(`${route.tool} to a direct message also checks the other person and writes when they are inside the workspace`, async () => {
		const { api, calls } = directMessageWith("U0999XYZ", user => ({ ok: true, user: { id: user } }));

		await run(route.tool, args({ channel_id: "D0123ABC" }), api);

		expect(calls.slice(0, 3)).toEqual([
			{ method: "conversations.info", params: { channel: "D0123ABC" } },
			{ method: "users.info", params: { user: "U0999XYZ" } },
			{ method: route.write, params: expect.objectContaining({ channel: "D0123ABC" }) },
		]);
	});

	test(`${route.tool} to a direct message with a person outside the workspace is refused as Slack Connect and nothing is written`, async () => {
		const { api, methods } = directMessageWith("U0999XYZ", user => ({
			ok: true,
			user: { id: user, is_stranger: user === "U0999XYZ" },
		}));

		const refusal = await failure(run(route.tool, args({ channel_id: "D0123ABC" }), api));

		expect(refusal.message).toContain("Slack Connect");
		expect(methods()).not.toContain(route.write);
	});

	test(`${route.tool} to a direct message whose other person Slack will not describe is refused and nothing is written`, async () => {
		const { api, methods } = directMessageWith("U0999XYZ", () => ({ ok: true }));

		const refusal = await failure(run(route.tool, args({ channel_id: "D0123ABC" }), api));

		expect(refusal.message).toStartWith("Slack did not describe U0999XYZ");
		expect(methods()).not.toContain(route.write);
	});

	test(`${route.tool} reports the conversation Slack wrote to, which for a person is the direct message Slack opened`, async () => {
		const { api } = fakeSlack({
			[route.write]: () => ({ ok: true, channel: "D0999XYZ", ts: POSTED_TS, scheduled_message_id: "Q0123ABC" }),
		});

		const result = await run(route.tool, args({ channel_id: "U0123ABC" }), api);

		expect(result.text).toContain("Channel: D0999XYZ");
	});

	test(`${route.tool} reports the addressed id as the channel when Slack's answer names none`, async () => {
		const { api } = fakeSlack({
			[route.write]: () => ({ ok: true, ts: POSTED_TS, scheduled_message_id: "Q0123ABC" }),
		});

		const result = await run(route.tool, args({ channel_id: "U0123ABC" }), api);

		expect(result.text).toContain("Channel: U0123ABC");
	});

	test.each([
		["conversation lookup", "conversations.info", "C0123ABC"],
		["person lookup", "users.info", "U0123ABC"],
		["write", route.write, "C0123ABC"],
	] as const)(
		`${route.tool} tells the user how to regain a scope Slack says is missing on the %s`,
		async (_name, method, id) => {
			const slackError = new SlackApiError(method, "missing_scope", "im:write");
			const { api } = fakeSlack({ [method]: throwing(slackError) });

			const refusal = await failure(run(route.tool, args({ channel_id: id }), api));

			expect(refusal.message).toStartWith(slackError.message);
			expect(refusal.message).toContain(`Reconnect Slack as you under ${CONNECT_PATH}`);
			expect(refusal.message).toContain("Read and send or Everything");
			expect(refusal.message).toContain("app manifest");
		},
	);

	test.each([
		[
			"a conversation the user is not in",
			route.write,
			new SlackApiError(route.write, "not_in_channel"),
			["not_in_channel"],
		],
		[
			"a conversation Slack cannot find",
			"conversations.info",
			new SlackApiError("conversations.info", "channel_not_found"),
			["channel_not_found"],
		],
		["an archived channel", route.write, new SlackApiError(route.write, "is_archived"), ["is_archived"]],
	] as const)(
		`${route.tool} turns %s into an error that keeps Slack's message and adds what to do about it`,
		async (_name, method, slackError, wording) => {
			const { api } = fakeSlack({ [method]: throwing(slackError) });

			const refusal = await failure(run(route.tool, args(), api));

			expect(refusal.message.startsWith(slackError.message)).toBe(true);
			expect(refusal.message.length).toBeGreaterThan(slackError.message.length);
			for (const word of wording) expect(refusal.message).toContain(word);
		},
	);

	test(`${route.tool} leaves a Slack error with no known remedy exactly as Slack worded it`, async () => {
		const { api } = fakeSlack({ [route.write]: throwing(new SlackApiError(route.write, "msg_too_long")) });

		const refusal = await failure(run(route.tool, args(), api));

		expect(refusal.message).toBe(`Slack ${route.write} failed: msg_too_long`);
	});

	test.each([
		["a conversation lookup", "conversations.info", "C0123ABC"],
		["a person lookup", "users.info", "U0123ABC"],
	] as const)(
		`${route.tool} lets a lost sign-in on %s through unchanged so the agent sees how to reconnect`,
		async (_name, method, id) => {
			const lost = new SlackSignInError("Reconnect Slack as you.");
			const { api } = fakeSlack({ [method]: throwing(lost) });

			await expect(run(route.tool, args({ channel_id: id }), api)).rejects.toBe(lost);
		},
	);
}

test("the permalink is asked for in the conversation Slack wrote to, not in the person the message was addressed to", async () => {
	const { api, calls } = fakeSlack({ "chat.postMessage": () => ({ ok: true, channel: "D0999XYZ", ts: POSTED_TS }) });

	await run(SEND, { channel_id: "U0123ABC", message: "hello" }, api);

	expect(calls.find(call => call.method === "chat.getPermalink")?.params).toEqual({
		channel: "D0999XYZ",
		message_ts: POSTED_TS,
	});
});

test("the permalink is asked for in the addressed conversation when Slack's answer names none", async () => {
	const { api, calls } = fakeSlack({ "chat.postMessage": () => ({ ok: true, ts: POSTED_TS }) });

	await run(SEND, { channel_id: "C0123ABC", message: "hello" }, api);

	expect(calls.find(call => call.method === "chat.getPermalink")?.params).toEqual({
		channel: "C0123ABC",
		message_ts: POSTED_TS,
	});
});
