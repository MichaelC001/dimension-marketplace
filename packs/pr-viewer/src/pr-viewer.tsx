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
	Button,
	GitHubPullRequestIcon,
	Icon,
	Pill,
	resolveReviewChains,
	reviewListLines,
	reviewPillState,
	reviewsUnavailableAdvice,
	useObservable,
	useStandardSessionFacts,
	visibleReviews,
} from "@fraym/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LinkDialog, RowMenu } from "./compose";
import { DetailView } from "./detail-view";
import {
	footerLine,
	refKey,
	type ReviewRef,
	type ReviewRequest,
	type ReviewsUnavailable,
	type ReviewSummary,
	type SessionReviewLink,
} from "./model";
import { ReviewRow } from "./review-row";
import type { HostStoreShape, ReviewAct, WorkspaceDriverShape, WorkspaceRefShape } from "./shapes";

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

/** The list failed for a stated reason (doc 73 §9): the fix, with the
 *  command in hand, instead of an empty list that reads as "no reviews". */
function UnavailableState({ unavailable }: { readonly unavailable: ReviewsUnavailable }) {
	const advice = reviewsUnavailableAdvice(unavailable);
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex flex-col items-start gap-2 p-3" data-slot="pr-viewer-unavailable" data-reason={unavailable.reason}>
			<span className="text-fr-md font-medium text-fr-text">{advice.title}</span>
			<span className="text-fr-sm text-fr-text-2">{advice.detail}</span>
			{advice.command ? (
				<span className="inline-flex max-w-full items-center gap-2 rounded-md border border-fr-border bg-fr-surface-3 py-1 pr-1 pl-2.5 text-fr-xs text-fr-text-2">
					<code className="truncate font-code">{advice.command}</code>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							void navigator.clipboard?.writeText(advice.command ?? "").then(() => setCopied(true));
						}}
					>
						{copied ? "Copied" : "Copy"}
					</Button>
				</span>
			) : null}
		</div>
	);
}

/** A review was asked for — by a row, or by a rail chip through the request
 *  cell — on a mount with no checkout driver behind it. The host cannot read
 *  the detail, so the surface SAYS so and offers the one thing it can do,
 *  rather than swallowing the selection and re-rendering the same list. */
