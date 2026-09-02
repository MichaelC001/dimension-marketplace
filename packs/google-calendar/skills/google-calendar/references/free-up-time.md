# Free up time

Use this when the goal is to **create** time, not just inspect it.

## Relevant tools

- `google_calendar_list_events` to map the day's current fragmentation and identify movable candidates.
- `google_calendar_get_event` when one candidate meeting needs a closer look before proposing a move.
- `google_calendar_find_free_slots` to confirm a target slot is actually open before proposing or placing a hold.
- `google_calendar_create_event` when the user explicitly wants a temporary hold or focus block once the target slot is grounded.
- `google_calendar_update_event` only after the proposal is clear. For a recurring meeting, remember it patches the id you pass — an occurrence id edits that occurrence; use the master id (`recurringEventId`, from `google_calendar_get_event`) for a series-level move.

## Workflow

1. Identify the target: today, tomorrow, this afternoon, a specific day, or a broader window. If the user already gave a concrete window or duration, work inside it before asking follow-up questions.
2. Optimize for contiguous free blocks, not raw free-minute totals.
3. Identify which meetings are likely fixed and which are more movable before proposing changes.
4. If the user explicitly wants a temporary hold or focus block rather than a reschedule plan, pick the best qualifying free slot and create the hold once the slot is clear.
5. Look for the smallest edit set that creates a meaningful uninterrupted block.
6. Prefer solutions that reduce fragmentation across the rest of the day, not just one local gap.
7. If no clean block exists, show the best partial win and what tradeoff it requires.

## Prioritization heuristics

- Protect hard anchors such as external meetings, major reviews, commute buffers, or a stable lunch.
- Move lower-cost meetings first — optional events, lightweight internal syncs, or self-created placeholders.
- Favor one or two coherent shifts over a chain of many tiny moves.
- Prefer creating one useful block over scattering a few small openings.

## Output conventions

- Show the before-and-after effect of the proposal.
- Name the block of time created and the minimum meetings that would need to move.
- When creating a hold, state the exact slot. (This connector creates a normal event as the placeholder — it does not set free/busy transparency in V1, so say if the user wanted a transparent hold.)
- If suggesting multiple options, keep them short and explain the tradeoff for each.

---

_Adapted from OpenAI's Codex google-calendar-free-up-time skill (MIT)._
