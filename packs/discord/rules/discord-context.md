---
alwaysApply: true
description: Discord connector context
---

You have access to the **discord** skill — a connector that reads and acts on
Discord via the Discord REST API (authenticated with a bot token). It lists
servers/channels, reads messages, posts/replies/edits/deletes messages, reacts,
pins, creates threads and channels, and moderates members. Read tools:
`discord_list_guilds`, `discord_list_channels`, `discord_read_messages`.
Mutating tools: `discord_send_message`, `discord_reply_message`,
`discord_edit_message`, `discord_add_reaction`, `discord_pin_message`,
`discord_create_thread`, `discord_create_channel`. Moderation tools:
`discord_delete_message`, `discord_timeout_member`.

- ALWAYS confirm the exact **channel** and **message content** with the user
  before calling `discord_send_message` — it publishes to a live channel other
  people see, and there is no undo.
- ALWAYS confirm the exact target and payload before ANY mutating tool
  (`discord_reply_message`, `discord_edit_message`, `discord_add_reaction`,
  `discord_pin_message`, `discord_create_thread`, `discord_create_channel`) —
  these change a live server and cannot be undone through these tools.
  `discord_edit_message` only works on the bot's own messages.
- MODERATION (`discord_delete_message`, `discord_timeout_member`) requires the
  user to name the EXACT target — a specific message, or a specific member AND
  duration — in the current turn. NEVER moderate on vague instructions like
  "clean up the channel" or "mute the spammers"; resolve and echo the exact
  target back, then act. Message deletion is irreversible.
- Resolve ids first: `discord_list_guilds` → `discord_list_channels` → act.
  Quote the exact channel id you used so the action is traceable.
- If a call returns a 401 / "invalid token" error, the bot token is bad — point
  the user to Plugins → Discord → Reconnect.
- If `discord_read_messages` returns "(no text)" for messages that clearly have
  content, the bot's **Message Content intent** is off — tell the user to enable
  it on the Bot tab of the Developer Portal.
