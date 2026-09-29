// The two "nothing here yet" surfaces. `StartPage` is what the View shows
// before a browser exists — and again after one ends: an address to open, and
// ONE folded row of choices about how. `BlankTab` covers a tab that is still at
// about:blank — a page with nothing on it is asked for an address, not shown as
// a white rectangle.
//
// Nothing here says "profile", "engine" or "relay". A person's browser keeps
// their sign-ins (the saved profile named `default`) unless they ask for a
// private one; other named sets and their own Chrome sit inside "Options".
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@fraym/ui/icons";
import { checkProfileName, DEFAULT_PROFILE, loginSetLabel } from "../../src/profile-name";
import { Omnibox, type OmniboxHandle, profileHue } from "./toolbar";
import { Overlays } from "./page-view";

export interface StartPageProps {
	/** The saved sets of logins that exist; null while they load. */
	readonly profiles: readonly string[] | null;
	readonly profilesError: string | null;
	/** The saved set the next browser opens with. */
	readonly profile: string;
	/** Open with nothing saved. */
	readonly isPrivate: boolean;
	/** Open in the Chrome the person is already signed in to. */
	readonly ownChrome: boolean;
	readonly opening: boolean;
	readonly error: string | null;
	/** The last browser ended: say so once, calmly, above the address. */
	readonly closed: boolean;
	readonly onProfile: (name: string) => void;
	readonly onPrivate: (on: boolean) => void;
	readonly onOwnChrome: (on: boolean) => void;
	/** Open with an address (may be empty: a blank tab). */
	readonly onOpen: (url: string) => void;
}

export function StartPage({ profiles, profilesError, profile, isPrivate, ownChrome, opening, error, closed, onProfile, onPrivate, onOwnChrome, onOpen }: StartPageProps) {
	const [expanded, setExpanded] = useState(false);
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const newRef = useRef<HTMLInputElement | null>(null);
	const omniRef = useRef<OmniboxHandle | null>(null);
	const panelId = useId();

	useEffect(() => {
		if (adding) newRef.current?.focus();
	}, [adding]);

	// The implicit set needs no picker: it appears once there is a second one to pick.
	const others = (profiles ?? []).filter(name => name !== DEFAULT_PROFILE);
	const pending = profile !== DEFAULT_PROFILE && !others.includes(profile);
	const picking = others.length > 0 || pending;
	const choosable = !opening && !isPrivate && !ownChrome;

	const stopAdding = () => {
		setAdding(false);
		setDraft("");
		setProblem(null);
	};

	const commitNew = () => {
		const check = checkProfileName(draft);
		if (!check.ok) {
			setProblem(check.problem);
			return;
		}
		onProfile(check.slug);
		stopAdding();
		omniRef.current?.focus();
	};

	const summary = ownChrome ? "Your Chrome" : isPrivate ? "Private" : profile !== DEFAULT_PROFILE ? `Saved logins: ${profile}` : null;

	return (
		<div className="bx-start" data-busy={opening || undefined}>
			<div className="bx-start-glow" aria-hidden="true" />
			<div className="bx-start-body">
				{closed && (
					<p className="bx-start-closed" role="status">
						This browser was closed.
					</p>
				)}

				<header className="bx-start-head">
					<span className="bx-start-mark" aria-hidden="true">
						<Icon name="globe" size={22} strokeWidth={1.6} />
					</span>
					<h1>Open a page</h1>
					<p>A browser you and your agent share — you both see the same page.</p>
				</header>

				<div className="bx-start-omni">
					<Omnibox
						ref={omniRef}
						url=""
						loading={false}
						disabled={opening}
						size="hero"
						placeholder="Type a website address"
						autoFocus
						allowEmpty
						onNavigate={url => onOpen(url)}
					/>
				</div>

				<div className="bx-start-foot">
					<button type="button" className="bx-start-open" disabled={opening} onClick={() => omniRef.current?.submit()}>
						{opening ? (
							<>
								<span className="bx-tab-spinner" aria-hidden="true" />
								Opening…
							</>
						) : (
							<>
								Open
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

				<section className="bx-options" aria-label="Options">
					<button type="button" className="bx-options-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(open => !open)}>
						<Icon name={expanded ? "caretD" : "caretR"} size={12} strokeWidth={2.25} />
						Options
						{summary !== null && <span className="bx-options-summary">{summary}</span>}
					</button>

					{expanded && (
						<div className="bx-options-panel" id={panelId}>
							<label className="bx-option">
								<input type="checkbox" checked={isPrivate} disabled={opening || ownChrome} onChange={event => onPrivate(event.target.checked)} />
								<span>Private — nothing is saved</span>
							</label>

							<div className="bx-option-block">
								{picking && (
									<>
										<span className="bx-start-label" id={`${panelId}-logins`}>
											Saved logins
										</span>
										<div className="bx-chips" role="radiogroup" aria-labelledby={`${panelId}-logins`}>
											{[DEFAULT_PROFILE, ...others].map(name => (
												<button
													key={name}
													type="button"
													role="radio"
													aria-checked={profile === name}
													className="bx-chip"
													disabled={!choosable}
													onClick={() => onProfile(name)}
												>
													<span className="bx-avatar" style={{ "--hue": profileHue(loginSetLabel(name)) } as CSSProperties} aria-hidden="true">
														{loginSetLabel(name)[0]?.toUpperCase()}
													</span>
													{loginSetLabel(name)}
												</button>
											))}
											{pending && (
												<button type="button" role="radio" aria-checked className="bx-chip" disabled={!choosable} onClick={() => onProfile(profile)}>
													<span className="bx-avatar" style={{ "--hue": profileHue(profile) } as CSSProperties} aria-hidden="true">
														{profile[0]?.toUpperCase()}
													</span>
													{profile}
													<span className="bx-chip-new">new</span>
												</button>
											)}
										</div>
									</>
								)}

								{adding ? (
									<form
										className="bx-option-add"
										onSubmit={event => {
											event.preventDefault();
											commitNew();
										}}
									>
										<input
											ref={newRef}
											className="bx-chip bx-chip-input"
											value={draft}
											placeholder="Name, like work"
											aria-label="Name for the new set of logins"
											aria-invalid={problem !== null || undefined}
											maxLength={64}
											onChange={event => {
												setDraft(event.target.value);
												setProblem(null);
											}}
											onKeyDown={event => {
												if (event.key === "Escape") {
													event.preventDefault();
													stopAdding();
												}
											}}
										/>
										<button type="submit" className="bx-chip bx-chip-add" disabled={draft.trim().length === 0}>
											Add
										</button>
										{problem !== null && <p className="bx-start-error">{problem}</p>}
									</form>
								) : (
									<button type="button" className="bx-chip bx-chip-add" disabled={!choosable} onClick={() => setAdding(true)}>
										<Icon name="plus" size={13} strokeWidth={2.25} />
										Add another login set
									</button>
								)}

								{profilesError !== null && <p className="bx-start-error">Couldn't load your saved logins ({profilesError}).</p>}
							</div>

							<div className="bx-option-block">
								<label className="bx-option">
									<input type="checkbox" checked={ownChrome} disabled={opening} onChange={event => onOwnChrome(event.target.checked)} />
									<span>Use my own Chrome (the one I'm signed in to)</span>
								</label>
								{ownChrome && <p className="bx-start-note">Your agent only sees the tabs opened here.</p>}
							</div>
						</div>
					)}
				</section>
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
