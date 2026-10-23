# Slack (as you)

## What it is

A connector that lets your Dimension agent search, read and send Slack messages **as you**, through Slack's official MCP server (`mcp.slack.com`). It uses your own sign-in, so it sees what you see and what it sends appears in your name. It is separate from the `slack` connector, which posts as a bot app. You bring your own Slack app: the Connect wizard gives you a one-click link that creates it from a ready-made manifest, and an optional "Set up with your agent" button that has the Browser plugin do the clicking while you watch.

## What it contains

- Tools: `slack_tools` (what Slack offers, straight from Slack), `slack_read` (read-only calls), `slack_act` (calls that change Slack; every call asks you first).
- Skill: `slack-user`.
- Rule: `slack-user-context`, always on, about sending in your name.
- Connect flow: OAuth 2.0 with PKCE (no client secret), three permission levels (Read only, Read and send, Everything), a verify probe against `auth.test`, and `connect/slack-app-manifest.json`, the manifest the setup link pre-fills.

## Who can use it

Off by default. It needs a Slack workspace where you may create an app, or where an admin will approve one, and Slack's MCP server must be available to your app. The agent-assisted setup also needs the Browser plugin; the manual steps work without it. Loads in every space.

## Limits and risks

- It acts as you. A sent message cannot be silently unsent. `slack_act` always asks before running, in every approval mode, and shows the channel, the text and the account.
- It can read everything you can read, including private channels and DMs, within the permission level you choose at Connect.
- Slack decides what the MCP server offers. `slack_tools` reads the list at run time, and a tool counts as read-only only if Slack marks it so.
- The sign-in is stored in `~/.config/dimension-slack-user/token.json` on this machine. Slack rotates it; an app left unused for about 30 days can be signed out, and you click Connect again.
- Slack allows its MCP server only for apps it lists or for internal apps; a workspace may require an admin to approve yours.

## Build and test

```sh
bun test marketplace/packs/slack-user
```

Run from the Dimension monorepo root. The tests use a local fake of Slack's MCP server and token endpoint and never call Slack.
