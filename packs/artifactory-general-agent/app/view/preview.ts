// PREVIEW — the View with no host (`bun run dev`, a top-level window, or
// `?preview`): seeded agents, parts, homes and switches kept in memory, and
// nothing written anywhere. Inside Dimension every byte comes from the pack's
// server and the host instead; this file is never read there.
//
// `?state=` picks what the page shows, for design review:
//   home (default) · empty · loading · error · profile (a user agent with a
//   home) · readonly (a pack agent) · create · proposal (a Machinist proposal
//   on a user agent) · rich (an agent whose Everything else carries keys)
// `&dock=off` is a host that lends no dock station; `&rail=off` one that does
// not lend the agents' switches.
import type { ViewAgentFact, ViewDockState } from "@dimension/sdk/artifactory";
import { type AgentDraft, blankDraft } from "../../src/agent-md";
import type { AgentHome, AgentListing, AgentSource, InstructionFile, ListedAgent, Part, PartListing } from "../../src/contracts";
import type { ForgeBackend } from "./forge-client";

const HOME = "~/.inso";
const PROJECT = "~/code/storefront";

interface Seed {
	readonly source: AgentSource;
	readonly pack?: string;
	readonly draft: Partial<AgentDraft> & Pick<AgentDraft, "name" | "description" | "charter">;
	readonly fact?: Pick<ViewAgentFact, "enabled" | "listed"> & { readonly title?: string };
	readonly instructions?: string;
}

const SEEDS: readonly Seed[] = [
	{
		source: "pack",
		pack: "dimension-agents",
		draft: {
			name: "machinist",
			description: "The workbench's own engineer — configures loops, model profiles, plugins, skills and MCP servers",
			vibr: "cube",
			habitat: "home",
			memory: "engram",
			tools: ["read", "bash", "loop", "models"],
			skills: ["autonomy", "model-intel"],
			approval: "write",
			charter: "You configure the machine: loops, model roles and profiles, plugins, marketplaces and MCP servers.\n\nYou never do the user's project work.",
		},
		fact: { enabled: true, listed: true, title: "Machinist" },
		instructions: "Prefer the smallest configuration change that works. Explain every grant you ask for.",
	},
	{
		source: "pack",
		pack: "dimension-agents",
		draft: {
			name: "coding",
			description: "The Code space's default agent — works the repository you opened",
			vibr: "lattice",
			thinking: "high",
			skills: ["code-health", "checkpoint"],
			approval: "always-ask",
			charter: "You work the repository this session was opened in. Read before you edit, prove before you claim.",
		},
		fact: { enabled: true, listed: true },
	},
	{
		source: "pack",
		pack: "dimension-agents",
		draft: {
			name: "aether",
			description: "Your personal companion across every project, with memory that spans all of them",
			vibr: "aurora",
			personality: "friendly",
			memory: "engram",
			memoryScope: "global",
			charter: "You are the person's companion across every project. Remember what matters; bring it back when it helps.",
			extra: "workspace:\n  policy: pinned\n  id: inso-personal",
		},
		fact: { enabled: true, listed: false, title: "Aether" },
	},
	{
		source: "user",
		draft: {
			name: "release-herald",
			description: "Writes the changelog and the release notes in my voice, from what actually merged",
			vibr: "orb",
			habitat: "home",
			memory: "engram",
			thinking: "medium",
			tools: ["read", "grep", "glob", "bash", "palace"],
			skills: ["checkpoint"],
			mcp: ["palace"],
			approval: "write",
			lineage: ["coding"],
			charter:
				"You write the changelog and the release notes.\n\n- Read the merged pull requests, never the branch names.\n- One line per change, in the past tense.\n- Never invent a change; when unsure, ask.",
		},
		fact: { enabled: true, listed: true },
		instructions: "Keep entries under 100 characters. Group by area: Desktop, Engine, Packs.",
	},
	{
		source: "user",
		draft: {
			name: "cmo",
			description: "Runs the marketing desk — positioning, launches and the weekly growth review",
			vibr: "",
			personality: "pragmatic",
			memory: "engram",
			approval: "always-ask",
			charter: "You run the marketing desk. Every claim you make about the product is one you have checked.",
			extra: [
				"title: Chief Marketing Officer",
				"defaultListed: false",
				"avatar:",
				"  id: mochi",
				"  skin: pearl",
				"engine:",
				"  model: [claude-sonnet-4.5, gpt-5.1]",
				"capabilities:",
				"  control: [observe, create, agents]",
				"  plugins: [browser, reach]",
				"routing:",
				"  card: Marketing, positioning and launch questions",
				"loop:",
				"  maxTurns: 40",
			].join("\n"),
		},
		fact: { enabled: true, listed: false, title: "Chief Marketing Officer" },
	},
	{
		source: "user",
		draft: {
			name: "scribe",
			description: "The workspace writer — terse, precise, dated entries",
			vibr: "static",
			personality: "pragmatic",
			tools: ["read", "write", "palace"],
			charter: "You write terse, precise, dated entries. No filler.",
		},
		fact: { enabled: false, listed: true },
	},
	{
		source: "workspace",
		draft: {
			name: "reviewer",
			description: "Reviews this storefront's pull requests for correctness, security and style",
			vibr: "quasar",
			thinking: "xhigh",
			tools: ["read", "grep", "glob", "lsp"],
			skills: ["code-health"],
			lineage: ["coding"],
			approval: "always-ask",
			charter: "You review changes for correctness, security and the storefront's standards. Every finding carries evidence.",
		},
		fact: { enabled: true, listed: true },
	},
];

