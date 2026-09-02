# Ethics Tests — full definitions + worked examples

The complete test battery behind the `ethics-check` gate. SKILL.md links each mode here; this file is the source of truth for how each check decides `PASS` / `FLAG` / `FAIL`.

Provenance: these are our own gate procedures, standing on published public science and humane-technology discourse — the Regret Test and Manipulation Matrix (Nir Eyal, *Hooked*), the Black Mirror test (humane-tech discourse), and the humane principles (Center for Humane Technology / "Time Well Spent"). They are heuristics that surface harm, not a legal standard — a `PASS` means "no ethical red flag found by these tests," not "certified safe."

---

## Quick gate

The four fast checks. Run all four on the artifact; never stop early. Each returns `PASS` / `FLAG` / `FAIL`.

### Regret

**Test:** If users knew everything the team knows, would they behave differently? If yes — reconsider.
**Variant (the "in the room" test):** Would you say the same things about this design if the user were sitting in the room?

- `PASS` — the persuasion survives full transparency; an informed user would still act the same.
- `FLAG` — some framing leans on what the user *doesn't* notice, but the core value is honest.
- `FAIL` — the technique **only works because the user is uninformed** (hidden fees revealed at step 5, auto-renew the user won't remember agreeing to, a "recommended" option that's recommended because it pays you most).

> Worked example. A trial flow that requires a card and silently converts to a $99/yr plan on day 8 with no reminder. Regret test: if the user knew "you'll be charged $99 and we won't remind you," most wouldn't enter the card. → **FAIL**. Rewrite: send a reminder 2 days before conversion and make the charge date visible at signup.

### Scarcity

**Test:** Is the scarcity or urgency real, or manufactured?
**Decision rule:** Does the number/timer change if the user reloads the page, clears cookies, or comes back tomorrow? If it resets or is hardcoded but presented as fixed, it is false.

- `PASS` — the constraint is real: genuine limited inventory, a real event/campaign deadline, a seat cap that actually caps.
- `FLAG` — real but exaggerated ("selling fast" with weak evidence).
- `FAIL` — **manufactured**: a countdown that resets on reload, "Only 3 left!" hardcoded regardless of stock, a per-visitor "sale ends in 10:00" timer, fake "17 people are viewing this."

> Worked example. Landing page with a 15-minute countdown to a discount that reappears every visit. → **FAIL**. Rewrite: bind the timer to the real campaign end date (shared by all visitors), or remove it and state the price plainly.

### Defaults

**Test:** Is each default set to the user's advantage, or does it profit from inaction and status-quo bias?

- `PASS` — defaults are the choice most users would want if they paid full attention (opt-in extras unchecked, privacy-protective by default, cheapest-suitable plan preselected).
- `FLAG` — a default that's convenient for you and neutral-ish for the user, worth a second look.
- `FAIL` — **profits from inaction**: pre-checked paid add-ons, marketing consent opt-out buried, auto-renew defaulted on with no easy off, "keep me signed in on public devices" defaulted.

> Worked example. Checkout with "Add shipping protection $4.99" pre-checked. → **FAIL**. Rewrite: uncheck it by default; let the user opt in.

### Control & completion

**Test:** Are there real exit points and a feeling of "done," and can users control when and what they receive?

- `PASS` — clear stopping cues, a genuine sense of completion, one-tap unsubscribe/cancel, user control over frequency and channel.
- `FLAG` — exits exist but are a little buried, or completion is fuzzy.
- `FAIL` — **no real exit**: infinite scroll with no natural end and no "you're all caught up," roach-motel cancellation (easy to start, maze to stop), hidden/absent unsubscribe, notifications the user can't turn down.

> Worked example. A feed with autoplay and no "you're all caught up" marker, plus notifications that can only be all-on or all-off. → **FAIL**. Rewrite: add a caught-up boundary and per-category notification controls.

---

## Deep review

Run the Quick gate, then add these four depth tests. Use for anything shipping at scale or when a Quick check flagged.

### Manipulation Matrix

Nir Eyal's two-axis test. Ask two literal questions:
1. **Would the maker use the product themselves?**
2. **Does it materially improve the user's life?**

