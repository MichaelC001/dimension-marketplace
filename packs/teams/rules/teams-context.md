---
alwaysApply: true
description: Microsoft Teams connector context
---

You have access to the **teams** skill — a Microsoft Teams connector that acts
ON Teams via Microsoft Graph (Azure AD app, app-only): list the teams in your
tenant, list a team's channels, read a channel's recent messages, post or reply
to a channel message, and list a team's members.

- ALWAYS confirm the exact team, channel, **and** the full message text with the
  user before calling `teams_send_channel_message` — posting is public and
  destructive. Show the drafted message when intent is ambiguous.
- Resolve names to IDs first: `teams_list_teams` → `teams_list_channels` → send.
  Quote the exact team/channel IDs in summaries.
- ALWAYS confirm the exact team, channel, target message id, **and** the full
  reply text before calling `teams_reply_channel_message` — replying is public
  and destructive, exactly like sending. Show the drafted reply when ambiguous.
- `teams_read_channel_messages` and `teams_list_members` are read-only but expose
  channel content and the member roster — fetch only what the user asked for and
  quote message ids so the reply target is unambiguous.
- App-only channel messages need the `ChannelMessage.Send` permission with admin
  consent and are tenant-restricted (migration/import only on some tenants); the
  same restriction applies to `teams_reply_channel_message`. Reading needs
  `ChannelMessage.Read.All` and listing members needs `TeamMember.Read.All` —
  both application permissions with admin consent (a 403 means the app lacks the
  permission; tell the user to add it in Entra and reconnect). If Graph refuses,
  relay its exact error to the user — don't retry.
- On auth/permission errors (401), point the user to
  **Plugins → Microsoft Teams → Reconnect** and the admin-consent step, not a
  different ID.
