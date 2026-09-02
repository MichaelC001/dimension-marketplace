// Hand-written declarations for the vendored bird subset (plain JS, shipped
// without .d.ts upstream). Sibling to cookies.js so `./lib/cookies.js` resolves.
//
// CAREFUL: these are asserted, not derived — a wrong shape here type-checks
// clean and fails at runtime. This file was wrong once (declared the flat
// cookie object as the return value instead of the `{ cookies, warnings }`
// envelope), which silently disabled the free lane; caught by x-reads.probe.ts,
// not by the compiler. Verify against cookies.js before changing.
export interface ResolvedCookies {
	readonly authToken: string | null;
	readonly ct0: string | null;
	readonly cookieHeader: string | null;
	/** "CLI argument", "AUTH_TOKEN env", "Safari", "Chrome (Default)", … */
	readonly source: string | null;
}

export interface ResolvedCredentials {
	readonly cookies: ResolvedCookies;
	/** Why a lookup came up short — missing dep, locked keychain, absent cookie. */
	readonly warnings: readonly string[];
}

export interface ResolveCredentialsOptions {
	/** Highest priority; recorded as source "CLI argument". */
	readonly authToken?: string | undefined;
	readonly ct0?: string | undefined;
	/** Restrict browser probing, e.g. "safari" | "chrome" | "firefox". */
	readonly cookieSource?: string | undefined;
	/** Browser-extraction timeout. NOT `timeoutMs` — that name is silently ignored. */
	readonly cookieTimeoutMs?: number | undefined;
}

/** Resolve X cookies. Priority: explicit args > env (AUTH_TOKEN/TWITTER_AUTH_TOKEN,
 *  CT0/TWITTER_CT0) > browsers, unless BIRD_DISABLE_BROWSER_COOKIES is set.
 *  Browser extraction dynamically imports `@steipete/sweet-cookie` INSIDE this
 *  module and degrades to a warning when absent, so env-only use needs no dep. */
export function resolveCredentials(options?: ResolveCredentialsOptions): Promise<ResolvedCredentials>;
