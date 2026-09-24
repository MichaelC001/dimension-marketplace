// A list row. One place decides how a review looks in a line, so the rail, the
// card and this list cannot read as three different reviews.

import { ChainRow, cn, DiffStat, GitHubPullRequestIcon, Icon, Pill, REVIEW_PILL_LABEL, REVIEW_PILL_TINT, reviewPillState, StateGlyph } from "@fraym/ui";
import type { ReactNode } from "react";
import { relativeTime, type ReviewSummary, type SessionReviewLink } from "./model";
import type { Tone } from "./shapes";

export function checksGlyph(state: ReviewSummary["checksState"]): ReactNode {
	if (state === undefined || state === null) return null;
	const tone: Tone = state === "passing" ? "positive" : state === "failing" ? "negative" : "warning";
	const label = state === "passing" ? "All checks passed" : state === "failing" ? "Some checks failed" : "Checks running";
	return <StateGlyph tone={tone} icon={<Icon name={state === "passing" ? "check" : state === "failing" ? "x" : "clock"} size={12} />} label={label} />;
}

export function sourceLabel(source: SessionReviewLink["source"]): string {
	return source === "created"
		? "created by this session"
		: source === "pushed"
			? "this session pushed to it"
			: source === "agent"
				? "the agent acted on it"
				: source === "stack"
					? "a stack sibling"
					: "linked by you";
}

/** A list row is STACKED (owner ruling 2026-09-17): the review's number line
 *  on top — a fixed state glyph box, `#N`, the state tag, then time and
 *  check/decision badges at the right edge — the title full-width beneath it,
 *  and the branch + diff stat under that. Every line starts on the same left
 *  edge. The row itself is a `ChainRow` card, so one review reads as one block
 *  at rest; the glyph box is the rail hover card's idiom (`size-5`, state
 *  tint), giving the status column a fixed x every row scans on. The number is
 *  its own tag and the state is a SEPARATE tag (owner revision 2026-09-22,
 *  dimension#909): a number is an identifier and a state is a property, so
 *  fusing them made the thing that never changes look unstable as the state
 *  changed, and a column of numbers could not be scanned as a column. */
export function ReviewRow({
	summary,
	link,
	depth,
	stack,
	sharedBase,
	sharedOwner,
	onSelect,
	menu,
}: {
	readonly summary: ReviewSummary | null;
	readonly link?: SessionReviewLink;
	readonly depth: number;
	/** The base branch every listed review targets — omitted from the row,
	 *  since the list itself proves it is this checkout's trunk. */
	readonly sharedBase: string | null;
	/** Likewise the author every listed review shares — named once, in the footer. */
	readonly sharedOwner: string | null;
	readonly stack: { readonly kind: "native" | "derived"; readonly size: number } | null;
	readonly onSelect: () => void;
	readonly menu: ReactNode;
}) {
	const ref = summary?.ref ?? link?.ref;
	const state = summary ? reviewPillState(summary) : "open";
	const label = summary ? REVIEW_PILL_LABEL[state] : "Not synced yet";
	return (
		<ChainRow depth={depth} variant="card" className="group pr-3">
			<button type="button" onClick={onSelect} className="flex min-w-0 flex-1 flex-col gap-1 py-2 text-left">
				{/* Every fact is a pill (owner ruling 2026-09-17), and the number
				    no longer carries its state's ink (owner revision 2026-09-22,
				    dimension#909): `#N` is a plain tag in constant ink, and the
				    state is the tag beside it, washed with the shared table's
				    tint — the same `Pill` + `REVIEW_PILL_TINT` the rail reads,
				    so a state tag and a filter chip are visibly one language. */}
				<span className="flex min-w-0 flex-wrap items-center gap-1.5">
					<span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-fr-border", REVIEW_PILL_TINT[state])} aria-hidden>
						<GitHubPullRequestIcon state={state} size={12} />
					</span>
					<Pill className="tabular-nums" title={link ? sourceLabel(link.source) : undefined}>
						<span className="text-fr-text">#{ref?.number}</span>
					</Pill>
					{summary ? (
						<Pill tint={REVIEW_PILL_TINT[state]}>{label}</Pill>
					) : (
						<Pill>Not synced yet</Pill>
					)}
					{summary?.reviewDecision === "changes-requested" ? (
						<Pill tint="bg-fr-warn/15">Changes requested</Pill>
					) : null}
					{checksGlyph(summary?.checksState)}
					{stack ? (
						<Pill title={stack.kind === "native" ? `Host stack of ${stack.size}: merging a layer lands the ones below it` : `${stack.size} reviews chained by base branch`}>
							<Icon name={stack.kind === "native" ? "layers" : "branch"} size={12} strokeWidth={1.6} />
							{stack.size}
						</Pill>
					) : null}
					{summary ? (
						<Pill className="ml-auto tabular-nums">
							<Icon name="clock" size={12} strokeWidth={1.6} />
							{relativeTime(summary.updatedAt)}
						</Pill>
					) : null}
				</span>
				<span className="min-w-0 truncate text-fr-sm font-semibold text-fr-text" title={summary?.title ?? link?.url ?? ""}>{summary?.title ?? link?.url ?? ""}</span>
				<span className="flex min-w-0 items-center gap-1.5">
					{summary?.author && summary.author.login !== sharedOwner ? (
						<Pill>
							<Icon name="user" size={12} strokeWidth={1.6} />
							{summary.author.login}
						</Pill>
					) : null}
					{/* `shrink` overrides Pill's `shrink-0`: the branch is the ONE fact on
					    this line that may give way, so it truncates and the diff stat
					    keeps its size. Without it `min-w-0` was inert, the branch took
					    the whole line, and at a narrow dock the `+N −M` pill overflowed
					    the card's edge (measured live at a 304px dock, 14 of 17 rows). */}
					<Pill className="min-w-0 max-w-full shrink justify-start">
						<Icon name="git-branch" size={12} strokeWidth={1.6} />
						<span className="truncate">
							{summary
								? summary.baseBranch === sharedBase
									? summary.headBranch
									: `${summary.headBranch} → ${summary.baseBranch}`
								: ref
									? `${ref.host}/${ref.repository}`
									: ""}
						</span>
					</Pill>
					{summary && (summary.additions !== undefined || summary.deletions !== undefined) ? (
						<Pill className="ml-auto">
							<DiffStat className="text-fr-2xs" additions={summary.additions} deletions={summary.deletions} />
						</Pill>
					) : null}
				</span>
			</button>
			<span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{menu}</span>
		</ChainRow>
	);
}
