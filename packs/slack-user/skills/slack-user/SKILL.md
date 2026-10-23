---
name: slack-user
description: Search Slack, read channels, threads and DMs, and send, schedule or react as the signed-in user through Slack's official MCP server. Use when the user wants Slack read or sent in their own name ("check my Slack", "reply to Priya", "what did we decide in #launch"), not as a bot.
---

# Slack (as you)

Slack's official MCP server (`https://mcp.slack.com/mcp`) with the user's own sign-in. Whatever
the user can see in Slack, this can read. Whatever it sends appears **as the user**.

Do not confuse it with the **slack** connector: that one posts as a bot app, and only in
channels the bot was invited to. Use this one when the message should come from the user.

## Tools

- `slack_tools` — lists what Slack offers right now, each marked `[read]` or `[write]`.
  Pass `tool: "<name>"` for one tool's full description and argument schema.
  Add `refresh: true` to re-fetch after Slack ships something new.
- `slack_read` — runs a `[read]` tool: search messages, files, users and channels, read a
  channel or thread, read a canvas or list. Refuses anything not marked `[read]`.
- `slack_act` — runs a `[write]` tool: send, schedule or draft a message, add a reaction,
  create a channel, canvas or list entry, upload a file. The user is asked to approve every call.

Both call tools take `{ tool, arguments }`. Slack defines the tools and their arguments;
this skill deliberately does not copy them, because they change.

## Workflow

1. `slack_tools` once per task. Read the schema of the tool you will use before calling it.
2. Resolve names to ids with a read tool (a channel from its name, a person from a name or
   email). Never guess an id.
3. Read with `slack_read`. Page through long results with the cursor Slack returns.
4. To send: show the user the exact channel (or person) and the exact text, wait for an
   explicit yes in the current turn, then `slack_act`. The approval card repeats what goes out.
5. Quote message links or timestamps when you refer to a specific message.

## Safety

- It sends in the user's name, to real people. Never send unprompted, never as a test, never
  more than was approved. A reply in a thread, a draft and a reaction count as sends.
- Private channels and DMs are readable. Use what the task needs and do not carry it elsewhere.
- Deleting or editing a message is not offered unless Slack's tool list includes it; if it
  does, treat it as irreversible and confirm the exact message first.

## Setup and sign-in

Not connected? **Plugins, Slack (as you), Connect.** The wizard can open a session where an agent
creates the Slack app for the user through the Browser plugin, or the user follows the same steps
by hand: one link opens Slack's Create an app screen with Dimension's manifest prefilled, then they
paste the app's Client ID and click Allow. No client secret is needed.

- **Read only / Read and send / Everything** is chosen at Connect. A call failing for a missing
  scope means the connection is narrower than the task: reconnect and pick a wider one.
- **403 from Slack** usually means the workspace has not approved the app, or the app's
  Agents, Slack MCP Server switch is off. An admin fixes the first; the app settings page the second.
- **Signed out** (revoked, or unused for about 30 days): Connect again.
- The token lives on this machine only, in `~/.config/dimension-slack-user/token.json`.
