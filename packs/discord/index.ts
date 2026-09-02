// Discord connector — list servers/channels, read and post messages over the
// Discord REST API v10, authenticated by a bot token from the plugin's `form`
// connect flow (see fraym.plugin.json). The connect flow writes {"access":<bot
// token>} to CONFIG_TARGET; this extension's ONLY job is to read that token and
// expose it as agent tools. No Discord SDK — plain fetch against the documented
// REST endpoints, matching the rest of this repo's connectors.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-connect.ts) renders connect/token.template.json
// there; this is the ONLY other place that path is spelled out (a JSON manifest
// can't share a TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-discord", "token.json");
const DISCORD_API = "https://discord.com/api/v10";
// Cap on how many characters of a message body we echo back per line so a wall
// of text can't blow up the tool result.
const MAX_MESSAGE_TEXT = 500;
// Discord's maximum member timeout is 28 days; the API rejects a
// `communication_disabled_until` further out than that.
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

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
			"Discord isn't connected yet. Open the plugin's Connect dialog (Plugins → Discord → Set up) and paste a bot token.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Discord's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

async function discordFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(`${DISCORD_API}${path}`, {
		...init,
		headers: {
			// Discord uses the "Bot" auth scheme for bot tokens, NOT "Bearer".
			Authorization: `Bot ${token}`,
			...(init?.headers ?? {}),
		},
	});
	if (res.status === 401) {
		throw new Error("Discord rejected the bot token (401). Reconnect the plugin (Plugins → Discord → Reconnect).");
	}
	return res;
}

async function discordJson<T>(path: string, token: string, op: string, init?: RequestInit): Promise<T> {
	const res = await discordFetch(path, token, init);
	const payload = (await res.json().catch(() => null)) as (T & { message?: string; code?: number }) | null;
	if (!res.ok || payload === null) {
		const detail = payload && typeof payload.message === "string" ? payload.message : res.statusText;
		throw new Error(`Discord ${op} failed: ${detail}`);
	}
	return payload;
}

// Like discordJson but for endpoints that return 204 No Content on success
// (reactions, deletes, pins, member timeouts). Surfaces the same error shape as
// discordJson when Discord rejects the call.
async function discordVoid(path: string, token: string, op: string, init?: RequestInit): Promise<void> {
	const res = await discordFetch(path, token, init);
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { message?: string } | null;
		const detail = payload && typeof payload.message === "string" ? payload.message : res.statusText;
		throw new Error(`Discord ${op} failed: ${detail}`);
	}
}

// RequestInit for a JSON body — the POST/PATCH shape every mutating Discord call
// shares (discordFetch adds the Authorization header).
function jsonInit(method: string, body: Record<string, unknown>): RequestInit {
	return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

interface Guild {
	readonly id: string;
	readonly name: string;
}

interface Channel {
	readonly id: string;
	readonly name?: string;
	readonly type: number;
}

interface DiscordUser {
	readonly username?: string;
	readonly global_name?: string | null;
}

interface Message {
	readonly id: string;
	readonly content: string;
	readonly timestamp: string;
	readonly author?: DiscordUser;
}

// Discord channel `type` codes → a short human label (Channel Types reference,
// https://discord.com/developers/docs/resources/channel#channel-object-channel-types).
const CHANNEL_TYPE_NAME: Readonly<Record<number, string>> = {
	0: "text",
	1: "dm",
	2: "voice",
	3: "group-dm",
	4: "category",
	5: "announcement",
	10: "announcement-thread",
	11: "public-thread",
	12: "private-thread",
	13: "stage-voice",
	14: "directory",
	15: "forum",
	16: "media",
};

// Human channel kinds accepted by discord_create_channel → Discord `type` code
// (a subset of CHANNEL_TYPE_NAME — the kinds it makes sense to create).
const CHANNEL_KIND_TYPE: Readonly<Record<string, number>> = {
	text: 0,
	voice: 2,
	category: 4,
};

function oneLine(text: string, max: number): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened;
}

