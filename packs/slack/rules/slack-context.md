---
alwaysApply: true
description: Slack connector context, with two identities
---

You have access to the **slack** skill. Slack can act as two different identities, and
each is connected on its own, so one or both may be available:

- **The Slack bot app** acts as a bot, only in channels it has been invited to
  (`/invite`). Its tools: `slack_list_channels`, `slack_read_messages`,
  `slack_post_message`, `slack_read_thread`, `slack_reply_thread`,
  `slack_add_reaction`, `slack_edit_message`, `slack_delete_message` and
  `slack_list_users`. Everything it sends appears as the bot.
- **As you** acts as the user, in their own name, through Slack's official MCP server.
  Its tools: `slack_tools` (what Slack offers, from Slack itself), `slack_read`
  (read-only calls) and `slack_act` (anything that changes Slack). Everything it sends
  appears as the user, and it can read whatever the user can read.

**Which identity a call acts as**

- A `slack_*` tool from the bot list above acts as the bot. `slack_tools`, `slack_read`
  and `slack_act` act as the user. Never describe one as the other.
- Every message-sending call names its identity in the confirmation. Tell the user
  "as the Slack bot app" or "as you" together with the exact channel (or person) and
  the exact text, and get an explicit yes in the current turn before sending. The
  approval card repeats the identity on its `As:` line.

**Choosing when both are connected**

- Send as the user when they say "as me", "from me", or ask you to reply to a person
  or in a DM. Send as the bot for announcements and automated notices.
- If the identity for a send is not clear from the request, ask which one before you
  draft. Never pick for them, and never fall back to the other identity when one fails.
- For reading, use as you for search, DMs and private channels, and the bot for a
  channel it is already in.
- If only one is connected, use it and say which identity the message goes out as.

**Sending safely**

- Always confirm the recipient AND the message text before any send: `slack_post_message`,
  `slack_reply_thread` and `slack_act`. Drafts, threads and replies count as sends.
- Never send unprompted, never send for effect. No test pings, no "just checking", no
  replies the user did not ask for. When unsure whether to send, draft and ask.
- Before `slack_edit_message`, confirm the channel, message `ts` and new text. It only
  works on the bot's own messages.
- `slack_delete_message` is IRREVERSIBLE. Confirm the exact channel and message `ts`,
  and that the user accepts it cannot be undone, before calling.
- Read quietly as the user. Reading and searching is private to them: quote only what
  the task needs, and do not repeat private channel or DM content anywhere else.
- Call `slack_tools` first before using `slack_read` or `slack_act`. The tool set and
  every argument schema come from Slack and can change; never guess a tool name.
- Resolve a channel or person to an id before acting on it (`slack_list_channels` for
  the bot, a read tool as the user). `ts` is the message id: quote it exactly.
- `slack_add_reaction` takes an emoji name WITHOUT colons (for example `thumbsup`).

**Auth errors and missing connections**

- When a call says an identity is not connected, or its sign-in or token was rejected
  (`invalid_auth`, `token_revoked`, `not_authed`, or a sign-in error), point the user
  to **Plugins, Slack, Connect** and name the right option: **A Slack bot app** for the
  bot tools, **As you** for `slack_tools`, `slack_read` and `slack_act`.
- `missing_scope` on a bot tool: they add the bot scope and reinstall the app.
  `slack_add_reaction` needs `reactions:write` and `slack_list_users` needs
  `users:read`. For as you, the permission level chosen at Connect is narrower than the
  task: they connect again and choose a wider one (Everything adds canvases, lists,
  files and channels).
