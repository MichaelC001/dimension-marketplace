// Slack connector — list channels, read channel history, and post messages over
// the Slack Web API (https://api.slack.com/web), authenticated via the plugin's
// `form` connect flow (see fraym.plugin.json). The connect flow writes
// {access} (a Bot User OAuth token, xoxb-…) to CONFIG_TARGET; this extension's
// ONLY job is to read that token and expose the API as agent tools. No Slack
// SDK — plain fetch against the documented REST endpoints, matching the rest of
// this repo's connectors.
//
// Slack quirk: the Web API returns HTTP 200 even on failure, with a body of
// {"ok":false,"error":"…"}. Every call MUST inspect `body.ok` and surface
// `body.error` — a 2xx status alone does NOT mean success.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-connect.ts) renders the token template there;
// this is the ONLY other place that path is spelled out (a JSON manifest can't
// share a TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-slack", "token.json");
const SLACK_API = "https://slack.com/api";
// Slack truncates single-page listings; keep the agent-facing caps modest so
// results stay readable and paginate explicitly via the cursor.
const MAX_MESSAGE_TEXT = 500;

const storedCredential = type({
	access: "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Slack isn't connected yet. Open the plugin's Connect dialog (Plugins → Slack → Set up) and paste your Bot User OAuth token.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Slack's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

interface SlackResponse {
	readonly ok: boolean;
	readonly error?: string;
}

/** Parse a Slack Web API response, honoring the ok=false-on-200 quirk. */
async function parseSlack<T extends SlackResponse>(res: Response, op: string): Promise<T> {
	if (res.status === 401) {
		throw new Error("Slack rejected the bot token (401). Reconnect the plugin (Plugins → Slack → Reconnect).");
	}
	const payload = (await res.json().catch(() => null)) as T | null;
	if (!payload) {
		throw new Error(`Slack ${op} failed: ${res.statusText}`);
	}
	if (!payload.ok) {
		throw new Error(`Slack ${op} failed: ${payload.error ?? "unknown_error"}`);
	}
	return payload;
}

async function slackGet<T extends SlackResponse>(method: string, query: URLSearchParams, op: string): Promise<T> {
	const { access } = await readCredential();
	const res = await fetch(`${SLACK_API}/${method}?${query.toString()}`, {
		headers: { Authorization: `Bearer ${access}` },
	});
	return await parseSlack<T>(res, op);
}

async function slackPost<T extends SlackResponse>(
	method: string,
	body: Record<string, unknown>,
	op: string,
): Promise<T> {
	const { access } = await readCredential();
	const res = await fetch(`${SLACK_API}/${method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${access}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(body),
	});
	return await parseSlack<T>(res, op);
}

interface SlackChannel {
	readonly id: string;
	readonly name: string;
	readonly topic?: { readonly value?: string };
}

interface SlackMessage {
	readonly ts: string;
	readonly user?: string;
	readonly text?: string;
}

interface SlackUser {
	readonly id: string;
	readonly name?: string;
	readonly real_name?: string;
	readonly deleted?: boolean;
	readonly is_bot?: boolean;
}

const listChannelsSchema = type({
	"limit?": type("number").describe("Max channels to return, default 100, capped at 200."),
	"cursor?": type("string").describe(
		"Pagination cursor from a previous call's 'next cursor' line — omit for the first page.",
	),
});

const readMessagesSchema = type({
	channel: type("string").describe("Channel id from slack_list_channels (e.g. C0123ABCD)."),
	"limit?": type("number").describe("Max messages, most-recent first, default 50, capped at 200."),
});

const postMessageSchema = type({
	channel: type("string").describe("Channel id (e.g. C0123ABCD) or #channel-name to post to."),
	text: type("string").describe("The message text to post — Slack mrkdwn is supported."),
});

const readThreadSchema = type({
	channel: type("string").describe("Channel id from slack_list_channels (e.g. C0123ABCD)."),
	threadTs: type("string").describe(
		"The `ts` of the thread's parent message (from slack_read_messages) whose replies to read.",
	),
	"limit?": type("number").describe("Max replies, oldest first, default 50, capped at 200."),
});

const replyThreadSchema = type({
	channel: type("string").describe("Channel id (e.g. C0123ABCD) or #channel-name of the thread."),
	threadTs: type("string").describe("The `ts` of the thread's parent message to reply under."),
	text: type("string").describe("The reply text to post — Slack mrkdwn is supported."),
});

const addReactionSchema = type({
	channel: type("string").describe("Channel id (e.g. C0123ABCD) containing the message."),
	messageTs: type("string").describe("The `ts` of the message to react to (from slack_read_messages)."),
	emoji: type("string").describe("Emoji name WITHOUT colons, e.g. `thumbsup` or `white_check_mark`."),
});

const editMessageSchema = type({
	channel: type("string").describe("Channel id (e.g. C0123ABCD) containing the message."),
	messageTs: type("string").describe("The `ts` of the message to edit — must be one the bot itself posted."),
	text: type("string").describe("The new text — replaces the original message entirely. Slack mrkdwn supported."),
});

const deleteMessageSchema = type({
	channel: type("string").describe("Channel id (e.g. C0123ABCD) containing the message."),
	messageTs: type("string").describe(
		"The `ts` of the message to delete — the bot's own message (or any with admin scopes).",
	),
});

const listUsersSchema = type({
	"limit?": type("number").describe("Max users to return, default 100, capped at 200."),
	"cursor?": type("string").describe(
		"Pagination cursor from a previous call's 'next cursor' line — omit for the first page.",
	),
});

function createListChannelsTool(): ToolDefinition<typeof listChannelsSchema> {
	return {
		name: "slack_list_channels",
		label: "Slack: List Channels",
		description:
			"List public and private channels in the connected Slack workspace. Returns id/#name/topic per line — pass an id to slack_read_messages or slack_post_message. Paginate with the returned 'next cursor'.",
		parameters: listChannelsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listChannelsSchema.infer) {
			const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);
			const query = new URLSearchParams({
				types: "public_channel,private_channel",
				exclude_archived: "true",
				limit: String(limit),
			});
			if (params.cursor) query.set("cursor", params.cursor);
			const payload = await slackGet<{
				channels?: SlackChannel[];
				response_metadata?: { next_cursor?: string };
			}>("conversations.list", query, "conversations.list");
			const channels = payload.channels ?? [];
			const lines =
				channels.length === 0
					? "No channels found. Invite the bot to a channel with /invite, or check its channels:read / groups:read scopes."
					: channels
							.map(
								channel =>
									`${channel.id}  #${channel.name}${channel.topic?.value ? `  — ${channel.topic.value}` : ""}`,
							)
							.join("\n");
			const nextCursor = payload.response_metadata?.next_cursor;
			const text = nextCursor ? `${lines}\n\nnext cursor: ${nextCursor}` : lines;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createReadMessagesTool(): ToolDefinition<typeof readMessagesSchema> {
	return {
		name: "slack_read_messages",
		label: "Slack: Read Messages",
		description:
			"Read recent messages from a Slack channel (most-recent first). Returns ts/user/text per line — the `ts` value IS the message id (use it to reference or thread a message). The bot must be a member of the channel.",
		parameters: readMessagesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readMessagesSchema.infer) {
			const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
			const query = new URLSearchParams({ channel: params.channel, limit: String(limit) });
			const payload = await slackGet<{ messages?: SlackMessage[] }>(
				"conversations.history",
				query,
				"conversations.history",
			);
			const messages = payload.messages ?? [];
			const text =
				messages.length === 0
					? "No messages. The bot must be a member of this channel — invite it with /invite."
					: messages
							.map(message => {
								const body = (message.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_TEXT);
								return `${message.ts}  ${message.user ?? "—"}  ${body}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createPostMessageTool(): ToolDefinition<typeof postMessageSchema> {
	return {
		name: "slack_post_message",
		label: "Slack: Post Message",
		description:
			"Post a message to a Slack channel. DESTRUCTIVE — this sends a real message visible to the channel; ALWAYS confirm the exact channel and text with the user before calling. The bot must be a member of the channel (invite it with /invite). Returns the posted message ts + channel.",
		parameters: postMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof postMessageSchema.infer) {
			const payload = await slackPost<{ channel?: string; ts?: string }>(
				"chat.postMessage",
				{ channel: params.channel, text: params.text },
				"chat.postMessage",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Posted to ${payload.channel ?? params.channel} — ts ${payload.ts ?? "?"}`,
					},
				],
			};
		},
	};
}

function createReadThreadTool(): ToolDefinition<typeof readThreadSchema> {
	return {
		name: "slack_read_thread",
		label: "Slack: Read Thread",
		description:
			"Read the replies in a Slack thread (oldest first). Pass the parent message's `ts` as threadTs — the first returned line is the parent, the rest are replies. Returns ts/user/text per line. The bot must be a member of the channel.",
		parameters: readThreadSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readThreadSchema.infer) {
			const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
			const query = new URLSearchParams({
				channel: params.channel,
				ts: params.threadTs,
				limit: String(limit),
			});
			const payload = await slackGet<{ messages?: SlackMessage[] }>(
				"conversations.replies",
				query,
				"conversations.replies",
			);
			const messages = payload.messages ?? [];
			const text =
				messages.length === 0
					? "No replies found. Check the thread `ts` and that the bot is a member of this channel."
					: messages
							.map(message => {
								const body = (message.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_TEXT);
								return `${message.ts}  ${message.user ?? "—"}  ${body}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createReplyThreadTool(): ToolDefinition<typeof replyThreadSchema> {
	return {
		name: "slack_reply_thread",
		label: "Slack: Reply in Thread",
		description:
			"Reply inside a Slack thread. DESTRUCTIVE — this sends a real message visible to the channel; ALWAYS confirm the exact channel, thread, and text with the user before calling. Pass the parent message's `ts` as threadTs. The bot must be a member of the channel. Returns the posted reply ts + channel.",
		parameters: replyThreadSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof replyThreadSchema.infer) {
			const payload = await slackPost<{ channel?: string; ts?: string }>(
				"chat.postMessage",
				{ channel: params.channel, text: params.text, thread_ts: params.threadTs },
				"chat.postMessage",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Replied in ${payload.channel ?? params.channel} thread ${params.threadTs} — ts ${payload.ts ?? "?"}`,
					},
				],
			};
		},
	};
}

