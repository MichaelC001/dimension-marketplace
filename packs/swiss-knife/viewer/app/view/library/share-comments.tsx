import { CommentThread, Face, threadAuthor, threadLine } from "@dimension/mcp-app-kit/annotate/react";
import { Button } from "@fraym/ui/elements/button";
import { Select } from "@fraym/ui/elements/select";
import { Textarea } from "@fraym/ui/elements/textarea";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShareSummary } from "../../../../src/library/types";
import { FOCUS } from "../focus-ring";
import { type SharedThread, threadsOf } from "./artifact-threads";
import { errorText, type LibraryTools, type ShareComment } from "./library-tools";
import { accessLabel, shareStatus } from "./share-options";

const MARK_READ_MS = 600;

export interface ArtifactComments {
	readonly comments: readonly ShareComment[] | null;
	readonly error: string | null;
	readonly threads: readonly SharedThread[];
	readonly reply: (thread: SharedThread, body: string) => Promise<void>;
	readonly post: (shareId: string, body: string) => Promise<void>;
	readonly seen: (ids: readonly string[]) => void;
}

export interface ArtifactCommentsOptions {
	readonly tools: LibraryTools;
	readonly artifactId: string;
	readonly shares: readonly ShareSummary[];
	readonly now: number;
	readonly onShares: (shares: readonly ShareSummary[]) => void;
}

