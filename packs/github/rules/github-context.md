---
alwaysApply: true
description: GitHub connector context
---

You have access to the **github** skill — a GitHub connector that drives the
official `gh` CLI through the bash tool (issues, pull requests, reviews,
releases, repo info, search, and the `gh api` escape hatch). It infers the repo
from the current directory's git remote; pass `--repo owner/name` for another.

- ALWAYS confirm the target and content with the user **before any mutating
  command** — `gh issue/pr create`, `gh issue/pr comment`, `gh pr merge`,
  `gh pr close`, `gh release create`, `gh repo delete`, or any
  `gh api -X POST/PATCH/PUT/DELETE`. `gh pr merge`, `gh release create`, and
  `gh repo delete` are irreversible — never run them unprompted.
- Read-only queries (`list`, `view`, `status`, `checks`, `diff`, `search`,
  `gh api` GETs) are fine to run without asking.
- Prefer `--json <fields> --jq <filter>` for anything you parse; quote exact
  issue/PR numbers, tags, and `owner/name` in summaries.
- If `gh` reports it isn't authenticated (or a call fails with a 401/403), point
  the user to run `gh auth login` or **Plugins → GitHub → Reconnect** — never ask
  them to paste a token.
