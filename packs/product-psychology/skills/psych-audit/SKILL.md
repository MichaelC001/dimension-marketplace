---
name: psych-audit
description: "Audit any screen, artifact, or flow for conversion and comprehension using the Imprint Loop (Filter · Frame · Act · Imprint) plus the Charge model (Net Charge = Drive − Friction). Produces a scored findings table with named principles + evidence, a compact per-stage verdict line, and a top-3 fix list ranked by impact/effort. Triggers: '/psych-audit', 'audit this screen', 'imprint loop audit', 'charge analysis', 'friction audit', 'why isn't this converting', 'run product psychology on X', 'why do users drop off', 'audit this flow', 'find the friction', 'decisions per page', 'review this landing page', 'conversion audit', 'UX psychology review'. Self-improving: every run ends with a gotcha review."
---

# Psych Audit

Audit any screen, artifact, or multi-step flow through the lens of fast-system psychology. The output is a **scored findings table** (each Imprint Loop stage marked PASS/WARN/FAIL with a named principle and concrete evidence), a compact **verdict line**, and a **top-3 fixes list** ranked by impact/effort, framed as testable hypotheses. Every recommended persuasion technique is coupled to the `ethics-check` gate.

This skill is **self-improving**. Every run must end with a gotcha review (see [Self-Improvement Protocol](#self-improvement-protocol)).

> **This skill is a checklist, not a suggestion.** Every mode below is a numbered checklist. You MUST tick each `[ ]` by writing its status + exit-criterion outcome in your response BEFORE moving to the next step. Skipping a step without documenting why is a skill violation.

---

## Pre-flight — ALWAYS (before any mode)

- [ ] **PF-1. Read [references/gotchas.md](references/gotchas.md).** Exit: you can state the most recent dated entries in one sentence each.
- [ ] **PF-2. Identify the input artifact.** A screenshot, a URL, a component/file, or a described flow. Exit: you have the actual artifact in hand (viewed the image, fetched the URL, read the component) — never audit from memory or a name alone. *If the "file" is source that only describes/embeds the artifact (a component module, a mock-data file with many exports, a template), isolate the ONE named target and render it as it ships — reconstruct + screenshot at its real width — before scoring. Never score raw source; scan path and Filter depend on the rendered pixels.*
- [ ] **PF-3. Load the frameworks.** Read [references/imprint-loop.md](references/imprint-loop.md), [references/charge-model.md](references/charge-model.md), and [references/charge-score.md](references/charge-score.md). Exit: you can name the four Imprint Loop stages and the Net Charge formula (Drive − Friction).
- [ ] **PF-4. Pick the mode.** Single artifact → **Audit screen**. Multi-step sequence → **Audit flow**. Exit: mode written down; if the input has both, do Audit flow and Audit-screen the worst step.

## Modes

| Mode | When to use | Output |
|---|---|---|
| **Audit screen** | One screen / artifact / component (screenshot, URL, code) | Imprint Loop score card + verdict line + decisions-per-page count + findings table + top-3 fixes |
| **Audit flow** | A multi-step sequence (funnel, onboarding, checkout) | Banded Charge ledger + cumulative curve + biggest-drop diagnosis + top-3 fixes |

---

## Mode: Audit screen

Walk the artifact through Filter → Frame → Act → Imprint *in the customer's shoes*, scoring each stage with a named principle and visible evidence.

- [ ] **AS-1. Establish the user story.** Who arrives here, in what emotional/contextual state, wanting what? One sentence. Exit: a customer-centered story written (not "the pricing page" but "a first-time visitor on a hot day, expecting to overpay, mistrusting a new brand").
- [ ] **AS-2. FILTER.** Run the Filter audit questions ([imprint-loop.md#filter](references/imprint-loop.md#filter)): redundant/unrelated? high-effort look? ad-like / sits where ads sit? unexpected enough? cue timing? Exit: Filter scored PASS/WARN/FAIL with ≥1 named principle (Hick's Law / selective attention / banner blindness / priming / …) and quoted evidence.
- [ ] **AS-3. FRAME.** Run the Frame questions ([#frame](references/imprint-loop.md#frame)): cognitive load, familiarity, anchors, waits→value, benefits explicit, discoverability, loss addressed. Exit: Frame scored with named principle + evidence.
- [ ] **AS-4. ACT + count decisions-per-page.** Count every distinct decision the screen demands (each choice, field, competing CTA). Then run the Act questions ([#act](references/imprint-loop.md#act)): remove options? valid defaults? split steps? progressive disclosure? Exit: a decision count reported AND Act scored with named principle + evidence.
- [ ] **AS-5. IMPRINT.** Run the Imprint questions ([#imprint](references/imprint-loop.md#imprint)): basics covered? clear feedback? reassurance? visible caring? delighters? For a static screen, reason about the feedback it *would* give on action. Exit: Imprint scored with named principle + evidence.
- [ ] **AS-6. Charge overlay.** Trace the scan path and band each key reaction drain/dip/neutral/lift/surge per [charge-score.md#bands](references/charge-score.md#bands). Exit: the pile-up of dip/drain reactions before the primary CTA is identified.
- [ ] **AS-7. Verdict line.** Emit the compact line per [charge-score.md#verdict-line](references/charge-score.md#verdict-line): `Verdict — Filter: _ · Frame: _ · Act: _ · Imprint: _ · Net Charge: _ (band)`. Exit: one verdict line written with all four stages + net Charge band.
- [ ] **AS-8. Build the findings table.** One row per issue: `Stage | Verdict | Principle | Evidence | User impact`. Exit: table has ≥1 row per FAIL/WARN, every row names a principle from the framework.
- [ ] **AS-9. Top-3 fixes.** Rank by impact/effort; frame each as a testable hypothesis; tag any persuasion technique `→ gate with ethics-check before shipping`. Exit: exactly the top 3 (highest impact, lowest effort first), each a hypothesis, ethics tags present where required.
- [ ] **AS-10. Pass the [Pre-Report Gate](#pre-report-gate).** Exit: every G-rule returns PASS.
- [ ] **AS-11. Update gotchas.** Exit: any new symptom/fix appended to [references/gotchas.md](references/gotchas.md), or a "nothing new" line added.

## Mode: Audit flow

Score how Charge varies across the steps to find where the experience leaks the most, then draw the curve.

- [ ] **AF-1. Enumerate the steps.** List the ordered steps of the flow (5–8 is ideal; collapse trivial ones). Exit: an ordered step list written.
- [ ] **AF-2. Story per anchor step.** For each major step, one line of what the user is doing/feeling. Exit: every step has a customer-side sentence.
- [ ] **AF-3. Build the banded Charge ledger.** One row per step per [charge-score.md#ledger-curve](references/charge-score.md#ledger-curve): `Step | What happens | Band (−3..+3) | Why (principle) | Cumulative`. Exit: ledger complete; cumulative Charge tracked down the flow.
- [ ] **AF-4. Draw the curve + find the biggest drops.** The cumulative column plotted is the journey's Charge axis. Identify the biggest dip/drain swings; look **slightly BEFORE** each drop for the root cause. Exit: the curve shape described (Pit = lowest cumulative, Peak = highest) and the 1–2 biggest drops named with their root-cause step.
- [ ] **AF-5. Peak-End check + leak scan.** Does the flow end on a drain (violates Peak-End)? Any step that only drains (a leak) vs. justified good friction? Exit: end-state and every pure-leak step flagged.
- [ ] **AF-6. Deep-audit the worst step.** Run Mode: Audit screen (AS-2..AS-9) on the single worst step. Exit: that step has a full Imprint Loop score card + verdict line + fixes.
- [ ] **AF-7. Top-3 fixes for the flow.** Rank by impact/effort, testable hypotheses, ethics tags where required. Exit: top 3 written, biggest-drop fix first.
- [ ] **AF-8. Hand off to journey-map.** State that the Charge curve is ready for `journey-map` to distill into Moments (Peak · Pit · Rise · Dip · Milestone) and Peak-End redesign. Exit: handoff line written.
- [ ] **AF-9. Pass the [Pre-Report Gate](#pre-report-gate).** Exit: every G-rule returns PASS.
- [ ] **AF-10. Update gotchas.** Exit: new learning appended, or "nothing new" line added.

---

## Pre-Report Gate (MUST pass before delivering any audit)

Every audit about to be delivered must pass every row below. Mark each `[ ]` with PASS / FAIL. A FAIL blocks delivery — fix it, don't ship the issue.

- [ ] **G0. Ethics coupling present.** Every recommended nudge / scarcity / social-proof / curiosity-gap / loss-aversion / anchoring / framing / defaults change carries `→ gate with ethics-check before shipping`. (Most-violated rule — check first.)
- [ ] **G1. Every claim names its principle.** No finding is bare opinion; each reads like "fails Filter: banner-blindness — sits where ads sit." See [imprint-loop.md#reporting-voice](references/imprint-loop.md#reporting-voice).
- [ ] **G2. Every finding cites evidence.** A quoted element / count / observed reaction from the actual artifact — never "feels" language.
- [ ] **G3. Findings lead with the user story.** The report opens customer-side, not product-side.
- [ ] **G4. Lead with what works.** The report states what the artifact gets right (PASS stages) before the FAILs (lead-with-what-works protocol).
- [ ] **G5. Fixes are testable hypotheses, framed as heuristics not laws.** Each fix names the expected Charge / Imprint Loop movement and a way to test it.
- [ ] **G6. Signature output present.** Audit screen → decisions-per-page count + verdict line. Audit flow → biggest drop named + cumulative curve.
- [ ] **G7. Charge score kept as a device, not a metric.** No precise/decimal Charge totals presented as measurements; bands rank frictions and draw the curve only ("insights over numbers — the score is a communication device, not a measurement").

---

## Shared Infrastructure

- **Imprint Loop (Filter/Frame/Act/Imprint, principles, checklist questions, ethics coupling, reporting voice):** [references/imprint-loop.md](references/imprint-loop.md)
- **Charge model (health bar, Net Charge, Action Map, scarcest-lever diagnosis):** [references/charge-model.md](references/charge-model.md)
- **Charge score (banded −3..+3 rubric, benchmarks, verdict line, ledger + curve):** [references/charge-score.md](references/charge-score.md)
- **Gotchas log:** [references/gotchas.md](references/gotchas.md)

---

## Self-Improvement Protocol

Every run must end with a gotcha review. New learnings die silently if you don't log them.

**During the run:**
- Undocumented error / dead-end → capture symptom + resolution verbatim.
- A principle or checklist question that didn't map cleanly to the artifact → note the actual shape.
- Scoring/heuristic surprise (a "FAIL" that tested fine, or a band that misjudged) → note the measurement.
- User pushback corrected your phrasing or methodology → ALWAYS log this. Pushback is the highest-value gotcha source.

**At end of run:**
1. **Promote the pattern** to its permanent home BEFORE appending the log entry:
   - New Imprint Loop principle / checklist nuance / reporting-voice rule → [references/imprint-loop.md](references/imprint-loop.md)
   - New Charge / Net Charge / Action Map scoring insight → [references/charge-model.md](references/charge-model.md)
   - New band / benchmark / verdict-line nuance → [references/charge-score.md](references/charge-score.md)
   - New hard rule → [Pre-Report Gate](#pre-report-gate) above
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
| Audit reads as a list of opinions | No named principles — re-run scoring with [imprint-loop.md#scoring](references/imprint-loop.md#scoring); every verdict needs a principle + evidence. |
| Recommendations feel like dark patterns | Ethics coupling missing — apply G0; tag every persuasion technique `→ gate with ethics-check before shipping`. |
| Can't tell which fix matters most | Ranking skipped — sort top-3 by impact/effort; in flow mode, the biggest dip/drain swing wins ([charge-score.md#ledger-curve](references/charge-score.md#ledger-curve)). |
| "Why won't users act AT ALL?" unclear | Use the Action Map three questions first — find the scarcest lever below the action line ([charge-model.md#action-map](references/charge-model.md#action-map)), then Imprint Loop the blocking step. |
| Charge totals get treated as a KPI | Device became a metric — apply G7; pull back to the worst step + root cause ([charge-score.md#ledger-curve](references/charge-score.md#ledger-curve)). |
| Fix list feels like decrees, stakeholder resists | Reframe as testable hypotheses + lead-with-what-works ([imprint-loop.md#reporting-voice](references/imprint-loop.md#reporting-voice)). |
| Auditing from a screen name / memory | PF-2 violated — obtain the real artifact (view the image, fetch the URL, read the component) before scoring. |

---

## Related

- `ethics-check` — the MANDATORY gate for every nudge/scarcity/framing this audit recommends. Never ship a persuasion fix without it.
- `user-empathy` — upstream: run Compass Questions / Story Strip / Action Map research to ground the user story (AS-1 / AF-2) instead of guessing it.
- `journey-map` — downstream of Audit flow: take the Charge curve and distill it to its Moments (Peak · Pit · Rise · Dip · Milestone), then improve via Peak-End tactics.
- `taste` (when available) — the craft counterpart: taste owns **Filter** (art direction, pattern break, anti-slop); this skill owns **Frame/Act/Imprint** (does it convert and get remembered). A surface that passes only one is half-done — pair them on every consumer-facing surface, with `ethics-check` gating both.
