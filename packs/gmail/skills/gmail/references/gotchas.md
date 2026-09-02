# Gotchas — gmail skill

Append-only log of real send/threading incidents and their fixes. The fix
lives in `composition.md`/`SKILL.md` where it's promoted into the default
workflow — entries here are breadcrumbs for WHY that guidance exists.

**Format:**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix. See <promoted-ref> for the full pattern.
Context: <what the task was>.
```

---

### 2026-07-02 — a hand-built reply template landed as a NEW Gmail conversation, not in the thread
Symptom → user reported "I don't see it in that thread" after a reply sent successfully (confirmed present in Sent/`[Gmail]/Sent Mail`, correct `In-Reply-To`, correct recipients). Cause → two silent threading breaks in the same message: (1) the raw template only set `In-Reply-To`, never `References` — Gmail's own conversation view folds a reply into its thread by matching the `References` chain, not just `In-Reply-To` + subject; (2) the original subject contained an en-dash (`–`) that got flattened to a plain hyphen (`-`) when retyped from a rendered header/table view, breaking Gmail's exact-subject thread match too. Fix → always set `References` = original's `References` + original's `Message-Id`, space-separated; always pull `Subject` via `himalaya message read <id> -H Subject` (never retype from a table) and reuse it byte-for-byte. See [composition.md § Replying with a hand-built template](composition.md#replying-with-a-hand-built-template-threading-correctly).
Context: replying to a multi-message business thread (OPC company registration) with attachments, composed as a raw MML template + `template send` rather than the interactive `message reply` editor flow (needed to attach files pulled from the Locker without a human at an editor).

### 2026-07-02 — `himalaya message delete` fails on Gmail: no folder named "Trash"
Symptom → `himalaya message delete <id> -f "[Gmail]/Drafts"` → `unexpected NO response: No folder Trash`. Cause → the command's default move-to-trash target is the literal name `Trash`; Gmail's trash folder is `[Gmail]/Trash`, and there's no flag to override the target folder name on `message delete` in the installed version. Fix → `himalaya flag add <id> -f <folder> deleted` instead — sets the `\Deleted` flag directly, works regardless of trash-folder naming, and Gmail purges flagged messages on its own schedule. Run `himalaya folder list` first if a folder name is ever assumed rather than confirmed (Gmail's Drafts is `[Gmail]/Drafts`, not `Drafts`, for the same reason).
Context: cleaning up a stale draft after sending a corrected version of the same reply directly instead.

## Append-only rules

1. Promote the fix into `composition.md`/`SKILL.md` BEFORE appending here — this file is the breadcrumb, not the source of truth.
2. Use absolute dates. Never relative.
3. One entry per discrete learning.
4. Never edit existing entries — supersede with a new dated entry instead.
