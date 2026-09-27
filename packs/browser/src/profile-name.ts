/**
 * The profile-name grammar — the ONE rule every door that takes a profile name
 * applies: the MCP tools' input schema (server.ts), the runtime's filesystem
 * slug check (store.ts), and the Browser dock panel's sign-in form (dock/).
 *
 * Pure and dependency-free on purpose: the dock panel runs in the host's page,
 * so it cannot reach the rule through store.ts (node:fs) or connection.ts
 * (tldts), and a copy of the regex there would drift from the one the server
 * enforces.
 */

/** 1-48 chars of [a-z0-9_-], starting alphanumeric: no dots, separators or drive letters. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Reserved slug for the chrome-relay engine: the human's own running Chrome,
 * one cookie jar, one lease per profile root. No other engine accepts it, and
 * it is never reported.
 */
export const RELAY_PROFILE = "relay";

/** `raw` as the slug the runtime stores it under (trimmed, lower-cased), or null when it is not one. */
export function profileSlug(raw: string): string | null {
	const slug = raw.trim().toLowerCase();
	return PROFILE_NAME.test(slug) ? slug : null;
}
