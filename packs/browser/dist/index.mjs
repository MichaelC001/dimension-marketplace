import { Button, Icon, Input, Pill, useObservable } from "@fraym/ui";
import { useEffect, useMemo, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/profile-name.ts
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
var PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/**
* Reserved slug for the chrome-relay engine: the human's own running Chrome,
* one cookie jar, one lease per profile root. No other engine accepts it, and
* it is never reported.
*/
var RELAY_PROFILE = "relay";
/** `raw` as the slug the runtime stores it under (trimmed, lower-cased), or null when it is not one. */
function profileSlug(raw) {
	const slug = raw.trim().toLowerCase();
	return PROFILE_NAME.test(slug) ? slug : null;
}
/** Every reported profile with its sites, both sorted by name. Empty when the
*  pack has reported nothing yet, or retracted its report. */
function profileRows(fact) {
	const profiles = fact?.reported?.profiles;
	if (!profiles) return [];
	return Object.entries(profiles).map(([name, { sites }]) => ({
		name,
		sites: Object.entries(sites).map(([host, site]) => ({
			host,
			...site
		})).sort((a, b) => a.host.localeCompare(b.host))
	})).sort((a, b) => a.name.localeCompare(b.name));
}
/** "just now", "5m ago", "3h ago", "2d ago" — for an epoch-ms observation. */
function observedAgo(at, now) {
	const seconds = Math.max(0, Math.round((now - at) / 1e3));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
//#endregion
//#region recipes/bluesky-post.json
var platform$2 = "Bluesky";
var origin$3 = "https://bsky.app";
//#endregion
//#region recipes/linkedin-post.json
var platform$1 = "LinkedIn";
var origin$2 = "https://www.linkedin.com";
//#endregion
//#region recipes/reddit-comment.json
var platform = "Reddit";
var origin$1 = "https://www.reddit.com";
//#endregion
//#region recipes/x-post.json
var origin = "https://x.com";
//#endregion
//#region src/dock/sites.ts
/** `connection.ts` keys a site by its registrable domain (tldts). Every preset
*  origin is either that domain or its `www.` host, so dropping the `www.`
*  yields the same key without shipping the Public Suffix List into the page. */
function fromPreset(platform, presetOrigin, loginPath) {
	const origin = new URL(presetOrigin);
	return {
		host: origin.hostname.replace(/^www\./, ""),
		label: platform,
		loginUrl: new URL(loginPath, origin).href
	};
}
var SIGN_IN_SITES = [
	fromPreset("X", origin, "/login"),
	fromPreset(platform$1, origin$2, "/login"),
	fromPreset(platform, origin$1, "/login"),
	fromPreset(platform$2, origin$3, "/")
];
var BY_HOST = new Map(SIGN_IN_SITES.map((site) => [site.host, site]));
/** The known site for a report key, if the panel has one. */
function knownSite(host) {
	return BY_HOST.get(host);
}
/** Where to start signing in to `host`: its login page when known, else the site itself. */
function signInUrl(host) {
	return BY_HOST.get(host)?.loginUrl ?? `https://${host}/`;
}
//#endregion
//#region src/dock/browser-accounts.tsx
var NONE = {
	getSnapshot: () => void 0,
	subscribe: () => () => {}
};
var MINUTE_MS = 6e4;
/** Why a typed profile name cannot be used, or null when it can. */
function profileProblem(raw) {
	const slug = profileSlug(raw);
	if (slug === null) return "Use 1–48 letters, digits, - or _, starting with a letter or digit.";
	if (slug === "relay") return `"${RELAY_PROFILE}" is reserved for your own Chrome.`;
	return null;
}
function SiteLine({ site, now, onSignIn }) {
	const label = knownSite(site.host)?.label ?? site.host;
	return /* @__PURE__ */ jsxs("li", {
		className: "flex min-w-0 items-center gap-2 py-1",
		"data-slot": "browser-accounts-site",
		"data-signed-in": site.signedIn,
		children: [/* @__PURE__ */ jsxs("span", {
			className: "flex min-w-0 flex-1 flex-col",
			children: [/* @__PURE__ */ jsxs("span", {
				className: "flex min-w-0 items-center gap-1.5",
				children: [/* @__PURE__ */ jsx("span", {
					className: "fr-overflow truncate text-fr-sm text-fr-text",
					children: label
				}), /* @__PURE__ */ jsx(Pill, {
					tint: site.signedIn ? "bg-fr-add-bg" : "bg-fr-warn/15",
					children: site.signedIn ? "Signed in" : "Signed out"
				})]
			}), /* @__PURE__ */ jsxs("span", {
				className: "fr-overflow truncate font-secondary text-fr-xs text-fr-text-3",
				children: [site.account ? `${site.account} · ` : "", observedAgo(site.observedAt, now)]
			})]
		}), /* @__PURE__ */ jsx(Button, {
			size: "sm",
			variant: site.signedIn ? "ghost" : "outline",
			disabled: !onSignIn,
			onClick: onSignIn ?? void 0,
			children: "Sign in"
		})]
	});
}
function ProfileSection({ profile, now, signIn, onPick }) {
	return /* @__PURE__ */ jsxs("section", {
		className: "flex flex-col border-fr-border-soft border-b px-3 py-2",
		"data-slot": "browser-accounts-profile",
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "flex min-w-0 items-center gap-1.5 text-left text-fr-text-2 hover:text-fr-text",
			title: "Use this profile for a new sign-in",
			onClick: onPick,
			children: [/* @__PURE__ */ jsx(Icon, {
				name: "user",
				size: 12
			}), /* @__PURE__ */ jsx("span", {
				className: "fr-overflow truncate font-secondary text-fr-xs",
				children: profile.name
			})]
		}), /* @__PURE__ */ jsx("ul", {
			className: "flex flex-col",
			children: profile.sites.map((site) => /* @__PURE__ */ jsx(SiteLine, {
				site,
				now,
				onSignIn: signIn ? () => signIn(profile.name, signInUrl(site.host)) : null
			}, site.host))
		})]
	});
}
function NewSignIn({ profile, onProfile, signIn }) {
	const [host, setHost] = useState(SIGN_IN_SITES[0]?.host ?? "");
	const [touched, setTouched] = useState(false);
	const problem = profileProblem(profile);
	const site = knownSite(host);
	const submit = (event) => {
		event.preventDefault();
		setTouched(true);
		const slug = profileSlug(profile);
		if (!signIn || !site || problem !== null || slug === null) return;
		signIn(slug, site.loginUrl);
	};
	return /* @__PURE__ */ jsxs("form", {
		className: "flex flex-col gap-2 px-3 py-2",
		"data-slot": "browser-accounts-new",
		onSubmit: submit,
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "fr-eyebrow text-fr-text-3",
				children: "New sign-in"
			}),
			/* @__PURE__ */ jsx("div", {
				className: "flex flex-wrap gap-1",
				role: "radiogroup",
				"aria-label": "Site",
				children: SIGN_IN_SITES.map((option) => /* @__PURE__ */ jsx(Button, {
					type: "button",
					size: "sm",
					variant: option.host === host ? "outline" : "ghost",
					role: "radio",
					"aria-checked": option.host === host,
					onClick: () => setHost(option.host),
					children: option.label
				}, option.host))
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-2",
				children: [/* @__PURE__ */ jsx(Input, {
					size: "sm",
					value: profile,
					placeholder: "Profile name, e.g. work",
					"aria-label": "Profile name",
					"aria-invalid": touched && problem !== null,
					"data-state": touched && problem !== null ? "invalid" : void 0,
					onChange: (event) => onProfile(event.target.value),
					onBlur: () => setTouched(profile.length > 0)
				}), /* @__PURE__ */ jsx(Button, {
					type: "submit",
					size: "sm",
					disabled: !signIn || profile.trim().length === 0,
					children: "Sign in"
				})]
			}),
			touched && problem !== null ? /* @__PURE__ */ jsx("span", {
				className: "text-fr-xs text-fr-del",
				children: problem
			}) : null
		]
	});
}
function BrowserAccounts({ sessionId, store }) {
	const fact = useObservable(useMemo(() => store?.watch("plugin/browser/connection") ?? NONE, [store]));
	const profiles = useMemo(() => profileRows(fact), [fact]);
	const [profile, setProfile] = useState("");
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	const signIn = useMemo(() => store && sessionId ? (name, url) => store.act("openArtifactoryView", {
		tool: "browser_open",
		args: {
			profile: name,
			url
		}
	}) : null, [store, sessionId]);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto",
		"data-slot": "browser-accounts",
		children: [
			profiles.map((row) => /* @__PURE__ */ jsx(ProfileSection, {
				profile: row,
				now,
				signIn,
				onPick: () => setProfile(row.name)
			}, row.name)),
			/* @__PURE__ */ jsx(NewSignIn, {
				profile,
				onProfile: setProfile,
				signIn
			}),
			!signIn ? /* @__PURE__ */ jsx("p", {
				className: "px-3 pb-3 text-fr-xs text-fr-text-3",
				children: "Open a session to sign in: the browser opens beside its chat."
			}) : profiles.length === 0 ? /* @__PURE__ */ jsx("p", {
				className: "px-3 pb-3 text-fr-xs text-fr-text-3",
				children: "The browser opens beside the chat and you sign in there; this panel then shows the account."
			}) : null
		]
	});
}
//#endregion
export { BrowserAccounts, BrowserAccounts as default };
