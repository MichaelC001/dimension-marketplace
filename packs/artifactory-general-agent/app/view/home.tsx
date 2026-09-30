// The home: every General Agent as a card. One quiet header names the page and
// holds its one action, the facet pills narrow the roster (and carry its
// counts), and each card is the house's hero card (`MarkCard`, the Harnesses
// and Memory providers card) with the agent's live face in its well, its name,
// its id and tier, two lines of what it is for and where it stands. A card
// carries no action: it opens the agent's profile, where the action lives (the
// owner's card ruling, 2026-09-30).

import type { ViewAgentFact } from "@dimension/sdk/artifactory";
import { type MarketplaceFilter, MarketplaceFilterPills } from "@fraym/ui/components/filter-pills";
import { Button } from "@fraym/ui/elements/button";
import { Skeleton } from "@fraym/ui/elements/skeleton";
import { MarkCard } from "@fraym/ui/features/mark-card";
import { Icon } from "@fraym/ui/icons";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { AgentListing, ListedAgent } from "../../src/contracts";
import { AgentFace, DockAgentButton, PANEL, Section, ViewColumn } from "./chrome";
import { faceHue, faceOf } from "./faces";
import type { ForgeBackend } from "./forge-client";
import { displayName, FACET_LABEL, FACETS, type Facet, facetCounts, factOf, filterAgents, standingOf, TIER_WORD } from "./roster";

/** The Harnesses grid's geometry: as many 15rem columns as fit the COLUMN. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4";

function AgentCard({ agent, fact, onOpen }: { readonly agent: ListedAgent; readonly fact: ViewAgentFact | undefined; readonly onOpen: () => void }) {
	// A wall of faces moves only where the pointer (or the keyboard) is, and the
	// orb, the page's own face, whose shared GL pool makes a lit grid cheap.
	const [near, setNear] = useState(false);
	const face = faceOf(agent.draft);
	const hue = faceHue(face);
	return (
		<div
			data-slot="agent-card"
			data-agent={agent.name}
			className="min-w-0"
			onPointerEnter={() => setNear(true)}
			onPointerLeave={() => setNear(false)}
			onFocus={() => setNear(true)}
			onBlur={() => setNear(false)}
		>
			<MarkCard
				variant="hero"
				name={displayName(agent, fact)}
				avatar={<AgentFace {...face} size="lg" live={near || face.avatar === "orb"} />}
				{...(hue !== undefined ? { hue } : {})}
				status={standingOf(agent, fact)}
				selected={false}
				onOpen={onOpen}
			>
				<p data-slot="agent-card-id" className="m-0 mt-1 fr-overflow font-secondary text-fr-xs text-fr-text-2">
					{agent.name} · {TIER_WORD[agent.source]}
				</p>
				<p data-slot="agent-card-description" className="m-0 mt-2 line-clamp-2 text-fr-sm leading-relaxed text-fr-text-2">
					{agent.description || "No description yet."}
				</p>
			</MarkCard>
		</div>
	);
}

/** The card grid, with roving arrow keys between the cards (`MemoryProviderGrid`'s
 *  contract): Tab still reaches every card; arrows, Home and End are an addition
 *  for a 2-D layout, and only move focus that is already inside the grid. */
function AgentGrid({ children, label }: { readonly children: ReactNode; readonly label: string }) {
	const grid = useRef<HTMLDivElement>(null);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
		const jump = event.key === "Home" ? "first" : event.key === "End" ? "last" : null;
		if (step === undefined && jump === null) return;
		const opens = [...(grid.current?.querySelectorAll<HTMLButtonElement>('[data-slot="mark-card-open"]') ?? [])];
		const current = opens.indexOf(document.activeElement as HTMLButtonElement);
		if (opens.length === 0 || (jump === null && current < 0)) return;
		const next = jump === "first" ? 0 : jump === "last" ? opens.length - 1 : (current + (step ?? 0) + opens.length) % opens.length;
		event.preventDefault();
		opens[next]?.focus();
	};
	return (
		<div ref={grid} role="group" aria-label={label} data-slot="agent-grid" onKeyDown={onKeyDown} className={GRID}>
			{children}
		</div>
	);
}

/** The cards' own shape, empty: the MarkCard radius, its face well and its lines. */
function HomeSkeleton() {
	return (
		<div role="status" aria-busy="true" className={GRID}>
			<span className="sr-only">Reading your agents…</span>
			{[0, 1, 2, 3].map(key => (
				<div key={key} aria-hidden className="flex flex-col overflow-hidden rounded-2xl border border-fr-border-soft bg-fr-surface/85">
					<div className="grid place-items-center border-b border-fr-border-soft py-5">
						<Skeleton className="size-24" circle />
					</div>
					<div className="flex flex-col gap-3 p-4">
						<Skeleton className="h-4 w-28" rounded="sm" />
						<Skeleton className="h-3 w-20" rounded="sm" />
						<Skeleton className="h-3 w-full" rounded="sm" />
						<Skeleton className="mt-2 h-3 w-24" rounded="sm" />
					</div>
				</div>
			))}
		</div>
	);
}

/** Things to ask the Machinist, who can build an agent with you from the dock. */
const ASK_FOR = [
	"Make me an agent that writes our release notes from what merged",
	"A reviewer that only reads, and asks before it runs anything",
	"Give the CMO a home and memory that follows it across projects",
] as const;

