# The Charge Score — banded rubric

A lightweight scoring mechanic for reactions and steps. **Insights over numbers — the score is a communication device, not a measurement.** Never present a Charge total as a precise metric or a KPI; it exists to *rank* frictions and *show* a curve, nothing more. Two decimals of Charge is a smell.

---

## The bands (−3 .. +3) {#bands}

Every user reaction (screen) or step (flow) gets ONE band. Five named bands across a −3..+3 range:

| Band | Score | Meaning | Feels like |
|---|---|---|---|
| **surge** | +3 | Delight beyond expectation; a Peak candidate | "oh, that's *great*" |
| **lift** | +1 to +2 | Clear value / progress / reassurance | "good, this is working" |
| **neutral** | 0 | Expected, frictionless, forgettable | (no reaction) |
| **dip** | −1 to −2 | Friction, confusion, mild doubt | "hm, wait…" |
| **drain** | −3 | Blocker; likely abandonment; a Pit candidate | "forget it, I'm out" |

Bands map to Imprint Loop stages: a **drain/dip** is a failing Filter/Frame/Act; a **lift/surge** is a working one, or a strong Imprint. Always pair the band with the named principle behind it.

---

## Benchmark table (define, then judge against it) {#benchmarks}

Rough anchors — adjust to the product, but judge every reaction against a stated benchmark so the score is defensible, not vibes.

| Pattern observed | Band | Principle |
|---|---|---|
| Long / confusing form, many fields at once | drain (−3) | Hick's Law · Ease-Mental scarce |
| Unexpected cost or requirement revealed late | drain (−3) | loss aversion (betrayed) · broken frame |
| Redundant, ad-like, or off-goal element | dip (−1) | banner blindness · selective attention |
| Dead-end / no clear next cue | dip (−2) | missing cue (Action Map) |
| Jargon / unclear benefit | dip (−1) | features-not-benefits |
| Familiar pattern, low cognitive load | lift (+1) | familiarity · cognitive load |
| Valid defaults remove input | lift (+2) | valid defaults |
| Clear progress / completion feedback | lift (+2) | clear feedback |
| Reassurance right when doubt peaks | lift (+2) | reassurance |
| Waiting turned into visible work | lift (+1) | labor illusion |
| Unexpected, thoughtful delight | surge (+3) | delighters · pattern break |
| Strong, caring finish (ends high) | surge (+3) | Peak-End (Kahneman) |

---

## Screen verdict line (Audit-screen mode) {#verdict-line}

After scoring the four stages, collapse the audit into ONE compact line:

```
Verdict — Filter: warn · Frame: pass · Act: fail · Imprint: warn · Net Charge: −2 (dip)
```

- Each stage is `pass` | `warn` | `fail` (from [imprint-loop.md#scoring](imprint-loop.md#scoring)).
- **Net Charge** is the screen's dominant band after weighing the reactions (the pile-up before the primary CTA usually decides it) — reported as a band name + rough score, never a decimal.

---

## Flow ledger + curve (Audit-flow mode) {#ledger-curve}

Build the ledger (see [charge-model.md#flow-ledger](charge-model.md#flow-ledger)), one banded row per step:

| Step | What happens | Band | Why (principle) | Cumulative |
|---|---|---|---|---|
| 1 | … | lift (+2) | familiarity | +2 |
| 2 | … | drain (−3) | unexpected cost — loss aversion | −1 |
| … | | | | |

- **Cumulative** column = the running sum. Plotted, that line **is the journey's vertical (Charge) axis**.
- Read the curve for: the biggest single **dip/drain** (priority fix), the lowest cumulative point (the Pit), the highest (the Peak), and the ending band (Peak-End check).
- **Hand off:** once the curve exists, pass it to `journey-map` to distill the flow into Moments (Peak · Pit · Rise · Dip · Milestone) and design the Peak-End improvements. The Charge audit finds *where it leaks*; journey-map decides *which moments to reshape*.

Discipline reminder: the −3..+3 numbers are a shared vocabulary for ranking and drawing the curve. **Insights over numbers.** If a stakeholder starts optimizing the total instead of the worst step, you've let the device become a metric — pull them back to the biggest drop and its root cause.
