// PR Viewer — the review instrument in the dock (doc 73 §10), as a marketplace
// pack. Owner ruling: the viewer is NOT a feature inside the kit; it is
// assembled FROM the kit's generic furniture, and every review-shaped decision
// lives here.
//
//   THE IMPORT SURFACE: `react` + the granted `@fraym/ui` bricks.
//
// DATA: this session's links arrive by NAME through channel 3
// (`useStandardSessionFacts` → `reviews`, `reviewRequest`); the checkout's
// other reviews ride the workspace cell `store.watch`; detail, threads and the
// diff are request/response on the workspace driver the dock hands in — large,
// on demand, never a cell (doc 73 §3).
//
// INTENTS: `store.act("linkReview" | "unlinkReview" | "refreshReviews" |
// "reviewAction" | "openReview", …)`, admitted to this pack by the
// `scm:review` grant its manifest declares. The pack never writes a fact.
//
// STACKS: `resolveReviewChains` + `reviewListLines` are the CONTRACT's own
// resolvers, granted, so the rail, the card and this list agree on what a
// stack is. This file only decides how a line looks.

import {
	Badge,
	Button,
	GitHubPullRequestIcon,
	REVIEW_PILL_LABEL,
	reviewPillState,
	StreamingMarkdown,
	ChainRow,
	cn,
	ConfirmDialog,
	DiffStat,
	Icon,
	Input,
	resolveReviewChains,
	reviewListLines,
	StateGlyph,
	ThreadCard,
	useObservable,
	useStandardSessionFacts,
	visibleReviews,
} from "@fraym/ui";
import { type ComponentProps, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
	footerLine,
	parseLinkInput,
	refKey,
	relativeTime,
	type ReviewDetail,
	type ReviewDiffFile,
	type ReviewRef,
	type ReviewRequest,
	type ReviewState,
	type ReviewSummary,
	type ReviewThread,
	type SessionReviewLink,
} from "./model";

/** The Store's contract shape, restated structurally (doc 68 §3.4). */
interface HostStoreShape {
	watch<T = unknown>(key: string): { getSnapshot(): T | undefined; subscribe(fn: () => void): () => void };
	act(intent: string, payload?: unknown): void;
}

interface WorkspaceRefShape {
	readonly workspaceId: string;
	readonly path: string;
}

/** The driver methods this instrument calls, restated structurally. Absent =
 *  the provider cannot; the surface hides. */
interface WorkspaceDriverShape {
	getReview?(workspace: WorkspaceRefShape, ref: ReviewRef): Promise<ReviewDetail>;
	getReviewThreads?(workspace: WorkspaceRefShape, ref: ReviewRef): Promise<readonly ReviewThread[]>;
	getReviewDiff?(workspace: WorkspaceRefShape, ref: ReviewRef): Promise<{ readonly files: readonly ReviewDiffFile[]; readonly truncated: boolean }>;
}

/** The structural subset of `InstrumentContext` this instrument reads. */
export interface PrViewerProps {
	readonly sessionId: string | null;
	readonly workspace?: WorkspaceRefShape | null;
	readonly workspaceDriver?: WorkspaceDriverShape | null;
	readonly store?: HostStoreShape;
}

interface SessionFacts {
	readonly reviews?: readonly SessionReviewLink[];
	readonly reviewRequest?: ReviewRequest;
}

const NO_LINKS: readonly SessionReviewLink[] = [];
const NO_ROWS: readonly ReviewSummary[] = [];
const NONE = { getSnapshot: () => undefined, subscribe: () => () => {} };

type BadgeTone = NonNullable<ComponentProps<typeof Badge>["tone"]>;
type Tone = ComponentProps<typeof StateGlyph>["tone"];

/** State → ink, ONE place: a review cannot look like two things in two rows. */
function stateGlyph(summary: Pick<ReviewSummary, "state" | "isDraft" | "mergeability"> | null): {
	readonly tone: Tone;
	readonly icon: ComponentProps<typeof Icon>["name"];
	readonly label: string;
} {
	if (summary === null) return { tone: "muted", icon: "branch", label: "Not synced yet" };
	const state = reviewPillState(summary);
	const tone: Tone =
		state === "merged" ? "accent" : state === "closed" ? "negative" : state === "draft" ? "muted" : state === "conflicting" ? "warning" : "positive";
	return { tone, icon: "branch", label: REVIEW_PILL_LABEL[state] };
}

