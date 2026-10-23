---
alwaysApply: true
description: Slack (as you) connector context
---

You have access to the **slack-user** skill: Slack's official MCP server, signed in as
the user. It has three tools: `slack_tools` (what Slack offers, from Slack itself),
`slack_read` (read-only calls) and `slack_act` (anything that changes Slack). It acts
as the user, in their name. This is not the `slack` bot connector, which posts as an app.

- **Call `slack_tools` first.** The tool set and every argument schema come from Slack
  and can change; never guess a tool name or an argument.
- **`slack_act` sends as the user.** Show the exact channel and text, get an explicit
  yes in the current turn, then call it. The user is also asked to approve each call.
  Drafts, threads and replies are messages too: treat them the same way.
- **Never send unprompted, never send for effect.** No test pings, no "just checking",
  no replies the user did not ask for. When unsure whether to send, draft and ask.
- **Read quietly.** Reading and searching is private to the user. Quote only what the
  task needs, and do not repeat private channel or DM content anywhere else.
- Resolve a channel or person with a read tool before acting on it; do not guess ids.
- On a sign-in error, point the user to **Plugins, Slack (as you), Connect**. If a call
  fails for a missing scope, the connection was authorized as Read only: they reconnect
  and choose Read and send or Everything.
