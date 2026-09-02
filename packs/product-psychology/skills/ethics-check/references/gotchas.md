# Gotchas — ethics-check skill

Append-only LOG of one-off learnings from real runs. Each entry is 1–3 lines. The fix lives in the promoted reference — entries here are breadcrumbs.

**Format:**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix. See [<promoted-ref>#<anchor>](<promoted-ref>#<anchor>) for the full pattern.
Context: <what you were doing + asset / mode / trigger>.
```

---

### 2026-07-04 — Blocking without a rewrite is an incomplete gate
Symptom → reviewer emitted "this is a dark pattern" and stopped → the artifact author had nothing to act on → every FAIL must ship with the concrete change that clears it. See [ethics-tests.md#how-the-checks-compose-into-a-verdict](ethics-tests.md#how-the-checks-compose-into-a-verdict).
Context: authoring the ethics-check gate; verdict format for Quick/Deep modes.

### 2026-07-04 — Scarcity call needs the reload test, not vibes
Symptom → "is this urgency real?" got answered by feel → made ambiguous countdowns pass → decide it mechanically: does the timer/number reset on reload or return tomorrow? If yes and it's shown as fixed, FAIL. See [ethics-tests.md#scarcity](ethics-tests.md#scarcity).
Context: authoring the Quick-gate scarcity-authenticity check.

### 2026-07-04 — This gate is not optional for the persuasion skills
Symptom → tempting to treat ethics-check as a separate, opt-in tool → but the plugin's always-on rule binds psych-audit/user-empathy/journey-map to it → any nudge/scarcity/framing that a user will SHIP must pass this gate first. See `../../rules/product-psychology-context.md`.
Context: authoring the ethics-check gate; stance from the plugin ethics contract (`rules/product-psychology-context.md`).

---

## Append-only rules

1. **Promote BEFORE you append.** The full fix lives in the appropriate reference; the entry here is the breadcrumb.
2. **Use absolute dates** (the user's current date). Never relative.
3. **One entry per discrete learning.** If a single run surfaces 5 things, log 5 separate entries.
4. **Never edit existing entries.** This is an audit log of what the skill learned and when. Strikethrough or supersede with a new dated entry instead.
5. **User pushback is the highest-value gotcha source.** If the user corrected you on phrasing or methodology, that's a must-log moment.