function NoDetailView({
	reviewRef,
	summary,
	link,
	act,
	onBack,
}: {
	readonly reviewRef: ReviewRef;
	readonly summary: ReviewSummary | null;
	readonly link: SessionReviewLink | undefined;
	readonly act: ReviewAct;
	readonly onBack: () => void;
}) {
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="pr-viewer-no-detail">
			<header className="flex min-w-0 items-center gap-1.5 border-fr-border-soft border-b px-3 py-1.5">
				<Button size="icon" variant="ghost" className="-ml-2.5" aria-label="Back to this session's reviews" onClick={onBack}>
					<Icon name="back" size={13} />
				</Button>
				<span className="flex items-center gap-1.5 text-fr-sm text-fr-text-2 tabular-nums">
					<GitHubPullRequestIcon state={summary ? reviewPillState(summary) : "open"} size={12} />
					<span>#{reviewRef.number}</span>
				</span>
			</header>
			<div className="flex flex-col items-start gap-2 p-3">
				<span className="text-fr-md font-medium text-fr-text">{summary?.title ?? `#${reviewRef.number}`}</span>
				<Pill className="min-w-0 max-w-full justify-start">
					<Icon name="git-branch" size={12} strokeWidth={1.6} />
					<span className="truncate">
						{reviewRef.host}/{reviewRef.repository}
					</span>
				</Pill>
				<span className="text-fr-sm text-fr-text-2">This mount has no checkout behind it, so the review's detail, threads and diff cannot be read here.</span>
				<Button size="sm" variant="outline" onClick={() => act("openReview", { ref: reviewRef, url: summary?.url ?? link?.url ?? "" })}>
					<Icon name="external" size={12} /> Open on the host
				</Button>
			</div>
		</div>
	);
}

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
	// WHY the checkout's list could not be read, when it could not — the same
	// catalogue-published cell the environment card draws its fix from.
	// A settled `reviewAction` (a reply, a resolve, a verdict) re-reads the
	// detail it changed: the action cell is the host's one lane for outcomes,
	// so watching it is how the viewer learns the write landed.
	const actionCell = useMemo(
		() => (store && workspace ? store.watch<{ readonly action?: string; readonly state?: string; readonly settledAt?: number }>(`workspace/${workspace.workspaceId}/scmAction`) : NONE),
		[store, workspace],
	);
	const actionFact = useObservable(actionCell as never) as
		| { readonly action?: string; readonly state?: string; readonly settledAt?: number; readonly error?: string; readonly result?: unknown }
		| undefined;
	const settledActions = actionFact?.action === "reviewAction" && actionFact.state === "settled" ? (actionFact.settledAt ?? 0) : 0;
	// A refused write says why, in the host's words — the result's own
	// `message` (a provider refusal) or the executor's error.
	const settledResult = actionFact?.action === "reviewAction" && actionFact.state === "settled" ? actionFact.result : undefined;
	const refusal =
		settledResult && typeof settledResult === "object" && "ok" in settledResult && settledResult.ok === false
			? "message" in settledResult && typeof settledResult.message === "string"
				? settledResult.message
				: "refused"
			: null;
	const actionNotice = actionFact?.action === "reviewAction" && actionFact.state === "settled" ? (actionFact.error ?? refusal) : null;
	const unavailableCell = useMemo(
		() => (store && workspace ? store.watch<ReviewsUnavailable>(`workspace/${workspace.workspaceId}/reviewsUnavailable`) : NONE),
		[store, workspace],
	);
	const unavailable = useObservable(unavailableCell as never) as ReviewsUnavailable | undefined;
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
		const first = links[0]?.ref ?? checkout?.[0]?.ref;
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
	const bases = new Set<string>();
	const owners = new Set<string>();
	for (const line of lines) {
		const summary = summaryFor(line.link);
		if (summary?.baseBranch) bases.add(summary.baseBranch);
		if (summary?.author) owners.add(summary.author.login);
	}
	for (const row of others) {
		bases.add(row.baseBranch);
		if (row.author) owners.add(row.author.login);
	}
	const sharedBase = bases.size === 1 ? [...bases][0]! : null;
	// Likewise the author they all share — named once, in the footer.
	const sharedOwner = owners.size === 1 ? [...owners][0]! : null;
	const selectedSummary = selected ? (selectedLink ? summaryFor(selectedLink) : (checkout?.find(row => refKey(row.ref) === refKey(selected)) ?? null)) : null;

	if (selected) {
		const back = links.length + others.length > 1 || !selectedLink ? () => setSelected(null) : null;
		return workspace && workspaceDriver ? (
			<DetailView
				reviewRef={selected}
				summary={selectedSummary}
				link={selectedLink}
				workspace={workspace}
				driver={workspaceDriver}
				act={act}
				onBack={back}
				settledActions={settledActions}
				actionNotice={actionNotice}
			/>
		) : (
			<NoDetailView reviewRef={selected} summary={selectedSummary} link={selectedLink} act={act} onBack={() => setSelected(null)} />
		);
	}

	// A link needs a session to land on (doc 73 §4): on the start surface there
	// is none yet, so the link/unlink rows are absent rather than offered and
	// then dropped by the fence. Measured live 2026-09-17.
	const rowMenu = (ref: ReviewRef, url: string, link: SessionReviewLink | undefined, summary?: ReviewSummary | null) => (
		<RowMenu
			actions={[
				{ label: "Open on the host", onClick: () => act("openReview", { ref, url, external: true }) },
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
				{lines.length === 0 && others.length === 0 && unavailable ? (
					<UnavailableState unavailable={unavailable} />
				) : lines.length === 0 ? (
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
						<div className="flex flex-col gap-2">
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
						</div>
					</>
				)}
				{others.length > 0 ? (
					<>
						<div className="px-2 pt-5 pb-2 text-fr-sm font-semibold text-fr-text">Also in this checkout</div>
						<div className="flex flex-col gap-2">
							{others.map(row => (
								<ReviewRow key={refKey(row.ref)} summary={row} depth={0} stack={null} sharedBase={sharedBase} sharedOwner={sharedOwner} onSelect={() => setSelected(row.ref)} menu={rowMenu(row.ref, row.url, undefined, row)} />
							))}
						</div>
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
