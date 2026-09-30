// The home: every General Agent as a card. A hero band names the page and
// counts the roster, the facet pills narrow it, and each card is the house's
// hero card (`MarkCard`, the Harnesses and Memory providers card) with the
// agent's live face in its well, its name, two lines of what it is for and
// where it stands. A card carries no action — it opens the agent's profile,
// where the one action lives (the owner's card ruling, 2026-09-30).

import type { ViewAgentFact } from "@dimension/sdk/artifactory";
import { type MarketplaceFilter, MarketplaceFilterPills } from "@fraym/ui/components/filter-pills";
import { Button } from "@fraym/ui/elements/button";
import { NebulaBackdrop } from "@fraym/ui/elements/nebula-backdrop";
import { Skeleton } from "@fraym/ui/elements/skeleton";
import { DiagramAtmosphere } from "@fraym/ui/features/diagram/atmosphere";
import { MarkCard } from "@fraym/ui/features/mark-card";
import { Icon } from "@fraym/ui/icons";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { AgentListing, ListedAgent } from "../../src/contracts";
import { AgentFace, DockAgentButton, HERO_LABEL, Section, ViewColumn } from "./chrome";
import { faceOf } from "./faces";
import type { ForgeBackend } from "./forge-client";
import { displayName, FACET_LABEL, FACETS, type Facet, facetCounts, factOf, filterAgents, standingOf } from "./roster";

/** The Harnesses grid's geometry: as many 236px columns as fit the COLUMN. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-4";

/** The tier, as one quiet word beside the name. */
const TIER_WORD = { pack: "Pack", user: "Yours", workspace: "Project" } as const;

/** The size a face is painted at in a card's well: the vibr scale's card step
 *  and a little over, so a face's halo fills the well the way a mark does. */
const CARD_FACE = 120;

