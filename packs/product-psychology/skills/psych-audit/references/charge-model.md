# The Charge Model — Net Charge, the Action Map, the user's health bar

The quantitative(-ish) companion to the Imprint Loop. Use it to gauge how much *psychological energy* a screen or step costs vs. gives. **Insights over numbers — the score is a communication device, not a measurement.** Focus on the direction and the relative size of each variation, and where the biggest drops are. The banded scoring rubric lives in [charge-score.md](charge-score.md).

---

## Charge = the user's health bar {#charge}

**Charge = Drive × Ease** — it merges the Drive and Ease axes of the Action Map into one running resource. The customer is a video-game hero on a quest; **Charge is their HP.** Every interaction **adds or drains** Charge. If Charge drops too low, it's game over — they abandon.

**Net Charge = Drive − Friction** (the value promised minus the effort demanded). A step is net-positive when the value it offers outweighs the effort it costs.

- **Friction = less Ease = more Charge needed to act.** BUT friction isn't always bad: **"good friction"** aligned with the user's Drive (e.g. a confirmation step before a destructive action, a values-signaling question) can *raise* conversion and trust.
- To learn what's actually in the user's head on a specific screen, use **Close-up Questions** — ask 5 successful *and* 5 dropout users about that screen's blockers and enablers.

Use the banded benchmarks as rough references (see [charge-score.md](charge-score.md)). Insights, not numbers.

---

## Scoring a screen's Charge {#charge-analysis}

For a single screen (Audit-screen mode's overlay):

1. Trace how the user's eye scans the screen (F-shaped scanning is the default for text-heavy pages).
2. Annotate each **key reaction** with a speech bubble ("wait, how much is this?", "oh, others booked it too").
3. Assign a **Charge band** to each reaction per [charge-score.md](charge-score.md): drain / dip / neutral / lift / surge, on a −3..+3 scale. Use relative magnitude, not fake decimals.
4. The screen's story is the *sequence* of bands. A pile of dips/drains before the CTA = the friction that kills conversion.

Every reaction maps back to an Imprint Loop principle — a drain/dip is a failing Filter/Frame/Act, a lift/surge is a working one. Charge scoring and Imprint Loop scoring are two views of the same thing.

---

## Charge across a flow {#flow-ledger}

For a multi-step flow (Audit-flow mode), build a **Charge ledger** — one row per step, using the bands from [charge-score.md](charge-score.md):

| Step | What happens | Band (−3..+3) | Why (principle) | Cumulative Charge |
|---|---|---|---|---|

- **Every step should ADD net Charge** (a lift/surge) or be justified good friction. A step that only drains is a leak.
- Track the **cumulative Charge** down the flow; plotted as a line it *is* the journey's vertical axis — hand that curve to `journey-map` to distill into Moments.
- The **biggest drops** (drain/dip bands, largest negative swings) are the priority fixes.
- Look **slightly BEFORE** the biggest drop for the root cause — abandonment often seeds one step earlier (an unexpected cost teased late, a promise not kept).
- A flow that ends on a drain violates **Peak-End** (Kahneman) — reorder to end high.

---

## The Action Map — Behavior = Drive × Ease × Cue {#action-map}

*(Builds on BJ Fogg's behavior model.)* Behavior only fires when **Drive × Ease × Cue** clears the **action line** (the threshold). When a desired behavior isn't happening, ask three diagnostic questions:

1. **Driven enough NOW?** (at that exact moment)
2. **Able?** — governed by the **SCARCEST** Ease lever (a chain is only as strong as its weakest link).
3. **Clearly, timely Cued?** — without a cue, there is no action.

**The 10 levers:**

- **Drive — Anticipation:** seeking hope / avoiding fear.
- **Drive — Sensation:** seeking pleasure / avoiding pain.
- **Drive — Belonging:** seeking acceptance / avoiding rejection.
- **Ease — Time:** how long does it take?
- **Ease — Money:** how costly is it?
- **Ease — Physical:** how physically demanding?
- **Ease — Mental:** how complicated?
- **Ease — Practice:** how familiar / practiced?
- **Cue — Explicit:** the "what to do" is in the cue itself (button, notification, email, timer).
- **Cue — Implicit:** cued by memory association (places, people, situations, emotions).

**Diagnostic use in an audit:** when a screen/step fails to convert, name which lever is short. "Below the action line: Drive-Anticipation is fine but Ease-Mental is the scarce lever — 4 unfamiliar fields at once." That's an Action-Map-backed finding, not a guess.

**Ethics floor:** never *force* a behavior. Align the product with what users already want → raise Drive → ease the path → cue the moment. Techniques that push past what the user wants belong to `ethics-check`.

---

## When to reach for which {#which}

- **Single screen** → Charge analysis (scan + bands) + Imprint Loop stages. Action Map if the screen is a conversion gate that's failing.
- **Multi-step flow** → Charge ledger + cumulative curve (find the biggest drops) + Imprint Loop on the worst steps.
- **"Why won't they act at all?"** → Action Map three questions first (which lever is below the action line?), then Imprint Loop on the blocking step.