const listGuildsSchema = type({});

const listChannelsSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
});

const readMessagesSchema = type({
	channelId: type("string").describe("The channel id, from discord_list_channels."),
	"limit?": type("number").describe("How many recent messages to fetch, default 20, capped at 100."),
});

const sendMessageSchema = type({
	channelId: type("string").describe("The channel id to post into, from discord_list_channels."),
	content: type("string").describe("The message text to post (Discord markdown supported, max 2000 chars)."),
});

const createThreadSchema = type({
	channelId: type("string").describe("The parent channel id to create the thread in, from discord_list_channels."),
	name: type("string").describe("The thread name (max 100 chars)."),
	"messageId?": type("string").describe(
		"Optional. When set, the thread is created FROM this existing message (it becomes the thread's starter message). Omit for a standalone thread.",
	),
});

const replyMessageSchema = type({
	channelId: type("string").describe("The channel id containing the message to reply to, from discord_list_channels."),
	messageId: type("string").describe("The id of the message to reply to (from discord_read_messages)."),
	content: type("string").describe("The reply text (Discord markdown supported, max 2000 chars)."),
});

const addReactionSchema = type({
	channelId: type("string").describe("The channel id containing the message, from discord_list_channels."),
	messageId: type("string").describe("The id of the message to react to, from discord_read_messages."),
	emoji: type("string").describe(
		"The emoji to add. For a standard Unicode emoji, pass the character itself (e.g. 👍). For a custom guild emoji, pass `name:id` (e.g. `partyblob:41771983429993937`). The reaction is added AS THE BOT.",
	),
});

const editMessageSchema = type({
	channelId: type("string").describe("The channel id containing the message, from discord_list_channels."),
	messageId: type("string").describe(
		"The id of the message to edit. ONLY the bot's own messages can be edited — Discord rejects edits to other users' messages.",
	),
	content: type("string").describe("The new message text, which fully replaces the current content (max 2000 chars)."),
});

const deleteMessageSchema = type({
	channelId: type("string").describe("The channel id containing the message, from discord_list_channels."),
	messageId: type("string").describe(
		"The id of the message to delete (from discord_read_messages). With Manage Messages this deletes ANYONE's message and is IRREVERSIBLE — confirm the exact message with the user first.",
	),
});

const pinMessageSchema = type({
	channelId: type("string").describe("The channel id containing the message, from discord_list_channels."),
	messageId: type("string").describe("The id of the message to pin (or unpin), from discord_read_messages."),
	"unpin?": type("boolean").describe("Set true to UNPIN the message instead of pinning it. Default false (pin)."),
});

const createChannelSchema = type({
	guildId: type("string").describe("The server (guild) id to create the channel in, from discord_list_guilds."),
	name: type("string").describe(
		"The new channel name (for text channels, lowercase with dashes, no spaces; max 100 chars).",
	),
	"kind?": type('"text" | "voice" | "category"').describe(
		'The channel kind: "text" (default), "voice", or "category".',
	),
	"topic?": type("string").describe(
		"Optional channel topic/description shown in the header (text channels only, max 1024 chars).",
	),
	"parentId?": type("string").describe("Optional id of a category channel to nest this channel under."),
});

const timeoutMemberSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
	userId: type("string").describe(
		"The id of the member to time out (mute) — the exact user, confirmed with the user.",
	),
	minutes: type("number").describe(
		"How long to time the member out, in minutes (1–40320, i.e. up to 28 days; clamped to that range). Pass 0 (or clear:true) to LIFT an existing timeout.",
	),
	"clear?": type("boolean").describe(
		"Set true to immediately lift the member's timeout (sends null). Overrides minutes.",
	),
});