function EmptyHome() {
	return (
		<div className={`${PANEL} grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 gap-y-5 px-5 py-6`}>
			<span className="flex size-10 items-center justify-center rounded-lg bg-fr-surface-3 text-fr-text-2">
				<Icon name="bot" size={20} strokeWidth={1.7} />
			</span>
			<div className="flex min-w-0 flex-col gap-1">
				<h2 className="m-0 text-fr-lg font-semibold text-fr-text">No agents yet</h2>
				<p className="m-0 max-w-prose text-fr-sm leading-relaxed text-pretty text-fr-text-2">
					A General Agent is a teammate with its own charter, tools, memory and home. Create one above, or tell the
					Machinist what you need and it drafts one for you to accept.
				</p>
			</div>
			<div className="col-start-2 flex flex-col gap-2">
				<span className="font-secondary text-fr-xs text-fr-text-2">Or ask the Machinist</span>
				<ul className="m-0 flex list-none flex-col gap-2 p-0">
					{ASK_FOR.map(line => (
						<li key={line} className="flex items-center gap-2 text-fr-sm text-fr-text">
							<Icon name="caretR" size={12} strokeWidth={2} className="shrink-0 text-fr-accent" />
							<span>“{line}”</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

export function ForgeHome({
	backend,
	listing,
	error,
	facts,
	facet,
	onFacet,
	focusAgent,
	onOpen,
	onCreate,
}: {
	readonly backend: ForgeBackend;
	readonly listing: AgentListing | null;
	readonly error: string | null;
	readonly facts: readonly ViewAgentFact[];
	readonly facet: Facet;
	readonly onFacet: (facet: Facet) => void;
	/** The card to hand focus back to, coming back from its profile. */
	readonly focusAgent: string | null;
	readonly onOpen: (agent: ListedAgent) => void;
	readonly onCreate: () => void;
}) {
	const [notice, setNotice] = useState<string | null>(null);
	const agents = listing?.agents ?? [];
	const counts = facetCounts(agents, facts);
	const shown = filterAgents(agents, facts, facet);
	const filters: readonly MarketplaceFilter<Facet>[] = FACETS.filter(id => id !== "off" || backend.visibility.offered()).map(id => ({
		id,
		label: FACET_LABEL[id],
		count: counts[id],
		disabled: id !== "all" && id !== facet && counts[id] === 0,
	}));

	// Back from a profile: the card it was opened from takes the focus again.
	useEffect(() => {
		if (focusAgent === null || listing === null) return;
		const cards = document.querySelectorAll<HTMLElement>('[data-slot="agent-card"]');
		for (const card of cards) {
			if (card.dataset.agent === focusAgent) {
				card.querySelector<HTMLButtonElement>('[data-slot="mark-card-open"]')?.focus();
				break;
			}
		}
	}, [focusAgent, listing]);

	return (
		<ViewColumn slot="forge-home">
			{/* The page's own top-right, as on Autonomy: the Machinist in the dock
			    beside this page. The row collapses when no dock station is lent. */}
			<div data-slot="forge-home-toolbar" className="-mt-2 -mb-4 flex min-h-8 items-center justify-end empty:hidden">
				<DockAgentButton dock={backend.dock} onError={setNotice} />
			</div>
			{/* One quiet surface: the page's name and its one action. The room's own
			    atmosphere behind the column is the only ambient light. */}
			<header className={`${PANEL} flex flex-wrap items-end justify-between gap-x-6 gap-y-4 px-6 py-6`}>
				<div className="flex min-w-0 max-w-prose flex-col gap-2">
					<h1 className="m-0 text-fr-2xl leading-tight font-semibold tracking-fr-tight text-balance text-fr-text">General Agents</h1>
					<p className="m-0 text-fr-sm leading-relaxed text-pretty text-fr-text-2">
						Every agent you can run. Open one to see everything it is and can do, and change it there.
					</p>
				</div>
				<Button onClick={onCreate} data-slot="forge-new-agent">
					<Icon name="plus" strokeWidth={2} />
					Create agent
				</Button>
			</header>
			{notice !== null ? (
				<p role="alert" className="m-0 -mt-3 text-fr-xs text-fr-warn">
					{notice}
				</p>
			) : null}
			{listing !== null && listing.notices.length > 0 ? (
				<ul className="m-0 -mt-3 flex list-none flex-col gap-1 p-0">
					{listing.notices.map(line => (
						<li key={line} className="text-fr-xs text-fr-text-2">
							{line}
						</li>
					))}
				</ul>
			) : null}
			{listing === null ? (
				error !== null ? (
					<div role="alert" className={`${PANEL} flex flex-col gap-1 p-4`}>
						<span className="text-fr-md font-semibold text-fr-text">Could not read your agents</span>
						<span className="text-fr-sm text-fr-text-2">{error}</span>
					</div>
				) : (
					<HomeSkeleton />
				)
			) : agents.length === 0 ? (
				<EmptyHome />
			) : (
				<>
					{agents.length > 1 ? <MarketplaceFilterPills filters={filters} active={facet} onChange={onFacet} ariaLabel="Filter agents" /> : null}
					<Section title={facet === "all" ? "All agents" : FACET_LABEL[facet]}>
						{shown.length === 0 ? (
							<p className="m-0 text-fr-sm text-fr-text-2">No agents here.</p>
						) : (
							<AgentGrid label="General Agents">
								{shown.map(agent => (
									<AgentCard key={agent.draft.key} agent={agent} fact={factOf(agent, facts)} onOpen={() => onOpen(agent)} />
								))}
							</AgentGrid>
						)}
					</Section>
				</>
			)}
		</ViewColumn>
	);
}
