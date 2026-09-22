// One review, in full: the header's world-touching actions, the tab bar the
// provider's CAPABILITIES decide, and the composer. Each tab's body is its own
// file; this one owns what is shared between them.

import { Button, ConfirmDialog, GitHubPullRequestIcon, Icon, cn, reviewPillState } from "@fraym/ui";
import { useMemo, useState } from "react";
import { ReviewWrite } from "./compose";
import { DiffTab } from "./diff-tab";
import { refKey, type ReviewRef, type ReviewSummary, type SessionReviewLink } from "./model";
import type { PendingAction, ReviewAct, WorkspaceDriverShape, WorkspaceRefShape } from "./shapes";
import { SummaryTab } from "./summary-tab";
import { ThreadsTab } from "./threads-tab";
import { useRead } from "./use-read";

type Tab = "summary" | "threads" | "diff";

export function DetailView({
	reviewRef,
	summary,
	link,
	workspace,
	driver,
	act,
	onBack,
	settledActions,
	actionNotice,
}: {
	readonly reviewRef: ReviewRef;
	readonly summary: ReviewSummary | null;
	readonly link: SessionReviewLink | undefined;
	readonly workspace: WorkspaceRefShape;
	readonly driver: WorkspaceDriverShape;
	readonly act: ReviewAct;
	readonly onBack: (() => void) | null;
	/** The workspace's action cell — a settled `reviewAction` re-reads what it changed. */
	readonly settledActions: number;
	readonly actionNotice: string | null;
}) {
	const key = `${refKey(reviewRef)}@${settledActions}`;
	const { getReview, getReviewThreads, getReviewDiff } = driver;
	// No fallback branch: a method the provider lacks means NO read at all, and
	// the surface that would have shown it is absent.
	const readDetail = useMemo(() => (getReview ? () => getReview(workspace, reviewRef) : null), [getReview, workspace, reviewRef]);
	const detail = useRead(readDetail, key);
	const [tab, setTab] = useState<Tab>("summary");
	// A world-touching action is confirmed first — one click closed a live PR
	// on the host during a design pass (2026-09-17). The dialog holds the
	// exact `reviewAction` input it will send, so confirm fires it verbatim.
	const [pending, setPending] = useState<PendingAction | null>(null);
	const head = detail.value ?? summary;
	// A tab the PROVIDER does not offer for THIS review is absent, not empty
	// ([S-03]): both the method and the review's own capability must say yes.
	const hasThreads = getReviewThreads !== undefined && head?.capabilities.reviewThreads === true;
	const hasDiff = getReviewDiff !== undefined && head?.capabilities.diff === true;
	const tabs: readonly Tab[] = ["summary", ...(hasThreads ? (["threads"] as const) : []), ...(hasDiff ? (["diff"] as const) : [])];
	const active: Tab = tabs.includes(tab) ? tab : "summary";
	const readThreads = useMemo(() => (getReviewThreads && hasThreads ? () => getReviewThreads(workspace, reviewRef) : null), [getReviewThreads, hasThreads, workspace, reviewRef]);
	const threads = useRead(readThreads, `${key}:threads`);
	const stack = detail.value?.stack ?? link?.stack ?? null;
	const canMerge = head?.state === "open" && !head.isDraft && (detail.value?.viewer.merge ?? false) && (head.capabilities.merge ?? false);
	const layerIndex = stack ? stack.layers.findIndex(layer => layer.number === reviewRef.number) : -1;
	const hasOpenLayerAbove = stack !== null && stack.layers.slice(layerIndex + 1).some(layer => layer.state === "open");
	const stackLayersBelow = stack ? stack.layers.slice(0, layerIndex + 1).filter(layer => layer.state !== "merged") : [];
	// A stack merge lands the WHOLE stack, so the host refuses one asked for
	// from a middle layer ("merge from the top layer instead") — the button is
	// absent there rather than offered and refused.
	const canStackMerge =
		canMerge && stack !== null && !hasOpenLayerAbove && head?.capabilities.stackActions === true && stackLayersBelow.length > 1 && stackLayersBelow.every(layer => layer.headSha && !layer.isDraft);
	const canStackRebase = stack !== null && head?.capabilities.stackActions === true && (detail.value?.viewer.stackRebase ?? false);
	const conflicting = head?.state === "open" && head.mergeability === "conflicting";
	const mergeBlocker =
		head?.state !== "open"
			? null
			: head.isDraft
				? "Draft — mark ready for review first"
				: conflicting
					? `Conflicts with ${head.baseBranch} — resolve them first`
					: detail.value && !detail.value.viewer.merge
						? "You cannot merge this review on the host"
						: null;

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<header className="flex min-w-0 items-center gap-1.5 overflow-hidden border-fr-border-soft border-b px-3 py-1.5">
				{onBack ? (
					<Button size="icon" variant="ghost" className="-ml-2.5" aria-label="Back to this session's reviews" onClick={onBack}>
						<Icon name="back" size={13} />
					</Button>
				) : null}
				<span className="flex items-center gap-1.5 text-fr-sm text-fr-text-2 tabular-nums">
					<GitHubPullRequestIcon state={head ? reviewPillState(head) : "open"} size={12} />
					<span>#{reviewRef.number}</span>
				</span>
				<span className="flex-1" />
				{/* From INSIDE the viewer an external glyph means the browser, always:
				// `openReview` without `external` prefers the mounted instrument that
				// declares `opens: ["review"]` — which is this panel — so the click
				// re-requested itself and read as a refresh. `external: true` names
				// the DESTINATION (the verb's own override); the request cell the
				// in-app path writes is never touched. */}
				<Button size="icon" variant="ghost" aria-label={`Open on ${reviewRef.host}`} onClick={() => act("openReview", { ref: reviewRef, url: head?.url ?? link?.url ?? "", external: true })}>
					<Icon name="external" size={13} />
				</Button>
				{head?.state === "open" ? (
					// Closes the REVIEW, not the panel: `head.label` is the host's
					// own noun ("PR" · "MR" · "review" · "CL", written by the
					// provider, never a string in a component — doc 73 §1), so a
					// hostname branch here would mislabel a self-hosted host.
					// `destructive` is a visible-at-rest peer of Merge in shape —
					// the ghost that only appeared on hover read as a label.
					<Button
						size="sm"
						variant="destructive"
						onClick={() =>
							setPending({
								title: `Close #${reviewRef.number} without merging?`,
								description: `The review closes on ${reviewRef.host}. Its branch stays; you can reopen it from here.`,
								confirmLabel: "Close review",
								intent: "danger",
								input: { ref: reviewRef, action: "close" },
							})
						}
					>
						Close {head.label}
					</Button>
				) : null}
				{canMerge && !canStackMerge ? (
					<Button
						size="sm"
						title={`Merge (${detail.value?.allowedMergeMethods[0] ?? "merge"})`}
						onClick={() =>
							setPending({
								title: `Merge #${reviewRef.number}?`,
								description: `${head?.headBranch ?? "This branch"} lands on ${head?.baseBranch ?? "its base"} via ${detail.value?.allowedMergeMethods[0] ?? "merge"} on ${reviewRef.host}. This cannot be undone from here.`,
								confirmLabel: "Merge",
								intent: "default",
								input: { ref: reviewRef, action: "merge", mergeMethod: detail.value?.allowedMergeMethods[0] },
							})
						}
					>
						Merge
					</Button>
				) : head?.state === "open" && !head.isDraft && mergeBlocker ? (
					// The reason is the amber status line one row below (a disabled
					// button cannot show a tooltip); the header stays one width.
					<Button
						size="sm"
						variant="outline"
						disabled
						className="cursor-not-allowed border-transparent bg-fr-accent-dim text-fr-text-2 disabled:opacity-100"
						aria-describedby="pr-viewer-merge-blocker"
					>
						Merge
					</Button>
				) : head?.state === "open" && head.isDraft && head.capabilities.draft ? (
					<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref: reviewRef, action: "ready" })}>
						Ready for review
					</Button>
				) : head?.state === "closed" ? (
					<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref: reviewRef, action: "reopen" })}>
						Reopen
					</Button>
				) : null}
			</header>
			{tabs.length > 1 ? (
				<nav className="flex gap-0.5 border-fr-border border-b px-3 py-1.5 text-fr-sm">
					{tabs.map((name, index) => (
						<button
							key={name}
							type="button"
							onClick={() => setTab(name)}
							className={cn("rounded-sm px-2 py-0.5 capitalize transition-colors", index === 0 && "-ml-2", active === name ? "bg-fr-accent-dim text-fr-text" : "text-fr-text-2 hover:bg-fr-surface hover:text-fr-text")}
						>
							{name}
						</button>
					))}
				</nav>
			) : null}
			<div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
				{detail.error ? <p className="p-3 text-fr-del text-fr-sm">{detail.error}</p> : null}
				{active === "summary" ? (
					<SummaryTab
						reviewRef={reviewRef}
						head={head}
						detail={detail.value}
						loading={detail.loading}
						stack={stack}
						threads={threads.value}
						conflicting={conflicting}
						stackLayersBelow={stackLayersBelow}
						canStackMerge={canStackMerge}
						canStackRebase={canStackRebase}
						act={act}
						onConfirm={setPending}
					/>
				) : null}
				{active === "threads" ? (
					<ThreadsTab
						reviewRef={reviewRef}
						threads={threads.value}
						loading={threads.loading}
						error={threads.error}
						canWrite={head?.capabilities.threadReplies === true}
						act={act}
					/>
				) : null}
				{active === "diff" && getReviewDiff ? <DiffTab reviewRef={reviewRef} workspace={workspace} getReviewDiff={getReviewDiff} cacheKey={`${key}:diff`} /> : null}
			</div>
			{actionNotice ? (
				<p className="border-fr-border border-t px-3 py-2 text-fr-xs text-fr-del" data-slot="pr-viewer-action-notice">
					{actionNotice}
				</p>
			) : null}
			{active === "summary" && head?.state === "open" ? (
				<ReviewWrite
					verdicts={head.capabilities.verdicts === true}
					onComment={body => act("reviewAction", { ref: reviewRef, action: "comment", body })}
					onReview={(verdict, body) => act("reviewAction", { ref: reviewRef, action: "submit-review", verdict, ...(body ? { body } : {}) })}
				/>
			) : null}
			{pending ? (
				<ConfirmDialog
					title={pending.title}
					description={pending.description}
					confirmLabel={pending.confirmLabel}
					intent={pending.intent}
					icon={pending.intent === "danger" ? "x" : "git-pr"}
					onConfirm={() => {
						act("reviewAction", pending.input);
						setPending(null);
					}}
					onClose={() => setPending(null)}
				/>
			) : null}
		</div>
	);
}
