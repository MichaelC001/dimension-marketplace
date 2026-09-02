# Journey Model — the 5 Moment types + mapping discipline

A customer journey map distills an experience to its top **5-6 Moments**, supports the
Story Strip, and summarizes Charge variations across the flow. This file is the full
mapping discipline behind Map mode.

> The goal is not a complete map. The goal is a map that gets **remembered and used**.
> Overly exhaustive maps are hard to build, hard to share, and never referenced.

---

## Charge — the resource being mapped {#charge}

**Charge** is the user's mental resource for getting through an experience — think of
it as a video-game health bar. Every interaction adds or drains Charge:

> **Net Charge = Drive − Friction**

(the pull toward the goal minus the cost of the interaction). Do NOT chase precise
numbers — Charge is a mental model. Score steps roughly (high / mid / low) and focus
on where it visibly rises and falls. The vertical axis of every journey map is Charge.

---

## Why 5-6 Moments (Miller's Law) {#distill}

People hold only **7±2 items** in working memory. A map with 5-6 Moments is short
enough for a whole team to grasp, recall, and act on. A 15-step map is a document;
a 5-Moment map is a shared mental model.

**Distillation procedure:**
1. List every raw step of the REAL journey (screens, waits, decisions, drop-offs).
2. Rough-score each step's Charge (high / mid / low). Net Charge = Drive − Friction.
3. Keep only the Moments that define the SHAPE of the experience:
   - the single **Peak** (must-have),
   - the single **Pit** (must-have),
   - the key **Milestone** (must-have — usually NOT the very first/last step),
   - plus the biggest **Rise** and biggest **Dip** to reach 5-6.
4. Everything else is noise. Drop it. If you still have 8+ Moments, you have not
   finished distilling — merge or cut until 5-6 remain.

A map that won't fit in one glance failed step 3.

---

## The 5 Moment types {#elements}

Each kept Moment is exactly one of these. Classify by ABSOLUTE and RELATIVE Charge:

| Moment | Definition | How to spot it |
|---|---|---|
| **Peak** | The highest ABSOLUTE Charge level in the whole journey | Where the user feels best — the "wow", the payoff, the win |
| **Pit** | The lowest ABSOLUTE Charge level | Where the user feels worst — confusion, cost, friction, doubt |
| **Rise** | A Charge INCREASE between Moments | A step that visibly lifts the user (a delight, a resolved worry) |
| **Dip** | A Charge DECREASE between Moments | A step that visibly deflates the user (a wall, a surprise cost) |
| **Milestone** | The start or end of a meaningful stage | Crossing a threshold: sign-up done, first task complete, "you're in" |

Peak and Pit are about the tallest/shortest points overall. Rise and Dip are about the
steepest changes between points. Milestones are about crossing a stage threshold,
regardless of height. A single step can be, e.g., both a Milestone and the Peak —
label the map with what matters most for the story.

---

## Vertical axis = Charge; emotions as FACES {#axis}

- **Vertical axis is always Charge level.** Plot Moments left-to-right in order; the
  line's shape (peaks and valleys) is the whole point. A table of Moments is not a
  map — the visible up-and-down IS the deliverable.
- **Represent each Moment's emotion with a FACE / emoji, not an abstract dot.**
  Pareidolia: humans read emotion into faces instantly and remember it. A row of dots
  communicates nothing about how the Moment FEELS; a row of faces makes the
  roller-coaster legible at a glance. This is the same reason stick-figure Story Strips
  build empathy.

---

## Map the REAL journey, not the ideal {#real-vs-ideal}

The single most common failure: mapping the journey you WISH users had.

- Map what is **really happening** now — include friction, dead-ends, and the
  **dropout path** (the people who quit), not just the happy path.
- A map with **no Pit** is almost always dishonest. Every real journey has a lowest
  point; if you can't find it, you haven't walked the real flow.
- The ideal lives elsewhere: it's the **Story Strip** from the `user-empathy` skill
  (the aspirational, happy-ending version of the customer's slice of life).
- In **Verify mode**, set the real map beside the ideal Story Strip. Every gap between
  the felt journey and the intended one is an improvement opportunity. That comparison
  — real vs. ideal — is where the backlog comes from.

---

## Worked micro-example (onboarding)

Raw steps → distilled to 5 Moments:

```
Charge
 high │            ⓔ (Peak)
      │        ↗              🙂 (Milestone: "You're in")
  mid │  🙂 ↗                       ↘
      │ (Rise)                        😕 (Dip)
  low │              😣 (Pit: empty dashboard, no data yet)
      └───────────────────────────────────────────────▶ time
        install    first-value   "you're in"   day-2 empty   churn risk
```

- **Peak** = first Moment of real value (the "wow").
- **Pit** = the empty/blank state right after — nothing to do yet.
- **Milestone** = "You're in".
- **Dip** = day-2 return to an empty dashboard.
- Faces, not dots. Axis = Charge. This is the REAL journey (it shows the churn risk),
  not the ideal.

Improvement then follows from [improvement-tactics.md](improvement-tactics.md):
fill that one Pit, and reorder so the journey ENDS on the Peak, not the Dip.
