// The two "nothing here yet" surfaces. `StartPage` is what the View shows
// before a browser exists: who to be (profile), what to run (engine), where
// to go. `BlankTab` covers a tab that is still at about:blank — a page with
// nothing on it is asked for an address, not shown as a white rectangle.
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { BrowserEngine } from "../../src/contracts";
import { Icon } from "@fraym/ui/icons";
import { Omnibox, type OmniboxHandle, profileHue } from "./toolbar";
import { Overlays } from "./page-view";

/** The runtime's reserved slug for attached Chrome; other engines refuse it. */
export const RELAY_PROFILE = "relay";

const ENGINES: readonly { readonly value: BrowserEngine; readonly label: string; readonly detail: string }[] = [
	{ value: "chromium", label: "Chromium", detail: "Managed browser with its own persistent profile" },
	{ value: "chrome-relay", label: "Your Chrome", detail: "Attach to the Chrome you are signed in to" },
];

export interface StartPageProps {
	readonly profiles: readonly string[] | null;
	readonly profilesError: string | null;
	readonly profile: string;
	readonly engine: BrowserEngine;
	readonly opening: boolean;
	readonly error: string | null;
	readonly onProfile: (name: string) => void;
	readonly onEngine: (engine: BrowserEngine) => void;
	/** Open with an address (may be empty: a blank tab). */
	readonly onOpen: (url: string) => void;
}

export function StartPage({ profiles, profilesError, profile, engine, opening, error, onProfile, onEngine, onOpen }: StartPageProps) {
	const [creating, setCreating] = useState(false);
	const [draft, setDraft] = useState("");
	const newRef = useRef<HTMLInputElement | null>(null);
	const omniRef = useRef<OmniboxHandle | null>(null);
	const relay = engine === "chrome-relay";
	const list = profiles ?? [];

	useEffect(() => {
		if (creating) newRef.current?.focus();
	}, [creating]);

	const commitNew = () => {
		const name = draft.trim();
		setCreating(false);
		setDraft("");
		if (name.length > 0) onProfile(name);
	};

	const canOpen = !opening && (relay || profile.trim().length > 0);

	return (
		<div className="bx-start" data-busy={opening || undefined}>
			<div className="bx-start-glow" aria-hidden="true" />
			<div className="bx-start-body">
				<header className="bx-start-head">
					<span className="bx-start-mark" aria-hidden="true">
						<Icon name="globe" size={22} strokeWidth={1.6} />
					</span>
					<h1>Where to?</h1>
					<p>Open a browser your agent can see, drive, and be shown things in.</p>
				</header>

				<div className="bx-start-omni">
					<Omnibox
						ref={omniRef}
						url=""
						loading={false}
						disabled={!canOpen}
						size="hero"
						placeholder="Enter an address, or just press Enter"
						autoFocus
						allowEmpty
						onNavigate={url => onOpen(url)}
					/>
				</div>

				<section className="bx-start-section" aria-label="Engine">
					<div className="bx-engines" role="radiogroup" aria-label="Engine">
						{ENGINES.map(entry => (
							<button
								key={entry.value}
								type="button"
								role="radio"
								aria-checked={engine === entry.value}
								className="bx-engine"
								disabled={opening}
								onClick={() => onEngine(entry.value)}
							>
								<span className="bx-engine-label">{entry.label}</span>
								<span className="bx-engine-detail">{entry.detail}</span>
							</button>
						))}
					</div>
				</section>

				<section className="bx-start-section" aria-label="Profile">
					<h2 className="bx-start-label">{relay ? "Identity" : "Profile"}</h2>
					{relay ? (
						<p className="bx-start-note">Uses whoever is signed in to the attached Chrome. Only the tabs opened here are visible to the agent.</p>
					) : profiles === null ? (
						<div className="bx-chips" aria-busy="true">
							<span className="bx-chip bx-chip-skeleton" />
							<span className="bx-chip bx-chip-skeleton" />
						</div>
					) : (
						<div className="bx-chips" role="radiogroup" aria-label="Profile">
							{list.map(name => (
								<button
									key={name}
									type="button"
									role="radio"
									aria-checked={profile === name}
									className="bx-chip"
									disabled={opening}
									onClick={() => onProfile(name)}
								>
									<span className="bx-avatar" style={{ "--hue": profileHue(name) } as CSSProperties} aria-hidden="true">
										{name[0]?.toUpperCase()}
									</span>
									{name}
								</button>
							))}
							{!list.includes(profile) && profile.trim().length > 0 && (
								<button type="button" role="radio" aria-checked className="bx-chip" disabled={opening} onClick={() => onProfile(profile)}>
									<span className="bx-avatar" style={{ "--hue": profileHue(profile) } as CSSProperties} aria-hidden="true">
										{profile[0]?.toUpperCase()}
									</span>
									{profile}
									<span className="bx-chip-new">new</span>
								</button>
							)}
							{creating ? (
								<input
									ref={newRef}
									className="bx-chip bx-chip-input"
									value={draft}
									placeholder="Profile name"
									aria-label="New profile name"
									maxLength={64}
									onChange={event => setDraft(event.target.value)}
									onBlur={commitNew}
									onKeyDown={event => {
										if (event.key === "Enter") {
											event.preventDefault();
											commitNew();
											omniRef.current?.focus();
										} else if (event.key === "Escape") {
											setDraft("");
											setCreating(false);
										}
									}}
								/>
							) : (
								<button type="button" className="bx-chip bx-chip-add" disabled={opening} onClick={() => setCreating(true)}>
									<Icon name="plus" size={13} strokeWidth={2.25} />
									New profile
								</button>
							)}
						</div>
					)}
					{profilesError !== null && (
						<p className="bx-start-error" role="alert">
							Couldn't list profiles ({profilesError}) — a new name still opens one.
						</p>
					)}
				</section>

				<div className="bx-start-foot">
					<button type="button" className="bx-start-open" disabled={!canOpen} onClick={() => onOpen("")}>
						{opening ? (
							<>
								<span className="bx-tab-spinner" aria-hidden="true" />
								Opening…
							</>
						) : (
							<>
								Open browser
								<kbd>↵</kbd>
							</>
						)}
					</button>
					{error !== null && (
						<p className="bx-start-error" role="alert">
							<Icon name="warnTri" size={13} strokeWidth={2} />
							{error}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

export interface BlankTabProps {
	readonly disabled: boolean;
	readonly onNavigate: (url: string) => void;
	/** The same floating layers the page shows (agent pill, toasts). */
	readonly children?: ReactNode;
}

export function BlankTab({ disabled, onNavigate, children }: BlankTabProps) {
	return (
		<div className="bx-blank">
			<div className="bx-start-glow" aria-hidden="true" />
			<div className="bx-blank-body">
				<span className="bx-start-mark" aria-hidden="true">
					<Icon name="globe" size={22} strokeWidth={1.6} />
				</span>
				<Omnibox url="" loading={false} disabled={disabled} size="hero" placeholder="Enter an address" autoFocus onNavigate={onNavigate} />
				<p className="bx-blank-hint">
					<kbd>Ctrl</kbd>
					<kbd>L</kbd> address · <kbd>Ctrl</kbd>
					<kbd>T</kbd> new tab · <kbd>Ctrl</kbd>
					<kbd>W</kbd> close tab
				</p>
			</div>
			{children !== undefined && <Overlays>{children}</Overlays>}
		</div>
	);
}
