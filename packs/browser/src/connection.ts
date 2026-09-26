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

/**
 * Reserved slug for the chrome-relay engine: the human's own running Chrome,
 * one cookie jar, one lease per profile root. Never reported.
 */
export const RELAY_PROFILE = "relay";

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

/** Second-level public suffixes under which the registrable domain takes three labels. */
const TWO_LABEL_SUFFIXES: Readonly<Record<string, true>> = Object.fromEntries([
	"co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
	"com.au", "net.au", "org.au", "edu.au", "gov.au",
	"co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "co.in", "co.za", "co.il",
	"com.br", "com.mx", "com.ar", "com.cn", "com.hk", "com.sg", "com.tw", "com.tr",
].map((suffix) => [suffix, true]));
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The site key for an origin: its bare registrable domain ("https://www.x.com"
 * → "x.com", "https://old.reddit.com" → "reddit.com"). A host with no
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
	if (host.startsWith("[") || IPV4.test(host)) return host;
	const labels = host.split(".");
	if (labels.length < 2) return host;
	const keep = labels.length >= 3 && TWO_LABEL_SUFFIXES[labels.slice(-2).join(".")] === true ? 3 : 2;
	return labels.slice(-keep).join(".");
}

/**
 * The account name in the page text an account selector matched: its first
 * "@handle" token when it has one ("Alice @alice" → "@alice"), else the text
 * with whitespace collapsed. Undefined when there is nothing.
 */
export function accountFromText(text: string | null | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const handle = /@[\p{L}\p{N}_.-]+/u.exec(text)?.[0];
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
		for (let i = 0; i < count; i += 1) {
			const { profile, host, site } = entries[i];
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
