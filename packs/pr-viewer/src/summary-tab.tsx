// The summary tab: the review's facts as pills, its stack, its body and checks.

import { Button, cn, DiffStat, GitHubPullRequestIcon, Icon, Pill, reviewPillState, Skeleton, SkeletonText, StreamingMarkdown } from "@fraym/ui";
import { relativeTime, type ReviewDetail, type ReviewRef, type ReviewSummary, type ReviewThread, type Stack, type StackLayer } from "./model";
import type { PendingAction, ReviewAct, Tone } from "./shapes";

export function SummaryTab({
	reviewRef,
	head,
	detail,
	loading,
	stack,
	threads,
	conflicting,
	stackLayersBelow,
	canStackMerge,
	canStackRebase,
	act,
	onConfirm,
}: {
	readonly reviewRef: ReviewRef;
	/** The best facts in hand: the loaded detail, else the list's summary. */
	readonly head: ReviewSummary | null;
	readonly detail: ReviewDetail | null;
	readonly loading: boolean;
	readonly stack: Stack | null;
	readonly threads: readonly ReviewThread[] | null;
	readonly conflicting: boolean;
	readonly stackLayersBelow: readonly StackLayer[];
	readonly canStackMerge: boolean;
	readonly canStackRebase: boolean;
	readonly act: ReviewAct;
	readonly onConfirm: (pending: PendingAction) => void;
}) {
	const statusLabel =
		head?.state === "merged"
			? "Merged"
			: head?.state === "closed"
				? "Closed"
				: head?.isDraft
					? "Draft"
					: head?.reviewDecision === "approved"
						? "Approved"
						: head?.reviewDecision === "changes-requested"
							? "Changes requested"
							: "Ready for review";
	// The ground tint the status pill wears — none for the plain cases.
	const statusTint =
		head?.state === "merged"
			? "bg-fr-accent-dim"
			: head?.state === "closed"
				? "bg-fr-del-bg"
				: head?.reviewDecision === "approved"
					? "bg-fr-add-bg"
					: head?.reviewDecision === "changes-requested"
						? "bg-fr-warn/15"
						: undefined;
	const checksLabel =
		head?.checksState === "passing"
			? "All checks passed"
			: head?.checksState === "failing"
				? "Some checks failed"
				: head?.checksState === "pending"
					? "Checks running"
					: "None";
	const checksTone: Tone =
		head?.checksState === "passing" ? "positive" : head?.checksState === "failing" ? "negative" : head?.checksState === "pending" ? "warning" : "neutral";
	const reviewers = detail?.reviewers.map(r => r.login) ?? [];
	const openThreads = threads?.filter(thread => !thread.isResolved).length;
	const emptyFacets = [
		...(detail && reviewers.length === 0 ? ["No reviewers"] : []),
		...(threads && !threads.some(thread => !thread.isResolved) ? ["no open threads"] : []),
		...(head && !head.checksState ? ["no checks"] : []),
	];
	return (
		<div className="flex flex-col gap-4 p-3">
			<div className="flex flex-col gap-1">
				<h1 className="font-primary text-fr-xl font-semibold leading-tight tracking-[-0.01em] text-fr-text">{head?.title ?? `#${reviewRef.number}`}</h1>
				{/* Every fact is a pill (owner ruling 2026-09-17), the same chips
				    the list rows wear, so the head and the list read as one surface. */}
				<span className="flex flex-wrap items-center gap-1.5">
					{head?.author ? (
						<Pill>
							<Icon name="user" size={12} strokeWidth={1.6} />
							{head.author.login}
						</Pill>
					) : null}
					{head?.updatedAt ? (
						<Pill className="tabular-nums">
							<Icon name="clock" size={12} strokeWidth={1.6} />
							{relativeTime(head.updatedAt)}
						</Pill>
					) : null}
					<Pill tint={conflicting ? undefined : statusTint}>{statusLabel}</Pill>
					{conflicting ? (
						<Pill id="pr-viewer-merge-blocker" tint="bg-fr-warn/15">
							<Icon name="warnTri" size={12} strokeWidth={1.6} aria-hidden="true" /> Conflicts with {head?.baseBranch}
						</Pill>
					) : null}
				</span>
			</div>
			<div className="flex flex-col gap-1.5">
				<span className="flex min-w-0 items-center gap-1.5">
					<Pill className="min-w-0 max-w-full justify-start" title={`${head?.headBranch ?? "—"} → ${head?.baseBranch ?? "—"}`}>
						<Icon name="git-branch" size={12} strokeWidth={1.6} />
						<span className="truncate">{head?.headBranch ?? "—"}</span>
						<span className="text-fr-text-3">→ {head?.baseBranch ?? "—"}</span>
					</Pill>
					{head && (head.additions !== undefined || head.deletions !== undefined) ? (
						<Pill className="ml-auto">
							<DiffStat className="text-fr-2xs" additions={head.additions} deletions={head.deletions} />
						</Pill>
					) : null}
				</span>
				<span className="flex flex-wrap items-center gap-1.5">
					{reviewers.length > 0 ? (
						<Pill className="min-w-0">
							<Icon name="user" size={12} strokeWidth={1.6} />
							<span className="truncate">{reviewers.join(", ")}</span>
						</Pill>
					) : null}
					{openThreads ? (
						<Pill>
							<Icon name="chat" size={12} strokeWidth={1.6} />
							{openThreads} open
						</Pill>
					) : null}
					{head?.checksState ? (
						<Pill tint={checksTone === "positive" ? "bg-fr-add-bg" : checksTone === "negative" ? "bg-fr-del-bg" : "bg-fr-warn/15"}>
							<Icon name={head.checksState === "failing" ? "x" : head.checksState === "pending" ? "clock" : "check"} size={12} strokeWidth={1.6} />
							{checksLabel}
						</Pill>
					) : null}
					{detail?.labels.map(label => (
						<Pill key={label.name}>
							<Icon name="pin" size={12} strokeWidth={1.6} />
							{label.name}
						</Pill>
					))}
				</span>
				{/* The facets that are EMPTY, on one legible line — three dim rows
				    of "None" were a dead band under the branch. */}
				{emptyFacets.length > 0 ? <span className="text-fr-xs text-fr-text-2">{emptyFacets.join(" · ")}</span> : null}
			</div>
			{stack ? (
				<section className="flex flex-col gap-1 rounded-md border border-fr-border bg-fr-surface p-2">
					<span className="text-fr-sm font-semibold text-fr-text">Stack · {stack.layers.length} layers on {stack.base}</span>
					{[...stack.layers].reverse().map(layer => (
						<span key={layer.number} className={cn("flex items-center gap-2 text-fr-xs", layer.number === reviewRef.number ? "text-fr-text" : "text-fr-text-2")}>
							<GitHubPullRequestIcon state={reviewPillState({ state: layer.state, isDraft: layer.isDraft ?? false })} size={12} />
							<span className="tabular-nums">#{layer.number}</span>
							<span className="min-w-0 flex-1 truncate">{layer.title ?? layer.headBranch}</span>
						</span>
					))}
					{canStackMerge || canStackRebase ? (
						<span className="flex gap-1 pt-1">
							{canStackMerge ? (
								<Button
									size="sm"
									onClick={() =>
										onConfirm({
											title: `Merge the stack under #${reviewRef.number}?`,
											description: `${stackLayersBelow.length} reviews land on ${reviewRef.host} in order, bottom first. This cannot be undone from here.`,
											confirmLabel: `Merge ${stackLayersBelow.length}`,
											intent: "default",
											input: { ref: reviewRef, action: "merge", stackNumber: stack.number, expectedStackHeads: stackLayersBelow.map(layer => ({ number: layer.number, headSha: layer.headSha })) },
										})
									}
								>
									Merge stack ({stackLayersBelow.length})
								</Button>
							) : null}
							{canStackRebase ? (
								// Stack scope is honoured on a MERGE only: a rebase acts on
								// #N alone, and sending stackNumber/expectedStackHeads with it
								// is refused by the provider.
								<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref: reviewRef, action: "update-branch" })}>
									Rebase stack
								</Button>
							) : null}
						</span>
					) : null}
				</section>
			) : null}
			{detail ? (
				// Stale-while-revalidate (#902): a refetch over painted content keeps
				// it dimmed (the context-popover `opacity-60` idiom) instead of
				// swapping it for a spinner.
				<section className={cn("flex flex-col gap-2", loading && "opacity-60")} aria-busy={loading || undefined}>
					<span aria-hidden="true" className="border-fr-border-soft border-t" />
					{detail.body.trim() ? (
						<StreamingMarkdown text={detail.body} className="text-fr-sm text-fr-text" />
					) : (
						<span className="text-fr-sm text-fr-text-3">No description.</span>
					)}
					{detail.checks.length > 0 ? (
						<ul className="mt-2 flex flex-col gap-0.5 rounded-md border border-fr-border bg-fr-surface p-2 text-fr-xs">
							{detail.checks.map(check => (
								<li key={check.name} className="flex items-center gap-2">
									<span className={cn("w-14 shrink-0 tabular-nums", check.status === "success" ? "text-fr-add" : check.status === "failure" ? "text-fr-del" : "text-fr-text-3")}>{check.status}</span>
									<span className="min-w-0 truncate text-fr-text-2">{check.name}</span>
								</li>
							))}
						</ul>
					) : null}
				</section>
			) : loading ? (
				// First load with nothing painted: a skeleton mirroring the body +
				// checks layout so nothing reflows when content lands.
				<section className="flex flex-col gap-2" aria-label="Loading review details">
					<span aria-hidden="true" className="border-fr-border-soft border-t" />
					<SkeletonText lines={4} lineHeight={12} gap={8} />
					<div className="mt-2 flex flex-col gap-2 rounded-md border border-fr-border bg-fr-surface p-2">
						<Skeleton h={10} rounded="sm" w="100%" />
						<Skeleton h={10} rounded="sm" w="100%" />
						<Skeleton h={10} rounded="sm" w="70%" />
					</div>
				</section>
			) : null}
		</div>
	);
}
