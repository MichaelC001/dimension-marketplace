# Gotchas — journey-map skill

Append-only LOG of one-off learnings from real runs. Each entry is 1–3 lines. The fix lives in the promoted reference — entries here are breadcrumbs.

**Format:**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix. See [<promoted-ref>#<anchor>](<promoted-ref>#<anchor>) for the full pattern.
Context: <what you were doing>.
```

---

### 2026-07-04 — Seed: maps drift toward the ideal, not the real
Symptom: first-draft journey maps show a smooth upward line with no Pit → cause: mapping the aspirational flow instead of walking the actual experience (incl. dropout) → fix: map the REAL journey; a Pit-free map is dishonest until proven. See [journey-model.md#real-vs-ideal](journey-model.md#real-vs-ideal).
Context: authoring the skill; Map mode.

### 2026-07-04 — Seed: filling every pit is whack-a-mole
Symptom: effort spread across many small dips, remembered experience unchanged → cause: ignoring Pareto — the biggest Pit dominates the memory → fix: fill ONLY the biggest Pit, leave the potholes, spend the rest on the Peak + End. See [improvement-tactics.md#fill-pit](improvement-tactics.md#fill-pit).
Context: authoring the skill; Improve mode, Tactic 3.

### 2026-07-04 — Seed: the ~9× ROI-of-Delight number is directional
Symptom: temptation to promise "9× revenue" as a forecast → cause: it's one aggregate study, not a per-product guarantee → fix: cite as directional to justify investing in delight, never as a precise promise. See [improvement-tactics.md#roi](improvement-tactics.md#roi).
Context: authoring the skill; encoded as Pre-Ship Gate G6.

---

### 2026-07-08 - A quality gate with a zero-must-fix rule can make the journey UNABLE to end high
Symptom -> the first-run flow's final beat loops forever: composite 0.80 -> 0.83 -> 0.85 (all >= threshold) but each jury round finds NEW must-fix nits (copy even regressed 0.74 -> 0.67), so the run never reaches 'pass' and the user's journey ends by giving up -> when the End of a journey is gated by a convergence rule, audit the rule for guaranteed termination (bounded rounds / accept-above-threshold); an unbounded gate turns the Milestone into the Pit.
Context: Map mode on the Studio first-run landing-page journey; the design-jury gate (gate: true) drove 3 revise rounds with no terminus.

## Append-only rules

1. **Promote BEFORE you append.** The full fix lives in the appropriate reference; the entry here is the breadcrumb.
2. **Use absolute dates** (the user's current date). Never relative.
3. **One entry per discrete learning.** If a single run surfaces 5 things, log 5 separate entries.
4. **Never edit existing entries.** This is an audit log of what the skill learned and when. Strikethrough or supersede with a new dated entry instead.
5. **User pushback is the highest-value gotcha source.** If the user corrected you on phrasing or methodology, that's a must-log moment.

### 2026-07-13 — The Pit lived on the dropout path the tool itself never mentions
Symptom → a full authoring journey (16 UI steps) ends "Untitled" with auto-save keyed to a project id that never exists; reload silently destroys everything → the Pit was invisible until the walk included the dropout path (close/reload) → always walk the exit, not just the last feature step. See [journey-model.md#real-vs-ideal](journey-model.md#real-vs-ideal).
Context: Map mode on Agentic Atlas world-authoring journey (live UI walk, fresh browser profile).
