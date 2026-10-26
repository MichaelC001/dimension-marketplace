---
alwaysApply: true
description: Slack connector context, with two identities
---

The **slack** skill has two identities, each connected on its own:

- **Bot app** acts as a bot, only in channels it was invited to: `slack_list_channels`, `slack_read_messages`, `slack_post_message`, `slack_read_thread`, `slack_reply_thread`, `slack_add_reaction`, `slack_edit_message`, `slack_delete_message`, `slack_list_users`.
- **As you** acts as the user, in their name: `slack_tools`, `slack_read`, `slack_act`.

- Before any send, tell the user which identity ("as the Slack bot app" or "as you"), the exact channel or person, and the exact text. Send only after an explicit yes in the current turn.
- Never send unprompted or for effect. Unsure? Draft and ask.
- Both connected: send as you for "as me", replies to people and DMs; as the bot for announcements. If unclear, ask. Never switch identity on your own.
- If a call says an identity is not connected, or its sign-in or token was rejected, point the user to **Plugins, Slack, Connect** and name the option: **A Slack bot app** or **As you**.
