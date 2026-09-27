// The panel's read of its own pack's connection fact. The fact is the host's
// `PluginConnectionFact` (`{ connected, account?, reported? }`), and the host
// stamps `reported` from THIS pack's server only: it is exactly what
// `buildConnectionReport` last sent (connection.ts), so its shape is this
// pack's own contract and is asserted, not re-validated, here.

import type { ConnectionReport } from "../connection";

/** The Store key the host publishes this pack's connection under — keyed by
 *  the MANIFEST id (`plugin.json` `name`), never the install key. The host
 *  admits a dock seat to this one key only when the seat is this pack's. */
export const CONNECTION_KEY = "plugin/browser/connection";

/** The members of the host's `PluginConnectionFact` this panel reads. */
export interface ConnectionFact {
	readonly reported?: ConnectionReport;
}

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

/** Every reported profile with its sites, both sorted by name. Empty when the
 *  pack has reported nothing yet, or retracted its report. */
export function profileRows(fact: ConnectionFact | undefined): readonly ProfileRow[] {
	const profiles = fact?.reported?.profiles;
	if (!profiles) return [];
	return Object.entries(profiles)
		.map(([name, { sites }]) => ({
			name,
			sites: Object.entries(sites)
				.map(([host, site]) => ({ host, ...site }))
				.sort((a, b) => a.host.localeCompare(b.host)),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
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