function createAddReactionTool(): ToolDefinition<typeof addReactionSchema> {
	return {
		name: "slack_add_reaction",
		label: "Slack: Add Reaction",
		description:
			"Add an emoji reaction to a Slack message. The emoji `name` is WITHOUT colons (e.g. `thumbsup`, not `:thumbsup:`). Requires the reactions:write scope — on a missing_scope error, tell the user to add it under OAuth & Permissions and reinstall. Returns a confirmation.",
		parameters: addReactionSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof addReactionSchema.infer) {
			const name = params.emoji.replace(/:/g, "");
			await slackPost<SlackResponse>(
				"reactions.add",
				{ channel: params.channel, timestamp: params.messageTs, name },
				"reactions.add",
			);
			return {
				content: [
					{ type: "text" as const, text: `Added :${name}: to ${params.channel} message ${params.messageTs}` },
				],
			};
		},
	};
}

function createEditMessageTool(): ToolDefinition<typeof editMessageSchema> {
	return {
		name: "slack_edit_message",
		label: "Slack: Edit Message",
		description:
			"Edit a Slack message. chat.update only works on messages the bot itself posted. DESTRUCTIVE — this replaces the visible message text; ALWAYS confirm the exact channel, message ts, and new text with the user before calling. Returns the updated ts + channel.",
		parameters: editMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof editMessageSchema.infer) {
			const payload = await slackPost<{ channel?: string; ts?: string }>(
				"chat.update",
				{ channel: params.channel, ts: params.messageTs, text: params.text },
				"chat.update",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Edited ${payload.channel ?? params.channel} message ${payload.ts ?? params.messageTs}`,
					},
				],
			};
		},
	};
}

function createDeleteMessageTool(): ToolDefinition<typeof deleteMessageSchema> {
	return {
		name: "slack_delete_message",
		label: "Slack: Delete Message",
		description:
			"Delete a Slack message. IRREVERSIBLE and DESTRUCTIVE — chat.delete removes the message permanently and it CANNOT be recovered. Only the bot's own messages (or any message if the token has admin scopes). ALWAYS confirm the EXACT channel and message ts with the user, and that they accept it cannot be undone, before calling. Returns a confirmation.",
		parameters: deleteMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof deleteMessageSchema.infer) {
			const payload = await slackPost<{ channel?: string; ts?: string }>(
				"chat.delete",
				{ channel: params.channel, ts: params.messageTs },
				"chat.delete",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Deleted message ${payload.ts ?? params.messageTs} from ${payload.channel ?? params.channel}`,
					},
				],
			};
		},
	};
}

