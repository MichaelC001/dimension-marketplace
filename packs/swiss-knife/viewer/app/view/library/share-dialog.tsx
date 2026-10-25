import type { Audience } from "@dimension/sdk/artifact-share";
import { MenuItem } from "@fraym/ui/components/menu";
import { Button } from "@fraym/ui/elements/button";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Input } from "@fraym/ui/elements/input";
import { Modal } from "@fraym/ui/elements/popover";
import { Select } from "@fraym/ui/elements/select";
import { Icon, type IconName } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { LibraryItem, ShareSummary } from "../../../../src/library/types";
import { copyText } from "../copy";
import { FOCUS } from "../focus-ring";
import { CopyField } from "./copy-field";
import { errorText, type LibraryTools, type LinkedShare, type ShareChange, type ShareHost, type ShareHosts, type ShareProgress } from "./library-tools";
import { MenuSeparator, MoreMenu } from "./more-menu";
import {
	audienceFrom,
	audienceProblem,
	defaultExpiry,
	defaultHost,
	expiryChoices,
	fileChanged,
	HOST_SETUP,
	hostChoices,
	hostName,
	initials,
	linkChoice,
	parsePairing,
	peopleFrom,
	peopleOf,
	shortDate,
	signinChoice,
} from "./share-options";

export const PROGRESS_POLL_MS = 250;

const DAY_MS = 86_400_000;
const SAVED_HOLD_MS = 2400;
const ADD_HOST = "add-host";
const CURRENT = "current";
const NEVER = "never";

export interface ShareDialogProps {
	readonly tools: LibraryTools;
	readonly item: LibraryItem;
	readonly shareId: string | null;
	readonly onClose: () => void;
	readonly onCreated: (share: LinkedShare) => void;
	readonly onChanged: (share: ShareSummary) => void;
}

type View = "share" | "add-host" | "stop";

type Status =
	| { readonly kind: "idle" }
	| { readonly kind: "creating"; readonly progress: ShareProgress | null }
	| { readonly kind: "saving"; readonly text: string }
	| { readonly kind: "saved"; readonly text: string }
	| { readonly kind: "failed"; readonly error: string };

const IDLE: Status = { kind: "idle" };

function hostLabel(host: ShareHost): string {
	return host.kind === "p2p" ? "This computer — works while it is on" : host.name;
}

function progressText(progress: ShareProgress | null): string {
	const percent = progress === null || progress.total === 0 ? null : Math.min(100, Math.round((progress.sent / progress.total) * 100));
	if (progress === null || progress.phase === "sealing") return percent === null ? "Encrypting…" : `Encrypting… ${percent}%`;
	if (progress.phase === "uploading") return percent === null ? "Uploading…" : `Uploading… ${percent}%`;
	return "Finishing…";
}

function accessNote(kind: Audience["kind"], people: number, current: Audience["kind"] | undefined, local: boolean, server: string): string {
	if (kind === "link") return local ? "Anyone with the link can open it while this computer is on." : "Anyone with the link can open it.";
	if (people > 0) return `Only the people above can open it, after they sign in to ${server}.`;
	if (current === "link") return "It stays open to anyone with the link until you add someone above.";
	if (current === "signin") return `Anyone who signs in to ${server} can open it until you add people.`;
	return "Only people you add can open it, after they sign in. Add someone above.";
}

function Heading({ children }: { readonly children: ReactNode }) {
	return <h3 className="mb-2 text-fr-sm font-medium text-fr-text">{children}</h3>;
}

function Avatar({ children, icon }: { readonly children?: ReactNode; readonly icon?: IconName }) {
	return (
		<span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-fr-surface-3 text-fr-xs font-semibold text-fr-text-2">
			{icon === undefined ? children : <Icon name={icon} size={15} />}
		</span>
	);
}

