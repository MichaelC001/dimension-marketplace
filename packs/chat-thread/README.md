# Chat Thread

## What it is

The Chat space's conversation and nothing else: your words, the assistant's words, and one quiet "Worked for" line per turn. It is built from the kit's `StoreThread` part, with no tool rows except a card for a file the assistant shows you, and no shipped thread inside.

## What it contains

One component, `chat-thread`, filling the `thread` slot (`dist/index.mjs`). No tools, skills, prompts or rules.

## Who can use it

Anyone on the canary release ring for now (`"channel": "canary"`; hidden on stable until the Chat set is promoted with 0.11.16), on by default. It loads in the Chat space, which requires it, as the space's `thread` section.

## Limits and risks

- It hides tool activity by design: what the agent ran is summarised as the "Worked for" line, not listed, apart from a card for a file the assistant shows you.
- It shows the conversation the host gives it and holds no data of its own.

## Build and test

```
bun run build   # vite build -> dist/index.mjs (committed: the host loads the built bundle)
```

This pack has no tests of its own.
