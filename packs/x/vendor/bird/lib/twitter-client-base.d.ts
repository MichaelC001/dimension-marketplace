// Hand-written declarations for the vendored bird subset (plain JS upstream).
export interface TwitterClientCookies {
	readonly authToken: string;
	readonly ct0: string;
	readonly cookieHeader?: string | undefined;
}

export interface TwitterClientOptions {
	readonly cookies: TwitterClientCookies;
	readonly userAgent?: string | undefined;
	readonly timeoutMs?: number | undefined;
	readonly quoteDepth?: number | undefined;
}

/** Base client: cookie auth, X's public web bearer, and the runtime query-id
 *  cache (refreshed from X's own JS bundles, with baked-in fallbacks). */
export declare class TwitterClientBase {
	constructor(options: TwitterClientOptions);
}
