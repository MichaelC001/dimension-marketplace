// The panel's read of its own pack's connection fact. The fact is the host's
// `PluginConnectionFact` (`{ connected, account?, reported? }`), and `reported`
// carries what this pack's server last sent: `buildConnectionReport`'s
// `{ profiles: { <name>: { sites: { <host>: { signedIn, account?, observedAt } } } } }`
// (connection.ts). It has crossed a process boundary and the host Store, so it
// is narrowed here with the same per-site rule the server applies to its own
// saved observations (`ProfileStore.connections`): a malformed profile or site
// is skipped, never rendered and never thrown on.

/** The Store key the host publishes this pack's connection under — keyed by
 *  the MANIFEST id (`plugin.json` `name`), never the install key. The host
 *  admits a dock seat to this one key only when the seat is this pack's. */
export const CONNECTION_KEY = "plugin/browser/connection";

export interface SiteRow {
	readonly host: string;
	readonly signedIn: boolean;
	readonly account?: string;
	readonly observedAt: number;
}

export interface ProfileRow {
	readonly name: string;
	readonly sites: readonly SiteRow[];
}

/** A plain JSON object's entries, or none for anything else (null, an array, a primitive). */
function entriesOf(value: unknown): [string, unknown][] {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : [];
}

/** Every reported profile with its well-formed sites, both sorted by name.
 *  Empty when the pack has reported nothing yet, or retracted its report. */
export function profileRows(fact: unknown): readonly ProfileRow[] {
	const profiles = (fact as { reported?: { profiles?: unknown } } | null | undefined)?.reported?.profiles;
	const rows: ProfileRow[] = [];
	for (const [name, profile] of entriesOf(profiles)) {
		const sites = (profile as { sites?: unknown } | null)?.sites;
		if (typeof sites !== "object" || sites === null || Array.isArray(sites)) continue;
		const siteRows: SiteRow[] = [];
		for (const [host, value] of Object.entries(sites)) {
			const site = value as { signedIn?: unknown; account?: unknown; observedAt?: unknown } | null;
			if (typeof site?.signedIn !== "boolean" || typeof site.observedAt !== "number" || !Number.isFinite(site.observedAt)) continue;
			siteRows.push({
				host,
				signedIn: site.signedIn,
				...(typeof site.account === "string" && site.account.length > 0 ? { account: site.account } : {}),
				observedAt: site.observedAt,
			});
		}
		rows.push({ name, sites: siteRows.sort((a, b) => a.host.localeCompare(b.host)) });
	}
	return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** "just now", "5m ago", "3h ago", "2d ago" — for an epoch-ms observation. */
export function observedAgo(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