function createListGuildsTool(): ToolDefinition<typeof listGuildsSchema> {
	return {
		name: "discord_list_guilds",
		label: "Discord: List Servers",
		description:
			"List the Discord servers (guilds) the connected bot is a member of. Returns id and name per line — pass a server id to discord_list_channels.",
		parameters: listGuildsSchema,
		approval: "read" as const,
		async execute() {
			const token = (await readCredential()).access;
			const guilds = await discordJson<Guild[]>("/users/@me/guilds", token, "list guilds");
			const text =
				guilds.length === 0
					? "The bot isn't in any servers yet. Invite it via OAuth2 → URL Generator (scope `bot`)."
					: guilds.map(g => `${g.id}  ${g.name}`).join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createListChannelsTool(): ToolDefinition<typeof listChannelsSchema> {
	return {
		name: "discord_list_channels",
		label: "Discord: List Channels",
		description:
			"List the channels in a Discord server. Returns id, name, and type per line — pass a text channel id to discord_read_messages or discord_send_message.",
		parameters: listChannelsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listChannelsSchema.infer) {
			const token = (await readCredential()).access;
			const channels = await discordJson<Channel[]>(
				`/guilds/${encodeURIComponent(params.guildId)}/channels`,
				token,
				"list channels",
			);
			const text =
				channels.length === 0
					? "No channels found (the bot may lack the View Channels permission in this server)."
					: channels
							.map(c => `${c.id}  ${c.name ?? "(unnamed)"}  (${CHANNEL_TYPE_NAME[c.type] ?? `type ${c.type}`})`)
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createReadMessagesTool(): ToolDefinition<typeof readMessagesSchema> {
	return {
		name: "discord_read_messages",
		label: "Discord: Read Messages",
		description:
			"Read the most recent messages in a Discord channel (newest first). Returns author, timestamp, and content per line. Requires the bot's MESSAGE CONTENT intent to see message text.",
		parameters: readMessagesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readMessagesSchema.infer) {
			const token = (await readCredential()).access;
			const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
			const messages = await discordJson<Message[]>(
				`/channels/${encodeURIComponent(params.channelId)}/messages?limit=${limit}`,
				token,
				"read messages",
			);
			const text =
				messages.length === 0
					? "No messages in this channel."
					: messages
							.map(m => {
								const author = m.author?.global_name || m.author?.username || "unknown";
								const body = m.content
									? oneLine(m.content, MAX_MESSAGE_TEXT)
									: "(no text — embed/attachment only)";
								return `${m.timestamp}  ${author}: ${body}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSendMessageTool(): ToolDefinition<typeof sendMessageSchema> {
	return {
		name: "discord_send_message",
		label: "Discord: Send Message",
		description:
			"Post a message to a Discord channel. DESTRUCTIVE — this publishes text to a live channel other people can see. ALWAYS confirm the exact channel and message content with the user before calling. Returns the new message id.",
		parameters: sendMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof sendMessageSchema.infer) {
			const token = (await readCredential()).access;
			const sent = await discordJson<Message>(
				`/channels/${encodeURIComponent(params.channelId)}/messages`,
				token,
				"send message",
				jsonInit("POST", { content: params.content }),
			);
			return { content: [{ type: "text" as const, text: `Message sent (id ${sent.id}).` }] };
		},
	};
}

function createCreateThreadTool(): ToolDefinition<typeof createThreadSchema> {
	return {
		name: "discord_create_thread",
		label: "Discord: Create Thread",
		description:
			"Create a thread in a Discord channel. If `messageId` is given the thread is spun off from that existing message; otherwise a standalone public thread is created. MUTATING — confirm the channel (and message, if any) and the thread name with the user first. Returns the new thread id and name.",
		parameters: createThreadSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof createThreadSchema.infer) {
			const token = (await readCredential()).access;
			const channelId = encodeURIComponent(params.channelId);
			const thread = params.messageId
				? await discordJson<Channel>(
						`/channels/${channelId}/messages/${encodeURIComponent(params.messageId)}/threads`,
						token,
						"create thread from message",
						jsonInit("POST", { name: params.name }),
					)
				: await discordJson<Channel>(
						`/channels/${channelId}/threads`,
						token,
						"create thread",
						// type 11 = PUBLIC_THREAD; the default for a threadless start would
						// otherwise be a private thread, which requires server perks.
						jsonInit("POST", { name: params.name, type: 11 }),
					);
			return {
				content: [
					{
						type: "text" as const,
						text: `Thread created (id ${thread.id}, name "${thread.name ?? params.name}").`,
					},
				],
			};
		},
	};
}

function createReplyMessageTool(): ToolDefinition<typeof replyMessageSchema> {
	return {
		name: "discord_reply_message",
		label: "Discord: Reply to Message",
		description:
			"Reply to a specific Discord message (posts a new message linked to the original). DESTRUCTIVE — this publishes text to a live channel other people can see. ALWAYS confirm the exact channel, target message, and reply content with the user first. Returns the new message id.",
		parameters: replyMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof replyMessageSchema.infer) {
			const token = (await readCredential()).access;
			const sent = await discordJson<Message>(
				`/channels/${encodeURIComponent(params.channelId)}/messages`,
				token,
				"reply to message",
				jsonInit("POST", {
					content: params.content,
					message_reference: { message_id: params.messageId },
				}),
			);
			return { content: [{ type: "text" as const, text: `Reply sent (id ${sent.id}).` }] };
		},
	};
}

function createAddReactionTool(): ToolDefinition<typeof addReactionSchema> {
	return {
		name: "discord_add_reaction",
		label: "Discord: Add Reaction",
		description:
			"Add an emoji reaction to a Discord message AS THE BOT. Low-risk but still a public write (everyone sees the bot reacted) — mention it to the user before reacting on their behalf. For a custom guild emoji pass `name:id`; for a standard emoji pass the character.",
		parameters: addReactionSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof addReactionSchema.infer) {
			const token = (await readCredential()).access;
			await discordVoid(
				`/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}/reactions/${encodeURIComponent(params.emoji)}/@me`,
				token,
				"add reaction",
				{ method: "PUT" },
			);
			return {
				content: [{ type: "text" as const, text: `Reacted with ${params.emoji} on message ${params.messageId}.` }],
			};
		},
	};
}

function createEditMessageTool(): ToolDefinition<typeof editMessageSchema> {
	return {
		name: "discord_edit_message",
		label: "Discord: Edit Message",
		description:
			"Edit the content of a Discord message. ONLY works on the bot's OWN messages — Discord rejects edits to messages posted by other users. DESTRUCTIVE — the previous content is replaced; confirm the exact message and new content with the user first.",
		parameters: editMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof editMessageSchema.infer) {
			const token = (await readCredential()).access;
			const edited = await discordJson<Message>(
				`/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}`,
				token,
				"edit message",
				jsonInit("PATCH", { content: params.content }),
			);
			return { content: [{ type: "text" as const, text: `Message edited (id ${edited.id}).` }] };
		},
	};
}

function createDeleteMessageTool(): ToolDefinition<typeof deleteMessageSchema> {
	return {
		name: "discord_delete_message",
		label: "Discord: Delete Message",
		description:
			"MODERATION. Permanently delete a Discord message — with the Manage Messages permission this works on ANYONE's message, not just the bot's. IRREVERSIBLE. NEVER call without EXPLICIT user confirmation of the EXACT message (channel + message id, ideally quoting its content) in the current turn. Refuse on vague instructions like \"clean up the channel\".",
		parameters: deleteMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof deleteMessageSchema.infer) {
			const token = (await readCredential()).access;
			await discordVoid(
				`/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}`,
				token,
				"delete message",
				{ method: "DELETE" },
			);
			return { content: [{ type: "text" as const, text: `Message ${params.messageId} deleted.` }] };
		},
	};
}

function createPinMessageTool(): ToolDefinition<typeof pinMessageSchema> {
	return {
		name: "discord_pin_message",
		label: "Discord: Pin Message",
		description:
			"Pin a Discord message to its channel (or unpin it with `unpin: true`). MUTATING — pinned messages are highlighted for everyone in the channel; confirm the exact message with the user first.",
		parameters: pinMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof pinMessageSchema.infer) {
			const token = (await readCredential()).access;
			const unpin = params.unpin === true;
			await discordVoid(
				`/channels/${encodeURIComponent(params.channelId)}/pins/${encodeURIComponent(params.messageId)}`,
				token,
				unpin ? "unpin message" : "pin message",
				{ method: unpin ? "DELETE" : "PUT" },
			);
			return {
				content: [{ type: "text" as const, text: `Message ${params.messageId} ${unpin ? "unpinned" : "pinned"}.` }],
			};
		},
	};
}

function createCreateChannelTool(): ToolDefinition<typeof createChannelSchema> {
	return {
		name: "discord_create_channel",
		label: "Discord: Create Channel",
		description:
			"Create a new channel in a Discord server — a text channel (default), voice channel, or category. MUTATING — this adds a visible channel to the server; confirm the server, name, and kind with the user first. Returns the new channel id.",
		parameters: createChannelSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof createChannelSchema.infer) {
			const token = (await readCredential()).access;
			const channelType = CHANNEL_KIND_TYPE[params.kind ?? "text"] ?? 0;
			const body: Record<string, unknown> = { name: params.name, type: channelType };
			if (params.topic) body.topic = params.topic;
			if (params.parentId) body.parent_id = params.parentId;
			const channel = await discordJson<Channel>(
				`/guilds/${encodeURIComponent(params.guildId)}/channels`,
				token,
				"create channel",
				jsonInit("POST", body),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Channel created (id ${channel.id}, name "${channel.name ?? params.name}").`,
					},
				],
			};
		},
	};
}

