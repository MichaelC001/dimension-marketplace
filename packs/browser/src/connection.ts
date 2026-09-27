/**
 * The connection report — which profiles are signed in to which sites, as the
 * Browser pack tells its host (dimension#1219) so Traction can show whether an
 * account can post.
 *
 * Pure: observations in, report out. Nothing here reads a page, a file or the
 * credential store. A site is only ever in a report because a publish check
 * saw the signed-in marker (or its absence), or a publish reached `posted`
 * (runtime.ts records those, store.ts persists them per profile). A host never
 * observed is absent, never `signedIn: false`.
 */
import { getDomain } from "tldts";
import { RELAY_PROFILE } from "./profile-name.js";

/**
 * The vendor notification the host listens for on the pack's own MCP server.
 * Mirrors `PACK_CONNECTION_REPORT_METHOD` from `@dimension/sdk/artifactory`
 * (not yet published); keep the two identical.
 */
export const PACK_CONNECTION_REPORT_METHOD = "notifications/ai.insodimension/connection";
/**
 * The host silently drops a notification whose report JSON is larger, or whose
 * `account` is longer. Mirror `PACK_CONNECTION_REPORT_MAX_BYTES` and
 * `PACK_CONNECTION_ACCOUNT_MAX_BYTES` from `@dimension/sdk/artifactory`.
 */
export const PACK_CONNECTION_REPORT_MAX_BYTES = 64 * 1024;
export const PACK_CONNECTION_ACCOUNT_MAX_BYTES = 256;

/** What one observation saw for one site on one profile. `observedAt` is epoch ms. */
export interface SiteObservation {
	signedIn: boolean;
	account?: string;
	observedAt: number;
}
/** One profile's observations, keyed by site host. */
export type SiteObservations = Record<string, SiteObservation>;
/** Every profile's observations, keyed by profile name. */
export type ConnectionObservations = Record<string, SiteObservations>;
/** The `report` param: the full current map. Each one replaces the last wholesale. */
export interface ConnectionReport {
	profiles: Record<string, { sites: SiteObservations }>;
}
export interface ConnectionReportParams {
	/** `null` retracts the report. */
	report: ConnectionReport | null;
	account?: string;
	[key: string]: unknown;
}

/** The registrable domain under the full Public Suffix List, private suffixes included ("alice.github.io" is a site). */
const PSL = { allowPrivateDomains: true, extractHostname: false } as const;
/** An "@handle" not preceded by a word character, so an email's "@domain" is never one. */
const HANDLE = /(?<![\p{L}\p{N}_])@[\p{L}\p{N}_.-]+/gu;

/**
 * The site key for an origin: its bare registrable domain (eTLD+1 under the
 * Public Suffix List: "https://www.x.com" → "x.com", "https://shop.example.com.my"
 * → "example.com.my", "https://alice.github.io" → itself). A host with no
 * registrable domain (an IP literal, `localhost`) keys as itself. Null for
 * anything that is not an http(s) URL.
 */
export function siteHost(origin: string): string | null {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const host = url.hostname.replace(/\.$/, "");
	return getDomain(host, PSL) ?? host;
}

/**
 * The account name in the page text an account selector matched: its LAST
 * "@handle" token when it has one (X renders the display name, which may hold
 * a mention, before the handle: "Jane (CEO @acme) @jane" → "@jane"; an email's
 * "@domain" is never a handle), else the text with whitespace collapsed.
 * Undefined when there is nothing.
 */
export function accountFromText(text: string | null | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const handle = text.match(HANDLE)?.at(-1);
	const account = handle ?? text.replace(/\s+/g, " ").trim();
	return account.length > 0 ? account : undefined;
}

/**
 * The report for `observations`: every profile except `relay`, every observed
 * site. It always fits the host's caps: an account over 256 UTF-8 bytes is
 * omitted (a cut-off handle would name a different account), and while the
 * report JSON is over 64 KiB the oldest observations are dropped.
 */
export function buildConnectionReport(observations: ConnectionObservations): ConnectionReport {
	const entries: Array<{ profile: string; host: string; site: SiteObservation }> = [];
	for (const [profile, sites] of Object.entries(observations)) {
		if (profile === RELAY_PROFILE) continue;
		for (const [host, observed] of Object.entries(sites)) {
			const site: SiteObservation = { signedIn: observed.signedIn, observedAt: observed.observedAt };
			if (observed.account !== undefined && Buffer.byteLength(observed.account, "utf8") <= PACK_CONNECTION_ACCOUNT_MAX_BYTES) site.account = observed.account;
			entries.push({ profile, host, site });
		}
	}
	// Newest first, so keeping a prefix drops the oldest.
	entries.sort((a, b) => b.site.observedAt - a.site.observedAt);
	const assemble = (count: number): ConnectionReport => {
		const profiles: ConnectionReport["profiles"] = {};
		for (const [index, { profile, host, site }] of entries.entries()) {
			if (index >= count) break;
			(profiles[profile] ??= { sites: {} }).sites[host] = site;
		}
		return { profiles };
	};
	const fits = (report: ConnectionReport): boolean => Buffer.byteLength(JSON.stringify(report), "utf8") <= PACK_CONNECTION_REPORT_MAX_BYTES;
	const whole = assemble(entries.length);
	if (fits(whole)) return whole;
	// Dropping entries never grows the JSON: binary-search the largest newest prefix that fits.
	let low = 0;
	let high = entries.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(assemble(mid))) low = mid;
		else high = mid - 1;
	}
	return assemble(low);
}
