import { ConfirmDialog } from "@fraym/ui/components/confirm-dialog";
import { Button } from "@fraym/ui/elements/button";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Textarea } from "@fraym/ui/elements/textarea";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type FormEvent, useEffect, useState } from "react";
import type { ShareSummary } from "../../../../src/library/types";
import { CopyField } from "./copy-field";
import { FOCUS } from "../focus-ring";
import { relativeAge } from "./kinds";
import { errorText, type LibraryTools, type ShareComment } from "./library-tools";
import { audienceLabel, displayUrl } from "./share-options";

export interface ShareListProps {
	readonly tools: LibraryTools;
	readonly artifactId: string;
	readonly shares: readonly ShareSummary[];
	readonly active: boolean;
	readonly now: number;
	readonly onShares: (shares: readonly ShareSummary[]) => void;
}

export function ShareList({ tools, artifactId, shares, active, now, onShares }: ShareListProps) {
	const [comments, setComments] = useState<readonly ShareComment[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<ShareSummary | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [shown, setShown] = useState<{ readonly id: string; readonly link: string } | null>(null);
	const unreadTotal = shares.reduce((sum, share) => sum + share.unread, 0);

	useEffect(() => {
		if (shares.length === 0) {
			setComments([]);
			return;
		}
		const controller = new AbortController();
		tools.comments(artifactId, controller.signal).then(
			rows => setComments(rows),
			cause => {
				if (!controller.signal.aborted) setError(errorText(cause));
			},
		);
		return () => controller.abort();
	}, [tools, artifactId, shares.length, unreadTotal]);

	useEffect(() => {
		if (!active) return;
		const unread = comments.filter(comment => comment.readAt === undefined).map(comment => comment.id);
		if (unread.length === 0) return;
		const timer = window.setTimeout(() => {
			tools.markRead(unread).then(
				() => {
					const readAt = Date.now();
					setComments(rows => rows.map(row => (row.readAt === undefined && unread.includes(row.id) ? { ...row, readAt } : row)));
					onShares(shares.map(share => (share.unread === 0 ? share : { ...share, unread: 0 })));
				},
				() => undefined,
			);
		}, 600);
		return () => window.clearTimeout(timer);
	}, [active, comments, tools, shares, onShares]);

	const act = (shareId: string, work: () => Promise<void>): void => {
		setBusy(shareId);
		setError(null);
		work().then(
			() => setBusy(null),
			cause => {
				setBusy(null);
				setError(errorText(cause));
			},
		);
	};

	if (shares.length === 0) return <p className="text-fr-xs text-fr-text-3">Not shared. Share… makes an encrypted link only the people you send it to can open.</p>;

	const ordered = [...shares].sort((a, b) => Number(a.revokedAt !== undefined) - Number(b.revokedAt !== undefined));
	return (
		<div className="flex flex-col gap-2">
			{error === null ? null : (
				<p role="alert" className="text-fr-xs text-fr-del">
					{error}
				</p>
			)}
			{ordered.map(share => {
				const revoked = share.revokedAt !== undefined;
				const expired = share.expiresAt !== undefined && share.expiresAt <= now;
				const thread = comments.filter(comment => comment.shareId === share.id);
				return (
					<div key={share.id} data-slot="library-share-row" className={cn("rounded-lg border border-fr-border-soft bg-fr-surface-2", revoked && "opacity-60")}>
						<div className="flex min-w-0 items-center gap-1 px-2.5 py-1.5">
							<Icon name={share.host === "p2p" ? "computer" : "cloud"} size={13} className="shrink-0 text-fr-text-3" />
							<span className="min-w-0 flex-1 truncate font-mono text-fr-xs text-fr-text" title={displayUrl(share.url)}>
								{displayUrl(share.url)}
							</span>
							{share.unread > 0 ? <span className="rounded-full bg-fr-accent px-1.5 text-fr-2xs font-semibold leading-4 text-fr-accent-ink tabular-nums">{share.unread}</span> : null}
							{revoked ? null : (
								<>
									<IconButton
										className={cn("size-6", FOCUS)}
										aria-label="Show the link"
										title="Show the link"
										toggled={shown?.id === share.id}
										disabled={busy === share.id}
										onClick={() => (shown?.id === share.id ? setShown(null) : act(share.id, async () => setShown({ id: share.id, link: await tools.link(share.id) })))}
									>
										<Icon name="link" size={12} />
									</IconButton>
									<IconButton className={cn("size-6", FOCUS)} aria-label="Share the current file as a new version" title="New version" disabled={busy === share.id} onClick={() => act(share.id, async () => {
										await tools.newVersion(share.id);
										onShares(shares.map(each => (each.id === share.id ? { ...each, version: each.version + 1 } : each)));
									})}>
										<Icon name="refresh" size={12} />
									</IconButton>
									<IconButton className={cn("size-6 hover:text-fr-del", FOCUS)} aria-label="Revoke link" title="Revoke" disabled={busy === share.id} onClick={() => setRevoking(share)}>
										<Icon name="x" size={12} />
									</IconButton>
								</>
							)}
						</div>
						{shown?.id === share.id && !revoked ? (
							<div className="px-2.5 pb-2">
								<CopyField text={shown.link} label="the link" />
							</div>
						) : null}
						<div className="flex flex-wrap gap-x-2 border-t border-fr-border-soft px-2.5 py-1 text-fr-2xs text-fr-text-3">
							<span>{audienceLabel(share.audience)}</span>
							<span>v{share.version}</span>
							<span>{revoked ? `Revoked ${relativeAge(share.revokedAt ?? now, now)}` : expired ? "Expired" : share.expiresAt === undefined ? "No expiry" : `Expires ${new Date(share.expiresAt).toLocaleDateString()}`}</span>
							{share.host === "p2p" && !revoked ? <span>Works while this computer is on</span> : null}
						</div>
						{thread.length > 0 || !revoked ? <Thread tools={tools} share={share} thread={thread} revoked={revoked} now={now} onReplied={comment => setComments(rows => [...rows, comment])} /> : null}
					</div>
				);
			})}
			{revoking === null ? null : (
				<ConfirmDialog
					title="Revoke this link?"
					description="Everyone who has it loses access right away. Comments stay here."
					intent="danger"
					confirmLabel="Revoke"
					focusCancel
					onClose={() => setRevoking(null)}
					onConfirm={() => {
						const target = revoking;
						setRevoking(null);
						act(target.id, async () => {
							await tools.revoke(target.id);
							const revokedAt = Date.now();
							onShares(shares.map(each => (each.id === target.id ? { ...each, revokedAt } : each)));
						});
					}}
				/>
			)}
		</div>
	);
}

function Thread({ tools, share, thread, revoked, now, onReplied }: { readonly tools: LibraryTools; readonly share: ShareSummary; readonly thread: readonly ShareComment[]; readonly revoked: boolean; readonly now: number; readonly onReplied: (comment: ShareComment) => void }) {
	const [body, setBody] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const send = (event: FormEvent): void => {
		event.preventDefault();
		const text = body.trim();
		if (text === "" || sending) return;
		setSending(true);
		setError(null);
		tools.reply(share.id, text).then(
			comment => {
				setSending(false);
				setBody("");
				onReplied(comment);
			},
			cause => {
				setSending(false);
				setError(errorText(cause));
			},
		);
	};
	return (
		<div className="border-t border-fr-border-soft px-2.5 py-2">
			{thread.length === 0 ? null : (
				<ol className="mb-2 flex flex-col gap-2" aria-label="Comments">
					{thread.map(comment => (
						<li key={comment.id} className="min-w-0">
							<div className="flex items-baseline gap-1.5 text-fr-2xs text-fr-text-3">
								<span className="font-semibold text-fr-text-2">{comment.author}</span>
								<span>{relativeAge(comment.createdAt, now)}</span>
								{comment.version !== share.version ? <span>on v{comment.version}</span> : null}
								{comment.readAt === undefined ? <span className="size-1.5 rounded-full bg-fr-accent" title="New" /> : null}
							</div>
							<p className="whitespace-pre-wrap text-fr-xs text-fr-text [overflow-wrap:anywhere]">{comment.body}</p>
						</li>
					))}
				</ol>
			)}
			{revoked ? null : (
				<form onSubmit={send} className="flex items-end gap-1.5">
					<Textarea
						rows={1}
						value={body}
						disabled={sending}
						onChange={event => setBody(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter" && !event.shiftKey) send(event);
						}}
						placeholder="Reply…"
						aria-label="Reply to comments on this link"
						className="min-h-0 flex-1 py-1 text-fr-xs"
					/>
					<Button type="submit" size="sm" variant="outline" loading={sending} disabled={body.trim() === ""}>
						Send
					</Button>
				</form>
			)}
			{error === null ? null : <p className="mt-1 text-fr-2xs text-fr-del">{error}</p>}
		</div>
	);
}
