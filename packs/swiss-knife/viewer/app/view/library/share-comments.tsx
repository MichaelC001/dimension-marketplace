import { Button } from "@fraym/ui/elements/button";
import { Select } from "@fraym/ui/elements/select";
import { Textarea } from "@fraym/ui/elements/textarea";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type FormEvent, useEffect, useState } from "react";
import type { ShareSummary } from "../../../../src/library/types";
import { relativeAge } from "./kinds";
import { errorText, type LibraryTools, type ShareComment } from "./library-tools";
import { accessLabel, anchorLabel, initials, shareStatus } from "./share-options";

const MARK_READ_MS = 600;

export interface CommentsPanelProps {
	readonly tools: LibraryTools;
	readonly artifactId: string;
	readonly shares: readonly ShareSummary[];
	readonly active: boolean;
	readonly now: number;
	readonly onShares: (shares: readonly ShareSummary[]) => void;
}

export function CommentsPanel({ tools, artifactId, shares, active, now, onShares }: CommentsPanelProps) {
	const [comments, setComments] = useState<readonly ShareComment[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
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
		if (!active || comments === null) return;
		const unread = comments.filter(comment => comment.readAt === undefined).map(comment => comment.id);
		if (unread.length === 0) return;
		setFresh(seen => (unread.every(id => seen.has(id)) ? seen : new Set([...seen, ...unread])));
		const timer = window.setTimeout(() => {
			tools.markRead(unread).then(
				() => {
					const readAt = Date.now();
					setComments(rows => rows?.map(row => (row.readAt === undefined && unread.includes(row.id) ? { ...row, readAt } : row)) ?? rows);
					onShares(shares.map(share => (share.unread === 0 ? share : { ...share, unread: 0 })));
				},
				() => undefined,
			);
		}, MARK_READ_MS);
		return () => window.clearTimeout(timer);
	}, [active, comments, tools, shares, onShares]);

	const open = shares.filter(share => shareStatus(share, now) === "live" && share.allowComments);
	const groups = shares.flatMap(share => {
		const thread = (comments ?? []).filter(comment => comment.shareId === share.id);
		return thread.length === 0 ? [] : [{ share, thread }];
	});
	const latest = (comments ?? []).reduce<ShareComment | null>((last, comment) => (last === null || comment.createdAt > last.createdAt ? comment : last), null);
	const target = open.find(share => share.id === latest?.shareId) ?? open[0];

	return (
		<div className="flex flex-col gap-4">
			{error === null ? null : (
				<p role="alert" className="text-fr-xs text-fr-del">
					{error}
				</p>
			)}
			{comments === null && error === null ? <p className="text-fr-xs text-fr-text-3">Loading comments…</p> : null}
			{comments !== null && groups.length === 0 ? (
				<div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
					<Icon name="chat" size={20} className="text-fr-text-3" />
					<p className="text-fr-xs text-fr-text-3">No comments yet. People you share with can leave notes here.</p>
				</div>
			) : null}
			{groups.map(({ share, thread }) => (
				<section key={share.id} aria-label={`Comments from ${accessLabel(share.audience)}`} className="flex flex-col gap-1">
					{groups.length > 1 ? (
						<h4 className="mb-1 text-fr-xs font-medium text-fr-text-3">
							{accessLabel(share.audience)}
							{shareStatus(share, now) === "live" ? "" : " · stopped"}
						</h4>
					) : null}
					<ol className="flex flex-col gap-1">
						{thread.map(comment => (
							<Comment key={comment.id} comment={comment} share={share} unread={comment.readAt === undefined || fresh.has(comment.id)} now={now} />
						))}
					</ol>
				</section>
			))}
			{target === undefined ? null : (
				<Composer
					key={target.id}
					tools={tools}
					targets={open}
					initial={target.id}
					onReplied={comment => setComments(rows => [...(rows ?? []), { ...comment, readAt: comment.readAt ?? Date.now() }])}
				/>
			)}
		</div>
	);
}

function Comment({ comment, share, unread, now }: { readonly comment: ShareComment; readonly share: ShareSummary; readonly unread: boolean; readonly now: number }) {
	const anchor = anchorLabel(comment.anchor);
	return (
		<li className={cn("-mx-2 flex gap-2.5 rounded-lg px-2 py-2", unread && "bg-fr-accent-dim")}>
			<span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-fr-surface-3 text-fr-2xs font-semibold text-fr-text-2">
				{initials(comment.author)}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-baseline gap-1.5 text-fr-xs">
					<span className="min-w-0 truncate font-medium text-fr-text">{comment.author}</span>
					<span className="shrink-0 text-fr-text-3">{relativeAge(comment.createdAt, now)}</span>
					{unread ? <span className="sr-only">New</span> : null}
				</div>
				{anchor === null && comment.version === share.version ? null : (
					<div className="mt-0.5 flex flex-wrap gap-1">
						{anchor === null ? null : <span className="rounded-sm bg-fr-surface-3 px-1.5 text-fr-2xs leading-5 text-fr-text-2 tabular-nums">{anchor}</span>}
						{comment.version === share.version ? null : <span className="rounded-sm bg-fr-surface-2 px-1.5 text-fr-2xs leading-5 text-fr-text-3">On an earlier version</span>}
					</div>
				)}
				<p className="mt-0.5 whitespace-pre-wrap text-fr-sm text-fr-text [overflow-wrap:anywhere]">{comment.body}</p>
			</div>
		</li>
	);
}

function Composer({ tools, targets, initial, onReplied }: { readonly tools: LibraryTools; readonly targets: readonly ShareSummary[]; readonly initial: string; readonly onReplied: (comment: ShareComment) => void }) {
	const [shareId, setShareId] = useState(initial);
	const [body, setBody] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const send = (event: FormEvent): void => {
		event.preventDefault();
		const text = body.trim();
		if (text === "" || sending) return;
		setSending(true);
		setError(null);
		tools.reply(shareId, text).then(
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
		<form onSubmit={send} className="flex flex-col gap-1.5 border-t border-fr-border-soft pt-3">
			{targets.length > 1 ? (
				<Select size="sm" aria-label="Reply to the people on" value={shareId} disabled={sending} onChange={event => setShareId(event.target.value)}>
					{targets.map(share => (
						<option key={share.id} value={share.id}>
							Reply to {accessLabel(share.audience)}
						</option>
					))}
				</Select>
			) : null}
			<div className="flex items-end gap-1.5">
				<Textarea
					rows={1}
					value={body}
					disabled={sending}
					onChange={event => setBody(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && !event.shiftKey) send(event);
					}}
					placeholder="Reply…"
					aria-label="Reply"
					className="min-h-0 flex-1 resize-none py-1.5 text-fr-sm"
				/>
				<Button type="submit" size="sm" loading={sending} disabled={body.trim() === ""}>
					Send
				</Button>
			</div>
			{error === null ? null : <p className="text-fr-xs text-fr-del">{error}</p>}
		</form>
	);
}
