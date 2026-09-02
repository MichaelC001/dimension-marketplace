# Daily brief

Turn one day of Google Calendar events into a readable brief instead of a raw event dump. Use the `google_calendar_*` tools for the source data, then render the brief yourself in the shape below.

## Workflow

1. Resolve the date window explicitly in the user's timezone — `[local_midnight, next_local_midnight)`.
2. Fetch the day's events with `google_calendar_list_events({ calendarId, timeMin, timeMax })`. Default `calendarId` to `"primary"` unless the user names a different calendar (list them with `google_calendar_list_calendars`).
3. If the brief needs richer per-event metadata than the list summary provides (attendee emails, full notes, conferencing), pull that event with `google_calendar_get_event`.
4. Render the brief as Markdown in the shape below. Lightly adapt the lead-in or emphasis if the user asked for a narrower scope, a more compact answer, or a specific focus.

## Data source rules

- Use the calendar tools, not web search and not a manually reconstructed schedule.
- Query with explicit day boundaries in the user's timezone (pass `timeMin`/`timeMax`).
- Preserve titles exactly as returned by Google Calendar.

## Default shape

A good baseline:

- date header
- short top summary lines
- `Day Shape`
- `Agenda`
- optional `What Needs Attention`
- `Useful Readout`
- optional `Remaining Today`

Keep the tone compact and practical. Do not use a fenced code block for the agenda.

## Formatting rules

- Keep markers restrained — no heavy decoration unless the user asks.
- Keep the agenda to two columns only: `Time` and `Meeting`.
- Use bare compact agenda times like `10:00-10:15` without meridiem in each row.
- Allow short inline conflict annotations in the meeting column only for the representative event in a conflict cluster; keep the fuller overlap explanation in `What Needs Attention`.
- Do not wrap agenda table cells in backticks or inline code.
- Keep `Day Shape` and `Useful Readout` narrative rather than metric-heavy.
- Treat all-day markers as context, not meetings.
- Base free-window and lunch-window calculations on opaque timed events.
- Preserve event ordering by start time.
- Include `Remaining Today` only when summarizing the current day (you know the current time); omit it for future days.

---

_Adapted from OpenAI's Codex google-calendar-daily-brief skill (MIT). The original shipped a Python formatter; here the agent renders the brief directly._
