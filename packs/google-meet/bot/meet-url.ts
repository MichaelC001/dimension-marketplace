// Shared Meet-URL gate for the google-meet plugin. It lives in its own leaf
// module because bot/meet-bot.ts runs as a DETACHED standalone script (it
// self-executes `process.exit(await run())` at module load), so ../bot.ts
// cannot import from it. Both sides import this instead — keeping the
// security-relevant URL regex a single source of truth that can't drift.

/** Match `https://meet.google.com/abc-defg-hij`, `.../lookup/<id>`, or `/new`.
 *  Anything else is rejected — explicit by design. Callers trim first. */
export const MEET_URL_RE =
	/^https:\/\/meet\.google\.com\/([a-z0-9]{3,}-[a-z0-9]{3,}-[a-z0-9]{3,}|lookup\/[^/?#]+|new)(?:[/?#].*)?$/;

/** Extract the `abc-defg-hij` meeting id, or a timestamped fallback for
 *  `lookup`/`new` URLs that carry no code. */
export function meetingIdFromUrl(url: string): string {
	const m = /meet\.google\.com\/([a-z0-9]{3,}-[a-z0-9]{3,}-[a-z0-9]{3,})/.exec(url ?? "");
	return m ? m[1] : `meet-${Date.now()}`;
}