export function useArtifactComments({ tools, artifactId, shares, now, onShares }: ArtifactCommentsOptions): ArtifactComments {
	const [comments, setComments] = useState<readonly ShareComment[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
	const unreadTotal = shares.reduce((sum, share) => sum + share.unread, 0);
	const latest = useRef({ shares, onShares });
	latest.current = { shares, onShares };
	const marking = useRef(new Set<string>());

	useEffect(() => {
		if (shares.length === 0) {
			setComments([]);
			return;
		}
		const controller = new AbortController();
		setError(null);
		tools.comments(artifactId, controller.signal).then(
			rows => setComments(rows),
			cause => {
				if (!controller.signal.aborted) setError(errorText(cause));
			},
		);
		return () => controller.abort();
	}, [tools, artifactId, shares.length, unreadTotal]);

	const add = useCallback((comment: ShareComment): void => {
		setComments(rows => [...(rows ?? []), { ...comment, readAt: comment.readAt ?? Date.now() }]);
	}, []);

	const reply = useCallback(
		async (thread: SharedThread, body: string): Promise<void> => {
			add(await tools.reply(thread.shareId, body, thread.anchor));
		},
		[tools, add],
	);

	const post = useCallback(
		async (shareId: string, body: string): Promise<void> => {
			add(await tools.reply(shareId, body));
		},
		[tools, add],
	);

	const seen = useCallback(
		(ids: readonly string[]): void => {
			const unread = (comments ?? []).filter(comment => comment.readAt === undefined && ids.includes(comment.id) && !marking.current.has(comment.id));
			if (unread.length === 0) return;
			const marked = unread.map(comment => comment.id);
			for (const id of marked) marking.current.add(id);
			setFresh(before => new Set([...before, ...marked]));
			tools.markRead(marked).then(
				() => {
					const readAt = Date.now();
					setComments(rows => rows?.map(row => (row.readAt === undefined && marked.includes(row.id) ? { ...row, readAt } : row)) ?? rows);
					const perShare = new Map<string, number>();
					for (const comment of unread) perShare.set(comment.shareId, (perShare.get(comment.shareId) ?? 0) + 1);
					const { shares: current, onShares: report } = latest.current;
					report(current.map(share => (perShare.has(share.id) ? { ...share, unread: Math.max(0, share.unread - (perShare.get(share.id) ?? 0)) } : share)));
				},
				() => undefined,
			).finally(() => {
				for (const id of marked) marking.current.delete(id);
			});
		},
		[comments, tools],
	);

	const threads = useMemo(() => threadsOf(comments ?? [], shares, now, fresh), [comments, shares, now, fresh]);
	return { comments, error, threads, reply, post, seen };
}

export function useSeenAfter(active: boolean, ids: readonly string[], seen: (ids: readonly string[]) => void): void {
	const key = ids.join("\u0000");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the list of ids.
	useEffect(() => {
		if (!active || ids.length === 0) return;
		const timer = window.setTimeout(() => seen(ids), MARK_READ_MS);
		return () => window.clearTimeout(timer);
	}, [active, key, seen]);
}

export interface CommentsViewProps {
	readonly data: ArtifactComments;
	readonly shares: readonly ShareSummary[];
	readonly now: number;
	readonly openId: string | null;
	readonly onPick: (id: string) => void;
}

export function CommentsView({ data, shares, now, openId, onPick }: CommentsViewProps) {
	const { comments, error, threads } = data;
	const placed = threads.filter(thread => thread.ordinal > 0);
	const general = threads.filter(thread => thread.ordinal === 0);
	const open = shares.filter(share => shareStatus(share, now) === "live" && share.allowComments);
	const unanswered = open.filter(share => !general.some(thread => thread.shareId === share.id));
	const byId = new Map(shares.map(share => [share.id, share]));
	useSeenAfter(true, (comments ?? []).filter(comment => comment.readAt === undefined).map(comment => comment.id), data.seen);

	return (
		<div className="flex flex-col gap-4">
			{error === null ? null : (
				<p role="alert" className="text-fr-xs text-fr-del">
					{error}
				</p>
			)}
			{comments === null && error === null ? <p className="text-fr-xs text-fr-text-3">Loading comments…</p> : null}
			{comments !== null && threads.length === 0 ? (
				<div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
					<Icon name="chat" size={20} className="text-fr-text-3" />
					<p className="text-fr-xs text-fr-text-3">No comments yet. People you share with can mark the artifact and leave notes; they appear on it here.</p>
				</div>
			) : null}
			{placed.length === 0 ? null : (
				<ol aria-label="Comments on the artifact" className="flex flex-col gap-0.5">
					{placed.map(thread => {
						const first = thread.comments[0];
						const unread = thread.entries.some(entry => entry.fresh === true);
						return (
							<li key={thread.id}>
								<button
									type="button"
									onClick={() => onPick(thread.id)}
									aria-current={openId === thread.id ? "true" : undefined}
									aria-label={`Comment ${thread.ordinal}, ${thread.heading ?? ""}, ${threadLine(thread)}. Show it on the artifact`}
									className={cn("-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-fr-surface-2", openId === thread.id && "bg-fr-surface-2", FOCUS)}
								>
									<span aria-hidden className="dam-root shrink-0">
										<Face name={threadAuthor(thread)} />
									</span>
									<span className="min-w-0 flex-1">
										<span className="flex min-w-0 items-baseline gap-1.5 text-fr-xs">
											<span className="shrink-0 tabular-nums text-fr-text-3">{`#${thread.ordinal}`}</span>
											<span className="min-w-0 truncate font-medium text-fr-text">{first?.author}</span>
											<span className="shrink-0 text-fr-text-3">{thread.entries[0]?.when}</span>
											{thread.heading === undefined ? null : <span className="min-w-0 truncate rounded-sm bg-fr-surface-3 px-1.5 text-fr-2xs leading-5 tabular-nums text-fr-text-2">{thread.heading}</span>}
										</span>
										<span className="mt-0.5 line-clamp-2 block text-fr-sm text-fr-text [overflow-wrap:anywhere]">{first?.body}</span>
										{thread.comments.length > 1 ? <span className="mt-0.5 block text-fr-2xs text-fr-text-3">{thread.comments.length - 1 === 1 ? "1 reply" : `${thread.comments.length - 1} replies`}</span> : null}
									</span>
									{unread ? (
										<span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-fr-accent">
											<span className="sr-only">New</span>
										</span>
									) : null}
								</button>
							</li>
						);
					})}
				</ol>
			)}
			{general.map(thread => {
				const share = byId.get(thread.shareId);
				return (
					<section key={thread.id} aria-label="General comments" className="flex flex-col gap-1 border-t border-fr-border-soft pt-3">
						<h4 className="text-fr-xs font-medium text-fr-text-3">
							{shares.length > 1 && share !== undefined ? `General · ${accessLabel(share.audience)}` : "General"}
							{share !== undefined && shareStatus(share, now) !== "live" ? " · stopped" : ""}
						</h4>
						<div className="dam-root">
							<CommentThread thread={thread} onReply={(_, body) => data.reply(thread, body)} />
						</div>
					</section>
				);
			})}
			{unanswered.length === 0 ? null : <Composer key={unanswered.map(share => share.id).join(",")} targets={unanswered} onPost={data.post} />}
		</div>
	);
}

function Composer({ targets, onPost }: { readonly targets: readonly ShareSummary[]; readonly onPost: (shareId: string, body: string) => Promise<void> }) {
	const [shareId, setShareId] = useState(targets[0]?.id ?? "");
	const [body, setBody] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const send = (event: FormEvent): void => {
		event.preventDefault();
		const text = body.trim();
		if (text === "" || sending || shareId === "") return;
		setSending(true);
		setError(null);
		onPost(shareId, text).then(
			() => {
				setSending(false);
				setBody("");
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
				<Select size="sm" aria-label="Write to the people on" value={shareId} disabled={sending} onChange={event => setShareId(event.target.value)}>
					{targets.map(share => (
						<option key={share.id} value={share.id}>
							Write to {accessLabel(share.audience)}
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
					placeholder="Write to the people you shared with…"
					aria-label="Write a comment"
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
