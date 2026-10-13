/**
 * When the pack looks at a saved profile's page for a sign-in, and by when it has written down what it saw. One module because the
 * runtime (which looks) and the View (which re-reads the profile list once a look has been noted) must agree on these numbers.
 */

/** A page that loads (or changes route) is looked at this long after the last such event, once. */
export const PROBE_DEBOUNCE_MS = 400;

/** How long the first look waits for the signed-in marker on a page where its absence decides: a single-page app draws it after `load`. */
export const SETTLE_MS = 3_000;

/**
 * The first look's miss is not a verdict: a page still drawing (a cold first load after a sign-in, a redirect chain) shows no marker yet and
 * is not signed out. The page is looked at once more, as it is, this long after, and only that miss is written down.
 */
export const RELOOK_MS = 4_000;

/** The note is written within this much after the look that makes it. */
const NOTE_SLACK_MS = 1_100;

/** After a page settles, a sign-in (the marker was there, or drew within SETTLE_MS) has been noted by now. */
export const SIGN_IN_NOTED_MS = PROBE_DEBOUNCE_MS + SETTLE_MS + NOTE_SLACK_MS;

/** After a page settles, a sign-out (the marker never drew, the re-look included) has been noted by now. */
export const SIGN_OUT_NOTED_MS = PROBE_DEBOUNCE_MS + SETTLE_MS + RELOOK_MS + NOTE_SLACK_MS;
