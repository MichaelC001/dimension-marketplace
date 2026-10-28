import type { CommentThreadData, ThreadEntry } from "@dimension/mcp-app-kit/annotate/react";
import { anchorKey, anchorLabel, type CommentAnchor, type CommentShape } from "@dimension/sdk/artifact-share";
import type { ShareSummary } from "../../../../src/library/types";
import { relativeAge } from "./kinds";
import type { ShareComment } from "./library-tools";
import { shareStatus } from "./share-options";

export interface SharedThread extends CommentThreadData {
	readonly shareId: string;
	readonly anchor?: CommentAnchor;
	readonly comments: readonly ShareComment[];
}

export interface PlacedThread extends SharedThread {
	readonly anchor: CommentAnchor;
}

function shapeTop(shape: CommentShape | undefined): number {
	if (shape === undefined) return 0;
	if (shape.kind === "pin") return shape.at.y;
	if (shape.kind === "pen") return Math.min(...shape.points.map(point => point.y));
	return Math.min(shape.from.y, shape.to.y);
}

function placeOrder(a: CommentAnchor, b: CommentAnchor): number {
	return (
		(a.startMs ?? Number.POSITIVE_INFINITY) - (b.startMs ?? Number.POSITIVE_INFINITY) ||
		(a.page ?? 0) - (b.page ?? 0) ||
		shapeTop(a.shape) - shapeTop(b.shape)
	);
}

function entryOf(comment: ShareComment, share: ShareSummary | undefined, now: number, fresh: ReadonlySet<string>): ThreadEntry {
	return {
		id: comment.id,
		author: comment.author,
		when: relativeAge(comment.createdAt, now),
		body: comment.body,
		...(comment.readAt === undefined || fresh.has(comment.id) ? { fresh: true } : {}),
		...(share !== undefined && comment.version !== share.version ? { flag: "earlier version" } : {}),
	};
}

export function threadsOf(comments: readonly ShareComment[], shares: readonly ShareSummary[], now: number, fresh: ReadonlySet<string>): readonly SharedThread[] {
	const byShare = new Map(shares.map(share => [share.id, share]));
	const groups = new Map<string, { shareId: string; anchor: CommentAnchor | undefined; comments: ShareComment[] }>();
	for (const comment of [...comments].sort((a, b) => a.createdAt - b.createdAt)) {
		const key = `${comment.shareId}\u0000${anchorKey(comment.anchor)}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, { shareId: comment.shareId, anchor: comment.anchor, comments: [comment] });
		else group.comments.push(comment);
	}
	const all = [...groups.entries()];
	const placed = all.filter(([, group]) => group.anchor !== undefined);
	const general = all.filter(([, group]) => group.anchor === undefined);
	placed.sort(([, a], [, b]) => placeOrder(a.anchor as CommentAnchor, b.anchor as CommentAnchor) || (a.comments[0]?.createdAt ?? 0) - (b.comments[0]?.createdAt ?? 0));
	const thread = ([key, group]: (typeof all)[number], ordinal: number): SharedThread => {
		const share = byShare.get(group.shareId);
		const heading = anchorLabel(group.anchor);
		return {
			id: key,
			ordinal,
			shareId: group.shareId,
			comments: group.comments,
			entries: group.comments.map(comment => entryOf(comment, share, now, fresh)),
			canReply: share !== undefined && share.allowComments && shareStatus(share, now) === "live",
			...(group.anchor === undefined ? {} : { anchor: group.anchor }),
			...(heading === null ? {} : { heading }),
		};
	};
	return [...placed.map((entry, index) => thread(entry, index + 1)), ...general.map(entry => thread(entry, 0))];
}

export function isPlaced(thread: SharedThread): thread is PlacedThread {
	return thread.anchor !== undefined;
}