const PARTS: readonly Part[] = [
	...["read", "edit", "write", "bash", "grep", "glob", "lsp", "task", "todo", "web_search", "recall", "retain", "palace", "board", "loop", "models"].map(
		(id): Part => ({ kind: "tool", id, label: id, hint: "Used by an agent on this machine" }),
	),
	{ kind: "skill", id: "code-health", label: "code-health", hint: "Evidence → simplify → review → prove" },
	{ kind: "skill", id: "checkpoint", label: "checkpoint", hint: "Session closeout and handoff" },
	{ kind: "skill", id: "autonomy", label: "autonomy", hint: "Create and operate autonomies" },
	{ kind: "skill", id: "model-intel", label: "model-intel", hint: "Live model rankings and profiles" },
	{ kind: "skill", id: "impeccable", label: "impeccable", hint: "Frontend design craft" },
	{ kind: "skill", id: "officecli", label: "officecli", hint: "Word, Excel, PowerPoint" },
	{ kind: "mcp", id: "palace", label: "palace", hint: "The Memory Palace App" },
	{ kind: "mcp", id: "browser", label: "browser", hint: "A shared browser App" },
	{ kind: "mcp", id: "general-agent", label: "general-agent", hint: "This page" },
	{ kind: "memory", id: "engram", label: "Engram", hint: "Local recall with a nightly dream" },
	{ kind: "memory", id: "local", label: "Local", hint: "Plain local memory" },
];

function pathOf(seed: Seed): string {
	const name = seed.draft.name;
	if (seed.source === "pack") return `${HOME}/plugins/${seed.pack}/general-agents/${name}/agent.md`;
	if (seed.source === "user") return `${HOME}/agent/agents/${name}/agent.md`;
	return `${PROJECT}/.inso/agents/${name}/agent.md`;
}

function listedOf(seed: Seed): ListedAgent {
	const draft: AgentDraft = { ...blankDraft(`${seed.source}:${seed.pack ?? ""}:${seed.draft.name}`), vibr: "", ...seed.draft };
	return {
		name: draft.name,
		description: draft.description,
		source: seed.source,
		...(seed.pack !== undefined ? { pack: seed.pack } : {}),
		path: pathOf(seed),
		editable: seed.source !== "pack",
		...(seed.source === "pack"
			? { readOnlyReason: `It ships in the ${seed.pack} pack, so it is read-only here. Extend it as a new agent to make it your own.` }
			: { revision: "preview" }),
		draft,
	};
}

