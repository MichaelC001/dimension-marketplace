# Gotchas — psych-audit skill

Append-only LOG of one-off learnings from real runs. Each entry is 1–3 lines. The fix lives in the promoted reference — entries here are breadcrumbs.

**Format:**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix. See [<promoted-ref>#<anchor>](<promoted-ref>#<anchor>) for the full pattern.
Context: <what you were doing + asset / mode / trigger>.
```

---

### 2026-07-04 — Seed: audits that skip the ethics coupling read as manipulation advice
Symptom → an audit recommends scarcity/urgency/framing with no ethics note → the fix ships as dark-pattern advice → every nudge/scarcity/framing/loss-aversion recommendation MUST carry `→ gate with ethics-check before shipping`. See [imprint-loop.md#ethics-coupling](imprint-loop.md#ethics-coupling) for the coupling table.
Context: seeding the skill's Act-stage nudges + the ethics gate.

### 2026-07-04 — Seed: "I don't like it" findings get dismissed
Symptom → a finding phrased as opinion ("this feels cluttered") is easy for a stakeholder to reject → findings without a named principle are unfalsifiable → every claim leads with the named principle + evidence ("fails Filter: banner-blindness — sits where ads sit"). See [imprint-loop.md#reporting-voice](imprint-loop.md#reporting-voice).
Context: setting the reporting voice (lead-with-what-works, principle vocabulary).

### 2026-07-04 — Seed: Charge score creeps from device to metric
Symptom → stakeholders start optimizing a Charge total instead of the worst step → the −3..+3 bands look like a KPI → keep it a communication device ("insights over numbers"); band reactions, draw the curve, fix the biggest drop. See [charge-score.md#ledger-curve](charge-score.md#ledger-curve).
Context: adding the banded Charge-score mechanic (bands, benchmarks, verdict line, curve).

### 2026-07-04 — "HTML landing page" was actually a TS mock module with 15 exports
Symptom → the named file was source, not the artifact: a `.html`-in-name target turned out to be a `.ts` mock-artifacts file where the landing was one `doc()` export (`AURORA_LANDING`) among 15 → scoring the raw source would've missed the rendered scan path entirely → isolate the ONE named export, reconstruct it standalone, and screenshot at its shipping width (`designWidth`) before Filter. See [SKILL.md](../SKILL.md) PF-2.
Context: Audit-screen on `scratch/aurora-landing-audit-target.html` (Nova landing hero).

### 2026-07-04 — Peak-End on a flow that ends in a persistent workspace
Symptom → an onboarding flow has no terminal screen; the "end" Peak-End weighs is the landing's first ~5 seconds → score the arrival state (including any stale/noise elements like recent-run rows) as the flow's final step, not just the last ceremony beat. See [charge-score.md#ledger-curve](charge-score.md#ledger-curve).
Context: Audit-flow on the Studio onboarding ceremony (live web app, 5 steps, first-run walk).

### 2026-07-04 — Copy that promises motion the screen doesn't perform
Symptom → a step *says* "arranging itself" while rendering instantly with static text → the promise/show gap reads as a broken claim and kills the Imprint (labor illusion inverted: claimed labor, no visible work) → audit present-progressive copy against what actually animates. Owner confirmed pairing with the `taste` skill: taste owns Filter, this skill owns Frame/Act/Imprint (promoted to SKILL.md Related).
Context: same run — beat 4 "Your studio is arranging itself." was the flow's biggest drop.

### 2026-07-04 — Owner pushback: "the onboarding flow" meant the ceremony ONLY, not the arrival page after it
Symptom → audited onboarding + post-onboarding landing as one flow; owner corrected the scope → where the flow ends decides the Peak-End verdict, so scope is not cosmetic: including the landing the flow ended high (pass); ceremony-only it ends on its weakest beat (FAIL) → confirm the flow's LAST step with the requester before scoring (AF-1), especially when a strong screen sits just past the intended boundary and can mask a weak ending.
Context: same Studio run — re-scoped ledger flipped Peak-End from pass to fail and re-ranked the fixes.

### 2026-07-05 — Owner pushback: "weren't the skills used?" — ad-hoc taste passes are not an audit
Symptom → three shipped iterations (v0–v3) of the Loops cockpit were composed by hand and still read mediocre; owner asked why the skills weren't run → the checklist IS the deliverable: the first formal AS-1..AS-9 pass immediately found what hand passes missed (a crash on the primary action, a redundancy wall, decorative hues). Run the mode checklist BEFORE iterating, not after rejection.
Context: Loops v4 redesign (Audit screen ×2: home + run-open, live web app).

### 2026-07-05 — Take the artifact's actions during Imprint — a screenshot can't crash
Symptom → v3's home scored fine statically, but clicking a run row hard-crashed the app (envelope stamped a synthetic workspaceId the session driver can't open) → the worst Imprint failure was invisible in pixels; promoted a "take the actions live" question. See [imprint-loop.md#imprint](imprint-loop.md#imprint).
Context: same run — the fix was engine-side data truth (real workspaceId) + a catalog remap fallback, not CSS.

### 2026-07-05 — An embedded substrate carries its own art direction into the product
Symptom → the Loops card embedded the docs-diagram FlowGraph substrate: cream/amber governor diamond, green comet wires, its own orb atmosphere — Filter read decorative multi-hue violating the product's single-accent law → judge embedded substrates against the PRODUCT's design law and fix with a scoped context override, never a global restyle. See ui-library-auditor `token-rules.md` leak pattern 4.
Context: same run — `.le-root.fr-loop-flow` remaps the substrate's own variables to fr tokens.

### 2026-07-05 — Owner pushback: the audit passed a card that fails at scale ("we can't show the entire graph upfront")
Symptom → the v4 card embedded the FULL loop diagram per card; the audit scored the one-simple-loop demo and missed that N loops × complex graphs makes the layout impossible → audit any card/list/diagram against its most COMPLEX realistic instance; a full detail view per item must demote to summary → snapshot → full view. Promoted to the Act questions. See [imprint-loop.md#act](imprint-loop.md#act).
Context: Loops v5 — the machine became a non-interactive card snapshot + a full-screen overlay on demand.

### 2026-07-05 — Owner pushback: "Promote to workspace… of what?" — an action's referent must be visible
Symptom → a Promote button at the sidebar's TOP read as acting on the whole loop; its real object (the selected run) was invisible — Gestalt proximity decides the referent, not the label → actions ride ON their object (the active row), with object-naming copy ("Keep as workspace session"). Promoted to the Act questions. See [imprint-loop.md#act](imprint-loop.md#act).
Context: same run — rows also flipped to lead with WHAT THE RUN DID (envelope `summary` = the session's last line) instead of a wall of "Completed" labels.

---

### 2026-07-08 - Auditing a LIVE agent flow: the auditor's browser tab is part of the system under audit
Symptom -> the automated audit tab died mid-run and silently killed the agent run being audited (engine retires a session sidecar on last connection detach) -> poll the ENGINE journal for flow progress, keep browser calls short, and score the interruption honestly - it exposed the journey's real resilience Pit (no resume affordance after a killed run).
Context: Audit-flow on the Dimension Studio first-run journey (live web app + live agent generation, 6 beats).

## Append-only rules

1. **Promote BEFORE you append.** The full fix lives in the appropriate reference; the entry here is the breadcrumb.
2. **Use absolute dates** (the user's current date). Never relative.
3. **One entry per discrete learning.** If a single run surfaces 5 things, log 5 separate entries.
4. **Never edit existing entries.** This is an audit log of what the skill learned and when. Strikethrough or supersede with a new dated entry instead.
5. **User pushback is the highest-value gotcha source.** If the user corrected you on phrasing or methodology, that's a must-log moment.

### 2026-07-10 — A responsive shell can hide the same element by TWO independent rule paths
Symptom → an Act-stage fix (make the rail toggle work at phone width) verified against the viewport media query still failed live → the element was also force-hidden by a container-query twin (`data-frame-w="narrow"`) with `!important` → when fixing responsive posture, enumerate EVERY rule touching the element (grep the slot name across all stylesheets) and verify with computed styles, not class lists.
Context: Inso Mobile shell audit (420×880 live web lane) — session-rail drawer fix; theme.css had both an `@media (max-width: 760px)` and a `[data-frame-w=narrow]` hide rule.
### 2026-07-10 — Catalog-driven UI: the code review sees ten chips, the live render sees fifty
Symptom → a capability-chip section looked fine in source but rendered as a ~50-chip wall live (options come from the workspace's skill catalog, not the code) — Act FAIL invisible until PF-2's real render; separately, the live check exposed a stale-PROCESS false negative (the engine serving the page predated the new catalog field, showing the empty-state copy). → For any UI whose option set is data-driven, audit at the most complex realistic catalog (see [imprint-loop.md#act](imprint-loop.md#act), 2026-07-05 scale rule) AND restart every process in the render path before trusting an empty state.
Context: Loops Agent-run inspector (skills/tools chips) — fix: armed-first ordering + collapse behind "+N more", verified live.

### 2026-07-13 — A working undo flips a destructive-action drain to a dip
Symptom → seed reroll silently desynced every downstream layer to rainbow noise (a certain drain) → but Ctrl+Z restored terrain AND all political layers completely → score the damage+rescue PAIR, not just the damage. See [imprint-loop.md#imprint](imprint-loop.md#imprint) for the promoted question.
Context: Audit-flow on Agentic Atlas worldgen authoring loop (live deck.gl app, 60K cells); also hit a mid-report citation-loop glitch in a subagent — re-request missing sections via irc instead of respawning.

### 2026-07-13 — Owner pushback: the flow ledger drove the agent API, not the human panels
Symptom → the authoring-loop audit ran via window.atlas calls; owner asked "did you even do the journey end to end, doing each individual panel like a user?" → the API path missed the journey's true Pit (world never saved; reload = total loss), a label-grammar Dip (7 different generator-button labels; a missed layer resulted), and showed a false ordering trap the UI actually solves → walk the HUMAN surface. See [imprint-loop.md#act](imprint-loop.md#act) for the promoted question.
Context: Agentic Atlas end-to-end UI walk (17 raw steps, all rail panels), after the earlier API-driven Audit-flow.
