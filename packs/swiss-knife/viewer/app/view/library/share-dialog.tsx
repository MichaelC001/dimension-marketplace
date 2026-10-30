import { initials } from "@dimension/mcp-app-kit/annotate";
import type { Audience } from "@dimension/sdk/artifact-share";
import { MenuItem } from "@fraym/ui/components/menu";
import { Badge } from "@fraym/ui/elements/badge";
import { Button } from "@fraym/ui/elements/button";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Input } from "@fraym/ui/elements/input";
import { Modal } from "@fraym/ui/elements/popover";
import { Select } from "@fraym/ui/elements/select";
import { Tip } from "@fraym/ui/elements/tooltip";
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
	CLOUD_HOST,
	defaultExpiry,
	defaultHost,
	expiryChoices,
	fileChanged,
	hostChoices,
	hostName,
	linkChoice,
	OWN_SERVER_PROMPT,
	type Place,
	placeOf,
	placesOf,
	parsePairing,
	peopleFrom,
	peopleOf,
	shortDate,
	signinChoice,
} from "./share-options";

export const PROGRESS_POLL_MS = 250;

const DAY_MS = 86_400_000;
const SAVED_HOLD_MS = 2400;
const CURRENT = "current";
const NEVER = "never";
const PAIRING = "pairing";

export interface ShareDialogProps {
	readonly tools: LibraryTools;
	readonly item: LibraryItem;
	readonly shareId: string | null;
	readonly onClose: () => void;
	readonly onCreated: (share: LinkedShare) => void;
	readonly onChanged: (share: ShareSummary) => void;
}

type View = "share" | "stop";

type Status =
	| { readonly kind: "idle" }
	| { readonly kind: "creating"; readonly progress: ShareProgress | null }
	| { readonly kind: "saving"; readonly text: string }
	| { readonly kind: "saved"; readonly text: string }
	| { readonly kind: "failed"; readonly error: string };

