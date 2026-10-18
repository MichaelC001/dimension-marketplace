import { Button, Input, Select, type SelectOption } from "@fraym/ui";
import { type FormEvent, useMemo, useState, useSyncExternalStore } from "react";
import { guessAddress } from "../address";
import { DEFAULT_PROFILE } from "../profile-name";

export const CONNECTION_KEY = "plugin/browser/connection";

const PRIVATE_CHOICE = "";

export interface ConnectionObservable {
	getSnapshot(): unknown;
	subscribe(listener: () => void): () => void;
}

export interface BrowserStoreShape {
	act(intent: string, payload?: unknown): void;
	watch(key: string): ConnectionObservable;
}

export interface BrowserAccountsProps {
	readonly sessionId: string | null;
	readonly store?: BrowserStoreShape;
}

type ProfileChoice = string;

type OpenPage = (url: string | null, profile: ProfileChoice) => void;

const NO_CONNECTION: ConnectionObservable = { getSnapshot: () => undefined, subscribe: () => () => {} };

function ownRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

function reportedProfiles(fact: unknown): readonly SelectOption[] {
	const profiles = ownRecord(ownRecord(ownRecord(fact)?.reported)?.profiles) ?? {};
	const labelOf = (name: string): string => {
		const label = ownRecord(profiles[name])?.label;
		return typeof label === "string" && label.trim() !== "" ? label : name;
	};
	const saved = Object.keys(profiles).filter(name => name !== DEFAULT_PROFILE);
	return [
		{ value: DEFAULT_PROFILE, label: labelOf(DEFAULT_PROFILE) },
		...saved.map(name => ({ value: name, label: labelOf(name) })),
		{ value: PRIVATE_CHOICE, label: "Private — nothing is saved" },
	];
}

function OpenPageForm({ openPage, choices }: { readonly openPage: OpenPage | null; readonly choices: readonly SelectOption[] }) {
	const [text, setText] = useState("");
	const [profile, setProfile] = useState<ProfileChoice>(DEFAULT_PROFILE);
	const [problem, setProblem] = useState<string | null>(null);
	const chosen = choices.some(choice => choice.value === profile) ? profile : DEFAULT_PROFILE;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!openPage) return;
		if (text.trim().length === 0) {
			setProblem(null);
			openPage(null, chosen);
			return;
		}
		const guess = guessAddress(text);
		setProblem(guess.ok ? null : guess.reason);
		if (guess.ok) openPage(guess.url, chosen);
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
			<Select size="sm" aria-label="Profile" value={chosen} options={choices} onChange={event => setProfile(event.target.value)} />
			{problem !== null ? (
				<span className="text-fr-xs text-fr-del" data-slot="browser-accounts-problem">
					{problem}
				</span>
			) : null}
		</form>
	);
}

export function BrowserAccounts({ sessionId, store }: BrowserAccountsProps) {
	const connection = useMemo(() => store?.watch(CONNECTION_KEY) ?? NO_CONNECTION, [store]);
	const fact = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
	const choices = useMemo(() => reportedProfiles(fact), [fact]);
	const openPage = useMemo<OpenPage | null>(
		() =>
			store && sessionId
				? (url, profile) => {
						const args: { profile?: string; url?: string } = {};
						if (url !== null) args.url = url;
						if (profile !== PRIVATE_CHOICE) args.profile = profile;
						store.act("openArtifactoryView", { tool: "browser_view", args });
					}
				: null,
		[store, sessionId],
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-slot="browser-accounts">
			<OpenPageForm openPage={openPage} choices={choices} />
			{!openPage ? (
				<p className="px-3 pb-3 text-fr-xs text-fr-text-3" data-slot="browser-accounts-hint">
					Start or open a chat first — the browser opens beside it.
				</p>
			) : null}
		</div>
	);
}
