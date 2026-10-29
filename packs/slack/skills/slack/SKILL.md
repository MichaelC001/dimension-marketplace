---
name: slack
description: Read and send Slack messages as a bot app or as the signed-in user. Use when the user asks to check, search, summarize, post, send, reply, react or edit in Slack, and choose the identity from who the message should come from.
---

# Slack (bot app and as you)

Slack can act as one of two identities. Each is connected on its own under
**Plugins, Slack, Connect**, so one or both may be connected:

| | A Slack bot app | As you |
| --- | --- | --- |
| Tools | `slack_list_channels`, `slack_read_messages`, `slack_post_message`, `slack_read_thread`, `slack_reply_thread`, `slack_add_reaction`, `slack_edit_message`, `slack_delete_message`, `slack_list_users` | `slack_tools`, `slack_read`, `slack_act` |
| Sends as | the bot app, a separate Slack user | the user, in their own name |
| Can see | only the channels the bot was invited to | whatever the user can see, including private channels and DMs |
| Connect with | **Plugins, Slack, Connect, A Slack bot app** | **Plugins, Slack, Connect, As you** |

## Choosing the identity

- Words like "as me", "from me", "reply to Priya", "my DMs", "check my Slack" or a
  search across the workspace mean **as you**.
- Words like "post an announcement", "notify #deploys" or a message the user wants to
  come from the bot mean **the bot app**.
- Only one is connected: use it and say which identity the message will go out as.
- Never retry a send as the other identity when one fails, and never describe one
  identity's tool as the other's.
- Both are connected and the identity of a **send** is not clear from the request: ask
  which one, naming both, before drafting anything. Do not guess.
- Both are connected and the task is only reading: use **as you** for search, DMs and
  private channels, and the bot app for a channel it is already in. Either is fine
  when both can see it.
- A call that says Slack is not connected, or that its sign-in or token was rejected
  (`invalid_auth`, `token_revoked`, `not_authed`, or a sign-in error), names the
  Connect path to point the user to. Give that path as written. If the user wants the
  other identity, point them to the other Connect option instead.

Every message-sending call names the identity in its confirmation. Before any send,
show the user the exact channel (or person), the exact text, and who it sends as
("as the Slack bot app" or "as you"), then wait for an explicit yes in the current turn.
The approval card repeats the identity on its `As:` line.

## A Slack bot app

Nine tools backed by the Slack Web API with a bot token (`xoxb-...`). This is an
**outbound** connector: the agent lists channels and users, reads history and
threads, posts, replies, edits and deletes messages, and adds reactions. It is not an
inbound bot that responds to Slack events.

The bot only sees channels it has been **invited** to. If a channel is missing or a
read or post fails, ask the user to `/invite` the bot into that channel.

**Setup.** Open **Plugins, Slack, Connect, A Slack bot app** and follow the steps:
create a Slack app, add the bot scopes (`channels:read`, `groups:read`,
`channels:history`, `groups:history`, `chat:write`), install it to the workspace, and
paste the **Bot User OAuth Token**. On an auth error, connect again from the same place.

**Scopes for the extra tools.** The reaction and user tools need scopes beyond the
first set: add `reactions:write` (for `slack_add_reaction`) and `users:read` (for
`slack_list_users`) under **OAuth & Permissions, Bot Token Scopes**, then
**reinstall the app**. If a call fails with `missing_scope`, that is the fix.

### Bot tools

- `slack_list_channels`: public and private channels the bot can see. Returns
  `id  #name  - topic` per line. Large workspaces paginate: pass the printed
  `next cursor` back as `cursor` to fetch the next page.
- `slack_read_messages`: recent messages in a channel, most recent first. Returns
  `ts  user  text` per line. **`ts` is the message id**: quote it exactly when
  referencing a specific message. Takes `channel` (id) and optional `limit`.
- `slack_post_message`: post to a channel. Takes `channel` (id or `#name`) and `text`
  (Slack mrkdwn). **Sends a real, visible message as the bot.**