function checksGlyph(state: ReviewSummary["checksState"]): ReactNode {
	if (state === undefined || state === null) return null;
	const tone: Tone = state === "passing" ? "positive" : state === "failing" ? "negative" : "warning";
	const label = state === "passing" ? "All checks passed" : state === "failing" ? "Some checks failed" : "Checks running";
	return <StateGlyph tone={tone} icon={<Icon name={state === "passing" ? "check" : state === "failing" ? "x" : "clock"} size={12} />} label={label} />;
}

function sourceLabel(source: SessionReviewLink["source"]): string {
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

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** Right-aligned relative time, so every row's diff stat shares one right edge. */
const TIME_COLUMN = "2.5rem";

/** A list row is STACKED (owner ruling 2026-09-17): the review's number line
 *  on top — state octicon, `#N`, then time and check/decision badges at the
 *  right edge — the title full-width beneath it, and the branch + diff stat
 *  under that. Every line starts on the same left edge. */
function ReviewRow({
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
	const glyph = stateGlyph(summary);
	const ref = summary?.ref ?? link?.ref;
	const state = summary ? reviewPillState(summary) : "open";
	const stateTone: BadgeTone =
		state === "merged" ? "accent" : state === "closed" ? "del" : state === "draft" ? "mute" : state === "conflicting" ? "warn" : "add";
	return (
		<ChainRow depth={depth} className="group rounded-md pr-3 hover:bg-fr-surface">
			<button type="button" onClick={onSelect} className="flex min-w-0 flex-1 flex-col gap-1.5 py-2.5 text-left">
				{/* Every fact is a pill (owner ruling 2026-09-17): the review's
				    number carries its state's ink; the rest are quiet chips. */}
				<span className="flex min-w-0 flex-wrap items-center gap-1.5">
					<Badge variant="soft" tone={stateTone} className="gap-1 rounded-full normal-case tabular-nums" title={link ? sourceLabel(link.source) : undefined}>
						<GitHubPullRequestIcon state={state} size={12} />#{ref?.number}
						<span className="opacity-80">· {glyph.label}</span>
					</Badge>
					{summary?.reviewDecision === "changes-requested" ? (
						<Badge variant="soft" tone="warn" className="rounded-full normal-case">
							Changes requested
						</Badge>
					) : null}
					{checksGlyph(summary?.checksState)}
					{stack ? (
						<Badge variant="code" tone="mute" className="gap-1 rounded-full" title={stack.kind === "native" ? `Host stack of ${stack.size}: merging a layer lands the ones below it` : `${stack.size} reviews chained by base branch`}>
							<Icon name={stack.kind === "native" ? "layers" : "branch"} size={12} strokeWidth={1.6} />
							{stack.size}
						</Badge>
					) : null}
					{summary ? (
						<Badge variant="code" tone="mute" className="ml-auto gap-1 rounded-full tabular-nums">
							<Icon name="clock" size={12} strokeWidth={1.6} />
							{relativeTime(summary.updatedAt)}
						</Badge>
					) : null}
				</span>
				<span className="line-clamp-2 min-w-0 whitespace-normal break-words text-fr-md font-medium text-fr-text">{summary?.title ?? link?.url ?? ""}</span>
				<span className="flex min-w-0 items-center gap-1.5">
					{summary?.author && summary.author.login !== sharedOwner ? (
						<Badge variant="code" tone="mute" className="gap-1 rounded-full">
							<Icon name="user" size={12} strokeWidth={1.6} />
							{summary.author.login}
						</Badge>
					) : null}
					<Badge variant="soft" tone="accent" className="min-w-0 max-w-full justify-start gap-1 rounded-full">
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
					</Badge>
					{summary && (summary.additions !== undefined || summary.deletions !== undefined) ? (
						<Badge variant="code" tone="mute" className="ml-auto rounded-full">
							<DiffStat className="text-fr-2xs" additions={summary.additions} deletions={summary.deletions} />
						</Badge>
					) : null}
				</span>
			</button>
			<span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{menu}</span>
		</ChainRow>
	);
}

/** The " · " between two facts on one line. */
function LayerGlyph({ state, isDraft }: { readonly state: ReviewState; readonly isDraft: boolean }) {
	const glyph = stateGlyph({ state, isDraft });
	return <StateGlyph {...glyph} icon={<GitHubPullRequestIcon size={11} />} />;
}

function RowMenu({ actions }: { readonly actions: readonly { readonly label: string; readonly onClick: () => void }[] }) {
	const [open, setOpen] = useState(false);
	return (
		<span className="relative">
			<Button size="icon" variant="ghost" aria-label="Row actions" onClick={() => setOpen(v => !v)}>
				<Icon name="dots" size={13} />
			</Button>
			{open ? (
				<span className="absolute right-0 z-10 mt-1 flex min-w-36 flex-col rounded-md border border-fr-border bg-fr-surface p-1 shadow-fr">
					{actions.map(action => (
						<button
							key={action.label}
							type="button"
							className="rounded-sm px-2 py-1 text-left text-fr-sm text-fr-text hover:bg-fr-surface-2"
							onClick={() => {
								setOpen(false);
								action.onClick();
							}}
						>
							{action.label}
						</button>
					))}
				</span>
			) : null}
		</span>
	);
}

function LinkDialog({
	own,
	onSubmit,
	onClose,
}: {
	readonly own: { readonly provider: string; readonly host: string; readonly repository: string } | null;
	readonly onSubmit: (ref: ReviewRef, url: string) => void;
	readonly onClose: () => void;
}) {
	const [text, setText] = useState("");
	const parsed = useMemo(() => parseLinkInput(text, own), [text, own]);
	const reason =
		text.trim() === ""
			? null
			: parsed
				? null
				: /^#?\d+$/.test(text.trim())
					? "This checkout has no review host; paste a full URL."
					: "Paste a review URL, or #123 for this repository.";
	return (
		<div className="flex flex-col gap-2 border-fr-border border-b p-2">
			<Input
				autoFocus
				value={text}
				placeholder="https://… or #123"
				onChange={event => setText(event.target.value)}
				onKeyDown={event => {
					if (event.key === "Escape") onClose();
					if (event.key === "Enter" && parsed) onSubmit(parsed.ref, parsed.url);
				}}
			/>
			{reason ? <span className="text-fr-2xs text-fr-warn">{reason}</span> : null}
			<div className="flex justify-end gap-1">
				<Button size="sm" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button size="sm" disabled={!parsed} onClick={() => parsed && onSubmit(parsed.ref, parsed.url)}>
					Link to this session
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

function useRead<T>(read: (() => Promise<T>) | null, key: string): { readonly value: T | null; readonly error: string | null; readonly loading: boolean } {
	const [state, setState] = useState<{ key: string; value: T | null; error: string | null; loading: boolean }>({ key, value: null, error: null, loading: read !== null });
	useEffect(() => {
		if (!read) return;
		let live = true;
		setState({ key, value: null, error: null, loading: true });
		read().then(
			value => live && setState({ key, value, error: null, loading: false }),
			error => live && setState({ key, value: null, error: error instanceof Error ? error.message : String(error), loading: false }),
		);
		return () => {
			live = false;
		};
	}, [key, read]);
	return state.key === key ? state : { value: null, error: null, loading: read !== null };
}

function DetailView({
	ref,
	summary,
	link,
	workspace,
	driver,
	act,
	onBack,
}: {
	readonly ref: ReviewRef;
	readonly summary: ReviewSummary | null;
	readonly link: SessionReviewLink | undefined;
	readonly workspace: WorkspaceRefShape;
	readonly driver: WorkspaceDriverShape;
	readonly act: (intent: string, payload: Record<string, unknown>) => void;
	readonly onBack: (() => void) | null;
}) {
	const key = refKey(ref);
  const readDetail = useCallback(() => (driver.getReview ? driver.getReview(workspace, ref) : Promise.reject(new Error("This host offers no detail"))), [driver, workspace, ref]);
  const readThreads = useCallback(() => (driver.getReviewThreads ? driver.getReviewThreads(workspace, ref) : Promise.resolve([] as readonly ReviewThread[])), [driver, workspace, ref]);
  const readDiff = useCallback(() => (driver.getReviewDiff ? driver.getReviewDiff(workspace, ref) : Promise.resolve({ files: [] as readonly ReviewDiffFile[], truncated: false })), [driver, workspace, ref]);
	const detail = useRead(driver.getReview ? readDetail : null, key);
	const [tab, setTab] = useState<"summary" | "threads" | "diff">("summary");
	// A world-touching action is confirmed first — one click closed a live PR
	// on the host during a design pass (2026-09-17). The dialog holds the
	// exact `reviewAction` input it will send, so confirm fires it verbatim.
	const [pending, setPending] = useState<{
		readonly title: string;
		readonly description: string;
		readonly confirmLabel: string;
		readonly intent: "default" | "danger";
		readonly input: Record<string, unknown>;
	} | null>(null);
	const threads = useRead(driver.getReviewThreads ? readThreads : null, `${key}:threads`);
	const diff = useRead(tab === "diff" && driver.getReviewDiff ? readDiff : null, `${key}:diff`);
	const [folded, setFolded] = useState<Record<string, boolean>>({});
	const head = detail.value ?? summary;
	const stack = detail.value?.stack ?? link?.stack ?? null;
	const canMerge = head?.state === "open" && !head.isDraft && (detail.value?.viewer.merge ?? false) && (head.capabilities.merge ?? false);
	const stackHeads = stack?.layers.filter(layer => layer.state === "open" && layer.headSha).map(layer => ({ number: layer.number, headSha: layer.headSha as string })) ?? [];
	const stackLayersBelow = stack ? stack.layers.slice(0, stack.layers.findIndex(layer => layer.number === ref.number) + 1).filter(layer => layer.state !== "merged") : [];
	const canStackMerge = canMerge && stack !== null && head?.capabilities.stackActions === true && stackLayersBelow.length > 1 && stackLayersBelow.every(layer => layer.headSha && !layer.isDraft);
	const canStackRebase = stack !== null && head?.capabilities.stackActions === true && (detail.value?.viewer.stackRebase ?? false) && stackHeads.length > 0;

	const conflicting = head?.state === "open" && head.mergeability === "conflicting";
	const glyphInk =
		head?.state === "merged" ? "text-fr-accent" : head?.state === "closed" ? "text-fr-del" : head?.isDraft ? "text-fr-text-3" : "text-fr-add";
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
	const statusTone: BadgeTone =
		head?.state === "merged"
			? "accent"
			: head?.state === "closed"
				? "del"
				: head?.isDraft
					? "mute"
					: head?.reviewDecision === "approved"
						? "add"
						: head?.reviewDecision === "changes-requested"
							? "warn"
							: "add";
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
	const reviewers = detail.value?.reviewers.map(r => r.login) ?? [];
	const openThreads = threads.value?.filter(thread => !thread.isResolved).length;
	const emptyFacets = [
		...(detail.value && reviewers.length === 0 ? ["No reviewers"] : []),
		...(threads.value && !threads.value.some(thread => !thread.isResolved) ? ["no open threads"] : []),
		...(head && !head.checksState ? ["no checks"] : []),
	];

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<header className="flex min-w-0 items-center gap-1.5 overflow-hidden border-fr-border-soft border-b px-3 py-1.5">
				{onBack ? (
					<Button size="icon" variant="ghost" className="-ml-2.5" aria-label="Back to this session's reviews" onClick={onBack}>
						<Icon name="back" size={13} />
					</Button>
				) : null}
				<span className="flex items-center gap-1.5 text-fr-sm text-fr-text-2 tabular-nums">
					<GitHubPullRequestIcon size={13} className={glyphInk} />
					<span>#{ref.number}</span>
				</span>
				<span className="flex-1" />
				<Button size="icon" variant="ghost" aria-label="Open on the host" onClick={() => act("openReview", { ref, url: head?.url ?? link?.url ?? "" })}>
					<Icon name="external" size={13} />
				</Button>
				{head?.state === "open" ? (
					// Closes the REVIEW, not the panel: the danger treatment DESIGN
					// reserves for an action the user cannot take back lightly.
					<Button
						size="sm"
						variant="ghost"
						className="hover:border-fr-del hover:text-fr-del"
						onClick={() =>
							setPending({
								title: `Close #${ref.number} without merging?`,
								description: `The review closes on ${ref.host}. Its branch stays; you can reopen it from here.`,
								confirmLabel: "Close review",
								intent: "danger",
								input: { ref, action: "close" },
							})
						}
					>
						Close
					</Button>
				) : null}
				{canMerge && !canStackMerge ? (
					<Button
						size="sm"
						title={`Merge (${detail.value?.allowedMergeMethods[0] ?? "merge"})`}
						onClick={() =>
							setPending({
								title: `Merge #${ref.number}?`,
								description: `${head?.headBranch ?? "This branch"} lands on ${head?.baseBranch ?? "its base"} via ${detail.value?.allowedMergeMethods[0] ?? "merge"} on ${ref.host}. This cannot be undone from here.`,
								confirmLabel: "Merge",
								intent: "default",
								input: { ref, action: "merge", mergeMethod: detail.value?.allowedMergeMethods[0] },
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
					<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref, action: "ready" })}>
						Ready for review
					</Button>
				) : head?.state === "closed" ? (
					<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref, action: "reopen" })}>
						Reopen
					</Button>
				) : null}
			</header>
			<nav className="flex gap-0.5 border-fr-border border-b px-3 py-1.5 text-fr-sm">
				{(["summary", "threads", "diff"] as const).map((name, index) => (
					<button
						key={name}
						type="button"
						onClick={() => setTab(name)}
						className={cn("rounded-sm px-2 py-0.5 capitalize transition-colors", index === 0 && "-ml-2", tab === name ? "bg-fr-accent-dim text-fr-text" : "text-fr-text-2 hover:bg-fr-surface hover:text-fr-text")}
					>
						{name}
					</button>
				))}
			</nav>
			<div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
				{detail.error ? <p className="p-3 text-fr-del text-fr-sm">{detail.error}</p> : null}
				{tab === "summary" ? (
					<div className="flex flex-col gap-4 p-3">
						<div className="flex flex-col gap-1">
							<h1 className="font-primary text-fr-xl font-semibold leading-tight tracking-[-0.01em] text-fr-text">{head?.title ?? `#${ref.number}`}</h1>
							{/* Every fact is a pill (owner ruling 2026-09-17), the same chips
							    the list rows wear, so the head and the list read as one surface. */}
							<span className="flex flex-wrap items-center gap-1.5">
								{head?.author ? (
									<Badge variant="code" tone="mute" className="gap-1 rounded-full pl-1">
										<span aria-hidden="true" className="inline-flex size-3.5 items-center justify-center rounded-full bg-fr-surface-3 text-[9px] uppercase text-fr-text">
											{head.author.login.slice(0, 1)}
										</span>
										{head.author.login}
									</Badge>
								) : null}
								{head?.updatedAt ? (
									<Badge variant="code" tone="mute" className="gap-1 rounded-full tabular-nums">
										<Icon name="clock" size={12} strokeWidth={1.6} />
										{relativeTime(head.updatedAt)}
									</Badge>
								) : null}
								<Badge variant="soft" tone={conflicting && statusTone === "add" ? "mute" : statusTone} className="rounded-full normal-case">
									{statusLabel}
								</Badge>
								{conflicting ? (
									<Badge id="pr-viewer-merge-blocker" variant="soft" tone="warn" className="gap-1 rounded-full normal-case">
										<Icon name="warnTri" size={12} strokeWidth={1.6} aria-hidden="true" /> Conflicts with {head?.baseBranch}
									</Badge>
								) : null}
							</span>
						</div>
						<div className="flex flex-col gap-1.5">
							<span className="flex min-w-0 items-center gap-1.5">
								<Badge variant="soft" tone="accent" className="min-w-0 max-w-full justify-start gap-1 rounded-full" title={`${head?.headBranch ?? "—"} → ${head?.baseBranch ?? "—"}`}>
									<Icon name="git-branch" size={12} strokeWidth={1.6} />
									<span className="truncate">{head?.headBranch ?? "—"}</span>
									<span className="opacity-70">→ {head?.baseBranch ?? "—"}</span>
								</Badge>
								{head && (head.additions !== undefined || head.deletions !== undefined) ? (
									<Badge variant="code" tone="mute" className="ml-auto rounded-full">
										<DiffStat className="text-fr-2xs" additions={head.additions} deletions={head.deletions} />
									</Badge>
								) : null}
							</span>
							<span className="flex flex-wrap items-center gap-1.5">
								{reviewers.length > 0 ? (
									<Badge variant="code" tone="mute" className="min-w-0 gap-1 rounded-full">
										<Icon name="user" size={12} strokeWidth={1.6} />
										<span className="truncate">{reviewers.join(", ")}</span>
									</Badge>
								) : null}
								{openThreads ? (
									<Badge variant="code" tone="mute" className="gap-1 rounded-full">
										<Icon name="chat" size={12} strokeWidth={1.6} />
										{openThreads} open
									</Badge>
								) : null}
								{head?.checksState ? (
									<Badge variant="soft" tone={checksTone === "positive" ? "add" : checksTone === "negative" ? "del" : "warn"} className="gap-1 rounded-full normal-case">
										<Icon name={head.checksState === "failing" ? "x" : head.checksState === "pending" ? "clock" : "check"} size={12} strokeWidth={1.6} />
										{checksLabel}
									</Badge>
								) : null}
								{detail.value?.labels.map(label => (
									<Badge key={label.name} variant="code" tone="mute" className="gap-1 rounded-full">
										<Icon name="pin" size={12} strokeWidth={1.6} />
										{label.name}
									</Badge>
								))}
							</span>
							{/* The facets that are EMPTY, on one legible line — three dim rows
							    of "None" were a dead band under the branch. */}
							{emptyFacets.length > 0 ? (
								<span className="text-fr-xs text-fr-text-2">{emptyFacets.join(" · ")}</span>
							) : null}
						</div>
						{stack ? (
							<section className="flex flex-col gap-1 rounded-md border border-fr-border bg-fr-surface p-2">
								<span className="text-fr-sm font-semibold text-fr-text">Stack · {stack.layers.length} layers on {stack.base}</span>
								{[...stack.layers].reverse().map(layer => (
									<span key={layer.number} className={cn("flex items-center gap-2 text-fr-xs", layer.number === ref.number ? "text-fr-text" : "text-fr-text-2")}>
										<LayerGlyph state={layer.state} isDraft={layer.isDraft ?? false} />
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
													setPending({
														title: `Merge the stack under #${ref.number}?`,
														description: `${stackLayersBelow.length} reviews land on ${ref.host} in order, bottom first. This cannot be undone from here.`,
														confirmLabel: `Merge ${stackLayersBelow.length}`,
														intent: "default",
														input: { ref, action: "merge", stackNumber: stack.number, expectedStackHeads: stackLayersBelow.map(layer => ({ number: layer.number, headSha: layer.headSha })) },
													})
												}
											>
												Merge stack ({stackLayersBelow.length})
											</Button>
										) : null}
										{canStackRebase ? (
											<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref, action: "update-branch", stackNumber: stack.number, expectedStackHeads: stackHeads })}>
												Rebase stack
											</Button>
										) : null}
									</span>
								) : null}
							</section>
						) : null}
						{detail.value ? (
							<section className="flex flex-col gap-2">
								<span aria-hidden="true" className="border-fr-border-soft border-t" />
								{detail.value.body.trim() ? (
									<StreamingMarkdown text={detail.value.body} className="text-fr-sm text-fr-text" />
								) : (
									<span className="text-fr-sm text-fr-text-3">No description.</span>
								)}
								{detail.value.checks.length > 0 ? (
									<ul className="mt-2 flex flex-col gap-0.5 rounded-md border border-fr-border bg-fr-surface p-2 text-fr-xs">
										{detail.value.checks.map(check => (
											<li key={check.name} className="flex items-center gap-2">
												<span className={cn("w-14 shrink-0 tabular-nums", check.status === "success" ? "text-fr-add" : check.status === "failure" ? "text-fr-del" : "text-fr-text-3")}>{check.status}</span>
												<span className="min-w-0 truncate text-fr-text-2">{check.name}</span>
											</li>
										))}
									</ul>
								) : null}
							</section>
						) : detail.loading ? (
							<span className="text-fr-xs text-fr-text-3">Loading…</span>
						) : null}
					</div>
				) : null}
				{tab === "threads" ? (
					<div className="flex flex-col gap-2 p-3">
						{threads.loading ? <span className="text-fr-xs text-fr-text-3">Loading…</span> : null}
						{threads.error ? <p className="text-fr-del text-fr-sm">{threads.error}</p> : null}
						{threads.value && threads.value.length > 0 ? (
							<span className="text-fr-2xs text-fr-text-3">
								{threads.value.filter(thread => !thread.isResolved).length} open · {threads.value.filter(thread => thread.isResolved).length} resolved
							</span>
						) : null}
						{(threads.value ?? []).map(thread => (
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
							</div>
						))}
						{threads.value && threads.value.length === 0 ? <span className="text-fr-xs text-fr-text-3">No review conversations.</span> : null}
					</div>
				) : null}
				{tab === "diff" ? (
					<div className="flex flex-col gap-2 p-3">
						{diff.loading ? <span className="text-fr-xs text-fr-text-3">Loading…</span> : null}
						{diff.error ? <p className="text-fr-del text-fr-sm">{diff.error}</p> : null}
						{diff.value && diff.value.files.length > 0 ? (
							<span className="flex items-center gap-2 text-fr-2xs text-fr-text-3">
								<span>
									{diff.value.files.length} file{diff.value.files.length === 1 ? "" : "s"} changed
								</span>
								<DiffStat
									additions={diff.value.files.reduce((sum, file) => sum + file.additions, 0)}
									deletions={diff.value.files.reduce((sum, file) => sum + file.deletions, 0)}
								/>
							</span>
						) : null}
						{(diff.value?.files ?? []).map(file => (
							<details key={file.path} className="group rounded-md border border-fr-border bg-fr-surface" open={diff.value !== null && diff.value.files.length <= 3}>
								<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-fr-xs hover:bg-fr-surface-2">
									<Icon name="file" size={12} aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate text-fr-text">{file.path}</span>
									<DiffStat additions={file.additions} deletions={file.deletions} />
								</summary>
								{file.patch ? (
									<div className="border-fr-border-soft border-t">
										<StreamingMarkdown text={`\`\`\`diff\n${file.patch}\n\`\`\``} className="text-fr-2xs" />
									</div>
								) : (
									<span className="block border-fr-border-soft border-t px-3 py-1.5 text-fr-2xs text-fr-text-2">Hunks withheld by the host.</span>
								)}
							</details>
						))}
						{diff.value && diff.value.files.length === 0 ? <span className="text-fr-xs text-fr-text-3">No file changes.</span> : null}
						{diff.value?.truncated ? <span className="text-fr-2xs text-fr-text-3">More files than the host returned — open on the host for the rest.</span> : null}
					</div>
				) : null}
			</div>
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

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

