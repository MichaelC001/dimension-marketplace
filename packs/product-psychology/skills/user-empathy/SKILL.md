---
name: user-empathy
description: "Understand users BEFORE designing — design empathy research, map why a behavior is (or isn't) happening, and sketch the customer's story. Produces the 3 Compass Questions adapted to a product (Hope/Pain/Barrier), an Action Map diagnosis (Behavior = Drive × Ease × Cue) with the scarcest lever named, and a six-panel Story Strip. Triggers: '/user-empathy', 'design a user survey', 'empathy questions', 'Compass Questions', 'JTBD research', 'Story Strip', 'customer story', 'Action Map', 'behavior map', 'action line', 'why aren't users doing X', 'why won't users convert', 'what does the user want', 'user interview questions'. Self-improving: every run ends with a gotcha review."
---

# User Empathy — research before you design

Understand the user **first**. This skill produces three research artifacts:
the **3 Compass Questions** adapted to a product (Hope/Pain/Barrier), an **Action
Map diagnosis** naming the scarcest lever blocking a behavior, and a **six-panel
Story Strip** of the customer's slice of life. None of these require a model
call — they drive *your* analysis and the user's research.

This skill is **self-improving**. Every run must end with a gotcha review (see
[Self-Improvement Protocol](#self-improvement-protocol)).

> **This skill is a checklist, not a suggestion.** Every mode below is a
> numbered checklist. You MUST tick each `[ ]` by writing its status +
> exit-criterion outcome in your response BEFORE moving to the next step.
> Skipping a step without documenting why is a skill violation.

---

## Pre-flight — ALWAYS (before any mode)

- [ ] **PF-1. Read [references/gotchas.md](references/gotchas.md).** Exit: you can state the most recent dated entries in one sentence each.
- [ ] **PF-2. Name the behavior `X` and the audience.** Exit: one sentence — "the user is trying to `X`" (a job-to-be-done verb, not a feature).
- [ ] **PF-3. Empathy-first check.** Exit: confirm you are NOT jumping to screen critique before understanding the user — if the ask is "improve this screen", you still start with the Compass Questions unless real research already exists.
- [ ] **PF-4. Pick the mode.** Exit: one of Design research / Map behavior / Sketch the story written down (modes chain; you may run all three).

## Modes

| Mode | When to use | Output |
|---|---|---|
| **Design research** | "what do users want", "design a survey", empathy/interview questions, JTBD | 3 Compass Questions adapted to the product + story-ask pro tip + Close-up Questions for a named screen |
| **Map behavior** | "why aren't users doing X", "won't convert", Action Map, action line | Action Map diagnosis: zone + scarcest Ease lever + the align/raise/ease/cue move |
| **Sketch the story** | "Story Strip", "tell the customer's story", build empathy fast | six-panel Story Strip: happy ending first, conflict in 2–5, ≤5 words/panel |

---

## Mode: Design research

Produce research instruments — never speculation about what users want. Detail + verbatim patterns: [references/empathy-questions.md](references/empathy-questions.md).

- [ ] **R-1. Adapt the 3 Compass Questions to the product.** Substitute the real `X`/`Y`. Use the verbatim patterns: **Hope** ("magic wand → instantly X, how does your life change?"), **Pain** ("#1 challenge with X, and why so challenging?"), **Barrier** ("last time you did X — how did it go? what stopped you from Y?"). Exit: three concrete, product-specific questions written out.
- [ ] **R-2. Append the story-ask pro tip.** Add "Be super specific — tell us a story if possible" (+300% response length; strongest on the Barrier question). Exit: the line is on the Compass Questions.
- [ ] **R-3. Set the method + sample.** Recommend **video > survey** (one call ≈ 100 surveys), **5 answers per question**. Exit: method + N stated.
- [ ] **R-4. (If a specific screen is named) add Close-up Questions.** Ask both **successful AND drop-out** users what they noticed first / hoped to see / hesitated on / gained confidence from. Exit: 4–5 Close-up Questions for the screen, or "no specific screen — Close-up Questions deferred" noted. Do NOT emit Close-up Questions without real Compass-Question answers or an existing research base.
- [ ] **R-5. Pass the [Ethics Gate](#ethics-gate).** Exit: every G-rule returns PASS.
- [ ] **R-6. Update gotchas.** Exit: new learning appended to [references/gotchas.md](references/gotchas.md), or a "nothing new" line added.

## Mode: Map behavior

Diagnose why a behavior is or isn't happening with the **Action Map** — **Behavior = Drive × Ease × Cue** (builds on BJ Fogg's behavior model). It's a product, not a sum — any factor at zero → no behavior. Detail + worked diagnoses: [references/action-map.md](references/action-map.md).

- [ ] **M-1. Ask the 3 diagnostic questions.** In order: (1) enough **Drive** — at that exact moment? (2) **able** — which Ease lever is scarcest? (3) clear, **timely Cue**? (no cue → no action). Exit: an answer for each.
- [ ] **M-2. Place the behavior in a zone.** A (fires) / B (wants, can't) / C (can, won't) / D (dead zone). Exit: zone named with a one-line reason vs. the action line.
- [ ] **M-3. Name the scarcest lever.** From the 10 levers — Drive: Anticipation/Sensation/Belonging; Ease: Time/Money/Physical/Mental/Practice; Cue: Explicit/Implicit. The **scarcest Ease lever governs**. Exit: one lever identified as the primary blocker.
- [ ] **M-4. Choose the move — align / raise / ease / cue.** Map the fix to exactly one legitimate move on a want the user already holds. Exit: the recommendation is phrased as one of the four.
- [ ] **M-5. Pass the [Ethics Gate](#ethics-gate).** Exit: every G-rule returns PASS.
- [ ] **M-6. Update gotchas.** Exit: appended, or "nothing new" line.

## Mode: Sketch the story

Build empathy with a six-panel **Story Strip** of the customer's slice of life (WHY/HOW), not a click-path through the UI (WHAT). Construction + improvement rules + psychology: [references/story-strip.md](references/story-strip.md).

- [ ] **S-1. Write panel 6 first — the happy ending, ≤5 words.** Anchor the resolution before anything else. Exit: panel 6 caption written.
- [ ] **S-2. Fill panels 1–5, ≤5 words each.** Panel 1 = ordinary context/trigger; 2–5 = the middle. Exit: all six captions present, each ≤5 words.
- [ ] **S-3. Put the conflict in panels 2–5.** No struggle = no empathy. Exit: at least one clear friction/doubt/wall in panels 2–5.
- [ ] **S-4. Keep it customer-life, not UI.** No panel names your product's buttons; focus on emotions/context/thoughts. Exit: confirmed no UI-step captions.
- [ ] **S-5. Mark one improvement gap.** Note the gap *between two panels* where something could go wrong — hand it to `journey-map` (a Pit) or `psych-audit` (a friction point). Exit: one gap named.
- [ ] **S-6. Update gotchas.** Exit: appended, or "nothing new" line.

---

## Ethics Gate (MUST pass before emitting a recommendation)

Every recommendation about to be emitted must pass every row. Mark each `[ ]`
with PASS / FAIL. A FAIL blocks it — fix it, don't ship it.

- [ ] **G0. Never force behavior.** The recommendation reduces to exactly one of **align / raise / ease / cue** on a behavior the user **already wants**. If it manufactures a want, it FAILS.
- [ ] **G1. No fake urgency or fake scarcity.** Any scarcity/urgency named must be real. If a persuasion technique (nudge/scarcity/loss-aversion/framing) is applied to something the user will SHIP or PUBLISH → escalate to the **`ethics-check`** skill first.
- [ ] **G2. Named principle, not opinion.** Each claim cites the framework term (e.g. "Zone B — scarcest lever is Money", "conflict absent in panels 2–5"), never bare taste.
- [ ] **G3. Hypothesis, not law.** Frame confidence honestly — these are heuristics for testable hypotheses (video interviews, funnel data), not guarantees.

---

## Shared Infrastructure

- **Compass & Close-up Question patterns + examples:** [references/empathy-questions.md](references/empathy-questions.md)
- **Action Map levers, action line, worked diagnosis:** [references/action-map.md](references/action-map.md)
- **Story Strip construction + improvement rules:** [references/story-strip.md](references/story-strip.md)
- **Gotchas log:** [references/gotchas.md](references/gotchas.md)

---

## Self-Improvement Protocol

Every run must end with a gotcha review. New learnings die silently if you don't log them.

**During the run:**
- Undocumented error / dead-end → capture symptom + resolution verbatim.
- A Compass/Close-up Question that produced weak or misleading answers → note the wording that failed.
- An Action Map diagnosis that was wrong once you saw real data → note the corrected read.
- User pushback corrected your phrasing or methodology → ALWAYS log this. Pushback is the highest-value gotcha source.

**At end of run:**
1. **Promote the pattern** to its permanent home BEFORE appending the log entry:
   - New Compass/Close-up Question pattern or wording fix → [references/empathy-questions.md](references/empathy-questions.md)
   - New behavior-lever / action-line insight → [references/action-map.md](references/action-map.md)
   - New Story Strip construction/improvement rule → [references/story-strip.md](references/story-strip.md)
   - New hard rule → the [Ethics Gate](#ethics-gate) above
2. **Then** append a 1–3 line entry to [references/gotchas.md](references/gotchas.md). Each entry must point to the promoted reference where the full fix lives.
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
| Jumped to critiquing a screen | Skipped empathy-first. Run Design-research Compass Questions before any screen work. See PF-3. |
| Compass answers are short/shallow | Missing the story-ask line. Append "tell us a story if possible" (+300%). See [empathy-questions.md#compass](references/empathy-questions.md#compass). |
| Recommendation reads coercive | Conflated raising odds with forcing. Reduce to align/raise/ease/cue, else escalate to `ethics-check`. See [action-map.md#ethics-never-force](references/action-map.md#ethics-never-force). |
| Eased Time but behavior didn't move | Wrong lever — the scarcest Ease lever (e.g. Mental) governs. Re-diagnose. See [action-map.md#levers](references/action-map.md#levers). |
| Story Strip is just app screenshots | Product-path, not life-slice. Rewrite as customer emotions/context. See [story-strip.md](references/story-strip.md). |
| Story feels flat / unengaging | No conflict in panels 2–5. Add the struggle. See [story-strip.md#psychology](references/story-strip.md#psychology). |

---

## Related

- `psych-audit` — consumes Close-up Question answers as friction/drive badges for a Charge analysis of a screen.
- `journey-map` — consumes the Story Strip's improvement gap as a Pit; the strip is the "ideal" it maps the real journey against.
- `ethics-check` — the mandatory gate before shipping any persuasion technique this skill's diagnosis suggests.
