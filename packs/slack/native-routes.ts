import { CONNECT_PATH } from "./credential";
import type { McpToolResult } from "./mcp-client";
import { isRecord } from "./type-guards";
import { SlackApiError, type WebApiClient } from "./web-api";

const USER_ID = /^[UW][A-Z0-9]{2,}$/;
const CONVERSATION_ID = /^[CGD][A-Z0-9]{2,}$/;
const SEND_TOOL = "slack_send_message";
const SCHEDULE_TOOL = "slack_schedule_message";
const SEND_ARGUMENTS = ["channel_id", "message", "thread_ts", "reply_broadcast", "unfurl_app_links"] as const;
const SCHEDULE_ARGUMENTS = ["channel_id", "message", "post_at", "thread_ts", "reply_broadcast"] as const;
const HINTS: Readonly<Record<string, string>> = {
	not_in_channel: "You are not a member of that conversation. Join it in Slack first.",
	channel_not_found: "That conversation does not exist, or you cannot see it.",
	is_archived: "That channel is archived.",
};

type Args = Record<string, unknown>;

export interface NativeRoute {
	run(args: Args, api: WebApiClient, signal?: AbortSignal): Promise<McpToolResult>;
}

export type NativeRoutes = ReadonlyMap<string, NativeRoute>;

function refuseUnsupported(tool: string, args: Args, supported: readonly string[]): void {
	const extra = Object.keys(args).filter(key => !supported.includes(key));
	if (extra.length === 0) return;
	if (extra.includes("draft_id")) {
		throw new Error(
			`${tool} cannot delete a draft when it sends as you, because Slack's API has no way to. Send without draft_id, or send the draft yourself from Slack.`,
		);
	}
	throw new Error(
		`${tool} does not support ${extra.map(key => `"${key}"`).join(", ")} when it sends as you. It supports: ${supported.join(", ")}.`,
	);
}

function requiredText(tool: string, args: Args, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${tool} needs "${key}" as a non-empty string.`);
	return value;
}

function optionalText(tool: string, args: Args, key: string): string | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") throw new Error(`${tool} needs "${key}" as a non-empty string.`);
	return value;
}

function optionalFlag(tool: string, args: Args, key: string): boolean | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${tool} needs "${key}" as true or false.`);
	return value;
}

async function withHints<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof SlackApiError)) throw error;
		const hint =
			error.code === "missing_scope"
				? `The Slack app is missing a scope. Paste the app manifest from ${CONNECT_PATH} into the Slack app again, reinstall it and reconnect.`
				: HINTS[error.code];
		throw hint ? new Error(`${error.message}. ${hint}`) : error;
	}
}

async function targetConversation(api: WebApiClient, tool: string, channelId: string, signal?: AbortSignal): Promise<string> {
	let channel = channelId;
	if (USER_ID.test(channelId)) {
		const opened = await api.call("conversations.open", { users: channelId }, signal);
		const id = isRecord(opened.channel) ? opened.channel.id : undefined;
		if (typeof id !== "string") throw new Error(`Slack did not open a direct message with ${channelId}.`);
		channel = id;
	} else if (!CONVERSATION_ID.test(channelId)) {
		throw new Error(
			`${tool} needs "channel_id" as a Slack id: C or G for a channel, a user id starting with U for a direct message. Find one with slack_search_channels or slack_search_users.`,
		);
	}
	const info = await api.call("conversations.info", { channel }, signal);
	const conversation = isRecord(info.channel) ? info.channel : {};
	if (conversation.is_ext_shared === true || conversation.is_pending_ext_shared === true) {
		throw new Error(
			`${channel} is shared outside this workspace (Slack Connect). Dimension does not send there as you.`,
		);
	}
	return channel;
}

async function permalinkOf(
	api: WebApiClient,
	channel: string,
	ts: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const found = await api.call("chat.getPermalink", { channel, message_ts: ts }, signal);
		return typeof found.permalink === "string" ? found.permalink : undefined;
	} catch {
		return undefined;
	}
}

function report(lines: readonly (string | undefined)[]): McpToolResult {
	return { text: lines.filter((line): line is string => line !== undefined).join("\n"), isError: false };
}

const sendMessage: NativeRoute = {
	run: (args, api, signal) =>
		withHints(async () => {
			refuseUnsupported(SEND_TOOL, args, SEND_ARGUMENTS);
			const message = requiredText(SEND_TOOL, args, "message");
			const channelId = requiredText(SEND_TOOL, args, "channel_id");
			const threadTs = optionalText(SEND_TOOL, args, "thread_ts");
			const broadcast = optionalFlag(SEND_TOOL, args, "reply_broadcast");
			const unfurlApps = optionalFlag(SEND_TOOL, args, "unfurl_app_links");
			const channel = await targetConversation(api, SEND_TOOL, channelId, signal);
			const posted = await api.call(
				"chat.postMessage",
				{
					channel,
					markdown_text: message,
					thread_ts: threadTs,
					reply_broadcast: broadcast,
					unfurl_app_links: unfurlApps === true,
				},
				signal,
			);
			const ts = typeof posted.ts === "string" ? posted.ts : undefined;
			const link = ts ? await permalinkOf(api, channel, ts, signal) : undefined;
			return report([
				"Message sent.",
				`Channel: ${channel}`,
				ts ? `Message TS: ${ts}` : undefined,
				link ? `Link: ${link}` : undefined,
			]);
		}),
};

const scheduleMessage: NativeRoute = {
	run: (args, api, signal) =>
		withHints(async () => {
			refuseUnsupported(SCHEDULE_TOOL, args, SCHEDULE_ARGUMENTS);
			const message = requiredText(SCHEDULE_TOOL, args, "message");
			const channelId = requiredText(SCHEDULE_TOOL, args, "channel_id");
			const threadTs = optionalText(SCHEDULE_TOOL, args, "thread_ts");
			const broadcast = optionalFlag(SCHEDULE_TOOL, args, "reply_broadcast");
			const postAt = args.post_at;
			if (typeof postAt !== "number" || !Number.isInteger(postAt)) {
				throw new Error(`${SCHEDULE_TOOL} needs "post_at" as a whole Unix timestamp in seconds.`);
			}
			const channel = await targetConversation(api, SCHEDULE_TOOL, channelId, signal);
			const scheduled = await api.call(
				"chat.scheduleMessage",
				{ channel, markdown_text: message, post_at: postAt, thread_ts: threadTs, reply_broadcast: broadcast },
				signal,
			);
			const id = typeof scheduled.scheduled_message_id === "string" ? scheduled.scheduled_message_id : undefined;
			return report([
				"Message scheduled.",
				`Channel: ${channel}`,
				`Scheduled for: ${new Date(postAt * 1000).toISOString()}`,
				id ? `Scheduled message id: ${id}` : undefined,
			]);
		}),
};

export function createNativeRoutes(): NativeRoutes {
	return new Map([
		[SEND_TOOL, sendMessage],
		[SCHEDULE_TOOL, scheduleMessage],
	]);
}
