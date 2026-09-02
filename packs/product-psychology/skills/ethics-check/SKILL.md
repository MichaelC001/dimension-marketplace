---
name: ethics-check
description: "Ethical pre-flight gate for anything persuasive a user will ship or publish — screens, nudges, campaigns, notifications, defaults, copy. Runs the Regret test, scarcity-authenticity, defaults, control/completion, the Manipulation Matrix, Black Mirror and In-Real-Life tests, and the humane principles, and returns a per-check pass/flag/fail verdict where any FAIL blocks with a concrete rewrite. Triggers: '/ethics-check', 'is this ethical', 'dark pattern check', 'regret test', 'before I publish this campaign', 'is this urgency real', 'scarcity authenticity', 'manipulation matrix', 'black mirror test', 'humane design check', 'defaults for the user', 'is this a dark pattern'. Self-improving: every run ends with a gotcha review."
---

# Ethics Check — the persuasion gate

This gate decides whether a persuasive artifact is safe to ship. Its output is a **verdict table**: one row per check, each `PASS` / `FLAG` / `FAIL` with one line of reasoning, and — for every `FAIL` — a concrete rewrite that removes the harm. A single `FAIL` blocks the artifact.

This skill is **self-improving**. Every run must end with a gotcha review (see [Self-Improvement Protocol](#self-improvement-protocol)).

> **This gate is INSEPARABLE from the persuasion skills.** `psych-audit`, `user-empathy`, and `journey-map` teach nudges, scarcity, loss aversion, and framing; the plugin's always-on rule (`rules/product-psychology-context.md`) requires that any such technique applied to something a user will SHIP or PUBLISH pass this gate FIRST. You do not get to persuade without passing here.

> **This skill is a checklist, not a suggestion.** Every mode below is a numbered checklist. Tick each `[ ]` by writing its status + exit-criterion outcome in your response BEFORE moving to the next step. Skipping a step without documenting why is a skill violation.

---

## Pre-flight — ALWAYS (before any mode)

- [ ] **PF-1. Read [references/gotchas.md](references/gotchas.md).** Exit: state the 3 most recent dated entries in one sentence each (or "log empty").
- [ ] **PF-2. Name the artifact + the ask.** Exit: one sentence — what is being persuaded, of whom, and what the user will SHIP (screen / campaign / notification / default / paywall / copy).
- [ ] **PF-3. Name the persuasion technique in play.** Exit: the specific lever(s) identified (scarcity, urgency, loss aversion, social proof, default, framing) — this is what the gate scrutinizes. If none, say so and note the gate is a formality.
- [ ] **PF-4. Pick the mode.** Exit: one of Quick gate / Deep review / Team ritual written down. Default = Quick gate; escalate to Deep review whenever any Quick check `FLAG`s or the artifact ships at scale.

## Modes

| Mode | When to use | Output |
|---|---|---|
| **Quick gate** | Fast pre-ship check on one artifact (the default) | 4-row verdict table + block/allow |
| **Deep review** | High-reach / high-stakes artifact, or any Quick `FLAG` | 8-row verdict table (Quick + 4 depth tests) |
| **Team ritual** | Reviewing a feature/roadmap as a group | Facilitated agenda + side-effects/preventions register |

Full test definitions and worked examples: [references/ethics-tests.md](references/ethics-tests.md). Humane principles: [references/humane-principles.md](references/humane-principles.md).

---

## Mode: Quick gate

The 4 fast checks. Run every one; do not stop early. See [ethics-tests.md#quick-gate](references/ethics-tests.md#quick-gate) for the decision rules per check.

- [ ] **Q-1. Regret test.** If users knew everything the team knows, would they act differently? (Variant: would you say the same things with the user sitting in the room?) Exit: `PASS`/`FLAG`/`FAIL` + one line. `FAIL` if the technique only works because the user is uninformed.
- [ ] **Q-2. Scarcity authenticity.** Is the scarcity/urgency real or manufactured? Exit: verdict + one line. `FAIL` on any false countdown, fake "only 2 left", or resettable "sale ends" timer.
- [ ] **Q-3. Defaults.** Is each default set to the user's advantage, or does it profit from inaction / status-quo bias? Exit: verdict + one line. `FAIL` on pre-checked upsells, opt-out-buried consent, auto-renew traps.
- [ ] **Q-4. Control & completion.** Are there real exit points and a feeling of done, and can users choose when/what they receive? Exit: verdict + one line. `FAIL` on infinite loops with no stopping cue, hidden unsubscribe, roach-motel cancellation.
- [ ] **Q-5. Emit the verdict.** Exit: verdict table rendered ([format below](#verdict-format)); if any row is `FAIL`, the artifact is BLOCKED with a rewrite per failing row.
- [ ] **Q-6. Pass the [Pre-Ship Gate](#pre-ship-gate).** Exit: every G-rule returns PASS.
- [ ] **Q-7. Update gotchas.** Exit: new learning appended to [references/gotchas.md](references/gotchas.md), or a "nothing new" line.

## Mode: Deep review

Run all 4 Quick checks, then add the 4 depth tests. Use for anything that ships at scale or when a Quick check flagged. See [ethics-tests.md#deep-review](references/ethics-tests.md#deep-review).

- [ ] **D-1. Quick gate.** Exit: Q-1..Q-4 completed with verdicts.
- [ ] **D-2. Manipulation Matrix quadrant.** Place the artifact on Nir Eyal's two axes — *would the maker use it?* × *does it materially improve the user's life?* → **Facilitator** (yes/yes, ship) · **Entertainer** (yes/no, ship only if honest) · **Peddler** (no/yes, check for self-delusion) · **Dealer** (no/no, STOP). Exit: quadrant named + verdict. `FAIL` = Dealer.
- [ ] **D-3. Black Mirror test.** Imagine everyone uses this all the time — does it end well? Trace second- and third-order effects at scale; ask *who or what disappears if the feature is TOO successful?* Exit: at least one plausible harmful downstream effect named (or a defensible "none"), + verdict.
- [ ] **D-4. In-Real-Life test.** Turn the screen into a person — what personality is it? Would you want to know them? Exit: the personality described in one line + verdict. `FLAG`/`FAIL` if the persona is a nag, a manipulator, or a stranger you'd avoid.
- [ ] **D-5. Humane principles.** Does it **save time**, **value attention** (no false notifications; bundle respectfully), and **reflect human values** (not just shareholder interest)? Exit: three sub-verdicts. See [humane-principles.md](references/humane-principles.md).
- [ ] **D-6. Emit the verdict.** Exit: 8-row verdict table; any `FAIL` blocks with a rewrite.
- [ ] **D-7. Pass the [Pre-Ship Gate](#pre-ship-gate).** Exit: every G-rule PASS.
- [ ] **D-8. Update gotchas.** Exit: appended, or "nothing new".

## Mode: Team ritual

Run the tests as a group exercise so the whole team owns the ethics, not one reviewer. See [ethics-tests.md#team-ritual](references/ethics-tests.md#team-ritual).

- [ ] **T-1. Frame the artifact.** Exit: everyone can restate what ships and who it persuades in one sentence.
- [ ] **T-2. Silent Regret + Black Mirror pass.** Each person writes, independently, (a) their Regret-test answer and (b) one way this ends badly at scale — *before* discussion, to avoid groupthink. Exit: every participant has written both.
- [ ] **T-3. Build the side-effects register.** Pool the Black Mirror answers into a table of **negative side effect → likelihood → prevention**. Exit: every named side effect has a concrete prevention or an explicit "accepted risk, owner: X".
- [ ] **T-4. Matrix + In-Real-Life together.** Agree the Manipulation Matrix quadrant and the In-Real-Life personality as a group. Exit: one quadrant + one persona the team endorses.
- [ ] **T-5. Emit team verdict + register.** Exit: verdict table + side-effects/preventions register recorded where the team will see it again at ship time.
- [ ] **T-6. Update gotchas.** Exit: appended, or "nothing new".

---

## Verdict format

Every mode emits a table; every row is one check.

```
| Check | Verdict | Reasoning (one line) |
|---|---|---|
| Regret test | FAIL | Countdown works only because users don't know it resets on reload |
| Scarcity authenticity | FAIL | "Only 3 left" is hardcoded, not inventory-backed |
| Defaults | PASS | Add-on is opt-in, unchecked by default |
| Control & completion | PASS | Clear unsubscribe in the footer; email is a digest, not a drip |

VERDICT: BLOCKED (2 FAIL). Fix required:
- Regret/Scarcity → replace the false countdown with the real campaign deadline, or remove the timer entirely.
```

Rules:
- `PASS` = no ethical concern. `FLAG` = defensible but watch it / escalate to Deep review. `FAIL` = blocks.
- **Every `FAIL` MUST carry a concrete rewrite** — the specific change that turns it into a `PASS` (e.g. *false countdown → bind to the real deadline or remove; pre-checked upsell → uncheck it; hidden exit → surface a one-tap unsubscribe*). A verdict of "this is unethical" with no rewrite is an incomplete gate.
- Any single `FAIL` ⇒ overall `VERDICT: BLOCKED`. All `PASS`/`FLAG` ⇒ `VERDICT: SHIP` (note the FLAGs to revisit).

---

## Pre-Ship Gate (MUST pass before the artifact is declared shippable)

Mark each `[ ]` PASS / FAIL. A FAIL blocks — fix it, don't ship the issue.

- [ ] **G0. No manufactured scarcity or urgency.** Every countdown, "N left", and "ending soon" maps to a real constraint. Fake ⇒ FAIL.
- [ ] **G1. Regret test passes.** The technique does not depend on the user being uninformed. Depends on it ⇒ FAIL.
- [ ] **G2. Defaults serve the user.** No pre-checked upsells, buried opt-outs, or inaction traps. Violates ⇒ FAIL.
- [ ] **G3. Real exit + control exist.** A stopping cue, a working unsubscribe/cancel, user choice over when/what they receive. Missing ⇒ FAIL.
- [ ] **G4. Not a Dealer.** The artifact is not in the Manipulation Matrix's Dealer quadrant. Is ⇒ FAIL.
- [ ] **G5. Every FAIL has a concrete rewrite.** No blocking verdict is emitted without the fix that clears it.

---

## Shared Infrastructure

- **All tests + worked examples:** [references/ethics-tests.md](references/ethics-tests.md)
- **Humane principles (time / attention / values):** [references/humane-principles.md](references/humane-principles.md)
- **Gotchas log:** [references/gotchas.md](references/gotchas.md)
- **The plugin ethics contract (always-on rule):** `../../rules/product-psychology-context.md`

---

## Self-Improvement Protocol

Every run must end with a gotcha review. New learnings die silently if you don't log them.

**During the run:**
- Undocumented dark pattern or edge case the tests missed → capture the artifact + which check should have caught it.
- A check that gave a false PASS or false FAIL → note the misread and the corrected rule.
- A rewrite suggestion that didn't actually remove the harm → note the better fix.
- User pushback corrected your verdict, phrasing, or methodology → ALWAYS log this. Pushback is the highest-value gotcha source.

**At end of run:**
1. **Promote the pattern** to its permanent home BEFORE appending the log entry:
   - New/refined test rule or worked example → [references/ethics-tests.md](references/ethics-tests.md)
   - Humane-principle nuance → [references/humane-principles.md](references/humane-principles.md)
   - New hard rule → [Pre-Ship Gate](#pre-ship-gate) above
2. **Then** append a 1–3 line entry to [references/gotchas.md](references/gotchas.md). Each entry points to the promoted reference where the full fix lives.
3. **Never** silently let a new learning die. If you discovered it, log it.

**Gotcha entry format (1–3 lines):**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix. See [<promoted-ref>#<anchor>](<promoted-ref>#<anchor>) for the full pattern.
Context: <what you were doing + asset / mode / trigger>.
```

Use today's absolute date (the user's current date) — never relative.

---

## Failure / Recovery

| Symptom | Cause / Fix |
|---|---|
| Verdict is "this feels manipulative" with no fix | Incomplete gate. Every `FAIL` needs a concrete rewrite — see [Verdict format](#verdict-format). |
| Everything comes back `PASS` on a persuasive artifact | You didn't name the technique (PF-3) or ran too shallow. Escalate to Deep review; re-run [ethics-tests.md#quick-gate](references/ethics-tests.md#quick-gate). |
| Scarcity call is ambiguous | Ask: does the number/timer change if the user reloads or comes back tomorrow? If yes and it's presented as fixed, it's `FAIL`. See [ethics-tests.md#scarcity](references/ethics-tests.md#scarcity). |
| Can't decide the Matrix quadrant | Answer the two axes literally: would *you* use it, and does it *materially* help the user? See [ethics-tests.md#manipulation-matrix](references/ethics-tests.md#manipulation-matrix). |
| Team ritual devolves into groupthink | You skipped the silent independent pass (T-2). Have people write before discussing. |
| Gate ran but persuasion technique shipped anyway | The plugin rule was bypassed. Persuasion from `psych-audit`/`journey-map`/`user-empathy` requires this gate FIRST — re-read `../../rules/product-psychology-context.md`. |

---

## Related

- `psych-audit` — applies Imprint Loop persuasion levers to screens; its recommendations that ship MUST clear this gate first.
- `user-empathy` — designs research; scarcity/urgency framing surfaced there routes here.
- `journey-map` — elevates Peaks with nudges; anything published from a journey redesign passes here.
- `rules/product-psychology-context.md` — the always-on plugin rule that binds the three persuasion skills to this gate.
