# The Imprint Loop — full reference

The core audit lens. Most decisions run on fast, automatic, recognition-driven thinking (call it the **fast system**); slow, deliberate, logical thinking is rare and expensive. **Design for the fast system.** Every interaction cycles **Filter → Frame → Act → Imprint**, and what gets **Imprinted** drives the *next* pass's Filter. Audit any screen by walking all four stages in order, in the *customer's* shoes, not the product owner's.

The high-level self-question per stage: *Does this pass my brain filters (Filter)? What do I understand (Frame)? How can I take action (Act)? Was it satisfying, clear, reassuring (Imprint)?*

*(This dual-system split builds on Kahneman's fast/slow thinking; the loop below organizes well-established System-1 heuristics into one audit pass.)*

---

## FILTER — the brain filters to save energy {#filter}

The brain continuously filters information to conserve energy. It **auto-filters out** anything that is:

- **High-Effort** — we take the path of least resistance; too many choices cause paralysis. Principle: **Hick's Law**.
- **Unrelated** — anything off-goal is filtered out. Principle: **selective attention**.
- **Redundant** — repeated patterns get filtered out. Principle: **banner blindness** (redundancy is a *Filter* concern; familiarity is a *Frame* lever — don't conflate).

Attention is **captured** by things that are:

- **In short-term memory** — recently-seen info is easily recalled. Principle: **priming**.
- **Confirming beliefs** — we're drawn to belief-consistent thoughts. Principle: **confirmation bias**.
- **Unexpected** — pattern breaks, humor, or personalization grab attention.

**Audit questions (Filter):**
- Are things redundant or unrelated to the user's goal?
- Does it *look* high-effort (dense, many choices)?
- Does it look like an ad, or sit where ads sit? (→ banner-blindness risk)
- Is there any unexpectedness / pattern break?
- Is the cue's timing aligned with the behavior?
- Does it create value from the user's hopes/pains to capture attention?
- Are there new, unexpected, personalized touchpoints?

**Named-principle vocabulary:** Hick's Law · selective attention · banner blindness · priming · confirmation bias · pattern break · personalization.

---

## FRAME — frame of reference decides understanding {#frame}

Establishing the right frame of reference lets people understand quickly. **7 levers to reframe context:**

- **Familiarity** — reuse existing/known patterns to aid interpretation.
- **Cognitive load** — cut noise around the critical info.
- **Benefits** — speak to their hopes, not features; easier to understand when it appeals to *them*.
- **Anchoring** — comparisons set the frame of reference.
- **Loss aversion** — highlight what's lost by *not* acting.
- **Discoverability** — make key elements stand out.
- **Labor illusion** — show behind-the-scenes work to guide users (turn waits into value).

**Audit questions (Frame):**
- Is cognitive load minimized (visuals, text-heaviness)?
- Does it build on familiar patterns?
- Are anchors present to set comparison?
- Are waiting periods turned into value (labor illusion)?
- Are the user's benefits explicit (aligned to hopes)?
- Is discoverability of the key action good?
- Does it address fear of loss (tied to benefits)?

**Named-principle vocabulary:** familiarity · cognitive load · features→benefits · anchoring · loss aversion · discoverability · labor illusion · framing effect.

**Ethics note:** reframing helps OR manipulates. Any reframing recommendation (esp. loss aversion / anchoring / framing) → gate with `ethics-check`.

---

## ACT — reduce friction, then nudge {#act}

Facilitate a behavior by **reducing friction** first, then **nudging** for key actions only.

**Reduce friction:**
- **Remove options** — more choices = longer decisions (Hick's Law).
- **Valid defaults** — design so no user input is needed.
- **Split steps** — three small steps beat one big step (lowers cognitive load).
- **Progressive disclosure** — reveal features gradually.

**Nudge (sparingly):**
- **Social proof** — show what others did in the same situation.
- **Curiosity gap** — an open loop people feel compelled to close.
- **Scarcity** — limited things feel more desirable.

**Careful:** overused nudges get **filtered out**; too-pushy nudges cause **reactance**. Reserve nudges for KEY actions.

**Audit questions (Act):**
- **Count the decisions per page** (every distinct choice = a decision). Report the number.
- Can any options be removed?
- Are there valid defaults to minimize input?
- Can a big step be split into smaller ones?
- Can features be revealed gradually (progressive disclosure)?
- **Does every action sit ON its object?** An action floating above a list (a promote/delete/save at the panel top) reads as acting on the whole container — Gestalt proximity decides the referent, not the label.
- **Walked the HUMAN path, not just the API?** If the product has both a human UI and an agent/API surface, the flow audit MUST drive the actual UI affordances (buttons, sliders, panels in rail order) — the API path skips label grammar, hidden CTAs, ordering traps, and unsaved-work volatility that only the human journey exposes.
- **Does the layout survive its most COMPLEX realistic instance?** Audit a card/list/diagram against N× items and the richest single item, not the demo's simplest one. A full detail view embedded per item fails at scale — summary → snapshot → full view (progressive disclosure).

**Named-principle vocabulary:** Hick's Law · valid defaults · cognitive load (split steps) · progressive disclosure · social proof · curiosity gap · scarcity · reactance · commitment & consistency.

---

## IMPRINT — the imaginary tab {#imprint}

Users keep a running tab of every interaction; it drives how they **Filter → Frame → Act** next time (a negative imprint → they filter more aggressively). Repeated recognizable, enjoyable patterns become **HABITS** (slow decisions become fast). **4 things leave a positive imprint, in impact order:**

1. **Clear feedback** — show clearly what just happened.
2. **Reassurance** — confirm they're doing the right thing.
3. **Feeling of caring** — show their best interests are at heart.
4. **Delighters** — go above and beyond.

The **Peak-End rule** (Kahneman) softens earlier negatives — ending strong reduces the weight of earlier friction.

**Audit questions (Imprint):**
- Are users' basic expectations covered (by today's standards)?
- Is there clear feedback on what happened?
- **Live artifact? TAKE the actions.** Click the primary rows/CTAs and watch the real feedback — static screenshots hide the worst Imprint failures (a crash screen IS the imprint). Score what the action actually returns, not what the layout implies.
- **Destructive action tested? Also test the RESCUE.** After exercising a destructive/regenerating action live, immediately try undo/restore — a working, complete undo flips a drain toward a dip (the imprint is "recoverable", not "ruined"), while a missing or partial undo confirms the drain. Score the pair, not just the damage.
- Do users feel reassured when taking action?
- Is caring about their outcome visible?
- Any small delighters?
- Does it build a positive long-term relationship?

**Named-principle vocabulary:** clear feedback · reassurance · feeling of caring · delighters · habit formation · Peak-End rule (Kahneman).

---

## Scoring each stage {#scoring}

Score each of Filter / Frame / Act / Imprint as **PASS / WARN / FAIL**:

- **PASS** — the stage's checklist questions are satisfied; name the principle(s) it gets right.
- **WARN** — a real risk but not fatal; name the principle and the hypothesis.
- **FAIL** — a checklist question is clearly violated with visible evidence; name the principle and quote the evidence.

Never score without (a) a named principle and (b) concrete evidence from the artifact. "Feels cluttered" is not a score; "fails Filter: high-effort — 9 competing CTAs above the fold (Hick's Law)" is.

The compact **verdict line** for a screen collapses the four stages plus the screen's net Charge into one line — see [charge-score.md#verdict-line](charge-score.md#verdict-line).

---

## Ethics coupling — MANDATORY {#ethics-coupling}

Any recommendation that uses a persuasion technique MUST carry the tag `→ gate with ethics-check before shipping`. The techniques that trigger the coupling:

| Technique (stage) | Why it needs the gate |
|---|---|
| Scarcity (Act) | risk of *false* urgency / fake scarcity |
| Social proof (Act) | risk of fabricated / borrowed proof |
| Curiosity gap (Act) | risk of clickbait / unfulfilled loop |
| Loss aversion (Frame) | risk of manufactured fear |
| Anchoring (Frame) | risk of deceptive comparison |
| Framing / benefits spin (Frame) | risk of misleading reframe |
| Valid defaults (Act) | risk of defaults set for the business, not the user |

Reducing friction, clarifying copy, cutting cognitive load, adding clear feedback/reassurance are **not** persuasion techniques and don't need the gate — but if in doubt, tag it. See sibling skill `ethics-check` for the actual tests (Regret Test · Manipulation Matrix · Black Mirror · scarcity authenticity · defaults-for-the-user).

---

## Reporting voice {#reporting-voice}

How to communicate the audit so it lands (an unsupported idea is easy to dismiss — even for a stakeholder's fast system):

1. **Lead with the user story.** Frame each finding as the customer's slice of experience, not the product's mechanics ("A first-time visitor lands on a hot day expecting to overpay and bounces before seeing the real price").
2. **Name the principle on every claim.** Psychology vocabulary turns "opinions" into reasoning: "fails Filter: banner-blindness — sits where ads sit" beats "I don't like the banner." This is what makes a finding falsifiable and hard to dismiss.
3. **Frame fixes as testable hypotheses.** "Moving the price above the fold should raise Frame (benefits) → test conversion" — not a decree. These are heuristics for hypotheses, not laws.
4. **Deliver feedback lead-with-what-works.** The 3-step answer to any feedback: (1) lead with a yes / what works, (2) repeat & empathize, (3) reassure you both want the best solution. Open the report with what the artifact gets right before the FAILs.
5. **Feedback guardrail:** state what you want feedback ON. When presenting the audit, say what decision it should inform.

Review-prep framing (when the audit feeds a stakeholder review): goal of the review? · what do I want feedback on? · what business problem does the fix solve? · how does the current state affect users today (the story)? · why this fix over alternatives?