function createTimeoutMemberTool(): ToolDefinition<typeof timeoutMemberSchema> {
	return {
		name: "discord_timeout_member",
		label: "Discord: Timeout Member",
		description:
			'MODERATION. Time out (mute) a server member for up to 28 days, or lift an existing timeout (minutes 0 / clear:true). Requires the Moderate Members permission. NEVER call without EXPLICIT user confirmation of the EXACT member AND the duration in the current turn. Refuse on vague instructions like "mute the spammers".',
		parameters: timeoutMemberSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof timeoutMemberSchema.infer) {
			const token = (await readCredential()).access;
			const clearing = params.clear === true || params.minutes <= 0;
			const until = clearing
				? null
				: new Date(
						Date.now() + Math.min(Math.max(Math.floor(params.minutes), 1), MAX_TIMEOUT_MINUTES) * 60_000,
					).toISOString();
			await discordVoid(
				`/guilds/${encodeURIComponent(params.guildId)}/members/${encodeURIComponent(params.userId)}`,
				token,
				clearing ? "clear member timeout" : "timeout member",
				jsonInit("PATCH", { communication_disabled_until: until }),
			);
			const text = clearing
				? `Timeout lifted for member ${params.userId}.`
				: `Member ${params.userId} timed out until ${until}.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

/**
 * Discord plugin. A standard OMP plugin — `skills/`/`rules/` load via OMP's
 * native plugin discovery. This module registers the twelve REST tools; the
 * connect flow (fraym.plugin.json's `connect.form`) is what collects the bot
 * token these tools read.
 */
export default function discordExtension(pi: ExtensionAPI): void {
	pi.registerTool(createListGuildsTool());
	pi.registerTool(createListChannelsTool());
	pi.registerTool(createReadMessagesTool());
	pi.registerTool(createSendMessageTool());
	pi.registerTool(createCreateThreadTool());
	pi.registerTool(createReplyMessageTool());
	pi.registerTool(createAddReactionTool());
	pi.registerTool(createEditMessageTool());
	pi.registerTool(createDeleteMessageTool());
	pi.registerTool(createPinMessageTool());
	pi.registerTool(createCreateChannelTool());
	pi.registerTool(createTimeoutMemberTool());
}
