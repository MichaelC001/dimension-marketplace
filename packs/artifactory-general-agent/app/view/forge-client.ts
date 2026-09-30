// The View's whole reach: one backend with two bodies. HOST mode is every call
// a standard `tools/call` to the pack's App-only tools (through the App kit's
// caller, which waits out a consent prompt), and what only the host can do —
// the agents' switches (`agents:configure`) and the Machinist's dock beside the
// page (`dock:open`), where talk-to-build happens. PREVIEW mode (`preview.ts`)
// answers from seeded data when there is no host at all.
import { canConfigureAgents, configureAgent, readAgents, subscribeAgents } from "@dimension/mcp-app-kit/agents";
import { dockOffered, dockState, openDock, subscribeDock } from "@dimension/mcp-app-kit/dock";
import { createToolCaller } from "@dimension/mcp-app-kit/tools";
import type { ViewAgentFact, ViewDockState } from "@dimension/sdk/artifactory";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentDraft, AgentProposal } from "../../src/agent-md";
import type {
	AgentHome,
	AgentListing,
	DraftCheck,
	ForgeOpened,
	ForgeProposed,
	InstructionsSaved,
	PartListing,
	SaveOutcome,
	SaveTarget,
} from "../../src/contracts";

/** The host's record of who is enabled and who is shown in the rail — and the
 *  two switches, flipped exactly as the Capabilities page flips them. */
export interface AgentVisibility {
	/** Whether this host lends the agents and answers the switch to THIS View. */
	offered(): boolean;
	read(): readonly ViewAgentFact[];
	subscribe(listener: () => void): () => void;
	/** Resolves once the host wrote; the new state arrives through `read`/`subscribe`. */
	configure(change: { readonly name: string; readonly enabled?: boolean; readonly listed?: boolean }): Promise<void>;
}

/** The dock beside the page, as the host lends it (the agent is the host's word). */
export interface ForgeDock {
	offered(): boolean;
	state(): ViewDockState | null;
	subscribe(listener: () => void): () => void;
	open(target: { readonly agent: string; readonly open: boolean }): Promise<void>;
}

export interface ForgeBackend {
	readonly mode: "host" | "preview";
	listAgents(): Promise<AgentListing>;
	listParts(): Promise<PartListing>;
	save(draft: AgentDraft, target: SaveTarget): Promise<SaveOutcome>;
	/** Whether the draft would save — the server's own check, nothing written. */
	validate(draft: AgentDraft): Promise<DraftCheck>;
	/** An agent's home, its standing instructions and its memory room. */
	home(name: string): Promise<AgentHome>;
	/** `revision` is the one `home` gave; the server refuses a write whose file or place changed since. */
	saveInstructions(name: string, text: string, revision: string): Promise<InstructionsSaved>;
	readonly visibility: AgentVisibility;
	readonly dock: ForgeDock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(result: CallToolResult): string {
	return (result.content ?? [])
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
}

/** The structuredContent of one of THIS pack's tools — its shape is the pack's
 *  own contract (`src/contracts.ts`). A refusal throws the server's own words. */
function structured<T>(tool: string, result: CallToolResult): T {
	if (result.isError) throw new Error(textOf(result) || `${tool} failed without saying why`);
	if (!isRecord(result.structuredContent)) throw new Error(`${tool} answered without structured content`);
	return result.structuredContent as T;
}

export type ForgeEvent = { readonly kind: "open"; readonly opened: ForgeOpened } | { readonly kind: "proposal"; readonly proposal: AgentProposal };

/** A tool result the host routed to this View — the mounting `forge_open` or a
 *  later `forge_propose`. Anything else is not this View's to act on. */
export function eventFromToolResult(result: CallToolResult): ForgeEvent | null {
	const content = result.structuredContent;
	if (result.isError || !isRecord(content)) return null;
	if (content.view === "forge") return { kind: "open", opened: structured<ForgeOpened>("forge_open", result) };
	if (content.view === "proposal" && isRecord(content.proposal) && typeof content.proposal.name === "string") {
		return { kind: "proposal", proposal: structured<ForgeProposed>("forge_propose", result).proposal };
	}
	return null;
}

export function hostBackend(app: App): ForgeBackend {
	const tools = createToolCaller(app);
	const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => structured<T>(name, await tools.raw(name, args));
	return {
		mode: "host",
		listAgents: () => call<AgentListing>("list_agents"),
		listParts: () => call<PartListing>("list_parts"),
		save: (draft, target) => call<SaveOutcome>("save_agent", { draft, ...target }),
		validate: draft => call<DraftCheck>("validate_agent", { draft }),
		home: name => call<AgentHome>("agent_home", { name }),
		saveInstructions: (name, text, revision) => call<InstructionsSaved>("save_instructions", { name, text, revision }),
		visibility: {
			offered: () => canConfigureAgents(app),
			read: () => readAgents(app),
			subscribe: listener => subscribeAgents(app, listener),
			configure: change => configureAgent(app, change),
		},
		dock: {
			offered: () => dockOffered(app),
			state: () => dockState(app),
			subscribe: listener => subscribeDock(app, listener),
			open: async target => {
				await openDock(app, target);
			},
		},
	};
}
