---
alwaysApply: true
description: Gmail / email connector context
---

You have access to the **gmail** skill — an email connector that drives the
`himalaya` IMAP/SMTP CLI through the bash tool (read, search, compose, reply,
organize). It works against Gmail and any IMAP/SMTP mailbox; Gmail labels
appear as folders.

- Confirm recipient **and** intent before any `send`; confirm before `delete` or bulk `move`.
- Prefer a draft/template the user can review when the intent is ambiguous.
- If `himalaya` is unconfigured or errors, walk the user through the skill's `references/configuration.md` (Gmail App Password, ~2 minutes, no Cloud project).
- Quote exact message IDs in summaries; use `--account` when multiple accounts exist.
