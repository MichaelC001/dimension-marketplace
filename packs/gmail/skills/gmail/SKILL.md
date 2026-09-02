---
name: gmail
description: Read, search, compose, reply to, and organize Gmail (or any IMAP/SMTP mailbox) using the himalaya CLI. Use when the user asks to check, find, summarize, draft, reply to, or send email.
prerequisites:
  commands: [himalaya]
---

# Gmail (IMAP/SMTP via himalaya)

Operate the user's mailbox with the `himalaya` CLI through the bash tool. The
skill is provider-agnostic IMAP/SMTP; Gmail is the primary target. Gmail
**labels appear as folders** in himalaya (e.g. `INBOX`, `[Gmail]/Sent Mail`,
`[Gmail]/All Mail`, plus any custom label).

References (load on demand):

- `references/configuration.md` — account/auth setup, the Gmail `config.toml`, and the App Password steps.
- `references/composition.md` — MML compose syntax for attachments and rich (HTML) messages; **read this before hand-building any reply template** — it covers the `References`-header and exact-subject threading traps.
- `references/gotchas.md` — dated log of real send/threading incidents and their fixes.

## Setup

Confirm the CLI is present and configured:

```bash
himalaya --version
himalaya envelope list
```

If `himalaya envelope list` errors (no config, auth failure, or "account not
found"), the mailbox is not set up yet — walk the user through
`references/configuration.md` (Gmail uses an **App Password**, ~2 minutes, no
Google Cloud project). Never paste secrets into chat; use a keyring or
`backend.auth.cmd`.

## Read / search

```bash
himalaya folder list                                  # Gmail labels show as folders
himalaya envelope list                                # recent mail in INBOX
himalaya envelope list --page-size 5                  # cap the count
himalaya envelope list from gmail.com subject invoice # filter by query terms
himalaya message read <id>                            # full message body
```

Map common email intents to himalaya query args:

- "from X" → `from <addr-or-domain>`
- "about / subject Y" → `subject <text>`
- "unread" → `not flag seen` (or `flag unseen`, version-dependent — see Safety)
- a different label/folder → `himalaya envelope list --folder "[Gmail]/Sent Mail"`

Quote the exact message `<id>` (and folder) so follow-up actions are
unambiguous.

## Compose / reply / forward

```bash
himalaya message write                                # opens $EDITOR with a template
himalaya message write -H "To:bob@example.com" -H "Subject:Hi" "Body here"
himalaya message reply <id>                           # quoted reply
himalaya message reply <id> --all                     # reply-all
himalaya message forward <id>
himalaya template write                               # produce a template to edit/save
himalaya template send < /tmp/message.txt             # send a prepared template from stdin
```

For attachments, inline images, or HTML, build an MML message — read
`references/composition.md` first.

## Organize

```bash
himalaya message move <id> <folder>                   # e.g. move <id> "[Gmail]/Trash"
himalaya message copy <id> <folder>
himalaya message delete <id>
himalaya flag add <id> --flag seen                    # mark read
himalaya flag remove <id> --flag seen                 # mark unread
```

## Safety

- NEVER `send`, `delete`, or bulk-`move` without explicit user confirmation **in
  the current turn**. When intent is ambiguous, prefer a draft/template the user
  can review.
- Quote exact message IDs (and folders) in every summary so actions are
  traceable.
- Use `--account <name>` when more than one account is configured.
- Subcommands are stable across himalaya versions, but **flags are
  version-dependent**. If a flag is rejected, run `himalaya <subcommand> --help`
  and adapt — the commands above are guidance, not a hard contract.