| | Improves user's life | Does NOT improve life |
|---|---|---|
| **Maker uses it** | **Facilitator** ✅ ship | **Entertainer** — OK only if honest about being entertainment |
| **Maker won't use it** | **Peddler** — check for self-delusion ("it's good for *them*") | **Dealer** ❌ STOP — exploitation |

- `PASS` — **Facilitator**. Also `PASS`/`FLAG` for a transparent **Entertainer**.
- `FLAG` — **Peddler**: you're building something you wouldn't use "because it helps them." Interrogate the assumption; you may be rationalizing.
- `FAIL` — **Dealer**: you wouldn't use it and it doesn't help the user. This is dark-pattern territory — stop.

> Worked example. A streak mechanic the team disables on their own accounts because it stresses them out, shipped because "it boosts DAU." Won't use it + doesn't help the user = **Dealer** → **FAIL**.

### Black Mirror

**Test:** Imagine everyone uses this product all the time — does it end well? Trace second- and third-order effects at scale. Ask: **who or what disappears if this feature becomes TOO successful?**

- `PASS` — at scale, the downstream effects are benign or positive.
- `FLAG` — plausible harm at scale that's mitigable.
- `FAIL` — a foreseeable, serious harm that the design actively drives (e.g. a "like" count that, at scale, becomes a teen mental-health lever; a rage-bait ranking that maximizes outrage).

> Worked example. A public follower/like counter. Second-order: social comparison. Third-order: at scale, quantified self-worth and engagement-chasing. Who disappears? Slow, low-metric creators. → at least **FLAG**; consider hiding public counts by default.

### In-Real-Life

**Test:** Turn the screen into a person — what personality is it? Would you want to know them?

- `PASS` — a helpful, respectful person you'd want as a friend or colleague.
- `FLAG`/`FAIL` — a **nag** (constant notifications), a **manipulator** (guilt-trips, "No thanks, I hate saving money" confirm-shaming), a **stranger** who won't leave you alone, or someone who talks over you.

> Worked example. A cancel flow that says "No, I don't want to save money." As a person: passive-aggressive, guilt-tripping. Not someone you'd want to know. → **FAIL**. Rewrite: neutral decline copy ("Cancel my plan").

### Humane principles

Three principles — evaluate each. Full detail in [humane-principles.md](humane-principles.md).
- **Save time** (not waste it).
- **Value attention** (not interrupt — no false notifications; bundle respectfully).
- **Reflect human values** (not shareholders' interests).

Any principle clearly violated by the artifact ⇒ at least `FLAG`, `FAIL` if the violation is the point of the feature.

---

## Team ritual

How to run the tests as a group so the whole team owns the ethics — not one gatekeeper. The core move: with your team, list the potential negative side effects and brainstorm how to prevent each one.

1. **Frame** the artifact so everyone can restate what ships and who it persuades.
2. **Silent independent pass** (critical — prevents groupthink): each person privately writes their Regret-test answer and one way this ends badly at scale, *before* any discussion.
3. **Side-effects register:** pool the answers into a table — **negative side effect → likelihood → prevention**. Every side effect gets a concrete prevention or an explicit "accepted risk, owner: X."
4. **Agree the quadrant + persona:** settle the Manipulation Matrix quadrant and the In-Real-Life personality as a group.
5. **Record** the verdict table and the side-effects register somewhere the team revisits at ship time.

> Side-effects register template:
>
> | Negative side effect | Likelihood | Prevention |
> |---|---|---|
> | Users game the streak, then churn on a miss | Med | Grace day + streak-freeze; measure post-break retention |
> | Notification fatigue → global mute | High | Bundle into one daily digest; per-category controls |

---

## How the checks compose into a verdict

- Each check → `PASS` / `FLAG` / `FAIL` + one line of reasoning.
- Any single `FAIL` ⇒ overall `VERDICT: BLOCKED`, and each failing row carries a **concrete rewrite** (the specific change that turns it into a `PASS`).
- All rows `PASS`/`FLAG` ⇒ `VERDICT: SHIP`; note the `FLAG`s to revisit.
- A blocking verdict with no rewrite is an incomplete gate — always pair the block with the fix.