- `slack_read_thread`: replies in a thread, oldest first. Takes `channel`, `threadTs`
  (the parent message's `ts`) and optional `limit`. The first line is the parent.
- `slack_reply_thread`: reply under a thread. Takes `channel`, `threadTs` and `text`.
  **Sends a real, visible message as the bot.**
- `slack_add_reaction`: react to a message. Takes `channel`, `messageTs` and `emoji`
  (the name **without** colons, for example `thumbsup`). Needs `reactions:write`.
- `slack_edit_message`: edit a message. Takes `channel`, `messageTs` and `text`. **Only
  works on messages the bot itself posted** (`chat.update`). Replaces the text entirely.
- `slack_delete_message`: delete a message. Takes `channel` and `messageTs`.
  **Irreversible.** Own messages only, unless the token has admin scopes.
- `slack_list_users`: workspace members. Returns `id  @name  real name` per line, with
  deleted accounts and bots flagged in `[...]`. Takes optional `limit` and `cursor`.
  Needs `users:read`.

### Bot usage patterns

- "Message #general ..." -> `slack_list_channels` to resolve `#general` to its id, then
  `slack_post_message`.
- "Summarize #incidents" -> `slack_read_messages` with that channel id, then summarize.
- "Find where X was shared" -> `slack_read_messages`, scan the text, quote the `ts`.
- "Reply in the thread about X" -> `slack_read_messages` (or `slack_read_thread` if you
  have the parent `ts`) to find the parent `ts`, then `slack_reply_thread`.
- "React with a thumbs up to that message" -> `slack_add_reaction` with the message
  `ts` and `emoji: thumbsup`.
- "Fix the typo in what you posted" -> `slack_edit_message` with the bot's own message
  `ts` and the corrected `text`.
- "Who is @alice?" -> `slack_list_users`, scan for the `@name` or real name.

A **thread** hangs off a parent message. Its `ts` (from `slack_read_messages`) is the
`threadTs` for both `slack_read_thread` and `slack_reply_thread`. Editing or deleting
another person's message needs admin scopes on the token.

## As you

Slack's official MCP server (`https://mcp.slack.com/mcp`) with the user's own
sign-in. Whatever the user can see in Slack, this can read. Whatever it sends appears
**as the user**.

- `slack_tools`: lists what Slack offers right now, each marked `[read]` or `[write]`.
  Pass `tool: "<name>"` for one tool's full description and argument schema. Add
  `refresh: true` to re-fetch after Slack ships something new.
- `slack_read`: runs a `[read]` tool: search messages, files, users and channels, read
  a channel or thread, read a canvas or list. Refuses anything not marked `[read]`.
- `slack_act`: runs a `[write]` tool: send, schedule or draft a message, add a
  reaction, create a channel, canvas or list entry, upload a file. The user is asked
  to approve every call.

Both call tools take `{ tool, arguments }`. Slack defines the tools and their
arguments, and this skill does not copy them because they change.

`slack_send_message` and `slack_schedule_message` go straight to Slack's Web API with the
user's sign-in instead of through the MCP server, so the message appears exactly as
written, with no "Sent using" footer. Call them as `slack_tools` describes them. They
refuse `draft_id` (send without it, or leave the draft for the user to send from Slack),
any argument Slack's schema does not list, and channels shared outside the workspace
(Slack Connect). A user id works as `channel_id` for a direct message.

### As-you workflow

1. `slack_tools` once per task. Read the schema of the tool you will use first. The
   tool set and every argument schema come from Slack and can change, so never guess a
   tool name or an argument.
2. Resolve names to ids with a read tool (a channel from its name, a person from a
   name or email). Never guess an id.
3. Read with `slack_read`. Page through long results with the cursor Slack returns.
4. To send: show the exact channel (or person) and the exact text, say it sends as the
   user, wait for an explicit yes in the current turn, then `slack_act`.
5. Quote message links or timestamps when you refer to a specific message.

### As-you setup and sign-in

Not connected? **Plugins, Slack, Connect, As you.** The steps can open a session where an
agent creates the Slack app for the user through the Browser plugin, or the user
follows the same steps by hand: one link opens Slack's Create an app screen with
Dimension's manifest filled in, then they paste the app's Client ID and click Allow.
No client secret is needed.

- **Read only, Read and send, Everything** is chosen at Connect. A call failing for a
  missing scope means the connection is narrower than the task: reconnect and pick a
  wider one (Everything adds canvases, lists, files and channels).
- **403 from Slack** usually means the workspace has not approved the app, or the app's
  Agents, Slack MCP Server switch is off. An admin fixes the first; the app settings
  page the second.
- **Signed out** (revoked, or unused for about 30 days): connect again.
- The token lives on this machine only, in `~/.config/dimension-slack-user/token.json`.
  The bot token lives in `~/.config/dimension-slack/token.json`.

## Safety

- **Confirm the exact channel, the exact text and the identity with the user before
  every message-sending call**: `slack_post_message`, `slack_reply_thread` and
  `slack_act`. A post is visible to the channel and cannot be silently undone. A reply
  in a thread and a draft are sends, and as you so is a reaction: each needs the user's
  yes in the conversation. `slack_act` also asks for approval itself on every call. The
  bot's `slack_add_reaction` is not prompted in write and yolo mode, but it is still a
  visible mark under the bot's name, so confirm the channel, the message and the emoji
  first.
- **Before `slack_edit_message`, confirm the exact channel, message `ts` and the new
  text.** The edit replaces the original and only works on the bot's own messages.
- **`slack_delete_message` is irreversible.** Confirm the exact channel and message `ts`
  with the user, and that they accept it cannot be recovered, before calling. Deleting
  or editing as the user is not offered unless Slack's tool list includes it; if it
  does, treat it as irreversible and confirm the exact message first.
- **Never send unprompted or for effect, as either identity.** No test pings, no "just
  checking", no replies the user did not ask for, and never more than was approved.
  When unsure whether to send, draft and ask. As you sends in the user's name, to real
  people.
- Private channels and DMs are readable as you. Reading and searching is private to the
  user: quote only what the task needs, and do not repeat private channel or DM content
  anywhere else.
- Resolve channel names to ids with `slack_list_channels` (bot) or a read tool (as
  you) rather than guessing. Posting to the wrong channel is the common mistake.
- The Web API returns HTTP 200 even on failure (`{"ok":false,"error":"..."}`). The bot
  tools already surface the Slack error string: read it (for example `not_in_channel`
  or `missing_scope`) to decide the fix.
