// The wire between the Forge's server and its View: the structuredContent each
// tool answers with. Types only — both halves import it, neither re-derives it.
import type { AgentDraft, AgentProposal } from "./agent-md";

export type PartKind = "tool" | "skill" | "mcp" | "memory" | "model" | "lineage";

export interface Part {
	readonly kind: PartKind;
	readonly id: string;
	readonly label: string;
	readonly hint: string;
}

/** `workspace` — `<root>/.inso/agents/<name>/agent.md` (or the legacy `.omp/`);
 *  `pack` — `<pack>/general-agents/<name>/agent.md` in an installed plugin. */
export type AgentSource = "workspace" | "pack";

export interface ListedAgent {
	readonly name: string;
	readonly description: string;
	readonly source: AgentSource;
	/** The installed plugin directory it ships in — pack agents only. */
	readonly pack?: string;
	/** Absolute path of the agent.md. */
	readonly path: string;
	/** Whether `save_agent` may rewrite it. False for every pack agent, a legacy
	 *  `.omp/` file, and a workspace file carrying settings the Forge cannot
	 *  show (it would silently drop them on save). */
	readonly editable: boolean;
	readonly readOnlyReason?: string;
	/** The agent as the Forge draws it. `key` is `<source>:<pack>:<name>`. */
	readonly draft: AgentDraft;
}

export interface AgentListing {
	/** The workspace root agents are read from and written to; null = unknown. */
	readonly workspace: string | null;
	/** The project config dir agents live under (`.inso`, or the dev engine's `.inso-dev`). */
	readonly configDir: string;
	readonly agents: readonly ListedAgent[];
	/** Things the human should know: an invalid file, a shadowed name, why pack
	 *  agents are missing, why there is no workspace. */
	readonly notices: readonly string[];
}

export interface PartListing {
	readonly parts: readonly Part[];
	/** Every place a part list was read from, so the tray can say so. */
	readonly sources: readonly string[];
	/** Part kinds (or halves of them) that could not be sourced, each with why. */
	readonly omitted: readonly string[];
}

export interface SaveOutcome {
	/** Absolute path written. */
	readonly path: string;
	/** Workspace-relative, `/`-separated. */
	readonly relativePath: string;
	readonly created: boolean;
}

/** `forge_open`'s answer: where the View should land. */
export interface ForgeOpened {
	readonly view: "forge";
	readonly agent: string | null;
	readonly workspace: string | null;
}

/** `forge_propose`'s answer: a draft for the human to accept or discard. */
export interface ForgeProposed {
	readonly view: "proposal";
	readonly proposal: AgentProposal;
}