export function ShareDialog({ tools, item, shareId, onClose, onCreated, onChanged }: ShareDialogProps) {
	const [ownId, setOwnId] = useState(shareId);
	const [own, setOwn] = useState<ShareSummary | null>(null);
	const existing = (ownId === null ? undefined : item.shares.find(share => share.id === ownId)) ?? (own !== null && own.id === ownId ? own : undefined);
	const [hosts, setHosts] = useState<ShareHosts | null>(null);
	const [hostsError, setHostsError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const [hostId, setHostId] = useState<string | null>(null);
	const [access, setAccess] = useState<Audience["kind"] | null>(existing?.audience.kind ?? null);
	const [people, setPeople] = useState<readonly string[]>(existing === undefined ? [] : peopleOf(existing.audience));
	const [allowComments, setAllowComments] = useState(existing?.allowComments ?? true);
	const [expiry, setExpiry] = useState<string | null>(existing === undefined ? null : CURRENT);
	const [view, setView] = useState<View>("share");
	const [status, setStatus] = useState<Status>(IDLE);
	const [stopNote, setStopNote] = useState<string | null>(null);
	const links = useRef(new Map<string, string>());
	const polling = useRef(0);
	const titleId = useId();
	useEffect(() => () => window.clearInterval(polling.current), []);

	useEffect(() => {
		let live = true;
		setHostsError(null);
		tools.hosts().then(
			answer => {
				if (live) setHosts(answer);
			},
			cause => {
				if (live) setHostsError(errorText(cause));
			},
		);
		return () => {
			live = false;
		};
	}, [tools, reload]);

	useEffect(() => {
		if (status.kind !== "saved") return;
		const timer = window.setTimeout(() => setStatus(current => (current === status ? IDLE : current)), SAVED_HOLD_MS);
		return () => window.clearTimeout(timer);
	}, [status]);

	const choices = hosts === null ? [] : hostChoices(hosts.hosts, item.size);
	const chosen = choices.find(choice => choice.host.id === hostId && choice.allowed) ?? choices.find(choice => choice.host.id === defaultHost(choices));
	const host = existing === undefined ? chosen?.host : hosts?.hosts.find(each => each.id === existing.host);
	const policy = host?.policy;
	const linkOk = linkChoice(policy).allowed;
	const signin = host === undefined ? { allowed: existing?.audience.kind === "signin", reason: undefined } : signinChoice(host);
	const wanted = access ?? (linkOk ? "link" : "signin");
	const kind: Audience["kind"] = wanted === "signin" ? (signin.allowed ? "signin" : "link") : linkOk ? "link" : "signin";
	const audience = audienceFrom(kind, people.join(" "));
	const problem = kind === "signin" && !signin.allowed ? signin.reason : audienceProblem(audience, policy);
	const needsPeople = kind === "signin" && people.length === 0;
	const managed = hosts?.hosts.some(each => each.managed) === true;
	const creating = status.kind === "creating";
	const syncing = ownId !== null && existing === undefined;
	const serverName = host === undefined ? (existing === undefined ? "the server" : hostName(existing.url)) : host.name;
	const expiries = expiryChoices(policy).filter(choice => existing === undefined || choice.days !== undefined);
	const fallbackExpiry = defaultExpiry(expiries);
	const expiryValue = expiry ?? (fallbackExpiry === undefined ? NEVER : String(fallbackExpiry));
	const expiryDays = expiryValue === NEVER || expiryValue === CURRENT ? undefined : Number(expiryValue);
	const canCreate = existing === undefined && !syncing && host !== undefined && problem === undefined && !needsPeople && !creating;
	const outdated = existing !== undefined && fileChanged(existing, item.mtimeMs);
	const name = item.title ?? item.name;

	const apply = (change: Omit<ShareChange, "shareId">): void => {
		if (existing === undefined) return;
		const before = existing;
		setStatus({ kind: "saving", text: "Saving…" });
		tools.changeShare({ shareId: before.id, ...change }).then(
			summary => {
				setOwn(summary);
				onChanged(summary);
				setStatus({ kind: "saved", text: "Saved" });
			},
			cause => {
				setAccess(before.audience.kind);
				setPeople(peopleOf(before.audience));
				setAllowComments(before.allowComments);
				setExpiry(CURRENT);
				setStatus({ kind: "failed", error: errorText(cause) });
			},
		);
	};

	const create = (): Promise<LinkedShare> => {
		const { promise, resolve, reject } = Promise.withResolvers<LinkedShare>();
		if (host === undefined) {
			reject(new Error("Choose where to share it from."));
			return promise;
		}
		const made = { host: host.id, audience, allowComments, expiresInDays: expiryDays };
		setStatus({ kind: "creating", progress: null });
		let settled = false;
		const settle = (): boolean => {
			if (settled) return false;
			settled = true;
			window.clearInterval(polling.current);
			return true;
		};
		const finish = (share: LinkedShare): void => {
			if (!settle()) return;
			links.current.set(share.id, share.link);
			setOwnId(share.id);
			setOwn(share);
			onCreated(share);
			resolve(share);
		};
		const fail = (error: string): void => {
			if (!settle()) return;
			setStatus({ kind: "failed", error });
			reject(new Error(error));
		};
		let linking = false;
		const fromProgress = (id: string): void => {
			if (linking) return;
			linking = true;
			tools.link(id).then(link => {
				const at = Date.now();
				finish({
					id,
					host: made.host,
					url: link.split("#")[0] ?? link,
					audience: made.audience,
					version: 1,
					versionAt: at,
					allowComments: made.allowComments,
					comments: 0,
					unread: 0,
					...(made.expiresInDays === undefined ? {} : { expiresAt: at + made.expiresInDays * DAY_MS }),
					link,
				});
			}, cause => fail(errorText(cause)));
		};
		polling.current = window.setInterval(() => {
			tools.shareProgress(item.id).then(
				progress => {
					if (settled) return;
					setStatus(current => (current.kind === "creating" ? { kind: "creating", progress } : current));
					if (progress.phase === "done" && progress.shareId !== undefined) fromProgress(progress.shareId);
					if (progress.phase === "failed") fail(progress.error ?? "The share could not be made.");
				},
				() => undefined,
			);
		}, PROGRESS_POLL_MS);
		tools.share({ artifactId: item.id, host: made.host, audience: made.audience, allowComments: made.allowComments, ...(made.expiresInDays === undefined ? {} : { expiresInDays: made.expiresInDays }) }).then(finish, cause => {
			if (settled) return;
			tools.shareProgress(item.id).then(
				progress => {
					if (settled || progress.phase === "sealing" || progress.phase === "uploading") return;
					if (progress.phase === "done" && progress.shareId !== undefined) fromProgress(progress.shareId);
					else fail(errorText(cause));
				},
				() => fail(errorText(cause)),
			);
		});
		return promise;
	};

	const copyLink = async (): Promise<void> => {
		if (creating || syncing) return;
		let target: { readonly id: string; readonly link: string };
		try {
			if (existing !== undefined) {
				const known = links.current.get(existing.id);
				target = { id: existing.id, link: known ?? (await tools.link(existing.id)) };
				links.current.set(existing.id, target.link);
			} else {
				if (!canCreate) return;
				const share = await create();
				target = { id: share.id, link: share.link };
			}
		} catch (cause) {
			setStatus({ kind: "failed", error: errorText(cause) });
			return;
		}
		const copied = await copyText(target.link);
		setStatus({ kind: "saved", text: copied ? "Link copied" : "The link is ready. Press Copy link to copy it." });
	};

	const done = (): void => {
		if (existing !== undefined || syncing || needsPeople) {
			onClose();
			return;
		}
		if (!canCreate) return;
		create().then(onClose, () => undefined);
	};

	const updateLink = (): void => {
		if (existing === undefined) return;
		setStatus({ kind: "saving", text: "Updating the link…" });
		tools.newVersion(existing.id).then(
			summary => {
				setOwn(summary);
				onChanged(summary);
				setStatus({ kind: "saved", text: "The link now shows the current file" });
			},
			cause => setStatus({ kind: "failed", error: errorText(cause) }),
		);
	};

	const stopSharing = (): void => {
		if (existing === undefined) return;
		const target = existing;
		setStatus({ kind: "saving", text: "Stopping…" });
		tools.revoke(target.id).then(
			outcome => {
				onChanged({ ...target, revokedAt: outcome.revokedAt });
				if (outcome.warning === undefined) {
					onClose();
					return;
				}
				setStatus(IDLE);
				setStopNote(outcome.warning);
			},
			cause => setStatus({ kind: "failed", error: errorText(cause) }),
		);
	};

	const onAccess = (next: Audience["kind"]): void => {
		setAccess(next);
		if (existing === undefined) return;
		if (next === "link") apply({ audience: { kind: "link" } });
		else if (people.length > 0) apply({ audience: audienceFrom("signin", people.join(" ")) });
	};

	const changePeople = (next: readonly string[]): void => {
		setPeople(next);
		if (next.length > 0) setAccess("signin");
		if (existing !== undefined && next.length > 0) apply({ audience: audienceFrom("signin", next.join(" ")) });
	};

	const onRole = (comment: boolean): void => {
		setAllowComments(comment);
		if (existing !== undefined) apply({ allowComments: comment });
	};

	const onExpiry = (value: string): void => {
		setExpiry(value);
		if (existing !== undefined && value !== CURRENT && value !== NEVER) apply({ expiresInDays: Number(value) });
	};

	const locked = creating || syncing || status.kind === "saving";
	const closing = creating ? () => undefined : onClose;

	return (
		<Modal aria-labelledby={titleId} onClose={closing} trapFocus className="w-[min(560px,calc(100vw-32px))]">
			<div data-slot="library-share" className="flex max-h-[min(760px,calc(100vh-48px))] flex-col">
				<div className="flex items-center gap-1.5 px-5 pb-3 pt-4">
					{view === "add-host" ? (
						<IconButton className={cn("-ml-2 size-8", FOCUS)} aria-label="Back" title="Back" disabled={locked} onClick={() => setView("share")}>
							<Icon name="back" size={16} />
						</IconButton>
					) : null}
					<h2 id={titleId} className="min-w-0 flex-1 truncate text-fr-lg font-semibold text-fr-text" title={name}>
						{view === "add-host" ? "Add a server" : view === "stop" ? (stopNote === null ? "Stop sharing?" : "Sharing stopped") : `Share “${name}”`}
					</h2>
					{existing !== undefined && view === "share" ? (
						<MoreMenu label="Link options">
							<MenuItem icon={<Icon name="refresh" size={14} />} disabled={locked} onClick={updateLink}>
								Update link to the current file
							</MenuItem>
							<MenuSeparator />
							<MenuItem icon={<Icon name="x" size={14} />} disabled={locked} onClick={() => setView("stop")} className="text-fr-del hover:bg-fr-del-bg hover:text-fr-del">
								Stop sharing
							</MenuItem>
						</MoreMenu>
					) : null}
					<IconButton className={cn("size-8", FOCUS)} aria-label="Close" title="Close" disabled={creating} onClick={onClose}>
						<Icon name="x" size={16} />
					</IconButton>
				</div>
				{view === "add-host" ? (
					<AddHost
						tools={tools}
						onCancel={() => setView("share")}
						onAdded={added => {
							setHostId(added.id);
							setReload(count => count + 1);
							setView("share");
						}}
					/>
				) : view === "stop" ? (
					<StopView
						note={stopNote}
						busy={status.kind === "saving"}
						error={status.kind === "failed" ? status.error : null}
						onCancel={() => {
							setStatus(IDLE);
							setView("share");
						}}
						onStop={stopSharing}
						onClose={onClose}
					/>
				) : (
					<>
						<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-5">
							{outdated ? (
								<div className="flex items-center gap-2.5 rounded-lg border border-fr-warn/30 bg-fr-warn/10 px-3 py-2 text-fr-sm text-fr-text">
									<Icon name="refresh" size={15} className="shrink-0 text-fr-warn" />
									<span className="min-w-0 flex-1">The file changed since you shared it.</span>
									<Button type="button" size="sm" variant="outline" disabled={locked} onClick={updateLink}>
										Update link
									</Button>
								</div>
							) : null}
							<PeopleInput disabled={locked || !signin.allowed} people={people} onAdd={added => changePeople([...people, ...added.filter(each => !people.includes(each))])} />
							{signin.allowed ? null : (
								<p className="-mt-3 text-fr-xs text-fr-text-3">
									Adding people needs a server with sign-in.{" "}
									{managed || existing !== undefined ? null : (
										<button type="button" className={cn("rounded-sm text-fr-accent-text hover:underline", FOCUS)} onClick={() => setView("add-host")}>
											Add a server
										</button>
									)}
								</p>
							)}
							<section>
								<Heading>People with access</Heading>
								<ul className="flex flex-col gap-2.5">
									<li className="flex items-center gap-3">
										<Avatar icon="user" />
										<span className="min-w-0 flex-1 text-fr-sm text-fr-text">You</span>
										<span className="text-fr-xs text-fr-text-3">Owner</span>
									</li>
									{kind === "signin"
										? people.map(person => (
												<li key={person} className="flex items-center gap-3">
													<Avatar>{person.startsWith("@") ? "@" : initials(person)}</Avatar>
													<span className="min-w-0 flex-1 truncate text-fr-sm text-fr-text" title={person}>
														{person.startsWith("@") ? `Anyone at ${person.slice(1)}` : person}
													</span>
													<IconButton
														className={cn("size-7", FOCUS)}
														aria-label={`Remove ${person}`}
														title={existing !== undefined && people.length === 1 ? "Add someone else first, or choose Anyone with the link" : `Remove ${person}`}
														disabled={locked || (existing !== undefined && people.length === 1)}
														onClick={() => changePeople(people.filter(each => each !== person))}
													>
														<Icon name="x" size={13} />
													</IconButton>
												</li>
											))
										: null}
								</ul>
							</section>
							<section>
								<Heading>General access</Heading>
								<div className="flex items-start gap-3">
									<Avatar icon={kind === "link" ? "globe" : "lock"} />
									<div className="min-w-0 flex-1">
										<Select variant="ghost" size="sm" aria-label="General access" className="-ml-[var(--fr-input-px)] w-auto font-medium" value={kind} disabled={locked} onChange={event => onAccess(event.target.value === "signin" ? "signin" : "link")}>
											<option value="signin" disabled={!signin.allowed}>
												Restricted
											</option>
											<option value="link" disabled={!linkOk}>
												Anyone with the link
											</option>
										</Select>
										<p className="mt-0.5 text-fr-xs text-fr-text-3">{accessNote(kind, people.length, existing?.audience.kind, host?.kind === "p2p" || existing?.host === "p2p", serverName)}</p>
									</div>
									<Select size="sm" aria-label="Role" className="w-auto shrink-0" value={allowComments ? "comment" : "view"} disabled={locked} onChange={event => onRole(event.target.value === "comment")}>
										<option value="view">Viewer</option>
										<option value="comment">Commenter</option>
									</Select>
								</div>
							</section>
							<div className="grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,180px)]">
								<section className="min-w-0">
									<Heading>Shared from</Heading>
									{existing !== undefined ? (
										<p className="flex min-w-0 items-center gap-2 text-fr-sm text-fr-text-2">
											<Icon name={existing.host === "p2p" ? "computer" : "cloud"} size={14} className="shrink-0 text-fr-text-3" />
											<span className="truncate">{host === undefined ? (existing.host === "p2p" ? "This computer — works while it is on" : serverName) : hostLabel(host)}</span>
										</p>
									) : hostsError !== null ? (
										<p role="alert" className="text-fr-sm text-fr-del">
											{hostsError}{" "}
											<button type="button" className={cn("rounded-sm text-fr-accent-text hover:underline", FOCUS)} onClick={() => setReload(count => count + 1)}>
												Try again
											</button>
										</p>
									) : hosts === null ? (
										<p className="text-fr-sm text-fr-text-3">Looking for your share servers…</p>
									) : (
										<>
											<Select
												size="sm"
												aria-label="Shared from"
												value={host?.id ?? ""}
												disabled={locked}
												onChange={event => {
													if (event.target.value === ADD_HOST) setView("add-host");
													else setHostId(event.target.value);
												}}
											>
												{host === undefined ? <option value="">No way to share yet</option> : null}
												{choices.map(choice => (
													<option key={choice.host.id} value={choice.host.id} disabled={!choice.allowed}>
														{hostLabel(choice.host)}
													</option>
												))}
												{managed ? null : <option value={ADD_HOST}>Add a server…</option>}
											</Select>
											{choices
												.filter(choice => !choice.allowed && choice.reason !== undefined)
												.map(choice => (
													<p key={choice.host.id} className="mt-1 text-fr-xs text-fr-text-3">
														{choice.host.name}: {choice.reason}
													</p>
												))}
										</>
									)}
								</section>
								<section className="min-w-0">
									<Heading>Link expires</Heading>
									<Select size="sm" aria-label="Link expires" value={expiryValue} disabled={locked} onChange={event => onExpiry(event.target.value)}>
										{existing === undefined ? null : <option value={CURRENT}>{existing.expiresAt === undefined ? "Never (current)" : `${shortDate(existing.expiresAt, Date.now())} (current)`}</option>}
										{expiries.map(choice => (
											<option key={choice.label} value={choice.days === undefined ? NEVER : String(choice.days)}>
												{existing === undefined || choice.days === undefined ? choice.label : `${choice.label} from now`}
											</option>
										))}
									</Select>
								</section>
							</div>
							<p className="-mt-2 flex items-start gap-2 text-fr-xs text-fr-text-3">
								<Icon name="lock" size={13} className="mt-px shrink-0" />
								Encrypted on this computer. The key lives only in the link; the server never sees the contents.
							</p>
							{problem === undefined || existing !== undefined ? null : <p className="text-fr-sm text-fr-warn">{problem}</p>}
						</div>
						<div className="flex items-center gap-3 border-t border-fr-border-soft px-5 py-3">
							<Button type="button" variant="outline" disabled={locked || (existing === undefined && !canCreate)} onClick={() => void copyLink()}>
								<Icon name="link" size={14} />
								Copy link
							</Button>
							<StatusLine status={status} />
							<Button type="button" disabled={creating || status.kind === "saving"} onClick={done}>
								Done
							</Button>
						</div>
					</>
				)}
			</div>
		</Modal>
	);
}

function StatusLine({ status }: { readonly status: Status }) {
	const text = status.kind === "creating" ? progressText(status.progress) : status.kind === "saving" || status.kind === "saved" ? status.text : status.kind === "failed" ? status.error : "";
	return (
		<p role={status.kind === "failed" ? "alert" : "status"} aria-live="polite" className={cn("min-w-0 flex-1 truncate text-right text-fr-xs", status.kind === "failed" ? "text-fr-del" : "text-fr-text-3")} title={text}>
			{status.kind === "saved" ? <Icon name="check" size={12} className="mr-1 inline text-fr-add" /> : null}
			{text}
		</p>
	);
}

function PeopleInput({ people, disabled, onAdd }: { readonly people: readonly string[]; readonly disabled: boolean; readonly onAdd: (people: readonly string[]) => void }) {
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const commit = (): void => {
		const { valid, invalid } = peopleFrom(draft);
		if (valid.length > 0) onAdd(valid);
		setDraft(invalid.join(" "));
		setError(invalid.length === 0 ? null : `“${invalid[0]}” is not an email or a domain.`);
	};
	return (
		<div>
			<Input
				aria-label="Add people and domains"
				placeholder="Add people and domains"
				value={draft}
				disabled={disabled}
				spellCheck={false}
				autoComplete="off"
				aria-invalid={error !== null}
				onChange={event => {
					setDraft(event.target.value);
					setError(null);
				}}
				onBlur={() => {
					if (draft.trim() !== "") commit();
				}}
				onKeyDown={event => {
					if ((event.key === "Enter" || event.key === "," || event.key === ";") && draft.trim() !== "") {
						event.preventDefault();
						commit();
					}
				}}
			/>
			{error === null ? null : <p className="mt-1 text-fr-xs text-fr-warn">{error}</p>}
			{people.length === 0 || disabled ? null : <p className="mt-1 text-fr-xs text-fr-text-3">Press Enter to add. An @domain lets in everyone there.</p>}
		</div>
	);
}

function StopView({ note, busy, error, onCancel, onStop, onClose }: { readonly note: string | null; readonly busy: boolean; readonly error: string | null; readonly onCancel: () => void; readonly onStop: () => void; readonly onClose: () => void }) {
	return (
		<>
			<div className="flex flex-col gap-3 px-5 pb-5">
				{note === null ? (
					<p className="text-fr-sm text-fr-text-2">Everyone who has the link loses access right away. Their comments stay here.</p>
				) : (
					<p className="text-fr-sm text-fr-text-2">Sharing stopped. The link no longer opens from this computer, but the relay could not be told: {note}</p>
				)}
				{error === null ? null : (
					<p role="alert" className="text-fr-sm text-fr-del">
						{error}
					</p>
				)}
			</div>
			<div className="flex justify-end gap-2 border-t border-fr-border-soft px-5 py-3">
				{note === null ? (
					<>
						<Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
							Cancel
						</Button>
						<Button type="button" variant="destructive" loading={busy} loadingText="Stopping…" onClick={onStop}>
							Stop sharing
						</Button>
					</>
				) : (
					<Button type="button" onClick={onClose}>
						Done
					</Button>
				)}
			</div>
		</>
	);
}

function AddHost({ tools, onAdded, onCancel }: { readonly tools: LibraryTools; readonly onAdded: (host: ShareHost) => void; readonly onCancel: () => void }) {
	const [pairing, setPairing] = useState("");
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [kind, setKind] = useState<"self" | "company">("self");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const paired = parsePairing(pairing);
	const manual = url.trim() !== "" && token.trim() !== "";
	const ready = paired !== null || (pairing.trim() === "" && manual);

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (!ready || busy) return;
		setBusy(true);
		setError(null);
		const request = paired !== null ? { ...paired, kind } : { url: url.trim(), token: token.trim(), kind };
		tools.addHost(request).then(onAdded, cause => {
			setBusy(false);
			setError(errorText(cause));
		});
	};

	return (
		<form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
				<p className="text-fr-sm text-fr-text-2">A server of your own keeps an encrypted copy, so the link works while this computer is off. On your server, from a Dimension checkout:</p>
				<ol className="flex flex-col gap-3">
					{HOST_SETUP.map((step, index) => (
						<li key={step.label} className="min-w-0">
							<Step number={index + 1}>{step.label}</Step>
							<CopyField text={step.command} label={step.label.toLowerCase()} />
						</li>
					))}
					<li className="min-w-0">
						<Step number={HOST_SETUP.length + 1}>Paste the link it prints</Step>
						<Input aria-label="Pairing link" value={pairing} onChange={event => setPairing(event.target.value)} placeholder="https://share.example.com/pair#t=…" spellCheck={false} disabled={busy} aria-invalid={pairing.trim() !== "" && paired === null} />
						{pairing.trim() !== "" && paired === null ? <p className="mt-1 text-fr-xs text-fr-warn">A pairing link starts with https:// and ends with #t= and a token.</p> : null}
					</li>
				</ol>
				<details className="group">
					<summary className={cn("flex cursor-pointer list-none items-center gap-1 rounded-sm text-fr-xs text-fr-text-3 hover:text-fr-text-2 [&::-webkit-details-marker]:hidden", FOCUS)}>
						<Icon name="caretR" size={12} className="transition-transform duration-[var(--fr-motion-fast)] group-open:rotate-90" />
						Or enter its address and upload token
					</summary>
					<div className="mt-2 flex flex-col gap-2">
						<Input aria-label="Server address" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://share.example.com" spellCheck={false} disabled={busy || pairing.trim() !== ""} />
						<Input aria-label="Upload token" type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Upload token" autoComplete="off" disabled={busy || pairing.trim() !== ""} />
					</div>
				</details>
				<label className="flex items-center justify-between gap-3">
					<span className="text-fr-sm text-fr-text">Whose server</span>
					<Select size="sm" className="w-auto" value={kind} disabled={busy} onChange={event => setKind(event.target.value === "company" ? "company" : "self")}>
						<option value="self">Mine</option>
						<option value="company">My company’s</option>
					</Select>
				</label>
				{error === null ? null : (
					<p role="alert" className="text-fr-sm text-fr-del">
						{error}
					</p>
				)}
			</div>
			<div className="flex justify-end gap-2 border-t border-fr-border-soft px-5 py-3">
				<Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
					Back
				</Button>
				<Button type="submit" loading={busy} loadingText="Checking the server…" disabled={!ready}>
					Add server
				</Button>
			</div>
		</form>
	);
}

function Step({ number, children }: { readonly number: number; readonly children: ReactNode }) {
	return (
		<div className="mb-1.5 flex items-center gap-2 text-fr-xs text-fr-text-2">
			<span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-fr-surface-3 text-fr-2xs font-semibold text-fr-text-2 tabular-nums">
				{number}
			</span>
			{children}
		</div>
	);
}
