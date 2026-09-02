# Gotchas — user-empathy skill

Append-only LOG of one-off learnings from real runs. Each entry is 1–3 lines. The fix lives in the promoted reference — entries here are breadcrumbs.

**Format:**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix. See [<promoted-ref>#<anchor>](<promoted-ref>#<anchor>) for the full pattern.
Context: <what you were doing + asset / mode / trigger>.
```

---

### 2026-07-04 — Compass Questions answer "should we build it", not "how to design it"
Symptom → agent jumps to Close-up Questions / screen critique before any Compass-Question research. Cause → skipping the empathy-first step because a product already exists feels like enough context. Fix → the Compass Questions (Hope/Pain/Barrier) come BEFORE design in every case; Close-up Questions only after you have a specific screen AND real Compass answers. See [empathy-questions.md#compass](empathy-questions.md#compass).
Context: authoring the skill — empathy-first, always.

### 2026-07-04 — "increase behavior" ≠ "force behavior"
Symptom → recommendation reads like coercion (dark-pattern nudge to make users act). Cause → conflating raising the odds of a behavior with imposing it. Fix → the only four moves are ALIGN with an existing want · RAISE Drive · EASE · CUE. If a recommendation can't be phrased as one of those four, it fails the gate — escalate to `ethics-check`. See [action-map.md#ethics-never-force](action-map.md#ethics-never-force).
Context: authoring — the Action Map's never-force-behavior insight is the ethics floor for this skill.

### 2026-07-04 — The Action Map arbitrates ARCHITECTURE, not just screens
Symptom → a "where should this feature's UI live" debate ran on rhetoric until the owner asked for the skill. Cause → treating placement as taste when it's a Drive×Ease×Cue co-occurrence question. Fix → run the placement test: creation surfaces must be reachable inside the drive's half-life (ambient); tuning homes ride deliberate drive (dedicated). Decided routine-creation = ambient birth card, Lab = tuning home. See [action-map.md#placement](action-map.md#placement).
Context: Dimension spaces/rooms design — "where would I design a cron/routine"; owner requested the skill decide.

### 2026-07-04 — Owner pushback: ambient surface = invocation point, NOT knowledge residence; and the tuning home may also be a deliberate-creation studio
Symptom → "ambient creation" read as the resident agent owning the capability (context bloat), and the dedicated home read as tuning-only. Cause → the placement test named WHERE the cue must land but not WHO carries the know-how, and treated the two drives as exclusive. Fix → ambient surface = a cheap invocation (slash command → specialist subagent, dies after); the resident agent carries zero domain knowledge. AND a dedicated home can legitimately serve BOTH drives — deliberate creation (a real studio with a resident specialist) and tuning — they're different visits, not different rooms. Also: a created thing's WORK surfaces in its domain (sessions where the work is), never in its home. See [action-map.md#placement](action-map.md#placement).
Context: Dimension routine lifecycle — owner corrected creation delegation, Lab-as-studio, and executions-live-in-domain.

### 2026-07-04 — IA derived from metaphor collapses; derive rooms from Barrier drop-offs
Symptom → a whole "room" (Studio's Desk) evaporated under one question because the IA was built from a metaphor ("production company → it needs a Desk"), not from jobs. Cause → surfaces asserted top-down, never tested against a real drop-off. Fix → run Compass Questions, cluster Barrier answers into drop-off points, and let each surface earn existence against one: no drop-off → no room. Bonus finding: "built it but never launched / went stale" = a CUE failure (Zone C), fixed by a build-time/cadence cue, not a richer room. See [action-map.md#cue-failure](action-map.md#cue-failure).
Context: Dimension Studio IA — owner ("this has been slopped") demanded the skill; Compass Qs on the owner (N=1 real) collapsed 6 metaphor-rooms to ~4 evidenced surfaces + reframed the center from "make" to "finish & keep-alive".

### 2026-07-04 — Don't generalize a "center of gravity" from one persona
Symptom → derived "the product's center is finish & keep-alive" from N=1 (a dev-founder who can already build); owner corrected — a designer's center is making (Stage), an analyst's is producing decks/reports on cadence, a game-dev's is the UE Stage. Cause → treating one persona's Barrier as universal. Fix → the center of gravity is PERSONA-RELATIVE; derive a small INVARIANT core (surfaces every persona's job touches) + PERSONA-CONDITIONAL surfaces (earn prominence only where that persona has a real job), and let arrangement move the center. A surface dead for one persona (e.g. gallery/Library for a dev-founder) can be core for another (designer/analyst). See [action-map.md#cue-failure](action-map.md#cue-failure) for the derive-from-Barrier rule this extends.
Context: Dimension Studio IA — owner reminded that personas span designer/game-dev/analyst/C-suite, not just dev-founder.

### 2026-07-04 — Audit each persona's journey; a design tuned to one persona drains the others
Symptom → Studio-as-designed scored +3 (make) then −7 across the tail for a content creator: Critique modeled design-quality not the creator's CTR metric, Ship was deploy/hand-to-code (dev-founder-shaped, noise to a creator), reuse was demoted though it's the creator's daily core, cadence was assumed via an unbuilt "cue". Cause → one persona's journey generalized into the design; also assumed automation that isn't built. Fix → run an Audit-flow per persona; the Pit locations differ; persona-arrangement is DERIVED from the scorecards, not asserted. Critique + Ship must recast per persona (creator Ship = export/post/A-B; creator jury = hook/CTR, not hierarchy). Never stage a journey on unbuilt automation. See [action-map.md#cue-failure](action-map.md#cue-failure).
Context: Dimension Studio — owner had me score a standalone content-creator's UX; exposed dev-founder bias + code-coupling.

---

## Append-only rules

1. **Promote BEFORE you append.** The full fix lives in the appropriate reference; the entry here is the breadcrumb.
2. **Use absolute dates** (the user's current date). Never relative.
3. **One entry per discrete learning.** If a single run surfaces 5 things, log 5 separate entries.
4. **Never edit existing entries.** This is an audit log of what the skill learned and when. Strikethrough or supersede with a new dated entry instead.
5. **User pushback is the highest-value gotcha source.** If the user corrected you on phrasing or methodology, that's a must-log moment.
