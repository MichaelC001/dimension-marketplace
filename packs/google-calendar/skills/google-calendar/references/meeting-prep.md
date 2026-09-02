# Meeting prep

Use this when the user wants a prep brief, not just the event details.

## Relevant tools

- `google_calendar_get_event` for the focal meeting — full detail: attendees with RSVP, description, recurrence, conferencing link, reminders.
- `google_calendar_list_events` when recurrence history, adjacent meetings, or same-day context matters to the brief.

## Workflow

1. Start from the event itself: title, description, attendees, recurrence context, and any obvious linked materials (via `google_calendar_get_event`).
2. If the event points to connected docs, decks, or notes and they're cheap to follow, inspect them before writing the brief.
3. Build the prep brief around what the meeting appears to be for, what decisions or inputs seem likely, and what context is attached versus missing.
4. Highlight what the user should read or prepare first rather than dumping every detail.
5. Stay close to the event and its linked context. Do broader research only if the user explicitly asks for it.

## Output conventions

- Lead with what this meeting appears to be about.
- Call out the most relevant attachments, notes, or linked docs.
- Separate confirmed context from missing context or open questions.
- End with a short "what to do before this meeting" list when there's enough evidence to support it.

---

_Adapted from OpenAI's Codex google-calendar-meeting-prep skill (MIT)._
