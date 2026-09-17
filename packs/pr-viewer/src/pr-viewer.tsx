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
	ChainRow,
	cn,
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

type Tone = ComponentProps<typeof StateGlyph>["tone"];

/** State → ink, ONE place: a review cannot look like two things in two rows. */
function stateGlyph(summary: Pick<ReviewSummary, "state" | "isDraft" | "mergeability"> | null): {
	readonly tone: Tone;
	readonly icon: ComponentProps<typeof Icon>["name"];
	readonly label: string;
} {
	if (summary === null) return { tone: "muted", icon: "branch", label: "Not synced yet" };
	if (summary.state === "merged") return { tone: "accent", icon: "check", label: "Merged" };
	if (summary.state === "closed") return { tone: "negative", icon: "x", label: "Closed" };
	if (summary.isDraft) return { tone: "muted", icon: "edit", label: "Draft" };
	if (summary.mergeability === "conflicting") return { tone: "warning", icon: "warnTri", label: "Conflicts" };
	return { tone: "positive", icon: "branch", label: "Open" };
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

function ReviewRow({
	summary,
	link,
	depth,
	stack,
	onSelect,
	menu,
}: {
	readonly summary: ReviewSummary | null;
	readonly link?: SessionReviewLink;
	readonly depth: number;
	readonly stack: { readonly kind: "native" | "derived"; readonly size: number } | null;
	readonly onSelect: () => void;
	readonly menu: ReactNode;
}) {
	const glyph = stateGlyph(summary);
	const ref = summary?.ref ?? link?.ref;
	const label = summary?.label ?? "review";
	return (
		<ChainRow depth={depth} className="group rounded-sm">
			<button type="button" onClick={onSelect} className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 text-left">
				<span className="flex min-w-0 items-center gap-1.5">
					<StateGlyph tone={glyph.tone} icon={<Icon name={glyph.icon} size={13} />} label={glyph.label} />
					<span className="font-secondary text-fr-xs text-fr-text-3 tabular-nums" title={link ? sourceLabel(link.source) : undefined}>
						{label} #{ref?.number}
					</span>
					<span className="min-w-0 flex-1 truncate text-fr-sm text-fr-text">{summary?.title ?? link?.url ?? ""}</span>
					{summary?.reviewDecision === "changes-requested" ? (
						<span className="font-secondary text-fr-2xs text-fr-warn">changes requested</span>
					) : null}
					{checksGlyph(summary?.checksState)}
					<DiffStat additions={summary?.additions} deletions={summary?.deletions} />
				</span>
				<span className="flex min-w-0 items-center gap-2 font-secondary text-fr-2xs text-fr-text-3">
					{stack ? (
						<span className="inline-flex items-center gap-0.5" title={stack.kind === "native" ? `Host stack of ${stack.size}: merging a layer lands the ones below it` : `${stack.size} reviews chained by base branch`}>
							<Icon name={stack.kind === "native" ? "layers" : "branch"} size={11} />
							{stack.size}
						</span>
					) : null}
					{summary?.author ? <span className="truncate">{summary.author.login}</span> : null}
					<span className="truncate font-mono">{summary ? `${summary.headBranch} → ${summary.baseBranch}` : ref ? `${ref.host}/${ref.repository}` : ""}</span>
					{summary ? <span className="ml-auto shrink-0">{relativeTime(summary.updatedAt)}</span> : null}
				</span>
			</button>
			<span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{menu}</span>
		</ChainRow>
	);
}

function LayerGlyph({ state, isDraft }: { readonly state: ReviewState; readonly isDraft: boolean }) {
	const glyph = stateGlyph({ state, isDraft });
	return <StateGlyph {...glyph} icon={<Icon name={glyph.icon} size={11} />} />;
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
			{reason ? <span className="font-secondary text-fr-2xs text-fr-warn">{reason}</span> : null}
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
	const threads = useRead(tab === "threads" && driver.getReviewThreads ? readThreads : null, `${key}:threads`);
	const diff = useRead(tab === "diff" && driver.getReviewDiff ? readDiff : null, `${key}:diff`);
	const [folded, setFolded] = useState<Record<string, boolean>>({});
	const head = detail.value ?? summary;
	const glyph = stateGlyph(head);
	const stack = detail.value?.stack ?? link?.stack ?? null;
	const canMerge = head?.state === "open" && !head.isDraft && (detail.value?.viewer.merge ?? false) && (head.capabilities.merge ?? false);
	const stackHeads = stack?.layers.filter(layer => layer.state === "open" && layer.headSha).map(layer => ({ number: layer.number, headSha: layer.headSha as string })) ?? [];
	const stackLayersBelow = stack ? stack.layers.slice(0, stack.layers.findIndex(layer => layer.number === ref.number) + 1).filter(layer => layer.state !== "merged") : [];
	const canStackMerge = canMerge && stack !== null && head?.capabilities.stackActions === true && stackLayersBelow.length > 1 && stackLayersBelow.every(layer => layer.headSha && !layer.isDraft);
	const canStackRebase = stack !== null && head?.capabilities.stackActions === true && (detail.value?.viewer.stackRebase ?? false) && stackHeads.length > 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-2 border-fr-border border-b px-2 py-1.5">
				{onBack ? (
					<Button size="icon" variant="ghost" aria-label="Back to this session's reviews" onClick={onBack}>
						<Icon name="back" size={13} />
					</Button>
				) : null}
				<StateGlyph tone={glyph.tone} icon={<Icon name={glyph.icon} size={13} />} label={glyph.label} />
				<span className="font-secondary text-fr-xs text-fr-text-3 tabular-nums">
					{head?.label ?? "review"} #{ref.number}
				</span>
				<span className="min-w-0 flex-1 truncate text-fr-sm text-fr-text">{head?.title ?? ""}</span>
				{checksGlyph(head?.checksState)}
				<DiffStat additions={head?.additions} deletions={head?.deletions} />
				<Button size="icon" variant="ghost" aria-label="Open on the host" onClick={() => act("openReview", { ref, url: head?.url ?? link?.url ?? "" })}>
					<Icon name="external" size={13} />
				</Button>
			</header>
			<nav className="flex gap-1 border-fr-border border-b px-2 py-1 font-secondary text-fr-xs">
				{(["summary", "threads", "diff"] as const).map(name => (
					<button key={name} type="button" onClick={() => setTab(name)} className={cn("rounded-sm px-2 py-0.5 capitalize", tab === name ? "bg-fr-surface-2 text-fr-text" : "text-fr-text-3 hover:text-fr-text")}>
						{name}
					</button>
				))}
			</nav>
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{detail.error ? <p className="text-fr-del text-fr-sm">{detail.error}</p> : null}
				{tab === "summary" ? (
					<div className="flex flex-col gap-3">
						{stack ? (
							<section className="flex flex-col gap-1 rounded-md border border-fr-border p-2">
								<span className="font-secondary text-fr-2xs text-fr-text-3">Stack · {stack.layers.length} layers on {stack.base}</span>
								{[...stack.layers].reverse().map(layer => (
									<span key={layer.number} className={cn("flex items-center gap-2 text-fr-xs", layer.number === ref.number ? "text-fr-text" : "text-fr-text-2")}>
										<LayerGlyph state={layer.state} isDraft={layer.isDraft ?? false} />
										<span className="tabular-nums">#{layer.number}</span>
										<span className="min-w-0 flex-1 truncate">{layer.title ?? layer.headBranch}</span>
									</span>
								))}
								<span className="flex gap-1 pt-1">
									{canStackMerge ? (
										<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref, action: "merge", stackNumber: stack.number, expectedStackHeads: stackLayersBelow.map(layer => ({ number: layer.number, headSha: layer.headSha })) })}>
											Merge stack ({stackLayersBelow.length})
										</Button>
									) : null}
									{canStackRebase ? (
										<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref, action: "update-branch", stackNumber: stack.number, expectedStackHeads: stackHeads })}>
											Rebase stack
										</Button>
									) : null}
								</span>
							</section>
						) : null}
						{detail.value ? (
							<>
								{detail.value.labels.length > 0 ? (
									<div className="flex flex-wrap gap-1">
										{detail.value.labels.map(label => (
											<span key={label.name} className="rounded-full border border-fr-border px-2 font-secondary text-fr-2xs text-fr-text-2">
												{label.name}
											</span>
										))}
									</div>
								) : null}
								{detail.value.reviewers.length > 0 ? (
									<span className="font-secondary text-fr-2xs text-fr-text-3">Reviewers · {detail.value.reviewers.map(r => r.login).join(", ")}</span>
								) : null}
								{detail.value.checks.length > 0 ? (
									<ul className="flex flex-col gap-0.5 font-secondary text-fr-xs">
										{detail.value.checks.map(check => (
											<li key={check.name} className="flex items-center gap-2">
												<span className={cn("tabular-nums", check.status === "success" ? "text-fr-add" : check.status === "failure" ? "text-fr-del" : "text-fr-text-3")}>{check.status}</span>
												<span className="min-w-0 truncate">{check.name}</span>
											</li>
										))}
									</ul>
								) : null}
								<pre className="whitespace-pre-wrap font-primary text-fr-sm text-fr-text-2">{detail.value.body}</pre>
								<span className="flex flex-wrap gap-1">
									{canMerge && !canStackMerge ? (
										<Button size="sm" onClick={() => act("reviewAction", { ref, action: "merge", mergeMethod: detail.value?.allowedMergeMethods[0] })}>
											Merge
										</Button>
									) : null}
									{head?.state === "open" && head.isDraft && head.capabilities.draft ? (
										<Button size="sm" variant="outline" onClick={() => act("reviewAction", { ref, action: "ready" })}>
											Ready for review
										</Button>
									) : null}
									{head?.state === "open" ? (
										<Button size="sm" variant="ghost" onClick={() => act("reviewAction", { ref, action: "close" })}>
											Close
										</Button>
									) : null}
									{head?.state === "closed" ? (
										<Button size="sm" variant="ghost" onClick={() => act("reviewAction", { ref, action: "reopen" })}>
											Reopen
										</Button>
									) : null}
								</span>
							</>
						) : detail.loading ? (
							<span className="font-secondary text-fr-xs text-fr-text-3">Loading…</span>
						) : null}
					</div>
				) : null}
				{tab === "threads" ? (
					<div className="flex flex-col gap-2">
						{threads.loading ? <span className="font-secondary text-fr-xs text-fr-text-3">Loading…</span> : null}
						{threads.error ? <p className="text-fr-del text-fr-sm">{threads.error}</p> : null}
						{(threads.value ?? []).map(thread => (
							<div key={thread.id} className="flex flex-col gap-1">
								<span className="font-secondary text-fr-2xs text-fr-text-3">
									{thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "no longer on a line"}
									{thread.isResolved ? " · resolved" : ""}
									{thread.isOutdated ? " · outdated" : ""}
								</span>
								<ThreadCard
									comments={thread.comments.map(comment => ({ id: comment.id, author: comment.author, body: comment.body, at: relativeTime(comment.createdAt) }))}
									folded={folded[thread.id] ?? thread.isResolved}
									onToggleFolded={() => setFolded(prev => ({ ...prev, [thread.id]: !(prev[thread.id] ?? thread.isResolved) }))}
								/>
							</div>
						))}
						{threads.value && threads.value.length === 0 ? <span className="font-secondary text-fr-xs text-fr-text-3">No review conversations.</span> : null}
					</div>
				) : null}
				{tab === "diff" ? (
					<div className="flex flex-col gap-2">
						{diff.loading ? <span className="font-secondary text-fr-xs text-fr-text-3">Loading…</span> : null}
						{diff.error ? <p className="text-fr-del text-fr-sm">{diff.error}</p> : null}
						{(diff.value?.files ?? []).map(file => (
							<details key={file.path} className="rounded-md border border-fr-border">
								<summary className="flex cursor-pointer items-center gap-2 px-2 py-1 font-secondary text-fr-xs">
									<span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
									<DiffStat additions={file.additions} deletions={file.deletions} />
								</summary>
								{file.patch ? <pre className="overflow-x-auto px-2 py-1 font-mono text-fr-2xs text-fr-text-2">{file.patch}</pre> : <span className="px-2 py-1 font-secondary text-fr-2xs text-fr-text-3">Hunks withheld by the host.</span>}
							</details>
						))}
						{diff.value?.truncated ? <span className="font-secondary text-fr-2xs text-fr-text-3">More files than the host returned — open on the host for the rest.</span> : null}
					</div>
				) : null}
			</div>
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
		return <p className="p-3 font-secondary text-fr-sm text-fr-text-3">No store on this mount — the viewer needs the host's facts.</p>;
	}
	const selectedLink = selected ? links.find(link => refKey(link.ref) === refKey(selected)) : undefined;
	// A link's own snapshot first (the sync stamps one on stack/pushed links);
	// otherwise the checkout sweep's row for the same ref — a MANUAL link
	// carries no snapshot, and without this it drew as a bare number + URL
	// beside a fully-titled sibling in "Also in this checkout" (live 2026-09-17).
	const summaryFor = (link: SessionReviewLink): ReviewSummary | null =>
		link.snapshot ?? checkout?.find(row => refKey(row.ref) === refKey(link.ref)) ?? null;
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
	const rowMenu = (ref: ReviewRef, url: string, link: SessionReviewLink | undefined) => (
		<RowMenu
			actions={[
				{ label: "Open on the host", onClick: () => act("openReview", { ref, url }) },
				{ label: "Refresh", onClick: () => act("refreshReviews", { ref }) },
				...(sessionId
					? [
							link
								? { label: link.source === "stack" ? "Dismiss from session" : "Unlink from session", onClick: () => act("unlinkReview", { ref }) }
								: { label: "Link to this session", onClick: () => act("linkReview", { ref, url }) },
						]
					: []),
			]}
		/>
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{linking ? (
				<LinkDialog
					own={own}
					onClose={() => setLinking(false)}
					onSubmit={(ref, url) => {
						act("linkReview", { ref, url });
						setLinking(false);
					}}
				/>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{lines.length === 0 ? (
					<div className="flex flex-col items-start gap-2 p-3">
						<span className="font-secondary text-fr-sm text-fr-text-3">
							{sessionId ? "No reviews linked to this session yet." : "Start a session to link reviews to it."}
						</span>
						{sessionId ? (
							<Button size="sm" variant="outline" onClick={() => setLinking(true)}>
								<Icon name="plus" size={12} /> Link a review
							</Button>
						) : null}
					</div>
				) : (
					lines.map(line => (
						<ReviewRow
							key={refKey(line.link.ref)}
							summary={summaryFor(line.link)}
							link={line.link}
							depth={line.depth}
							stack={line.stack}
							onSelect={() => setSelected(line.link.ref)}
							menu={rowMenu(line.link.ref, line.link.url, line.link)}
						/>
					))
				)}
				{others.length > 0 ? (
					<>
						<div className="px-2 pt-2 pb-1 font-secondary text-fr-2xs text-fr-text-3 uppercase">Also in this checkout</div>
						{others.map(row => (
							<ReviewRow key={refKey(row.ref)} summary={row} depth={0} stack={null} onSelect={() => setSelected(row.ref)} menu={rowMenu(row.ref, row.url, undefined)} />
						))}
					</>
				) : null}
			</div>
			<footer className="flex items-center justify-between border-fr-border border-t px-2 py-1 font-secondary text-fr-2xs text-fr-text-3">
				<span>{footerLine(links)}</span>
				{sessionId ? (
					<Button size="sm" variant="ghost" onClick={() => setLinking(true)}>
						<Icon name="plus" size={12} /> Link
					</Button>
				) : null}
			</footer>
		</div>
	);
}
