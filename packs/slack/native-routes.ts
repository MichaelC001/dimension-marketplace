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

interface Fields {
	readonly message: string;
	readonly channelId: string;
	readonly threadTs: string | undefined;
	readonly broadcast: boolean | undefined;
}

function readFields(tool: string, args: Args, supported: readonly string[]): Fields {
	refuseUnsupported(tool, args, supported);
	return {
		message: requiredText(tool, args, "message"),
		channelId: requiredText(tool, args, "channel_id"),
		threadTs: optionalText(tool, args, "thread_ts"),
		broadcast: optionalFlag(tool, args, "reply_broadcast"),
	};
}

async function withHints<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof SlackApiError)) throw error;
		const hint =
			error.code === "missing_scope"
				? `This sign-in lacks a scope. Reconnect Slack as you under ${CONNECT_PATH} and choose Read and send or Everything. If the Slack app itself lacks it, paste the app manifest from the same page into the app again and reinstall it first.`
				: HINTS[error.code];
		throw hint ? new Error(`${error.message}. ${hint}`) : error;
	}
}

const OUTSIDE_WORKSPACE = "is outside this workspace (Slack Connect). Dimension does not send there as you.";

async function refuseOutsider(api: WebApiClient, userId: string, signal?: AbortSignal): Promise<void> {
	const [me, found] = await Promise.all([
		api.call("auth.test", {}, signal),
		api.call("users.info", { user: userId }, signal),
	]);
	if (typeof me.team_id !== "string") {
		throw new Error("Slack did not say which workspace this sign-in belongs to, so Dimension cannot tell whether that person is outside it.");
	}
	if (!isRecord(found.user)) {
		throw new Error(`Slack did not describe ${userId}, so Dimension cannot tell whether that person is outside this workspace.`);
	}
	if (found.user.is_stranger === true || found.user.team_id !== me.team_id) {
		throw new Error(`${userId} ${OUTSIDE_WORKSPACE}`);
	}
}

async function targetConversation(api: WebApiClient, tool: string, channelId: string, signal?: AbortSignal): Promise<string> {
	if (USER_ID.test(channelId)) {
		await refuseOutsider(api, channelId, signal);
		return channelId;
	}
	if (!CONVERSATION_ID.test(channelId)) {
		throw new Error(
			`${tool} needs "channel_id" as a Slack id: C or G for a channel, D for a direct message, or a user id starting with U or W to message that person. Find one with slack_search_channels or slack_search_users.`,
		);
	}
	const info = await api.call("conversations.info", { channel: channelId }, signal);
	if (!isRecord(info.channel)) {
		throw new Error(`Slack did not describe ${channelId}, so Dimension cannot tell whether it is shared outside this workspace.`);
	}
	if (info.channel.is_ext_shared === true || info.channel.is_pending_ext_shared === true) {
		throw new Error(`${channelId} ${OUTSIDE_WORKSPACE}`);
	}
	if (info.channel.is_im === true) {
		if (typeof info.channel.user !== "string") {
			throw new Error(`Slack did not say who ${channelId} is a conversation with, so Dimension cannot tell whether that person is outside this workspace.`);
		}
		await refuseOutsider(api, info.channel.user, signal);
	}
	return channelId;
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
			const fields = readFields(SEND_TOOL, args, SEND_ARGUMENTS);
			const unfurlApps = optionalFlag(SEND_TOOL, args, "unfurl_app_links");
			const channel = await targetConversation(api, SEND_TOOL, fields.channelId, signal);
			const posted = await api.call(
				"chat.postMessage",
				{
					channel,
					markdown_text: fields.message,
					thread_ts: fields.threadTs,
					reply_broadcast: fields.broadcast,
					unfurl_app_links: unfurlApps === true,
				},
				signal,
			);
			const ts = typeof posted.ts === "string" ? posted.ts : undefined;
			const where = typeof posted.channel === "string" ? posted.channel : channel;
			const link = ts ? await permalinkOf(api, where, ts, signal) : undefined;
			return report([
				"Message sent.",
				`Channel: ${where}`,
				ts ? `Message TS: ${ts}` : undefined,
				link ? `Link: ${link}` : undefined,
			]);
		}),
};

const scheduleMessage: NativeRoute = {
	run: (args, api, signal) =>
		withHints(async () => {
			const fields = readFields(SCHEDULE_TOOL, args, SCHEDULE_ARGUMENTS);
			const postAt = args.post_at;
			if (typeof postAt !== "number" || !Number.isInteger(postAt)) {
				throw new Error(`${SCHEDULE_TOOL} needs "post_at" as a whole Unix timestamp in seconds.`);
			}
			const channel = await targetConversation(api, SCHEDULE_TOOL, fields.channelId, signal);
			const scheduled = await api.call(
				"chat.scheduleMessage",
				{
					channel,
					markdown_text: fields.message,
					post_at: postAt,
					thread_ts: fields.threadTs,
					reply_broadcast: fields.broadcast,
				},
				signal,
			);
			const id = typeof scheduled.scheduled_message_id === "string" ? scheduled.scheduled_message_id : undefined;
			return report([
				"Message scheduled.",
				`Channel: ${typeof scheduled.channel === "string" ? scheduled.channel : channel}`,
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
