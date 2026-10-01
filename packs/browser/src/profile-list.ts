/**
 * The saved profiles as an agent (and the View) reads them: `browser_profiles`.
 *
 * Built from what is already on disk and nothing else: the profile folder
 * names, each one's `profile.json` (label, colour) and its observations
 * (`connections.json`). It never opens a profile's Chrome folder, its
 * credentials or its lock, so a cookie, a password, a path or a browser id has
 * no way into the answer: every field below is named here, one by one, and no
 * stored record is passed through. The relay (the human's own Chrome) and the
 * throwaway browsers are not profiles and never appear.
 *
 * The sites are the SAME observations the dock panel shows (connection.ts
 * builds that report), read with the same rules (profile-meta.ts): an
 * observation over 7 days old is not claimed, and a site that was only visited
 * (no check exists for it) is the human's history, not the agent's business, so
 * it is left out here.
 */
import { reportableAccount } from "./connection.js";
import type { ProfileHolder, ProfileListing, ProfileSiteListing } from "./contracts.js";
import { effectiveSignedIn, resolveProfileMeta } from "./profile-meta.js";
import { RELAY_PROFILE } from "./profile-name.js";
import type { ProfileStore } from "./store.js";

/** The most profiles one answer to a model carries; the rest are counted, not listed. */
export const MAX_PROFILES_FOR_MODEL = 40;

/** Every saved profile, by slug. `holderOf` says who holds each, from the asking chat's side. */
export function buildProfileList(store: ProfileStore, holderOf: (slug: string) => ProfileHolder, now: number): ProfileListing[] {
	return store
		.list()
		.filter((slug) => slug !== RELAY_PROFILE)
		.map((slug): ProfileListing => {
			const { label, colour } = resolveProfileMeta(slug, store.meta(slug));
			const sites: ProfileSiteListing[] = [];
			for (const [site, observed] of Object.entries(store.connections(slug))) {
				const seen = new Date(observed.observedAt);
				if (observed.signedIn === null || Number.isNaN(seen.getTime())) continue;
				const account = reportableAccount(observed.account);
				sites.push({
					site,
					...(account === undefined ? {} : { account }),
					signedIn: effectiveSignedIn(observed.signedIn, observed.observedAt, now),
					seenAt: seen.toISOString(),
				});
			}
			sites.sort((a, b) => b.seenAt.localeCompare(a.seenAt) || a.site.localeCompare(b.site));
			return { name: slug, label, colour, heldBy: holderOf(slug), sites };
		});
}

/**
 * What a model is sent when there are more profiles than it should be: the ones
 * in use, then the ones signed in somewhere, then the rest, each by name; the
 * remainder counted in `omitted`. Agents leave profiles behind, and every line
 * is tokens on every call.
 */
export function profilesForModel(list: readonly ProfileListing[], max: number = MAX_PROFILES_FOR_MODEL): { profiles: ProfileListing[]; omitted?: number } {
	if (list.length <= max) return { profiles: [...list] };
	const rank = (profile: ProfileListing): number => (profile.heldBy !== null ? 0 : profile.sites.length > 0 ? 1 : 2);
	const kept = [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, max);
	return { profiles: kept.sort((a, b) => a.name.localeCompare(b.name)), omitted: list.length - max };
}
