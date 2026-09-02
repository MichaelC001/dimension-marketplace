# Group scheduler

Use this when the scheduling problem itself is the task — finding and ranking good meeting times across several people.

## Relevant tools

- `google_calendar_find_free_slots` for attendee and room/resource busy windows once you know the concrete calendar ids (or attendee emails).
- `google_calendar_list_events` when you need event context, candidate-room history, or a clearer read on what's creating conflicts.
- `google_calendar_get_event` when attendee emails, a manager contact, a room email, or full source-event details must be recovered from an existing event (the list summary omits attendee emails).

## Workflow

1. Ground the problem first: date window, duration, timezone, required attendees, optional attendees, and any hard constraints ("this week", "afternoons only", "avoid lunch").
2. Normalize the request into explicit candidate windows before ranking anything.
3. If attendee or room identities are referenced indirectly ("my manager", "same attendees", "the room we usually use"), search a bounded relevant window with `google_calendar_list_events` and read the likely source event with `google_calendar_get_event` before asking the user for contact details.
4. Query busy windows for the concrete attendee/room set with `google_calendar_find_free_slots`, then compute the open overlaps yourself.
5. Rank slots — don't enumerate everything. Optimize for a short list of strong options.
6. Prefer slots that minimize conflict cost, are reasonably fair across timezones, and avoid fragmenting the day for the most constrained attendees.
7. If no perfect slot exists, return the best compromise and state exactly who's impacted.
8. If the meeting also needs a room, first narrow to attendee-compatible slots, then check likely rooms/resources (mined from past meetings) against those shortlisted times.

## Ranking heuristics

- Favor required-attendee fit over optional-attendee fit.
- Favor slots that avoid very early or very late local times for distributed attendees.
- Favor slots that preserve lunch and avoid consuming someone's only large free block unless the meeting is clearly important.
- Favor a small number of high-confidence options over a long weak list.
- When two slots are similar, prefer the one that causes less calendar fragmentation.

## Output conventions

- Return 2–4 candidate slots by default.
- For each slot, say why it works and who, if anyone, would be inconvenienced.
- If there's no clean option, say what tradeoff the best slot is making.

---

_Adapted from OpenAI's Codex google-calendar-group-scheduler skill (MIT)._
