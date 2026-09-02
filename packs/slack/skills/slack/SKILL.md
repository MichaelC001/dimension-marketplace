---
name: slack
description: List channels and users, read channel history and threads, post/reply/edit/delete messages, and add reactions in a Slack workspace via the Slack Web API. Use when the user asks to send or manage a Slack message, reply in a thread, react, summarize or search a channel, or find a user.
---

# Slack (Web API connector)

Act on the user's Slack workspace through nine tools backed by the Slack Web API
(a bot token, `xoxb-…`). This is an **outbound** connector — the agent lists
channels and users, reads history and threads, posts/replies/edits/deletes
messages, and adds reactions; it is not an inbound bot that responds to Slack
events.

The bot only sees channels it has been **invited** to. If a channel is missing
or a read/post fails, ask the user to `/invite` the bot into that channel.

## Setup

Not connected yet? Open **Plugins → Slack → Set up** and follow the wizard:
create a Slack app, add the bot scopes (`channels:read`, `groups:read`,
`channels:history`, `groups:history`, `chat:write`), install it to the
workspace, and paste the **Bot User OAuth Token**. On an auth error, use
**Plugins → Slack → Reconnect**.

**Scopes for the extra tools:** the reaction and user tools need scopes beyond
the v1 set — add `reactions:write` (for `slack_add_reaction`) and `users:read`
(for `slack_list_users`) under **OAuth & Permissions → Bot Token Scopes**, then
**reinstall the app**. If a call fails with `missing_scope`, that's the fix.

## Tools

- `slack_list_channels` — public + private channels the bot can see. Returns
  `id  #name  — topic` per line. Large workspaces paginate: pass the printed
  `next cursor` back as `cursor` to fetch the next page.
- `slack_read_messages` — recent messages in a channel (most-recent first).
  Returns `ts  user  text` per line. **`ts` is the message id** — quote it when
  referencing a specific message. Takes `channel` (id) and optional `limit`.
- `slack_post_message` — post to a channel. Takes `channel` (id or `#name`) and
  `text` (Slack mrkdwn). **Sends a real, visible message.**
- `slack_read_thread` — replies in a thread (oldest first). Takes `channel`,
  `threadTs` (the parent message's `ts`), optional `limit`. Returns
  `ts  user  text` per line; the first line is the parent.
- `slack_reply_thread` — reply under a thread. Takes `channel`, `threadTs`, and
  `text`. **Sends a real, visible message.**
- `slack_add_reaction` — react to a message. Takes `channel`, `messageTs`, and
  `emoji` (name **without** colons, e.g. `thumbsup`). Needs `reactions:write`.
- `slack_edit_message` — edit a message. Takes `channel`, `messageTs`, `text`.
  **Only works on messages the bot itself posted** (`chat.update`). Replaces the
  text entirely.
- `slack_delete_message` — delete a message. Takes `channel`, `messageTs`.
  **Irreversible.** Own messages only, unless the token has admin scopes.
- `slack_list_users` — workspace members. Returns `id  @name  real name` per
  line (deleted accounts and bots flagged in `[…]`). Takes optional `limit` and
  `cursor`. Needs `users:read`.

## Usage patterns

- "Message #general …" → `slack_list_channels` to resolve `#general` → its id,
  then `slack_post_message`.
- "Summarize #incidents" → `slack_read_messages` with that channel id, then
  summarize the returned lines.
- "Find where X was shared" → `slack_read_messages`, scan the text, quote the
  `ts` of the match.
- "Reply in the thread about X" → `slack_read_messages` (or `slack_read_thread`
  if you have the parent `ts`) to find the thread's parent `ts`, then
  `slack_reply_thread` with that `threadTs`.
- "React 👍 to that message" → `slack_add_reaction` with the message `ts` and
  `emoji: thumbsup` (no colons).
- "Fix the typo in what you posted" → `slack_edit_message` with the bot's own
  message `ts` and the corrected `text`.
- "Who is @alice?" → `slack_list_users`, scan for the `@name` / real name.

## Threads & reactions

- A **thread** hangs off a parent message. Its `ts` (from `slack_read_messages`)
  is the `threadTs` for both `slack_read_thread` and `slack_reply_thread`.
  `slack_read_thread` returns the parent first, then replies oldest-first.
- **Reactions** take an emoji **name without colons** — `thumbsup`,
  `white_check_mark`, `eyes` — not `:thumbsup:`. The tool strips stray colons
  defensively, but pass the bare name.
- `slack_edit_message` and `slack_delete_message` operate through `chat.update` /
  `chat.delete`, which by default only touch **messages the bot itself posted**.
  Editing/deleting another user's message needs admin scopes on the token.

## Safety

- **Confirm the exact channel and message text with the user before every
  message-sending call** (`slack_post_message`, `slack_reply_thread`). A post is
  public to the channel and cannot be silently undone.
- **Before `slack_edit_message`, confirm the exact channel, message `ts`, and the
  new text** — the edit replaces the original entirely and only works on the
  bot's own messages.
- **`slack_delete_message` is IRREVERSIBLE.** Confirm the EXACT channel and
  message `ts` with the user, and that they accept it cannot be recovered, before
  calling. Never delete a message you are unsure about.
- Resolve channel names to ids with `slack_list_channels` rather than guessing —
  posting to the wrong channel is the common mistake.
- The Web API returns HTTP 200 even on failure (`{"ok":false,"error":"…"}`); the
  tools already surface the Slack error string — read it (e.g. `not_in_channel`,
  `missing_scope`) to decide the fix.