function AgentCard({ agent, fact, onOpen }: { readonly agent: ListedAgent; readonly fact: ViewAgentFact | undefined; readonly onOpen: () => void }) {
	// A wall of faces moves only where the pointer (or the keyboard) is — and the
	// orb, the page's own face, whose shared GL pool makes a lit grid cheap.
	const [near, setNear] = useState(false);
	const face = faceOf(agent.draft);
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
				vendor={TIER_WORD[agent.source]}
				avatar={<AgentFace {...face} size={CARD_FACE} live={near || face.avatar === "orb"} />}
				status={standingOf(agent, fact)}
				selected={false}
				onOpen={onOpen}
			>
				<p data-slot="agent-card-description" className="m-0 mt-1 line-clamp-2 text-fr-sm leading-relaxed text-fr-text-2">
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

function HomeSkeleton() {
	return (
		<div role="status" aria-busy="true" className={GRID}>
			<span className="sr-only">Reading your agents…</span>
			{[0, 1, 2, 3].map(key => (
				<div key={key} aria-hidden className="flex flex-col overflow-hidden rounded-2xl border border-fr-border-soft bg-fr-surface/85">
					<div className="grid h-[156px] place-items-center border-b border-fr-border-soft">
						<Skeleton className="size-[88px]" circle />
					</div>
					<div className="flex flex-col gap-2.5 px-4 pt-3.5 pb-4">
						<Skeleton className="h-4 w-28" rounded="sm" />
						<Skeleton className="h-3 w-full" rounded="sm" />
						<Skeleton className="h-3 w-3/4" rounded="sm" />
						<Skeleton className="mt-3 h-3 w-24" rounded="sm" />
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

function EmptyHome({ onCreate }: { readonly onCreate: () => void }) {
	return (
		<div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3.5 gap-y-5 rounded-lg border border-fr-border-soft bg-fr-surface px-5 py-6">
			<span className="flex size-10 items-center justify-center rounded-lg bg-fr-surface-3 text-fr-text-2">
				<Icon name="bot" size={20} strokeWidth={1.7} />
			</span>
			<div className="flex min-w-0 flex-col items-start gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="m-0 text-fr-lg font-semibold text-fr-text">No agents yet</h2>
					<p className="m-0 max-w-prose text-fr-sm leading-relaxed text-pretty text-fr-text-2">
						A General Agent is a teammate with its own charter, tools, memory and home. Make one here, or tell the
						Machinist what you need and it drafts one for you to accept.
					</p>
				</div>
				<Button onClick={onCreate}>
					<Icon name="plus" strokeWidth={2} />
					New agent
				</Button>
			</div>
			<div className="col-start-2 flex flex-col gap-2">
				<span className="font-secondary text-fr-xs text-fr-text-2">Or ask the Machinist</span>
				<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
					{ASK_FOR.map(line => (
						<li key={line} className="flex items-baseline gap-2 text-fr-sm text-fr-text">
							<Icon name="caretR" size={12} strokeWidth={2} className="shrink-0 translate-y-px text-fr-accent" />
							<span>“{line}”</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

function Kpi({ label, value }: { readonly label: string; readonly value: number }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className={HERO_LABEL}>{label}</dt>
			<dd className="m-0 font-secondary text-fr-lg leading-none font-semibold text-fr-text tabular-nums">{value}</dd>
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
	const offered = backend.visibility.offered();
	const counts = facetCounts(agents, facts);
	const shown = filterAgents(agents, facts, facet);
	const on = agents.filter(agent => factOf(agent, facts)?.enabled === true);
	const inRail = on.filter(agent => factOf(agent, facts)?.listed === true);
	const filters: readonly MarketplaceFilter<Facet>[] = FACETS.filter(id => id !== "off" || offered).map(id => ({
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
			<header className="relative isolate flex flex-wrap items-end justify-between gap-x-6 gap-y-5 overflow-hidden rounded-lg border border-fr-accent-line px-6 pt-8 pb-7 shadow-[inset_0_1px_0_color-mix(in_oklab,var(--fr-text)_10%,transparent)]">
				<NebulaBackdrop colors={["var(--fr-accent)", "var(--fr-iris)"]} intensity="lit" />
				<DiagramAtmosphere orbs={false} net="dot" className="opacity-60 [mask-image:linear-gradient(100deg,transparent_25%,#000_85%)]" />
				<div className="relative flex min-w-0 max-w-prose flex-col items-start gap-1.5">
					<h1 className="m-0 text-fr-2xl leading-tight font-semibold tracking-[-0.01em] text-balance text-fr-text">General Agents</h1>
					<p className="m-0 text-fr-sm leading-relaxed text-pretty text-fr-text/80">
						Every agent you can run. Open one to see everything it is and can do — and change it there.
					</p>
					{/* With no agents at all the empty card below holds the one New agent. */}
					{listing !== null && agents.length === 0 ? null : (
						<Button className="mt-3.5" onClick={onCreate} data-slot="forge-new-agent">
							<Icon name="plus" strokeWidth={2} />
							New agent
						</Button>
					)}
				</div>
				{listing !== null && agents.length > 0 ? (
					<dl className="relative m-0 flex items-end gap-6">
						<Kpi label={agents.length === 1 ? "Agent" : "Agents"} value={agents.length} />
						{offered ? <Kpi label="On" value={on.length} /> : null}
						{offered ? <Kpi label="In rail" value={inRail.length} /> : null}
						<Kpi label="Yours" value={counts.yours} />
					</dl>
				) : null}
			</header>
			{notice !== null ? (
				<p role="alert" className="m-0 -mt-3 text-fr-xs text-fr-warn">
					{notice}
				</p>
			) : null}
			{listing !== null && listing.notices.length > 0 ? (
				<ul className="m-0 -mt-3 flex list-none flex-col gap-1 p-0">
					{listing.notices.map(notice => (
						<li key={notice} className="text-fr-xs text-fr-text-2">
							{notice}
						</li>
					))}
				</ul>
			) : null}
			{listing === null ? (
				error !== null ? (
					<div role="alert" className="flex flex-col gap-1 rounded-lg border border-fr-border-soft bg-fr-surface/70 px-4 py-4">
						<span className="text-fr-md font-semibold text-fr-text">Could not read your agents</span>
						<span className="text-fr-sm text-fr-text-2">{error}</span>
					</div>
				) : (
					<HomeSkeleton />
				)
			) : agents.length === 0 ? (
				<EmptyHome onCreate={onCreate} />
			) : (
				<>
					{agents.length > 1 ? <MarketplaceFilterPills filters={filters} active={facet} onChange={onFacet} ariaLabel="Filter agents" /> : null}
					<Section title={facet === "all" ? "All agents" : FACET_LABEL[facet]} count={shown.length}>
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