function createListUsersTool(): ToolDefinition<typeof listUsersSchema> {
	return {
		name: "slack_list_users",
		label: "Slack: List Users",
		description:
			"List members of the connected Slack workspace. Returns `id  @name  real name` per line (deleted accounts and bots are flagged in brackets). Requires the users:read scope — on a missing_scope error, tell the user to add it under OAuth & Permissions and reinstall. Paginate with the returned 'next cursor'.",
		parameters: listUsersSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listUsersSchema.infer) {
			const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);
			const query = new URLSearchParams({ limit: String(limit) });
			if (params.cursor) query.set("cursor", params.cursor);
			const payload = await slackGet<{
				members?: SlackUser[];
				response_metadata?: { next_cursor?: string };
			}>("users.list", query, "users.list");
			const members = payload.members ?? [];
			const lines =
				members.length === 0
					? "No users found. Check the bot's users:read scope."
					: members
							.map(member => {
								const flags = [member.deleted ? "deleted" : null, member.is_bot ? "bot" : null]
									.filter(Boolean)
									.join(",");
								return `${member.id}  @${member.name ?? "—"}  ${member.real_name ?? "—"}${flags ? `  [${flags}]` : ""}`;
							})
							.join("\n");
			const nextCursor = payload.response_metadata?.next_cursor;
			const text = nextCursor ? `${lines}\n\nnext cursor: ${nextCursor}` : lines;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

/**
 * Slack plugin. A standard OMP plugin — `skills/`/`rules/` load via OMP's native
 * plugin discovery. This module registers the nine Web API tools; the connect
 * flow (fraym.plugin.json's `connect.form`) is what obtains the bot token these
 * tools read.
 */
export default function slackExtension(pi: ExtensionAPI): void {
	pi.registerTool(createListChannelsTool());
	pi.registerTool(createReadMessagesTool());
	pi.registerTool(createPostMessageTool());
	pi.registerTool(createReadThreadTool());
	pi.registerTool(createReplyThreadTool());
	pi.registerTool(createAddReactionTool());
	pi.registerTool(createEditMessageTool());
	pi.registerTool(createDeleteMessageTool());
	pi.registerTool(createListUsersTool());
}
