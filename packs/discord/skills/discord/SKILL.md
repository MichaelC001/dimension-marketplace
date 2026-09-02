---
name: discord
description: List Discord servers and channels, read recent messages, and post messages to a channel via the Discord REST API (bot token). Use when the user asks to send/post a Discord message, summarize a channel, or list their servers/channels.
---

# Discord (REST API via bot token)

Act on Discord as a bot: enumerate the servers the bot is in, list a server's
channels, read a channel's recent messages, post/reply/edit/delete messages,
react, pin, spin up threads, create channels, and moderate members. All twelve
tools are plain Discord REST v10 calls authenticated with the bot token
collected by the Connect flow — no gateway/websocket, no SDK.

Tools:

- `discord_list_guilds` — servers the bot has joined (id + name per line).
- `discord_list_channels` — channels in a server (`guildId`); id, name, type.
- `discord_read_messages` — recent messages in a channel (`channelId`, optional
  `limit`, default 20, max 100); author, timestamp, content, newest first.
- `discord_send_message` — post text to a channel (`channelId`, `content`).
  **Destructive — confirm first (see Safety).**
- `discord_reply_message` — reply to a specific message (`channelId`,
  `messageId`, `content`). **Destructive — confirm first.**
- `discord_edit_message` — edit the content of the **bot's own** message
  (`channelId`, `messageId`, `content`). **Destructive — confirm first.**
- `discord_add_reaction` — react to a message as the bot (`channelId`,
  `messageId`, `emoji`).
- `discord_pin_message` — pin (or `unpin: true`) a message (`channelId`,
  `messageId`). **Confirm first.**
- `discord_create_thread` — start a thread in a channel (`channelId`, `name`,
  optional `messageId` to thread from a message). **Confirm first.**
- `discord_create_channel` — create a channel in a server (`guildId`, `name`,
  optional `kind`/`topic`/`parentId`). **Confirm first.**
- `discord_delete_message` — **moderation:** delete anyone's message
  (`channelId`, `messageId`). **Irreversible — confirm the exact target.**
- `discord_timeout_member` — **moderation:** mute a member (`guildId`,
  `userId`, `minutes`; `clear: true` lifts it). **Confirm the exact member and
  duration.**

## Setup

If a tool errors with "isn't connected yet" or a 401, the bot isn't set up.
Open **Plugins → Discord → Set up** and follow the wizard: create an
application in the Discord Developer Portal, add a Bot, **enable the Message
Content intent** (required to read message text), copy the bot token into the
form, then invite the bot to a server via OAuth2 → URL Generator (scope `bot`,
permissions: View Channels, Send Messages, Read Message History).

The bot only ever sees servers it has been invited to, and only the channels
where it has the View Channels permission.

## Usage patterns

Resolve ids top-down before acting — the agent rarely knows a raw channel id:

1. `discord_list_guilds` → pick the server id.
2. `discord_list_channels` with that `guildId` → pick the text channel id.
3. Read or send using that `channelId`.

Examples:

- "Summarize the last 20 messages in #dev" → list guilds → list channels → find
  the channel named `dev` → `discord_read_messages` with its id → summarize.
- "Post the release notes to #announcements" → resolve the channel id → confirm
  the exact text with the user → `discord_send_message`.
- "What servers is the bot in?" → `discord_list_guilds`.

Notes:

- Message content over 500 chars is truncated in read results; content sent has
  Discord's own 2000-char limit.
- If read messages show "(no text — embed/attachment only)" for normal
  messages, the **Message Content intent** is disabled — have the user enable it
  on the Bot tab.

## Threads & reactions

Resolve the `channelId` (and, when acting on a message, the `messageId` from
`discord_read_messages`) first, then:

- **Reply in context** — `discord_reply_message` posts a new message linked to
  the target (needs **Send Messages** + Read Message History). Confirm the
  channel, the message you're replying to, and the exact text first.
- **Edit a bot post** — `discord_edit_message` replaces the content of one of
  the **bot's own** messages (no extra permission; editing another user's
  message is impossible). Confirm the message and new text.
- **React** — `discord_add_reaction` adds an emoji as the bot (needs **Add
  Reactions** + Read Message History). Standard emoji use the character (👍);
  custom guild emoji use `name:id` (e.g. `partyblob:41771983429993937`).
- **Pin / unpin** — `discord_pin_message` (needs **Manage Messages**); pass
  `unpin: true` to remove a pin. Pins are visible to everyone — confirm first.
- **Threads** — `discord_create_thread` starts a public thread (needs **Create
  Public Threads**, or **Create Private Threads**); pass `messageId` to thread
  off an existing message, otherwise it's standalone. Confirm the name first.
- **Channels** — `discord_create_channel` adds a `text` (default), `voice`, or
  `category` channel to a server (needs **Manage Channels**); `parentId` nests
  it under a category. Confirm the server, name, and kind first.

## Moderation

Moderation tools act on OTHER people. NEVER call one on a vague instruction —
the user MUST name the exact target in the current turn, and you confirm it back
before acting.

- `discord_delete_message` — removes a message (needs **Manage Messages** to
  delete anyone's; own messages need none). **Irreversible.** Only after the
  user confirms the exact message (channel + message id, ideally its content):
  resolve the id via `discord_read_messages`, echo what you're about to delete,
  then call it. Refuse "clean up the channel" / "delete the spam" — get the id.
- `discord_timeout_member` — mutes a member for `minutes` (1–40320, i.e. up to
  28 days; clamped), or lifts an existing timeout with `minutes: 0` /
  `clear: true` (needs **Moderate Members**). Confirm the exact `userId` AND the
  duration before calling; refuse "mute the spammers" until the user names who.

**Not included:** listing a server's members. The Discord list-guild-members
endpoint requires the privileged **Server Members Intent**, which is off by
default and would force every user to flip an extra toggle — so this tool set
deliberately omits it. Resolve a `userId` from a message author instead (e.g.
via `discord_read_messages`).

## Safety

- NEVER call `discord_send_message` without explicit user confirmation of the
  **channel** and the **exact content** in the current turn — posts are public
  to the channel and cannot be unsent by these tools.
- Every mutating tool (`discord_reply_message`, `discord_edit_message`,
  `discord_pin_message`, `discord_create_thread`, `discord_create_channel`)
  needs the same up-front confirmation — a live server changes and there is no
  undo through these tools.
- Moderation tools (`discord_delete_message`, `discord_timeout_member`) are
  doubly guarded: the user MUST name the exact target (a specific message, a
  specific member) in the current turn. NEVER moderate on a vague instruction,
  and echo the target back before you act.
- Quote the channel id (and name) you acted on in every summary.
- A 401 / "invalid token" means the bot token is bad — direct the user to
  Plugins → Discord → Reconnect.
