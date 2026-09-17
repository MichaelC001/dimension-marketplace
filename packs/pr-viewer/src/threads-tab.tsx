// The threads tab: the review's line conversations, each foldable, each with
// a reply/resolve composer when the host admits thread writes.

import { Icon, ThreadCard } from "@fraym/ui";
import { useState } from "react";
import { ThreadWrite } from "./compose";
import { relativeTime, type ReviewRef, type ReviewThread } from "./model";
import type { ReviewAct } from "./shapes";

export function ThreadsTab({
	reviewRef,
	threads,
	loading,
	error,
	canWrite,
	act,
}: {
	readonly reviewRef: ReviewRef;
	readonly threads: readonly ReviewThread[] | null;
	readonly loading: boolean;
	readonly error: string | null;
	readonly canWrite: boolean;
	readonly act: ReviewAct;
}) {
	const [folded, setFolded] = useState<Record<string, boolean>>({});
	return (
		<div className="flex flex-col gap-2 p-3">
			{loading ? <span className="text-fr-xs text-fr-text-3">Loading…</span> : null}
			{error ? <p className="text-fr-del text-fr-sm">{error}</p> : null}
			{threads && threads.length > 0 ? (
				<span className="text-fr-2xs text-fr-text-3">
					{threads.filter(thread => !thread.isResolved).length} open · {threads.filter(thread => thread.isResolved).length} resolved
				</span>
			) : null}
			{(threads ?? []).map(thread => (
				<div key={thread.id} className="flex flex-col gap-1">
					<span className="flex items-center gap-1.5 text-fr-2xs text-fr-text-3">
						<Icon name="file" size={11} aria-hidden="true" />
						<span className="min-w-0 truncate text-fr-text-2">{thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "no longer on a line"}</span>
						{thread.isResolved ? <span className="rounded-[3px] border border-fr-border px-1 text-fr-text-3">resolved</span> : null}
						{thread.isOutdated ? <span className="rounded-[3px] border border-fr-border px-1 text-fr-text-3">outdated</span> : null}
					</span>
					<ThreadCard
						comments={thread.comments.map(comment => ({ id: comment.id, author: comment.author, body: comment.body, at: relativeTime(comment.createdAt) }))}
						folded={folded[thread.id] ?? thread.isResolved}
						onToggleFolded={() => setFolded(prev => ({ ...prev, [thread.id]: !(prev[thread.id] ?? thread.isResolved) }))}
					/>
					{canWrite ? (
						<ThreadWrite
							resolved={thread.isResolved}
							onReply={body => act("reviewAction", { ref: reviewRef, action: "reply", threadId: thread.id, body })}
							onResolve={() => act("reviewAction", { ref: reviewRef, action: thread.isResolved ? "unresolve" : "resolve", threadId: thread.id })}
						/>
					) : null}
				</div>
			))}
			{threads && threads.length === 0 ? <span className="text-fr-xs text-fr-text-3">No review conversations.</span> : null}
		</div>
	);
}
