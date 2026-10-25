import type { Audience } from "@dimension/sdk/artifact-share";
import { Button } from "@fraym/ui/elements/button";
import { Input } from "@fraym/ui/elements/input";
import { Modal } from "@fraym/ui/elements/popover";
import { Select } from "@fraym/ui/elements/select";
import { Switch } from "@fraym/ui/elements/switch";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import { FOCUS } from "../focus-ring";
import { formatBytes } from "../format";
import { CopyField } from "./copy-field";
import { errorText, type LibraryTools, type LinkedShare, type ShareHost, type ShareHosts, type ShareProgress } from "./library-tools";
import {
	audienceFrom,
	type Choice,
	audienceProblem,
	defaultExpiry,
	defaultHost,
	expiryChoices,
	hostChoices,
	INSTALL_COMMAND,
	linkChoice,
	parsePairing,
	parseRecipients,
	signinChoice,
} from "./share-options";

export const PROGRESS_POLL_MS = 250;

export interface ShareDialogProps {
	readonly tools: LibraryTools;
	readonly item: LibraryItem;
	readonly onClose: () => void;
	readonly onShared: (share: LinkedShare) => void;
}

type Stage =
	| { readonly name: "form" }
	| { readonly name: "add-host" }
	| { readonly name: "working"; readonly progress: ShareProgress | null }
	| { readonly name: "done"; readonly share: LinkedShare }
	| { readonly name: "failed"; readonly error: string };

const HOST_ICON: Record<ShareHost["kind"], "computer" | "cloud" | "shield" | "globe"> = {
	p2p: "computer",
	self: "cloud",
	company: "shield",
	dimension: "globe",
};

const HOST_NOTE: Record<ShareHost["kind"], string> = {
	p2p: "Nothing is uploaded. The link works while this computer is on and Dimension is running.",
	self: "Your server keeps an encrypted copy; the link works any time.",
	company: "Your company’s server keeps an encrypted copy under its rules.",
	dimension: "Dimension cloud keeps an encrypted copy; it cannot read it.",
};

function Section({ label, children }: { readonly label: string; readonly children: ReactNode }) {
	return (
		<fieldset className="mt-4 min-w-0">
			<legend className="mb-1.5 text-fr-xs font-semibold text-fr-text-2">{label}</legend>
			{children}
		</fieldset>
	);
}

function Option({ selected, disabled, onSelect, icon, title, detail, reason }: { readonly selected: boolean; readonly disabled: boolean; readonly onSelect: () => void; readonly icon: "computer" | "cloud" | "shield" | "globe" | "link" | "lock"; readonly title: string; readonly detail?: string; readonly reason?: string }) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			disabled={disabled}
			onClick={onSelect}
			className={cn(
				"flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-left disabled:cursor-not-allowed",
				selected ? "border-fr-accent bg-fr-accent-dim" : "border-fr-border-soft bg-fr-surface-2 hover:border-fr-border",
				disabled && "opacity-60",
				FOCUS,
			)}
		>
			<Icon name={icon} size={16} className={cn("mt-0.5 shrink-0", selected ? "text-fr-accent" : "text-fr-text-3")} />
			<span className="min-w-0 flex-1">
				<span className="block text-fr-sm text-fr-text">{title}</span>
				{detail === undefined ? null : <span className="block text-fr-xs text-fr-text-3">{detail}</span>}
				{reason === undefined ? null : <span className="block text-fr-xs text-fr-warn">{reason}</span>}
			</span>
		</button>
	);
}

