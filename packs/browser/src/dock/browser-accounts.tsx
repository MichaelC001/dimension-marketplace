// The Browser dock tab: a person opens a page in the live Browser beside the
// chat. Nothing else lives here. Profiles, sign-ins and which sites they are
// signed in to belong to the Browser itself (its profile menu), not to a second
// panel that is not a browser.
//
//   THE IMPORT SURFACE: `react` + the granted `@fraym/ui` bricks.
//
// INTENT: `store.act("openArtifactoryView", { tool: "browser_view", args })`,
// admitted by the `artifactory:open` grant the manifest declares. The host
// resolves the server itself (this pack's artifactory) and opens the View in
// the seat's session; a refusal is the host's console warning, never a throw.

import { Button, Input } from "@fraym/ui";
import { type FormEvent, useMemo, useState } from "react";
import { guessAddress } from "../address";
import { DEFAULT_PROFILE } from "../profile-name";

/** The Store's contract shape, restated by the members this panel uses. */
export interface BrowserStoreShape {
	act(intent: string, payload?: unknown): void;
}

/** The structural subset of `InstrumentContext` this instrument reads. */
export interface BrowserAccountsProps {
	readonly sessionId: string | null;
	readonly store?: BrowserStoreShape;
}

/** Open a page: `url` null is a blank browser; private opens with nothing saved. */
type OpenPage = (url: string | null, isPrivate: boolean) => void;

function OpenPageForm({ openPage }: { readonly openPage: OpenPage | null }) {
	const [text, setText] = useState("");
	const [isPrivate, setPrivate] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const submit = (event: FormEvent) => {
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
	return (
		<form className="flex flex-col gap-2 border-fr-border-soft border-b px-3 py-2" data-slot="browser-accounts-open" onSubmit={submit}>
			<span className="fr-eyebrow text-fr-text-3">Open a page</span>
			<div className="flex items-center gap-2">
				<Input
					size="sm"
					value={text}
					placeholder="Type a website address"
					aria-label="Website address"
					aria-invalid={problem !== null}
					data-state={problem !== null ? "invalid" : undefined}
					onChange={event => {
						setText(event.target.value);
						setProblem(null);
					}}
				/>
				<Button type="submit" size="sm" disabled={!openPage}>
					Open
				</Button>
			</div>
			<label className="flex items-center gap-2 text-fr-xs text-fr-text-2">
				<input type="checkbox" checked={isPrivate} onChange={event => setPrivate(event.target.checked)} />
				Private — nothing is saved
			</label>
			{problem !== null ? (
				<span className="text-fr-xs text-fr-del" data-slot="browser-accounts-problem">
					{problem}
				</span>
			) : null}
		</form>
	);
}

export function BrowserAccounts({ sessionId, store }: BrowserAccountsProps) {
	// The View opens in the seat's session, so with none there is nowhere to open it.
	const openPage = useMemo<OpenPage | null>(
		() =>
			store && sessionId
				? (url, isPrivate) => {
						const args: { profile?: string; url?: string } = {};
						if (url !== null) args.url = url;
						// A person's own browser keeps their logins: the saved set `default`, unless Private.
						if (!isPrivate) args.profile = DEFAULT_PROFILE;
						store.act("openArtifactoryView", { tool: "browser_view", args });
					}
				: null,
		[store, sessionId],
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-slot="browser-accounts">
			<OpenPageForm openPage={openPage} />
			{!openPage ? (
				<p className="px-3 pb-3 text-fr-xs text-fr-text-3" data-slot="browser-accounts-hint">
					Start or open a chat first — the browser opens beside it.
				</p>
			) : null}
		</div>
	);
}