export function PrViewer({ sessionId, workspace, workspaceDriver, store }: PrViewerProps) {
	const facts = useStandardSessionFacts(sessionId) as SessionFacts;
	const links = useMemo(() => visibleReviews((facts.reviews ?? NO_LINKS) as never) as readonly SessionReviewLink[], [facts.reviews]);
	// The checkout's OTHER reviews. Read by key because no workspace-scoped
	// standard fact exists yet; the dock's fence permits its own workspace's
	// cells (doc 68 §5), and the key is the catalogue's published one.
	const workspaceCell = useMemo(
		() => (store && workspace ? store.watch<readonly ReviewSummary[]>(`workspace/${workspace.workspaceId}/reviews`) : NONE),
		[store, workspace],
	);
	const checkout = useObservable(workspaceCell as never) as readonly ReviewSummary[] | undefined;
	const lines = useMemo(() => reviewListLines(resolveReviewChains(links as never)) as readonly { link: SessionReviewLink; depth: number; chainKey: string; stack: { kind: "native" | "derived"; size: number } | null }[], [links]);
	const linkedKeys = useMemo(() => new Set(links.map(link => refKey(link.ref))), [links]);
	const others = useMemo(() => (checkout ?? NO_ROWS).filter(row => !linkedKeys.has(refKey(row.ref))), [checkout, linkedKeys]);
	const [selected, setSelected] = useState<ReviewRef | null>(null);
	const [linking, setLinking] = useState(false);
	const act = useCallback(
		(intent: string, payload: Record<string, unknown>) => {
			if (!store) return;
			store.act(intent, { ...payload, ...(workspace ? { env: workspace } : {}), ...(sessionId ? { sessionId } : {}) });
		},
		[store, workspace, sessionId],
	);
	// THE REQUEST CELL (doc 73 §7): a rail chip asked for a review. The host
	// only writes it when THIS instrument is mounted, so answering it is the
	// whole reason `opens: ["review"]` is in the manifest.
	const request = facts.reviewRequest;
	useEffect(() => {
		if (request) setSelected(request.ref);
	}, [request]);

	const own = useMemo(() => {
		const first = links[0]?.snapshot?.ref ?? links[0]?.ref ?? checkout?.[0]?.ref;
		return first ? { provider: first.provider, host: first.host, repository: first.repository } : null;
	}, [links, checkout]);

	if (!store) {
		return <p className="p-3 text-fr-sm text-fr-text-3">No store on this mount — the viewer needs the host's facts.</p>;
	}
	const selectedLink = selected ? links.find(link => refKey(link.ref) === refKey(selected)) : undefined;
	// A link's own snapshot first (the sync stamps one on stack/pushed links);
	// otherwise the checkout sweep's row for the same ref — a MANUAL link
	// carries no snapshot, and without this it drew as a bare number + URL
	// beside a fully-titled sibling in "Also in this checkout" (live 2026-09-17).
	const summaryFor = (link: SessionReviewLink): ReviewSummary | null =>
		link.snapshot ?? checkout?.find(row => refKey(row.ref) === refKey(link.ref)) ?? null;
	// The base every listed review targets, when they all agree — the list is
	// its own proof of the checkout's trunk, so "→ main" on every row says nothing.
	const sharedBase = useMemo(() => {
		const bases = new Set<string>();
		for (const line of lines) {
			const base = summaryFor(line.link)?.baseBranch;
			if (base) bases.add(base);
		}
		for (const row of others) bases.add(row.baseBranch);
		return bases.size === 1 ? [...bases][0]! : null;
	}, [lines, others, summaryFor]);
	const sharedOwner = useMemo(() => {
		const owners = new Set<string>();
		for (const line of lines) {
			const owner = summaryFor(line.link)?.author?.login;
			if (owner) owners.add(owner);
		}
		for (const row of others) if (row.author) owners.add(row.author.login);
		return owners.size === 1 ? [...owners][0]! : null;
	}, [lines, others, summaryFor]);
	const selectedSummary = selected ? (selectedLink ? summaryFor(selectedLink) : (checkout?.find(row => refKey(row.ref) === refKey(selected)) ?? null)) : null;

	if (selected && workspace && workspaceDriver) {
		return (
			<DetailView
				ref={selected}
				summary={selectedSummary}
				link={selectedLink}
				workspace={workspace}
				driver={workspaceDriver}
				act={act}
				onBack={links.length + others.length > 1 || !selectedLink ? () => setSelected(null) : null}
			/>
		);
	}

	// A link needs a session to land on (doc 73 §4): on the start surface there
	// is none yet, so the link/unlink rows are absent rather than offered and
	// then dropped by the fence. Measured live 2026-09-17.
	const rowMenu = (ref: ReviewRef, url: string, link: SessionReviewLink | undefined, summary?: ReviewSummary | null) => (
		<RowMenu
			actions={[
				{ label: "Open on the host", onClick: () => act("openReview", { ref, url }) },
				{ label: "Refresh", onClick: () => act("refreshReviews", { ref }) },
				...(sessionId
					? [
							link
								? { label: link.source === "stack" ? "Dismiss from session" : "Unlink from session", onClick: () => act("unlinkReview", { ref }) }
								: { label: "Link to this session", onClick: () => act("linkReview", { ref, url, ...(summary ? { snapshot: summary } : {}) }) },
						]
					: []),
			]}
		/>
	);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{linking ? (
				<LinkDialog
					own={own}
					onClose={() => setLinking(false)}
					onSubmit={(ref, url) => {
						const known = checkout?.find(row => refKey(row.ref) === refKey(ref));
						act("linkReview", { ref, url, ...(known ? { snapshot: known } : {}) });
						setLinking(false);
					}}
				/>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{lines.length === 0 ? (
					<div className="flex flex-col items-start gap-2 p-3">
						<span className="text-fr-sm text-fr-text-3">
							{sessionId ? "No reviews linked to this session yet." : "Start a session to link reviews to it."}
						</span>
						{sessionId ? (
							<Button size="sm" variant="outline" onClick={() => setLinking(true)}>
								<Icon name="plus" size={12} /> Link a review
							</Button>
						) : null}
					</div>
				) : (
					<>
						{others.length > 0 ? <div className="px-2 pt-2 pb-2 text-fr-sm font-semibold text-fr-text">Linked to this session</div> : null}
						{lines.map(line => (
						<ReviewRow
							key={refKey(line.link.ref)}
							summary={summaryFor(line.link)}
							link={line.link}
							depth={line.depth}
							stack={line.stack}
							sharedBase={sharedBase}
							sharedOwner={sharedOwner}
							onSelect={() => setSelected(line.link.ref)}
							menu={rowMenu(line.link.ref, line.link.url, line.link)}
						/>
					))}
					</>
				)}
				{others.length > 0 ? (
					<>
						<div className="px-2 pt-5 pb-2 text-fr-sm font-semibold text-fr-text">Also in this checkout</div>
						{others.map(row => (
							<ReviewRow key={refKey(row.ref)} summary={row} depth={0} stack={null} sharedBase={sharedBase} sharedOwner={sharedOwner} onSelect={() => setSelected(row.ref)} menu={rowMenu(row.ref, row.url, undefined, row)} />
						))}
					</>
				) : null}
			</div>
			<footer className="flex items-center justify-between border-fr-border border-t px-4 py-2 text-fr-2xs text-fr-text-2">
				<span className="truncate">
					{footerLine(links)}
					{sharedOwner ? ` · by ${sharedOwner}` : ""}
				</span>
				{sessionId ? (
					<Button size="sm" variant="ghost" onClick={() => setLinking(true)}>
						<Icon name="plus" size={12} /> Link
					</Button>
				) : null}
			</footer>
		</div>
	);
}
