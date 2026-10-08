import { Button, Input } from "@fraym/ui";
import { useMemo, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/address.ts
var LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d{1,5})?(\/|$)/i;
var IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(:\d{1,5})?(\/|$)/;
/** `name.tld` with an optional port and path — the shape an address has
*  before anyone typed a scheme. The TLD is letters, at least two of them. */
var DOTTED_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(:\d{1,5})?(\/|[?#]|$)/i;
/** The browser only opens http and https. A bare host is guessed: https for
*  the public web, http for this machine and bare IPs (dev servers rarely
*  carry certificates). Anything else is refused with a sentence, not guessed
*  into a search — this browser has no search engine to send words to. */
function guessAddress(raw) {
	const text = raw.trim();
	if (text.length === 0) return {
		ok: false,
		reason: "Type an address, like example.com."
	};
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
	if (scheme === "http" || scheme === "https") try {
		return {
			ok: true,
			url: new URL(text).href
		};
	} catch {
		return {
			ok: false,
			reason: `“${text}” is not a valid address.`
		};
	}
	if (/\s/.test(text)) return {
		ok: false,
		reason: `“${text}” isn't an address. Try something like example.com.`
	};
	const local = LOCAL_HOST.test(text) || IPV4_HOST.test(text);
	if (scheme !== void 0 && !local && !/^[^:]+:\d/.test(text)) return {
		ok: false,
		reason: `Only http and https addresses can be opened here, not ${scheme}:.`
	};
	if (!local && !DOTTED_HOST.test(text)) return {
		ok: false,
		reason: `“${text}” isn't an address. Try something like ${text.toLowerCase()}.com.`
	};
	try {
		return {
			ok: true,
			url: new URL(`${local ? "http" : "https"}://${text}`).href
		};
	} catch {
		return {
			ok: false,
			reason: `“${text}” is not a valid address.`
		};
	}
}
//#endregion
//#region src/profile-name.ts
/**
* The saved profile a person's own Browser opens (the View's start page and the
* dock's "Open a page"). They never name it: the word "profile" stays out of
* the UI. An agent that passes no profile gets a throwaway browser instead.
*/
var DEFAULT_PROFILE = "default";
//#endregion
//#region src/dock/browser-accounts.tsx
function OpenPageForm({ openPage }) {
	const [text, setText] = useState("");
	const [isPrivate, setPrivate] = useState(false);
	const [problem, setProblem] = useState(null);
	const submit = (event) => {
		event.preventDefault();
		if (!openPage) return;
		if (text.trim().length === 0) {
			setProblem(null);
			openPage(null, isPrivate);
			return;
		}
		const guess = guessAddress(text);
		setProblem(guess.ok ? null : guess.reason);
		if (guess.ok) openPage(guess.url, isPrivate);
	};
	return /* @__PURE__ */ jsxs("form", {
		className: "flex flex-col gap-2 border-fr-border-soft border-b px-3 py-2",
		"data-slot": "browser-accounts-open",
		onSubmit: submit,
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "fr-eyebrow text-fr-text-3",
				children: "Open a page"
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-2",
				children: [/* @__PURE__ */ jsx(Input, {
					size: "sm",
					value: text,
					placeholder: "Type a website address",
					"aria-label": "Website address",
					"aria-invalid": problem !== null,
					"data-state": problem !== null ? "invalid" : void 0,
					onChange: (event) => {
						setText(event.target.value);
						setProblem(null);
					}
				}), /* @__PURE__ */ jsx(Button, {
					type: "submit",
					size: "sm",
					disabled: !openPage,
					children: "Open"
				})]
			}),
			/* @__PURE__ */ jsxs("label", {
				className: "flex items-center gap-2 text-fr-xs text-fr-text-2",
				children: [/* @__PURE__ */ jsx("input", {
					type: "checkbox",
					checked: isPrivate,
					onChange: (event) => setPrivate(event.target.checked)
				}), "Private — nothing is saved"]
			}),
			problem !== null ? /* @__PURE__ */ jsx("span", {
				className: "text-fr-xs text-fr-del",
				"data-slot": "browser-accounts-problem",
				children: problem
			}) : null
		]
	});
}
function BrowserAccounts({ sessionId, store }) {
	const openPage = useMemo(() => store && sessionId ? (url, isPrivate) => {
		const args = {};
		if (url !== null) args.url = url;
		if (!isPrivate) args.profile = DEFAULT_PROFILE;
		store.act("openArtifactoryView", {
			tool: "browser_view",
			args
		});
	} : null, [store, sessionId]);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto",
		"data-slot": "browser-accounts",
		children: [/* @__PURE__ */ jsx(OpenPageForm, { openPage }), !openPage ? /* @__PURE__ */ jsx("p", {
			className: "px-3 pb-3 text-fr-xs text-fr-text-3",
			"data-slot": "browser-accounts-hint",
			children: "Start or open a chat first — the browser opens beside it."
		}) : null]
	});
}
//#endregion
export { BrowserAccounts, BrowserAccounts as default };
