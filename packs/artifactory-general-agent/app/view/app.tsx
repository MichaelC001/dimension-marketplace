// The General Agents View: the home (every agent as a card) or one agent's
// profile, on the flat canvas with the studio atmosphere behind — the Autonomy
// page's shape. What to show arrives as a tool result (`forge_open` lands on
// the home or on one agent; `forge_propose` lays the Machinist's draft on a
// profile) and from the person's own clicks inside it. Everything it reads
// comes through `backend`, so the preview hands it seeded data.

import { DiagramAtmosphere } from "@fraym/ui/features/diagram/atmosphere";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AgentDraft, AgentProposal } from "../../src/agent-md";
import type { AgentListing, PartListing } from "../../src/contracts";
import { errorText, ViewColumn } from "./chrome";
import type { ForgeBackend, ForgeEvent } from "./forge-client";
import { ForgeHome } from "./home";
import { AgentProfile } from "./profile";
import { extendFrom, openBlank, openListed, type ProfileState, receiveProposal } from "./profile-state";
import type { Facet } from "./roster";

/** A tool result routed to this View, numbered so the same event twice is two events. */
export interface IncomingEvent {
	readonly event: ForgeEvent;
	readonly seq: number;
}

export function ForgeApp({
	backend,
	incoming,
	initial,
}: {
	readonly backend: ForgeBackend;
	readonly incoming: IncomingEvent | null;
	/** Where the preview starts: an agent's profile by name, or a new agent. */
	readonly initial?: { readonly open?: string; readonly create?: boolean };
}) {
	const [listing, setListing] = useState<AgentListing | null>(null);
	const [parts, setParts] = useState<PartListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [profile, setProfile] = useState<ProfileState | null>(initial?.create === true ? openBlank() : null);
	const [facet, setFacet] = useState<Facet>("all");
	/** The card to hand focus back to, coming back from its profile. */
	const [returnTo, setReturnTo] = useState<string | null>(null);
	/** An agent asked for (by `forge_open`) before the listing that has it arrived. */
	const [pendingOpen, setPendingOpen] = useState<string | null>(initial?.open ?? null);
	/** A proposal that arrived before the listing: it rides on the agent it names, so it waits for it. */
	const [pendingProposal, setPendingProposal] = useState<AgentProposal | null>(null);
	const facts = useSyncExternalStore(backend.visibility.subscribe, backend.visibility.read);

	const refresh = useCallback(async (): Promise<AgentListing | null> => {
		try {
			const [nextAgents, nextParts] = await Promise.all([backend.listAgents(), backend.listParts()]);
			setListing(nextAgents);
			setParts(nextParts);
			setError(null);
			return nextAgents;
		} catch (cause) {
			setError(errorText(cause));
			return null;
		}
	}, [backend]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const agents = listing?.agents ?? [];

	// What the Machinist sends: `forge_open` lands, `forge_propose` drafts.
	useEffect(() => {
		if (incoming === null) return;
		const { event } = incoming;
		if (event.kind === "proposal") {
			setPendingProposal(event.proposal);
			return;
		}
		// `forge_open` may have just told the server which workspace this is.
		void refresh();
		if (event.opened.agent !== null) setPendingOpen(event.opened.agent);
		else setProfile(null);
		// Only a NEW event acts; the listing changing must not replay it.
	}, [incoming]);

	useEffect(() => {
		if (pendingOpen === null || listing === null) return;
		const agent = listing.agents.find(candidate => candidate.name === pendingOpen);
		if (agent !== undefined) setProfile(openListed(agent));
		setPendingOpen(null);
	}, [pendingOpen, listing]);

	useEffect(() => {
		if (pendingProposal === null || listing === null) return;
		setProfile(current => receiveProposal(current, pendingProposal, listing.agents));
		setPendingProposal(null);
	}, [pendingProposal, listing]);

	const back = () => {
		setReturnTo(profile?.agent?.name ?? null);
		setProfile(null);
	};

	const saved = async (name: string) => {
		const next = await refresh();
		const agent = next?.agents.find(candidate => candidate.name === name);
		if (agent !== undefined) setProfile(openListed(agent));
	};

	const content =
		profile !== null ? (
			<ViewColumn slot="forge-profile">
				<AgentProfile
					key={profile.agent?.draft.key ?? profile.draft.key}
					backend={backend}
					state={profile}
					agents={agents}
					parts={parts?.parts ?? []}
					facts={facts}
					userAgentsDir={listing?.userAgentsDir ?? null}
					onChange={setProfile}
					onClose={() => setProfile(null)}
					onBack={back}
					onSaved={saved}
					onExtend={(base: AgentDraft) => setProfile(extendFrom(base))}
				/>
			</ViewColumn>
		) : (
			<ForgeHome
				backend={backend}
				listing={listing}
				error={error}
				facts={facts}
				facet={facet}
				onFacet={setFacet}
				focusAgent={returnTo}
				onOpen={agent => setProfile(openListed(agent))}
				onCreate={() => setProfile(openBlank())}
			/>
		);

	// The whole View sits on one quiet texture: the studio atmosphere's dot net
	// alone, no glow. Every surface above it is translucent enough to let it
	// through.
	return (
		<div
			data-slot="forge-view"
			className="relative flex h-full min-h-0 flex-col overflow-hidden bg-fr-bg"
			onKeyDown={event => {
				const target = event.target as HTMLElement;
				const typing = target.closest("input, textarea, select, [role=dialog]") !== null;
				if (event.key === "Escape" && profile !== null && !typing) back();
			}}
		>
			<DiagramAtmosphere net="dot" orbs={false} />
			<div className="relative z-10 min-h-0 flex-1">{content}</div>
		</div>
	);
}