export function ShareDialog({ tools, item, onClose, onShared }: ShareDialogProps) {
	const [hosts, setHosts] = useState<ShareHosts | null>(null);
	const [hostsError, setHostsError] = useState<string | null>(null);
	const [hostId, setHostId] = useState<string | null>(null);
	const [audienceKind, setAudienceKind] = useState<Audience["kind"]>("link");
	const [recipients, setRecipients] = useState("");
	const [expiry, setExpiry] = useState<number | undefined>(undefined);
	const [allowComments, setAllowComments] = useState(true);
	const [stage, setStage] = useState<Stage>({ name: "form" });
	const [reload, setReload] = useState(0);
	const recipientsId = useId();
	const polling = useRef(0);
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

	const choices = hosts === null ? [] : hostChoices(hosts.hosts, item.size);
	const chosen = choices.find(choice => choice.host.id === hostId && choice.allowed) ?? choices.find(choice => choice.host.id === defaultHost(choices));
	const host = chosen?.host;
	const policy = host?.policy;
	const link = linkChoice(policy);
	const signin: Choice = host === undefined ? { allowed: false } : signinChoice(host);
	const kind: Audience["kind"] = audienceKind === "signin" && signin.allowed ? "signin" : link.allowed ? "link" : "signin";
	const expiries = expiryChoices(policy);
	const expiryDays = expiries.some(choice => choice.days === expiry) ? expiry : defaultExpiry(expiries);
	const audience = audienceFrom(kind, recipients);
	const problem = kind === "signin" && !signin.allowed ? signin.reason : audienceProblem(audience, policy);
	const managed = hosts?.hosts.some(each => each.managed) === true;
	const working = stage.name === "working";

	const create = (): void => {
		if (host === undefined || problem !== undefined || working) return;
		setStage({ name: "working", progress: null });
		let settled = false;
		const poll = window.setInterval(() => {
			tools.shareProgress(item.id).then(
				progress => {
					if (settled) return;
					setStage(current => (current.name === "working" ? { name: "working", progress } : current));
					if (progress.phase === "done" && progress.shareId !== undefined) {
						settled = true;
						window.clearInterval(poll);
						void finishFromProgress(progress.shareId);
					}
					if (progress.phase === "failed") {
						settled = true;
						window.clearInterval(poll);
						setStage({ name: "failed", error: progress.error ?? "The share could not be made." });
					}
				},
				() => undefined,
			);
		}, PROGRESS_POLL_MS);
		polling.current = poll;
		const finishFromProgress = async (shareId: string): Promise<void> => {
			try {
				const url = await tools.link(shareId);
				const made: LinkedShare = { id: shareId, host: host.id, url: url.split("#")[0] ?? url, audience, version: 1, comments: 0, unread: 0, link: url };
				setStage({ name: "done", share: made });
				onShared(made);
			} catch (cause) {
				setStage({ name: "failed", error: errorText(cause) });
			}
		};
		tools
			.share({ artifactId: item.id, host: host.id, audience, ...(expiryDays === undefined ? {} : { expiresInDays: expiryDays }), allowComments })
			.then(
				share => {
					if (settled) return;
					settled = true;
					window.clearInterval(poll);
					setStage({ name: "done", share });
					onShared(share);
				},
				cause => {
					if (settled) return;
					tools.shareProgress(item.id).then(
						progress => {
							if (settled) return;
							if (progress.phase === "sealing" || progress.phase === "uploading") return;
							settled = true;
							window.clearInterval(poll);
							if (progress.phase === "done" && progress.shareId !== undefined) void finishFromProgress(progress.shareId);
							else setStage({ name: "failed", error: errorText(cause) });
						},
						() => {
							settled = true;
							window.clearInterval(poll);
							setStage({ name: "failed", error: errorText(cause) });
						},
					);
				},
			);
	};

	return (
		<Modal aria-label="Share artifact" onClose={working ? () => undefined : onClose} trapFocus className="w-[min(520px,calc(100vw-32px))]">
			<div data-slot="library-share" className="flex max-h-[min(720px,calc(100vh-48px))] flex-col">
				<div className="flex items-start gap-3 border-b border-fr-border-soft px-5 py-4">
					<div className="min-w-0 flex-1">
						<div className="text-fr-lg font-semibold text-fr-text">{stage.name === "add-host" ? "Add your server" : "Share"}</div>
						<div className="truncate text-fr-sm text-fr-text-3" title={item.path}>
							{item.title ?? item.name} · {formatBytes(item.size)}
						</div>
					</div>
					<button type="button" aria-label="Close" disabled={working} onClick={stage.name === "add-host" ? () => setStage({ name: "form" }) : onClose} className={cn("rounded-md p-1 text-fr-text-3 hover:bg-fr-surface-2 hover:text-fr-text disabled:opacity-40", FOCUS)}>
						<Icon name={stage.name === "add-host" ? "back" : "x"} size={16} />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
					{stage.name === "add-host" ? (
						<AddHost
							tools={tools}
							onAdded={added => {
								setHostId(added.id);
								setReload(count => count + 1);
								setStage({ name: "form" });
							}}
						/>
					) : stage.name === "done" ? (
						<Done share={stage.share} host={host} onClose={onClose} />
					) : (
						<>
							<Section label="Where the link lives">
								{hostsError !== null ? (
									<p role="alert" className="text-fr-sm text-fr-del">
										{hostsError}
									</p>
								) : hosts === null ? (
									<p className="text-fr-sm text-fr-text-3">Looking for your share servers…</p>
								) : (
									<div role="radiogroup" aria-label="Where the link lives" className="flex flex-col gap-1.5">
										{choices.map(choice => (
											<Option
												key={choice.host.id}
												selected={choice.host.id === host?.id}
												disabled={!choice.allowed || working}
												onSelect={() => setHostId(choice.host.id)}
												icon={HOST_ICON[choice.host.kind]}
												title={choice.host.name}
												detail={choice.host.id === host?.id ? HOST_NOTE[choice.host.kind] : choice.host.kind === "p2p" ? "Works while this computer is on" : choice.host.baseUrl.replace(/^https?:\/\//, "")}
												{...(choice.reason === undefined ? {} : { reason: choice.reason })}
											/>
										))}
										{choices.length === 0 ? <p className="text-fr-sm text-fr-text-3">No way to share is set up here yet. Add your server to share.</p> : null}
										{managed ? null : (
											<button type="button" disabled={working} onClick={() => setStage({ name: "add-host" })} className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-fr-sm text-fr-accent-text hover:bg-fr-surface-2", FOCUS)}>
												<Icon name="plus" size={14} />
												Add your server
											</button>
										)}
									</div>
								)}
							</Section>
							{host === undefined ? null : (
								<>
									<Section label="Who can open it">
										<div role="radiogroup" aria-label="Who can open it" className="flex flex-col gap-1.5">
											<Option selected={kind === "link"} disabled={!link.allowed || working} onSelect={() => setAudienceKind("link")} icon="link" title="Anyone with the link" detail="The key is in the link itself; the server never sees what is inside." {...(link.reason === undefined ? {} : { reason: link.reason })} />
											<Option selected={kind === "signin"} disabled={!signin.allowed || working} onSelect={() => setAudienceKind("signin")} icon="lock" title="Only people who sign in" detail="They sign in with this server’s sign-in before it opens." {...(signin.reason === undefined ? {} : { reason: signin.reason })} />
										</div>
										{kind === "signin" ? (
											<div className="mt-2">
												<label htmlFor={recipientsId} className="mb-1 block text-fr-xs text-fr-text-3">
													Emails or domains, separated by commas (empty: anyone who can sign in)
												</label>
												<Input id={recipientsId} size="sm" value={recipients} disabled={working} onChange={event => setRecipients(event.target.value)} placeholder="ana@example.com, example.org" spellCheck={false} />
												<Chips text={recipients} />
											</div>
										) : null}
									</Section>
									<div className="mt-4 grid grid-cols-2 gap-3">
										<label className="min-w-0">
											<span className="mb-1.5 block text-fr-xs font-semibold text-fr-text-2">Link expires</span>
											<Select size="sm" disabled={working} value={expiryDays === undefined ? "never" : String(expiryDays)} onChange={event => setExpiry(event.target.value === "never" ? undefined : Number(event.target.value))}>
												{expiries.map(choice => (
													<option key={choice.label} value={choice.days === undefined ? "never" : String(choice.days)}>
														{choice.label}
													</option>
												))}
											</Select>
										</label>
										<label className="flex min-w-0 items-end justify-between gap-2 pb-1">
											<span className="text-fr-sm text-fr-text-2">Allow comments</span>
											<Switch checked={allowComments} disabled={working} onCheckedChange={setAllowComments} />
										</label>
									</div>
								</>
							)}
							{problem === undefined ? null : <p className="mt-3 text-fr-sm text-fr-warn">{problem}</p>}
							{stage.name === "failed" ? (
								<p role="alert" className="mt-3 text-fr-sm text-fr-del">
									{stage.error}
								</p>
							) : null}
							{stage.name === "working" ? <Progress progress={stage.progress} /> : null}
							<div className="mt-5 flex justify-end gap-2">
								<Button type="button" variant="outline" onClick={onClose} disabled={working}>
									Cancel
								</Button>
								<Button type="button" onClick={create} loading={working} loadingText="Sharing…" disabled={host === undefined || problem !== undefined}>
									{stage.name === "failed" ? "Try again" : "Create link"}
								</Button>
							</div>
						</>
					)}
				</div>
			</div>
		</Modal>
	);
}

function Chips({ text }: { readonly text: string }) {
	const { emails, domains } = parseRecipients(text);
	if (emails.length + domains.length === 0) return null;
	return (
		<div className="mt-1.5 flex flex-wrap gap-1">
			{[...emails, ...domains.map(domain => `@${domain}`)].map(entry => (
				<span key={entry} className="rounded-full border border-fr-border-soft bg-fr-surface-2 px-2 text-fr-xs leading-5 text-fr-text-2">
					{entry}
				</span>
			))}
		</div>
	);
}

function Progress({ progress }: { readonly progress: ShareProgress | null }) {
	const fraction = progress === null || progress.total === 0 ? 0 : Math.min(1, progress.sent / progress.total);
	const label = progress === null || progress.phase === "sealing" ? "Encrypting…" : progress.phase === "uploading" ? `Uploading ${formatBytes(progress.sent)} of ${formatBytes(progress.total)}` : "Finishing…";
	return (
		<div className="mt-4" role="status" aria-live="polite">
			<div className="mb-1 text-fr-xs text-fr-text-3">{label}</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-fr-surface-3">
				<div className="h-full rounded-full bg-fr-accent transition-[width] duration-[var(--fr-motion-base)]" style={{ width: `${Math.round(fraction * 100)}%` }} />
			</div>
		</div>
	);
}

function Done({ share, host, onClose }: { readonly share: LinkedShare; readonly host: ShareHost | undefined; readonly onClose: () => void }) {
	return (
		<div className="pt-4">
			<div className="mb-2 flex items-center gap-2 text-fr-sm text-fr-text">
				<Icon name="check" size={16} className="text-fr-add" />
				The link is ready
			</div>
			<CopyField text={share.link} label="The share link, with its key" />
			<p className="mt-2 text-fr-xs text-fr-text-3">
				Anyone you send it to {share.audience.kind === "link" ? "can open it" : "signs in first"}.
				{host?.kind === "p2p" ? " It works while this computer is on and Dimension is running." : ""}
				{share.expiresAt === undefined ? "" : ` It expires ${new Date(share.expiresAt).toLocaleDateString()}.`} The key is only in this link; keep it somewhere safe if you need it again.
			</p>
			<div className="mt-5 flex justify-end">
				<Button type="button" onClick={onClose}>
					Done
				</Button>
			</div>
		</div>
	);
}

function AddHost({ tools, onAdded }: { readonly tools: LibraryTools; readonly onAdded: (host: ShareHost) => void }) {
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
		<form onSubmit={submit} className="pt-4">
			<p className="text-fr-sm leading-5 text-fr-text-3">Run this on your server (any Linux VPS with a domain pointed at it). It installs the share server with automatic HTTPS and prints a pairing link.</p>
			<div className="mt-2">
				<CopyField text={INSTALL_COMMAND} label="The install command" />
			</div>
			<Section label="Pairing link">
				<Input value={pairing} onChange={event => setPairing(event.target.value)} placeholder="https://share.example.com/pair#t=…" spellCheck={false} disabled={busy} aria-invalid={pairing.trim() !== "" && paired === null} />
				{pairing.trim() !== "" && paired === null ? <p className="mt-1 text-fr-xs text-fr-text-3">A pairing link starts with https:// and ends with #t= and a token.</p> : null}
			</Section>
			<Section label="Or its address and token">
				<div className="flex flex-col gap-2">
					<Input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://share.example.com" spellCheck={false} disabled={busy || pairing.trim() !== ""} />
					<Input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Upload token" autoComplete="off" disabled={busy || pairing.trim() !== ""} />
				</div>
			</Section>
			<Section label="Whose server">
				<Select size="sm" value={kind} disabled={busy} onChange={event => setKind(event.target.value === "company" ? "company" : "self")}>
					<option value="self">My server</option>
					<option value="company">My company’s server</option>
				</Select>
			</Section>
			{error === null ? null : (
				<p role="alert" className="mt-3 text-fr-sm text-fr-del">
					{error}
				</p>
			)}
			<div className="mt-5 flex justify-end">
				<Button type="submit" loading={busy} loadingText="Checking the server…" disabled={!ready}>
					Add server
				</Button>
			</div>
		</form>
	);
}