const IDLE: Status = { kind: "idle" };

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
	const [link, setLink] = useState<string | null>(null);
	const [linkError, setLinkError] = useState<string | null>(null);
	const [linkReload, setLinkReload] = useState(0);
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

	const existingId = existing?.id;
	useEffect(() => {
		if (existingId === undefined) return;
		const known = links.current.get(existingId);
		if (known !== undefined) {
			setLink(known);
			return;
		}
		let live = true;
		setLinkError(null);
		tools.link(existingId).then(
			found => {
				links.current.set(existingId, found);
				if (live) setLink(found);
			},
			cause => {
				if (live) setLinkError(errorText(cause));
			},
		);
		return () => {
			live = false;
		};
	}, [tools, existingId, linkReload]);

	const choices = hosts === null ? [] : hostChoices(hosts.hosts, item.size);
	const pairing = hostId === PAIRING;
	const chosen = pairing ? undefined : hostId === null ? choices.find(choice => choice.host.id === defaultHost(choices)) : choices.find(choice => choice.host.id === hostId && choice.allowed);
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
	const expiries = expiryChoices(host?.kind === "p2p" ? undefined : policy).filter(choice => existing === undefined || choice.days !== undefined);
	const fallbackExpiry = defaultExpiry(expiries);
	const expiryValue = expiry ?? (fallbackExpiry === undefined ? NEVER : String(fallbackExpiry));
	const expiryDays = expiryValue === NEVER || expiryValue === CURRENT ? undefined : Number(expiryValue);
	const canCreate = existing === undefined && !syncing && host !== undefined && problem === undefined && !needsPeople && !creating;
	const outdated = existing !== undefined && fileChanged(existing, item.mtimeMs);
	const name = item.title ?? item.name;
	const local = host?.kind === "p2p" || existing?.host === "p2p";

	const blocked = (): string | undefined => {
		if (canCreate || creating || existing !== undefined) return undefined;
		if (hosts === null) return undefined;
		if (pairing) return "Connect your server first.";
		if (host === undefined) return hostId === null ? "None of these can take the link right now." : "The place you picked cannot take the link right now.";
		if (needsPeople) return "Add someone, or choose Anyone with the link.";
		return problem;
	};

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
			reject(new Error("Choose where the link lives."));
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
			if (share.outcome === "created") onCreated(share);
			else onChanged(share);
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
			tools.link(id).then(found => {
				const at = Date.now();
				const known = item.shares.find(share => share.id === id);
				if (known !== undefined) {
					finish({ ...known, version: known.version + 1, versionAt: at, link: found, outcome: "updated" });
					return;
				}
				finish({
					id,
					host: made.host,
					url: found.split("#")[0] ?? found,
					audience: made.audience,
					version: 1,
					versionAt: at,
					allowComments: made.allowComments,
					comments: 0,
					unread: 0,
					...(made.expiresInDays === undefined ? {} : { expiresAt: at + made.expiresInDays * DAY_MS }),
					link: found,
					outcome: "created",
				});
			}, cause => fail(errorText(cause)));
		};
		polling.current = window.setInterval(() => {
			tools.shareProgress(item.id).then(
				progress => {
					if (settled) return;
					setStatus(current => (current.kind === "creating" ? { kind: "creating", progress } : current));
					if (progress.phase === "done" && progress.shareId !== undefined) fromProgress(progress.shareId);
					if (progress.phase === "failed") fail(progress.error ?? "The link could not be made.");
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

	const createLink = async (): Promise<void> => {
		if (!canCreate) return;
		let share: LinkedShare;
		try {
			share = await create();
		} catch {
			return;
		}
		setLink(share.link);
		const copied = await copyText(share.link);
		const done = { created: "Link created", updated: `The link you already shared now shows this version (v${share.version})`, unchanged: "This file already has this link" }[share.outcome];
		setStatus({ kind: "saved", text: copied ? `${done} and copied` : `${done}. Copy it below.` });
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
	const hint = blocked();

	const { places, servers, retryable } = hosts === null ? { places: [], servers: 0, retryable: false } : placesOf(hosts, choices);

	return (
		<Modal aria-labelledby={titleId} onClose={closing} trapFocus className="w-[min(560px,calc(100vw-32px))]">
			<div data-slot="library-share" className="flex max-h-[min(780px,calc(100vh-48px))] flex-col">
				<div className="flex items-center gap-1.5 px-5 pb-3 pt-4">
					<h2 id={titleId} className="min-w-0 flex-1 truncate text-fr-lg font-semibold text-fr-text" title={name}>
						{view === "stop" ? (stopNote === null ? "Stop sharing?" : "Sharing stopped") : `Share “${name}”`}
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
				{view === "stop" ? (
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
							{existing !== undefined ? (
								<section className="min-w-0">
									<Heading>Link</Heading>
									{link !== null ? (
										<CopyField text={link} label="link" />
									) : linkError !== null ? (
										<p role="alert" className="text-fr-sm text-fr-del">
											{linkError}{" "}
											<button type="button" className={cn("rounded-sm text-fr-accent-text hover:underline", FOCUS)} onClick={() => setLinkReload(count => count + 1)}>
												Try again
											</button>
										</p>
									) : (
										<p className="text-fr-sm text-fr-text-3">Reading the link…</p>
									)}
									<p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-fr-xs text-fr-text-3">
										<Icon name={existing.host === "p2p" ? "computer" : existing.host === CLOUD_HOST ? "cloud" : "box"} size={12} className="shrink-0" />
										<span className="truncate">{placeOf(existing)}</span>
									</p>
								</section>
							) : (
								<section className="min-w-0">
									<Heading>Where the link lives</Heading>
									{hostsError !== null ? (
										<p role="alert" className="text-fr-sm text-fr-del">
											{hostsError}{" "}
											<button type="button" className={cn("rounded-sm text-fr-accent-text hover:underline", FOCUS)} onClick={() => setReload(count => count + 1)}>
												Try again
											</button>
										</p>
									) : hosts === null ? (
										<p className="text-fr-sm text-fr-text-3">Checking where you can share from…</p>
									) : (
										<div role="radiogroup" aria-label="Where the link lives" className="flex flex-col gap-2">
											{places.map(place => (
												<PlaceCard key={place.id} place={place} selected={!pairing && host?.id === place.id} disabled={locked} onSelect={() => setHostId(place.id)} />
											))}
											{managed ? null : servers === 0 || pairing ? (
												<OwnServer
													tools={tools}
													selected={pairing}
													disabled={locked}
													onSelect={() => setHostId(PAIRING)}
													onAdded={added => {
														setHostId(added.id);
														setReload(count => count + 1);
													}}
												/>
											) : (
												<button type="button" className={cn("self-start rounded-sm text-fr-xs text-fr-accent-text hover:underline", FOCUS)} disabled={locked} onClick={() => setHostId(PAIRING)}>
													Connect another server
												</button>
											)}
											{retryable ? (
												<button type="button" className={cn("self-start rounded-sm text-fr-xs text-fr-accent-text hover:underline", FOCUS)} onClick={() => setReload(count => count + 1)}>
													Check again
												</button>
											) : null}
										</div>
									)}
								</section>
							)}
							{signin.allowed ? (
								<PeopleInput disabled={locked} people={people} onAdd={added => changePeople([...people, ...added.filter(each => !people.includes(each))])} />
							) : null}
							<section>
								<Heading>Who can open it</Heading>
								<ul className="mb-3 flex flex-col gap-2.5">
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
								<div className="flex items-start gap-3">
									<Avatar icon={kind === "link" ? "globe" : "lock"} />
									<div className="min-w-0 flex-1">
										{signin.allowed ? (
											<Select variant="ghost" size="sm" aria-label="General access" className="-ml-[var(--fr-input-px)] w-auto font-medium" value={kind} disabled={locked} onChange={event => onAccess(event.target.value === "signin" ? "signin" : "link")}>
												<option value="signin">Only people I add</option>
												<option value="link" disabled={!linkOk}>
													Anyone with the link
												</option>
											</Select>
										) : (
											<p className="text-fr-sm font-medium text-fr-text">Anyone with the link</p>
										)}
										<p className="mt-0.5 text-fr-xs text-fr-text-3">{accessNote(kind, people.length, existing?.audience.kind, local, serverName)}</p>
									</div>
									<Select size="sm" aria-label="They can" className="w-auto shrink-0" value={allowComments ? "comment" : "view"} disabled={locked} onChange={event => onRole(event.target.value === "comment")}>
										<option value="comment">Can comment</option>
										<option value="view">Can only view</option>
									</Select>
								</div>
							</section>
							<section className="flex items-center justify-between gap-3">
								<h3 className="text-fr-sm font-medium text-fr-text">Link expires</h3>
								<Select size="sm" aria-label="Link expires" className="w-auto" value={expiryValue} disabled={locked} onChange={event => onExpiry(event.target.value)}>
									{existing === undefined ? null : <option value={CURRENT}>{existing.expiresAt === undefined ? "Never (current)" : `${shortDate(existing.expiresAt, Date.now())} (current)`}</option>}
									{expiries.map(choice => (
										<option key={choice.label} value={choice.days === undefined ? NEVER : String(choice.days)}>
											{existing === undefined || choice.days === undefined ? choice.label : `${choice.label} from now`}
										</option>
									))}
								</Select>
							</section>
							<p className="-mt-2 flex items-start gap-2 text-fr-xs text-fr-text-3">
								<Icon name="lock" size={13} className="mt-px shrink-0" />
								Encrypted on this computer. The key lives only in the link, so no server can read the file.
							</p>
						</div>
						<div className="flex items-center gap-3 border-t border-fr-border-soft px-5 py-3">
							{status.kind === "idle" && hint !== undefined ? <p className="min-w-0 flex-1 truncate text-fr-xs text-fr-text-3" title={hint}>{hint}</p> : <StatusLine status={status} />}
							{existing === undefined ? (
								<>
									<Button type="button" variant="outline" disabled={creating} onClick={onClose}>
										Cancel
									</Button>
									<Button type="button" disabled={!canCreate} loading={creating} loadingText="Creating…" onClick={() => void createLink()}>
										<Icon name="link" size={14} />
										Create link
									</Button>
								</>
							) : (
								<Button type="button" disabled={status.kind === "saving"} onClick={onClose}>
									Done
								</Button>
							)}
						</div>
					</>
				)}
			</div>
		</Modal>
	);
}

const OWN_SERVER: Place = {
	id: PAIRING,
	icon: "box",
	title: "Your own server",
	detail: "A VPS or your company's server. Links stay up while this computer is off, and you choose who can sign in.",
	allowed: true,
};

function PlaceCard({ place, selected, disabled, onSelect, children }: { readonly place: Place; readonly selected: boolean; readonly disabled: boolean; readonly onSelect: () => void; readonly children?: ReactNode }) {
	const off = disabled || !place.allowed;
	return (
		<div
			data-slot="share-place"
			className={cn(
				"rounded-lg border transition-colors",
				selected ? "border-fr-accent bg-fr-accent/5" : "border-fr-border",
				!off && !selected && "hover:border-fr-control-edge-hover",
				!place.allowed && "opacity-60",
			)}
		>
			<div className="flex items-start gap-3 px-3 py-2.5">
				<button type="button" role="radio" aria-checked={selected} disabled={off} onClick={onSelect} className={cn("flex min-w-0 flex-1 items-start gap-3 rounded-md text-left disabled:cursor-not-allowed", FOCUS)}>
					<span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-fr-accent bg-fr-accent" : "border-fr-control-edge")}>
						{selected ? <span className="size-1.5 rounded-full bg-fr-accent-ink" /> : null}
					</span>
					<Icon name={place.icon} size={16} className="mt-0.5 shrink-0 text-fr-text-2" />
					<span className="min-w-0 flex-1">
						<span className="block text-fr-sm font-medium text-fr-text">{place.title}</span>
						<span className="mt-0.5 block text-fr-xs text-fr-text-3">{place.allowed || place.reason === undefined ? place.detail : place.reason}</span>
					</span>
				</button>
				{place.badge === undefined || !place.allowed ? null : (
					<Tip label={place.badge.tip} contentClassName="max-w-72 [&>span]:whitespace-normal">
						<Badge variant="soft" tone="mute" className="shrink-0" tabIndex={place.badge.tip === undefined ? undefined : 0}>
							{place.badge.text}
						</Badge>
					</Tip>
				)}
			</div>
			{children === undefined ? null : <div className="pb-3 pl-[4.25rem] pr-3">{children}</div>}
		</div>
	);
}

function OwnServer({ tools, selected, disabled, onSelect, onAdded }: { readonly tools: LibraryTools; readonly selected: boolean; readonly disabled: boolean; readonly onSelect: () => void; readonly onAdded: (host: ShareHost) => void }) {
	const [pairing, setPairing] = useState("");
	const [busy, setBusy] = useState(false);
	const [asked, setAsked] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const paired = parsePairing(pairing);

	const ask = (): void => {
		setError(null);
		setAsked(true);
		tools.askAgent(OWN_SERVER_PROMPT).catch((cause: unknown) => {
			setAsked(false);
			setError(errorText(cause));
		});
	};

	const connect = (event: FormEvent): void => {
		event.preventDefault();
		if (paired === null || busy) return;
		setBusy(true);
		setError(null);
		tools.addHost({ ...paired, kind: "self" }).then(onAdded, cause => {
			setBusy(false);
			setError(errorText(cause));
		});
	};

	return (
		<PlaceCard place={OWN_SERVER} selected={selected} disabled={disabled} onSelect={onSelect}>
			{selected ? (
				<form onSubmit={connect} className="flex flex-col gap-2.5">
					<Button type="button" variant="outline" size="sm" className="self-start" disabled={disabled || asked} onClick={ask}>
						<Icon name="bot" size={14} />
						{asked ? "Asked the agent" : "Ask an agent to set it up"}
					</Button>
					<p className="text-fr-xs text-fr-text-3">
						{asked ? "The agent in this conversation is setting it up. When it gives you a pairing link, paste it here." : "The agent installs the server on your machine and gives you a pairing link. No commands to type."}
					</p>
					<div className="flex items-center gap-2">
						<Input aria-label="Pairing link" className="min-w-0 flex-1" value={pairing} onChange={event => setPairing(event.target.value)} placeholder="Paste the pairing link" spellCheck={false} disabled={busy || disabled} aria-invalid={pairing.trim() !== "" && paired === null} />
						<Button type="submit" size="sm" loading={busy} loadingText="Checking…" disabled={paired === null || disabled}>
							Connect
						</Button>
					</div>
					{pairing.trim() !== "" && paired === null ? <p className="text-fr-xs text-fr-warn">A pairing link starts with https:// and ends with #t= and a token.</p> : null}
					{error === null ? null : (
						<p role="alert" className="text-fr-xs text-fr-del">
							{error}
						</p>
					)}
				</form>
			) : undefined}
		</PlaceCard>
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

