// The Browser panel — the dock instrument that shows which Browser profiles
// are signed in where, and starts a sign-in the person does THEMSELVES in the
// live Browser View beside the chat.
//
//   THE IMPORT SURFACE: `react` + the granted `@fraym/ui` bricks.
//
// DATA: this pack's own connection fact (`report.ts`), the one Store key the
// host admits this seat to beyond the public ones.
//
// INTENT: `store.act("openArtifactoryView", { tool: "browser_open", args })`,
// admitted by the `artifactory:open` grant the manifest declares. The host
// resolves the server itself (this pack's artifactory) and opens the View in
// the seat's session; a refusal is the host's console warning, never a throw.

import { Button, Icon, Input, Pill, useObservable } from "@fraym/ui";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { profileSlug, RELAY_PROFILE } from "../profile-name";
import { CONNECTION_KEY, observedAgo, type ProfileRow, profileRows, type SiteRow } from "./report";
import { knownSite, SIGN_IN_SITES, signInUrl } from "./sites";

/** The Store's contract shape, restated by the members this panel uses. */
export interface BrowserStoreShape {
	watch<T = unknown>(key: string): { getSnapshot(): T | undefined; subscribe(fn: () => void): () => void };
	act(intent: string, payload?: unknown): void;
}

/** The structural subset of `InstrumentContext` this instrument reads. */
export interface BrowserAccountsProps {
	readonly sessionId: string | null;
	readonly store?: BrowserStoreShape;
}

type SignIn = (profile: string, url: string) => void;

const NONE = { getSnapshot: () => undefined, subscribe: () => () => {} };
const MINUTE_MS = 60_000;

/** Why a typed profile name cannot be used, or null when it can. */
function profileProblem(raw: string): string | null {
	const slug = profileSlug(raw);
	if (slug === null) return "Use 1–48 letters, digits, - or _, starting with a letter or digit.";
	if (slug === RELAY_PROFILE) return `"${RELAY_PROFILE}" is reserved for your own Chrome.`;
	return null;
}

function SiteLine({ site, now, onSignIn }: { readonly site: SiteRow; readonly now: number; readonly onSignIn: (() => void) | null }) {
	const label = knownSite(site.host)?.label ?? site.host;
	return (
		<li className="flex min-w-0 items-center gap-2 py-1" data-slot="browser-accounts-site" data-signed-in={site.signedIn}>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="fr-overflow text-fr-sm text-fr-text">{label}</span>
					<Pill tint={site.signedIn ? "bg-fr-add-bg" : "bg-fr-warn/15"}>{site.signedIn ? "Signed in" : "Signed out"}</Pill>
				</span>
				<span className="fr-overflow font-secondary text-fr-xs text-fr-text-3">
					{site.account ? `${site.account} · ` : ""}
					{observedAgo(site.observedAt, now)}
				</span>
			</span>
			<Button size="sm" variant={site.signedIn ? "ghost" : "outline"} disabled={!onSignIn} onClick={onSignIn ?? undefined}>
				Sign in
			</Button>
		</li>
	);
}

function ProfileSection({
	profile,
	now,
	signIn,
	onPick,
}: {
	readonly profile: ProfileRow;
	readonly now: number;
	readonly signIn: SignIn | null;
	readonly onPick: () => void;
}) {
	return (
		<section className="flex flex-col border-fr-border-soft border-b px-3 py-2" data-slot="browser-accounts-profile">
			<button
				type="button"
				className="flex min-w-0 items-center gap-1.5 text-left text-fr-text-2 hover:text-fr-text"
				title="Use this profile for a new sign-in"
				onClick={onPick}
			>
				<Icon name="user" size={12} />
				<span className="fr-overflow font-secondary text-fr-xs">{profile.name}</span>
			</button>
			<ul className="flex flex-col">
				{profile.sites.map(site => (
					<SiteLine
						key={site.host}
						site={site}
						now={now}
						onSignIn={signIn ? () => signIn(profile.name, signInUrl(site.host)) : null}
					/>
				))}
			</ul>
		</section>
	);
}

function NewSignIn({ profile, onProfile, signIn }: { readonly profile: string; readonly onProfile: (value: string) => void; readonly signIn: SignIn | null }) {
	const [host, setHost] = useState(SIGN_IN_SITES[0]?.host ?? "");
	const [touched, setTouched] = useState(false);
	const problem = profileProblem(profile);
	const site = knownSite(host);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		setTouched(true);
		const slug = profileSlug(profile);
		if (!signIn || !site || problem !== null || slug === null) return;
		signIn(slug, site.loginUrl);
	};
	return (
		<form className="flex flex-col gap-2 px-3 py-2" data-slot="browser-accounts-new" onSubmit={submit}>
			<span className="fr-eyebrow text-fr-text-3">New sign-in</span>
			<div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Site">
				{SIGN_IN_SITES.map(option => (
					<Button
						key={option.host}
						type="button"
						size="sm"
						variant={option.host === host ? "outline" : "ghost"}
						role="radio"
						aria-checked={option.host === host}
						onClick={() => setHost(option.host)}
					>
						{option.label}
					</Button>
				))}
			</div>
			<div className="flex items-center gap-2">
				<Input
					size="sm"
					value={profile}
					placeholder="Profile name, e.g. work"
					aria-label="Profile name"
					aria-invalid={touched && problem !== null}
					data-state={touched && problem !== null ? "invalid" : undefined}
					onChange={event => onProfile(event.target.value)}
					onBlur={() => setTouched(profile.length > 0)}
				/>
				<Button type="submit" size="sm" disabled={!signIn || profile.trim().length === 0}>
					Sign in
				</Button>
			</div>
			{touched && problem !== null ? <span className="text-fr-xs text-fr-del">{problem}</span> : null}
		</form>
	);
}

export function BrowserAccounts({ sessionId, store }: BrowserAccountsProps) {
	const observable = useMemo(() => store?.watch(CONNECTION_KEY) ?? NONE, [store]);
	const fact = useObservable(observable);
	const profiles = useMemo(() => profileRows(fact), [fact]);
	const [profile, setProfile] = useState("");
	// Observations are minutes-to-days old; a minute tick keeps "5m ago" honest
	// without re-rendering on every frame.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	// The View opens in the seat's session, so with none there is nowhere to open it.
	const signIn = useMemo<SignIn | null>(
		() =>
			store && sessionId
				? (name, url) => store.act("openArtifactoryView", { tool: "browser_open", args: { profile: name, url } })
				: null,
		[store, sessionId],
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-slot="browser-accounts">
			{profiles.map(row => (
				<ProfileSection key={row.name} profile={row} now={now} signIn={signIn} onPick={() => setProfile(row.name)} />
			))}
			<NewSignIn profile={profile} onProfile={setProfile} signIn={signIn} />
			{!signIn ? (
				<p className="px-3 pb-3 text-fr-xs text-fr-text-3">Open a session to sign in: the browser opens beside its chat.</p>
			) : profiles.length === 0 ? (
				<p className="px-3 pb-3 text-fr-xs text-fr-text-3">
					The browser opens beside the chat and you sign in there; this panel then shows the account.
				</p>
			) : null}
		</div>
	);
}
