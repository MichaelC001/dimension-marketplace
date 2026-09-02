# Humane Principles

Beyond passing the ethics tests, humane products go further: they treat the user's time, attention, and values as things worth protecting. The guiding idea, from humane-technology discourse (Center for Humane Technology / "Time Well Spent"): *technology should enable us, not keep us secretly captive.*

Use these when running the Deep-review humane-principles step (D-5) and whenever an artifact "passes" the dark-pattern tests but still feels extractive.

---

## 1. Save time (not waste it)

The product should get the user to their goal faster, and could always save more.

- **Ask:** does this feature shorten the path to what the user actually came for, or does it insert steps that serve us?
- **Green flags:** valid defaults, skippable onboarding, a fast path for returning users, "you're all caught up" so people can stop.
- **Red flags:** artificial friction to inflate session time, interstitials before the content, "watch this before continuing," padding a flow so an engagement metric goes up.
- **Prompt:** "Where could this save the user another 30 seconds?" If the honest answer is "we don't want to — longer sessions are the KPI," that's the violation.

## 2. Value attention (not interrupt)

Attention is finite and borrowed. Don't spend it without a real reason.

- **Ask:** is every notification/interruption something the user would thank you for, and is it bundled and timed respectfully?
- **Green flags:** batched digests, quiet hours, per-category controls, notifications tied to the user's own goals, no "false" notifications (badges/pings with nothing meaningful behind them).
- **Red flags:** false-notification badges to bait re-opens, re-engagement pings unrelated to anything the user wanted, high-frequency drips, "someone you may know" nags.
- **Worked example:** a social app where the user has ignored ~20 past notifications should **bundle them into a single relevant, respectful notification** rather than firing a 21st. Respect the signal that they're not reading them.

## 3. Reflect human values (not shareholders' interests)

When the business goal and the human good diverge, humane products don't quietly pick the shareholder.

- **Ask:** whose interest does this feature actually serve when they conflict — the person using it, or the quarterly metric?
- **Green flags:** defaults that protect the user even when a laxer default earns more, honest comparisons, letting people leave gracefully, surfacing the cheaper/healthier option.
- **Red flags:** engagement maximized at the cost of wellbeing, growth loops that exploit loneliness or FOMO, "human values" cited in the mission but contradicted by the incentive the feature optimizes.
- **Note:** delight is not charity — delighting "good" customers earns ~9x more revenue (Forrester, 2017). Humane and profitable are usually aligned over the long term; the violation is trading long-term trust for a short-term metric.

---

## How to score the humane step

Give each principle a sub-verdict:
- `PASS` — the artifact clearly honors the principle.
- `FLAG` — neutral or a missed opportunity to be more humane (log it as a future improvement, don't block).
- `FAIL` — the artifact's *point* is to violate the principle (its value depends on wasting time / hijacking attention / putting the metric above the person).

A humane `FAIL` blocks like any other check and needs a concrete rewrite (bundle the notifications, remove the padding step, flip the default toward the user).
