// The View's whole reach into the pack: one backend with two bodies. HOST mode
// is every call a standard `tools/call` proxied by the host (`App.callServerTool`)
// to the pack's App-only tools, plus `ui/message` for talk-to-build. PREVIEW mode
// (vite dev, `?preview`, or no host at all) keeps agents in this browser's
// localStorage with seeded data and says so everywhere it matters.
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type AgentDraft, type AgentProposal, manifestPath } from "../../src/agent-md";
import type { AgentListing, ForgeOpened, ForgeProposed, ListedAgent, PartListing, SaveOutcome } from "../../src/contracts";
import { PREVIEW_AGENTS, PREVIEW_PARTS } from "./catalog";

export interface ForgeBackend {
	readonly mode: "host" | "preview";
	listAgents(): Promise<AgentListing>;
	listParts(): Promise<PartListing>;
	save(draft: AgentDraft, create: boolean): Promise<SaveOutcome>;
	/** Talk-to-build: the line goes to the agent's session as the user's words. */
	speak(text: string): Promise<void>;
}

/** A tool answered `isError`, or answered a shape this View cannot read — both
 *  shown to the human verbatim, never replaced with a plausible value. */
export class ForgeToolError extends Error {
	override readonly name = "ForgeToolError";
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

/** The structuredContent of one of THIS pack's tools. Its shape is the pack's
 *  own contract (`src/contracts.ts`), written by the server beside this file. */
function structured<T>(tool: string, result: CallToolResult): T {
	if (result.isError) throw new ForgeToolError(textOf(result) || `${tool} failed without saying why`);
	if (!isRecord(result.structuredContent)) throw new ForgeToolError(`${tool} answered without structured content`);
	const contract = result.structuredContent as T;
	return contract;
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
	const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
		structured<T>(name, await app.callServerTool({ name, arguments: args }));
	return {
		mode: "host",
		listAgents: () => call<AgentListing>("list_agents"),
		listParts: () => call<PartListing>("list_parts"),
		save: (draft, create) => call<SaveOutcome>("save_agent", { draft, create }),
		speak: async text => {
			const answer = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
			if (answer.isError) throw new ForgeToolError("The host did not take the message.");
		},
	};
}

const STORE_KEY = "dimension.forge.preview.v1";

function previewDrafts(): AgentDraft[] {
	try {
		const raw = localStorage.getItem(STORE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (Array.isArray(parsed)) return parsed as AgentDraft[];
	} catch {
		// A corrupt preview store is not worth an error screen — start from the seeds.
	}
	return [...PREVIEW_AGENTS];
}

export function previewBackend(): ForgeBackend {
	let drafts = previewDrafts();
	const listed = (draft: AgentDraft): ListedAgent => ({
		name: draft.name,
		description: draft.description,
		source: "workspace",
		path: manifestPath(draft),
		editable: true,
		draft,
	});
	return {
		mode: "preview",
		listAgents: async () => ({
			workspace: null,
			configDir: ".inso",
			agents: drafts.map(listed),
			notices: ["Preview: seeded agents kept in this browser. Inside Dimension the Forge reads and writes real agent.md files."],
		}),
		listParts: async () => ({
			parts: PREVIEW_PARTS,
			sources: ["preview: catalog.ts"],
			omitted: ["Preview: an illustrative tray. Inside Dimension the skills and MCP servers come from the workspace and the installed packs."],
		}),
		save: async (draft, create) => {
			const key = draft.key;
			drafts = create ? [...drafts.filter(existing => existing.key !== key), draft] : drafts.map(existing => (existing.key === key ? draft : existing));
			localStorage.setItem(STORE_KEY, JSON.stringify(drafts));
			return { path: "", relativePath: manifestPath(draft), created: create };
		},
		speak: async () => {
			throw new ForgeToolError("Talk-to-build needs Dimension: inside it, this line goes to your agent, and the draft it proposes appears here.");
		},
	};
}
