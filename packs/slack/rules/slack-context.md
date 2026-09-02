---
alwaysApply: true
description: Slack connector context
---

You have access to the **slack** skill — a Slack Web API connector with nine
tools: `slack_list_channels`, `slack_read_messages`, `slack_post_message`,
`slack_read_thread`, `slack_reply_thread`, `slack_add_reaction`,
`slack_edit_message`, `slack_delete_message`, and `slack_list_users`. The bot
acts only in channels it has been invited to (`/invite`).

- **Always confirm the recipient channel AND the message text with the user
  before any message-sending call** (`slack_post_message`, `slack_reply_thread`)
  — it sends a real message visible to the whole channel.
- **Before `slack_edit_message`, confirm the channel, message `ts`, and new
  text** — it replaces the original and only works on the bot's own messages.
- **`slack_delete_message` is IRREVERSIBLE** — confirm the EXACT channel and
  message `ts`, and that the user accepts it cannot be undone, before calling.
- `slack_add_reaction` takes an emoji name WITHOUT colons (e.g. `thumbsup`).
- Resolve `#channel-name` to a channel id with `slack_list_channels` before
  reading or posting; don't guess ids.
- `ts` is the message id — quote it exactly when referencing a message.
- On an auth error (`invalid_auth`, `token_revoked`, `not_authed`), point the
  user to **Plugins → Slack → Reconnect**. On `missing_scope`, they need to add
  the bot scope and reinstall the app — `slack_add_reaction` needs
  `reactions:write` and `slack_list_users` needs `users:read` (both beyond the
  v1 scopes).