function homeOf(seed: Seed | undefined, name: string): AgentHome {
	const source = seed?.source ?? "user";
	const homeId = `home-${name}`;
	const canStandAtHome = source !== "workspace";
	const folder = canStandAtHome ? `${HOME}/workspaces/${homeId}` : null;
	const text = seed?.instructions ?? "";
	const dir = seed === undefined ? `${HOME}/agent/agents/${name}` : pathOf(seed).replace(/\/agent\.md$/, "");
	const files: InstructionFile[] = [
		...(source === "pack" ? [{ kind: "workspace-copy" as const, path: `${PROJECT}/.inso/agents/${name}/AGENTS.md`, exists: false, bytes: 0, wins: false }] : []),
		...(canStandAtHome ? [{ kind: "home" as const, path: `${folder}/AGENTS.md`, exists: text !== "", bytes: text.length, wins: text !== "" }] : []),
		{ kind: source === "pack" ? "pack" : "agent-dir", path: `${dir}/AGENTS.md`, exists: text === "", bytes: 0, wins: text === "" },
	];
	return {
		name,
		exists: seed !== undefined,
		source,
		homeId,
		canStandAtHome,
		hasHome: canStandAtHome,
		homeNote: canStandAtHome
			? `Its home is ${homeId}; the folder exists.`
			: "A project's own agent belongs to that project and has no home of its own.",
		folder,
		folderExists: canStandAtHome && seed !== undefined,
		memoryRoom: canStandAtHome ? homeId : "storefront",
		instructions: {
			files,
			text,
			editable: source !== "pack" && seed !== undefined,
			note:
				source === "pack"
					? "A pack agent's instructions ship with its pack. A project copy, or its home AGENTS.md, takes their place."
					: "One file loads per session: the first of these that holds text.",
			target: source === "pack" || seed === undefined ? null : { path: files[0]?.path ?? "", kind: canStandAtHome ? "home" : "agent-dir", revision: "preview" },
		},
	};
}

/** Tell subscribers something moved. */
function emitter() {
	const listeners = new Set<() => void>();
	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		emit() {
			for (const listener of listeners) listener();
		},
	};
}

export function previewBackend(params: URLSearchParams): ForgeBackend {
	const state = params.get("state") ?? "home";
	let seeds = state === "empty" ? [] : [...SEEDS];
	let facts: readonly ViewAgentFact[] = seeds.map(seed => ({
		name: seed.draft.name,
		provenance: seed.source === "pack" ? "dimension" : seed.source === "user" ? "local" : "workspace",
		enabled: seed.fact?.enabled ?? true,
		listed: seed.fact?.listed ?? true,
		defaultEnabled: true,
		defaultListed: true,
		...(seed.fact?.title !== undefined ? { title: seed.fact.title } : {}),
	}));
	const rail = emitter();
	let station: ViewDockState | null = params.get("dock") === "off" ? null : { agent: "machinist", label: "Machinist", open: false, avatar: "cube" };
	const dock = emitter();
	const never = new Promise<never>(() => {});
	const listing = (): AgentListing => ({
		workspace: PROJECT,
		configDir: ".inso",
		userAgentsDir: `${HOME}/agent/agents`,
		agents: seeds.map(listedOf),
		notices: [],
	});
	return {
		mode: "preview",
		listAgents: async () => {
			if (state === "loading") return never;
			if (state === "error") throw new Error("list_agents: the engine did not answer (preview).");
			return listing();
		},
		listParts: async () => ({ parts: PARTS, sources: ["preview"], omitted: [] }) satisfies PartListing,
		save: async (draft, target) => {
			const seed: Seed = { source: "user", draft, fact: { enabled: true, listed: true } };
			seeds = target.create ? [...seeds, seed] : seeds.map(existing => (existing.draft.name === draft.name ? { ...existing, draft } : existing));
			if (target.create) {
				facts = [...facts, { name: draft.name, provenance: "local", enabled: true, listed: true, defaultEnabled: true, defaultListed: true }];
				rail.emit();
			}
			return { path: pathOf(seed), relativePath: `agent/agents/${draft.name}/agent.md`, created: target.create, tier: "user" };
		},
		validate: async () => ({ problems: [] }),
		home: async name => homeOf(seeds.find(seed => seed.draft.name === name), name),
		saveInstructions: async (name, text) => {
			seeds = seeds.map(seed => (seed.draft.name === name ? { ...seed, instructions: text } : seed));
			return { path: `${HOME}/workspaces/home-${name}/AGENTS.md`, kind: "home" };
		},
		visibility: {
			offered: () => params.get("rail") !== "off",
			read: () => facts,
			subscribe: rail.subscribe,
			configure: async change => {
				facts = facts.map(fact =>
					fact.name === change.name
						? { ...fact, ...(change.enabled !== undefined ? { enabled: change.enabled } : {}), ...(change.listed !== undefined ? { listed: change.listed } : {}) }
						: fact,
				);
				rail.emit();
			},
		},
		dock: {
			offered: () => station !== null,
			state: () => station,
			subscribe: dock.subscribe,
			open: async ({ open }) => {
				if (station === null) return;
				station = { ...station, open };
				dock.emit();
			},
		},
	};
}
