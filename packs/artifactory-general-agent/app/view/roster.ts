// What the home page says about the roster: which facet an agent belongs to,
// where it stands, what it is called and the facts the extra text holds. Pure —
// no React, no kit — so the rules are the same wherever they are drawn and the
// tests read them without a DOM.
//
// Where an agent stands (on, in the rail) is the HOST's record, lent through
// the `agents:configure` grant; the files know only what an agent says about
// itself. Nothing here guesses a switch the host did not lend.
import type { ViewAgentFact } from "@dimension/sdk/artifactory";
import type { AgentSource, ListedAgent } from "../../src/contracts";
import { type Block, parseExtra } from "../../src/extra";

/** The home page's filters. */
export type Facet = "all" | "yours" | "packs" | "project" | "off";

export const FACETS: readonly Facet[] = ["all", "yours", "packs", "project", "off"];

export const FACET_LABEL: Readonly<Record<Facet, string>> = {
	all: "All",
	yours: "Yours",
	packs: "From packs",
	project: "This project",
	off: "Off",
};

/** Which tier each facet is; `all` and `off` are not a tier. */
const FACET_TIER: Readonly<Partial<Record<Facet, AgentSource>>> = { yours: "user", packs: "pack", project: "workspace" };

/** The host's record of this agent, when the host lends one. */
export function factOf(agent: Pick<ListedAgent, "name">, facts: readonly ViewAgentFact[]): ViewAgentFact | undefined {
	return facts.find(fact => fact.name === agent.name);
}

/** Whether `agent` belongs under `facet`. `off` is the host's word: an agent
 *  the host lends no record for is not known to be off. */
export function inFacet(agent: ListedAgent, fact: ViewAgentFact | undefined, facet: Facet): boolean {
	if (facet === "all") return true;
	if (facet === "off") return fact?.enabled === false;
	return agent.source === FACET_TIER[facet];
}

export function filterAgents(agents: readonly ListedAgent[], facts: readonly ViewAgentFact[], facet: Facet): ListedAgent[] {
	return agents.filter(agent => inFacet(agent, factOf(agent, facts), facet));
}

export function facetCounts(agents: readonly ListedAgent[], facts: readonly ViewAgentFact[]): Record<Facet, number> {
	const counts = { all: 0, yours: 0, packs: 0, project: 0, off: 0 } satisfies Record<Facet, number>;
	for (const facet of FACETS) counts[facet] = filterAgents(agents, facts, facet).length;
	return counts;
}

/** The status line's tone, in `MarkCard`'s words. */
export type StandingTone = "ready" | "idle" | "off";

export interface Standing {
	readonly label: string;
	readonly tone: StandingTone;
}

/** Where an agent stands, in one line: on and in the rail, on but hidden from
 *  the rail, or off. `null` when the host lends no record: nothing here guesses. */
export function standingOf(fact: ViewAgentFact | undefined): Standing | null {
	if (fact === undefined) return null;
	if (!fact.enabled) return { label: "Off", tone: "off" };
	return fact.listed ? { label: "On · In rail", tone: "ready" } : { label: "On · Hidden from rail", tone: "idle" };
}

/** The tier, as a person says it: the card's source line and the profile's
 *  badge, in the filter pills' words. */
export const TIER_LABEL: Readonly<Record<AgentSource, string>> = {
	pack: "From a pack",
	user: "Yours",
	workspace: "This project",
};

// ── what the extra text says ─────────────────────────────────────────────────

/** A scalar written in YAML, unquoted: `"Chief of Staff"` → `Chief of Staff`. */
function plain(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** The value lines of a block: its inline value, or the `- item` lines under it. */
function listOf(block: Block): string[] | null {
	const inline = block.inline.trim();
	if (inline.startsWith("[") && inline.endsWith("]")) {
		const inner = inline.slice(1, -1).trim();
		return inner === "" ? [] : inner.split(",").map(plain);
	}
	if (inline !== "") return [plain(inline)];
	const items = block.lines
		.slice(1)
		.map(line => line.trim())
		.filter(line => line.startsWith("- "))
		.map(line => plain(line.slice(2)));
	return items.length > 0 ? items : null;
}

function blockAt(extra: string, path: string): Block | undefined {
	const [head, child] = path.split(".");
	const top = parseExtra(extra).blocks.find(block => block.key === head);
	if (child === undefined || top === undefined) return top;
	return top.children?.find(block => block.key === child);
}

/** A key of the extra text read as a list (`[a, b]`, `- a` lines or one
 *  scalar); `null` when the text does not set it, or sets it as a shape this
 *  reader does not read (a mapping) — the Advanced editor shows it as written. */
export function extraList(extra: string, path: string): string[] | null {
	const block = blockAt(extra, path);
	if (block === undefined || block.children !== null) return null;
	return listOf(block);
}

/** A key of the extra text read as one scalar; `null` when it is not set as one. */
export function extraScalar(extra: string, path: string): string | null {
	const block = blockAt(extra, path);
	if (block === undefined || block.children !== null || block.inline.trim() === "") return null;
	return plain(block.inline);
}

/** The face a file declares when it cannot be a plain id — a skin or an accent
 *  rides with it: `avatar: { id, skin, accent }`, flow or block. */
export function heldAvatar(extra: string): { readonly id: string; readonly skin?: string; readonly accent?: string } | null {
	const block = blockAt(extra, "avatar");
	if (block === undefined) return null;
	const read = (key: string): string | undefined => {
		if (block.children !== null) {
			const child = block.children.find(entry => entry.key === key);
			return child === undefined || child.inline.trim() === "" ? undefined : plain(child.inline);
		}
		const flow = new RegExp(`\\b${key}:\\s*([^,}\\s]+)`).exec(block.inline);
		return flow?.[1] === undefined ? undefined : plain(flow[1]);
	};
	const id = read("id") ?? (block.children === null && !block.inline.includes("{") && block.inline.trim() !== "" ? plain(block.inline) : undefined);
	if (id === undefined) return null;
	const skin = read("skin");
	const accent = read("accent");
	return { id, ...(skin !== undefined ? { skin } : {}), ...(accent !== undefined ? { accent } : {}) };
}

/** A slug as a person reads it: `release-herald` → `Release herald`. */
export function humanize(slug: string): string {
	const words = slug.replace(/-+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the agent is called on screen: the host's `title`, the file's own
 *  `title:`, else its name read as words. The name itself stays the id, shown
 *  beside it where the two differ. */
export function displayName(agent: Pick<ListedAgent, "name" | "draft">, fact: ViewAgentFact | undefined): string {
	return fact?.title ?? extraScalar(agent.draft.extra, "title") ?? humanize(agent.name);
}

/** An agent named by its id (a lineage entry), as a person reads it: its
 *  display name when it is listed, else its id read as words. */
export function titleOf(name: string, agents: readonly ListedAgent[], facts: readonly ViewAgentFact[]): string {
	const agent = agents.find(candidate => candidate.name === name);
	return agent === undefined ? humanize(name) : displayName(agent, factOf(agent, facts));
}
