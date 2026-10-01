/**
 * What a person calls a saved profile, and how a profile's sign-in observations
 * are read — the ONE rule the agent's list (`browser_profiles`), the host
 * connection report and the dock panel share.
 *
 * Pure and dependency-free on purpose, like profile-name.ts: the dock panel
 * runs in the host's page, so it cannot reach this through store.ts
 * (node:fs). The slug (profile-name.ts) names the folder and never changes;
 * the label, colour and avatar here are separate, free to edit, and optional:
 * a profile with no metadata file gets defaults derived from its slug.
 */
import { loginSetLabel } from "./profile-name.js";

/** The fixed palette. A colour is one of these names, never a free value. */
export const PROFILE_COLOURS = ["blue", "orange", "green", "red", "purple", "pink", "teal", "grey"] as const;
export type ProfileColour = (typeof PROFILE_COLOURS)[number];

/** The longest label, in characters, after trimming. */
export const MAX_LABEL_CHARS = 48;

/** What a profile's metadata file holds. Every field is optional; a bad one is dropped, never trusted. */
export interface StoredProfileMeta {
	label?: string;
	colour?: ProfileColour;
	/** One emoji. Absent: the View draws the label's first letter. */
	avatar?: string;
	/** Epoch ms of the last open or close. */
	lastUsed?: number;
	/** The browser application that last ran this profile (`chrome`, `msedge`, ...): its cookies are encrypted for that build. */
	app?: string;
}

/** A profile as a person sees it: always a label and a colour. */
export interface ResolvedProfileMeta {
	label: string;
	colour: ProfileColour;
	avatar?: string;
}

/** `raw` as a label: trimmed, inner whitespace collapsed, control characters removed; undefined when blank or too long. */
export function cleanLabel(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	const label = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	return label.length > 0 && label.length <= MAX_LABEL_CHARS ? label : undefined;
}

/** One emoji (a ZWJ sequence or a variation selector counts as one), or undefined. */
const EMOJI = /^\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*$/u;
export function cleanAvatar(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length <= 16 && EMOJI.test(raw) ? raw : undefined;
}

export function isProfileColour(raw: unknown): raw is ProfileColour {
	return typeof raw === "string" && (PROFILE_COLOURS as readonly string[]).includes(raw);
}

/** A stable colour for a slug with none chosen: the same slug is always the same colour. */
export function defaultColour(slug: string): ProfileColour {
	let hash = 0;
	for (let i = 0; i < slug.length; i += 1) hash = (Math.imul(hash, 31) + slug.charCodeAt(i)) >>> 0;
	return PROFILE_COLOURS[hash % PROFILE_COLOURS.length] as ProfileColour;
}

/** `slug`'s label, colour and avatar: what was stored, else what the slug gives. */
export function resolveProfileMeta(slug: string, stored: StoredProfileMeta = {}): ResolvedProfileMeta {
	return {
		label: cleanLabel(stored.label) ?? loginSetLabel(slug),
		colour: isProfileColour(stored.colour) ? stored.colour : defaultColour(slug),
		...(cleanAvatar(stored.avatar) === undefined ? {} : { avatar: stored.avatar }),
	};
}

const fold = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The profiles `query` names, ignoring case and surrounding or repeated
 * spaces. A slug is a folder name, so it is unique: an exact slug names its
 * own profile and nothing else, however another profile is labelled (else a
 * label equal to a slug would make that profile impossible to open, `default`
 * included). Only when no slug is the query is it matched against labels, where
 * two profiles that differ only by case are both returned and the caller says
 * so. Nothing is ever the "closest": no match is empty.
 */
export function matchProfiles<T extends { slug: string; label: string }>(query: string, profiles: readonly T[]): T[] {
	const wanted = fold(query);
	if (wanted.length === 0) return [];
	const named = profiles.find((profile) => profile.slug === wanted);
	return named === undefined ? profiles.filter((profile) => fold(profile.label) === wanted) : [named];
}

/** A sign-in observation older than this is not evidence of anything now. */
export const SIGNED_IN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How far ahead of this clock an observation's time may be (two clocks, a resume) and still count as now. */
const CLOCK_SKEW_MS = 60_000;

/**
 * What an observation says NOW. `null` is "not known": the site was visited but
 * never checked, the check is over 7 days old, or its time is in the future
 * (a wrong clock or a copied file: a sign-in is not claimed for days that have
 * not happened). Signed in is never claimed from old data (nor signed out: a
 * session may have been renewed since).
 */
export function effectiveSignedIn(signedIn: boolean | null, observedAt: number, now: number): boolean | null {
	const age = now - observedAt;
	return signedIn !== null && age >= -CLOCK_SKEW_MS && age <= SIGNED_IN_MAX_AGE_MS ? signedIn : null;
}
