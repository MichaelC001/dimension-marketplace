# The Action Map — Behavior = Drive × Ease × Cue

A mental model for **why a behavior is or isn't happening** (builds on BJ Fogg's
behavior model). Use it to diagnose a stuck behavior and to name the single
cheapest lever to move.

> **Behavior = Drive × Ease × Cue** — a behavior happens only when **Drive**,
> **Ease**, and a **Cue** converge at the same moment. It's a product, not a
> sum: any factor at zero → no behavior. No cue → no action, however driven and
> able.

- **Drive** — the willpower to act *right now*.
- **Ease** — the capacity to act (governed by the **scarcest** lever, below).
- **Cue** — the timely trigger to act.

---

## The action line

Plot Drive (vertical) against Ease (horizontal). The **action line** is the
curve separating "acts" from "doesn't act": high drive compensates for low ease,
and vice-versa, but below the curve nothing fires even when a cue lands.

**Zones** (drive × ease, with a cue present):

| | Low ease | High ease |
|---|---|---|
| **High drive** | **B** — wants it, can't do it → *ease it* | **A** — fires easily → protect it |
| **Low drive** | **D** — dead zone → *nothing fires* | **C** — can do it, won't → *raise Drive* |

A cue that lands **below** the action line (low drive, allergic-to-it, not-now)
produces no behavior, no matter how explicit. Fix the missing factor, not the
cue volume.

### The 3 diagnostic questions

When the desired behavior isn't happening, ask, in order:

1. **Enough Drive — at that exact moment?** (not in general — *then*.)
2. **Able?** — and specifically, *which Ease lever is scarcest here?*
3. **Cued?** — is there a clear, timely trigger? (No cue → stop; add one first.)

---

## The 10 levers {#levers}

**Drive (3)** — each is a seek/avoid pair:
- **Anticipation** — seeking hope / avoiding fear.
- **Sensation** — seeking pleasure / avoiding pain.
- **Belonging** — seeking acceptance / avoiding rejection.

**Ease (5)** — *the scarcest one governs the whole behavior:*
- **Time** — how long does it take?
- **Money** — how costly is it?
- **Physical** — how physically demanding is it?
- **Mental** — how complicated is it? (cognitive load)
- **Practice** — how familiar / rehearsed is it?

**Cue (2)**:
- **Explicit** — the what-to-do is *in* the trigger: button, notification, email, timer.
- **Implicit** — cued by memory association: places, people, situations, emotions.

> **Scarcest-lever rule.** Ease is a chain — its strength is the weakest link.
> Shaving Time off a task whose real blocker is Mental complexity moves nothing.
> Diagnose the scarcest lever first, then spend effort there.

---

## Worked diagnosis

### Example 1 — the sushi notification (textbook)

*Millionaire, allergic to sushi, not hungry, gets a "sushi nearby!" push as
they pick up the phone.* Cue = explicit and well-timed. But: Drive is floored
(not hungry = Sensation zero; allergic = avoid-pain active). Money ease is
sky-high (irrelevant). → Lands in **Zone D**, far below the action line.
**Diagnosis:** no lever to pull — this user should never have been cued. The fix
is *targeting*, not a louder notification.

### Example 2 — same-day pool booking (product)

Compass-Question answers (see [empathy-questions.md](empathy-questions.md)) revealed:
- "figured it'd cost $300+" → **Anticipation** miscalibrated + **Money** ease *perceived* as low.
- "never heard of the brand" → **Belonging/trust** friction.
- "Googling on a hot day, want it today" → **Implicit cue** (hot-day situation) already firing; drive high.

**Diagnosis:** Drive is *high* (hot day, wants a pool now) and the cue exists —
so this sits in **Zone B**: wants it, blocked on perceived Ease (price anchor)
and Belonging (trust). **Scarcest lever = the price anchor** — show real hourly
pricing up front to collapse the Money/Anticipation gap; add trust proof for
Belonging. That's *ease it* + *raise Drive*, not a harder sell.

---
## The placement test — where a creation surface lives {#placement}

When deciding WHERE a capability's UI lives (a builder, a creation flow, a
"new X" surface), plot the **drive moment** first: when does the user actually
want this, and how long does that drive live? The surface must be reachable —
with a cue that fires — **inside the drive's half-life**. If the drive moment
and the surface cannot co-occur, the surface is decoration, however good.

- **Creation** rides short, situational drive (annoyance, inspiration) → it must
  be **ambient**: invocable where the drive spikes (composer, inline card,
  slash command), one confirmation, never a navigation. The ambient surface is
  an **invocation point, not a knowledge residence** — delegate to a specialist
  (subagent/skill loaded on demand) so the resident agent carries zero extra
  context.
- **Tuning/management** rides slow, deliberate drive (curiosity, oversight) →
  a **dedicated home** works, because visiting it IS the cued behavior. The
  home may ALSO serve deliberate creation as a real studio (canvas + resident
  specialist) — two drives, two visit kinds, one room.
- **The thing's WORK surfaces in its domain** (sessions/artifacts where the
  work happens), never in its home — the home holds the definition, history,
  and tuning only.
- Corollary: a "designer/builder" page owns deliberate design and editing,
  never the drive-moment capture. Separate the two drives or the feature
  yields ~zero behavior (the Zapier-class failure: the annoyance-moment and
  the builder never meet).

## "Done but not shipped" is a CUE failure, not Ease/Drive {#cue-failure}

When a Barrier answer is *"I built it but never launched / it went stale"*, the
user is in **Zone C** (able, willing-in-principle, didn't) — the missing factor
is almost always the **Cue**, not Ease or Drive. They can do it; nothing
triggered it at the moment it was doable. **The fix is a timely cue, never a
better tool/room:** fire it off a real event the user already produces (a build
ships → cue the launch; a week passes → cue the refresh). Building a richer
*place* to do the dropped work moves nothing — the place was never the blocker.
Corollary for IA: **derive surfaces from Barrier drop-off points; a surface
that doesn't sit on a real drop-off is a metaphor-slot and will collapse.**


## Ethics — never force behavior {#ethics-never-force}

The Action Map can be abused to coerce. It must not be. There are exactly **four
legitimate moves**, and every recommendation must reduce to one of them:

1. **ALIGN** — with a behavior the user *already wants* (from a Hope/Pain answer).
2. **RAISE** drive — make the existing benefit vivid and honest.
3. **EASE** — remove the scarcest Ease-lever cost (Time/Money/Mental/…).
4. **CUE** — a clear, timely trigger for a behavior they'd welcome.

If a recommendation can't be phrased as align/raise/ease/cue on a want the user
already holds — if it *manufactures* a want, fakes scarcity, or exploits fear —
it fails, and you escalate to the **`ethics-check`** skill before shipping it.
The Action Map is a lens for finding opportunities, not a lever for imposing
behavior.
