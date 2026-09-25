import { type AgentDraft, blankDraft, type Part } from "./model";

/**
 * PREVIEW DATA. The Forge runs standalone (vite dev) before the pack's MCP
 * server exists; in that mode these are what the tray and the constellation
 * show. Every name below is a real tool, skill, MCP server or agent in this
 * workbench — the server slice replaces the lists with the live ones
 * (`list_agents`, `list_parts`), never with a second hand-kept copy.
 */
export const PREVIEW_PARTS: readonly Part[] = [
	{ kind: "tool", id: "read", label: "read", hint: "Files, directories, URLs, archives" },
	{ kind: "tool", id: "edit", label: "edit", hint: "Surgical line-anchored edits" },
	{ kind: "tool", id: "write", label: "write", hint: "Create or overwrite a file" },
	{ kind: "tool", id: "bash", label: "bash", hint: "Run a command in a shell" },
	{ kind: "tool", id: "grep", label: "grep", hint: "Regex search across files" },
	{ kind: "tool", id: "glob", label: "glob", hint: "Find paths by pattern" },
	{ kind: "tool", id: "lsp", label: "lsp", hint: "Definitions, references, renames" },
	{ kind: "tool", id: "eval", label: "eval", hint: "A persistent Python / JS kernel" },
	{ kind: "tool", id: "task", label: "task", hint: "Spawn subagents" },
	{ kind: "tool", id: "todo", label: "todo", hint: "A session checklist" },
	{ kind: "tool", id: "web_search", label: "web_search", hint: "Search the live web" },
	{ kind: "tool", id: "recall", label: "recall", hint: "Search long-term memory" },
	{ kind: "tool", id: "retain", label: "retain", hint: "Store a durable fact" },
	{ kind: "tool", id: "palace", label: "palace", hint: "Memory Palace notes" },
	{ kind: "tool", id: "board", label: "board", hint: "The project task board" },
	{ kind: "tool", id: "loop", label: "loop", hint: "Create and run Loops" },
	{ kind: "tool", id: "models", label: "models", hint: "Model intelligence and profiles" },
	{ kind: "tool", id: "generate_image", label: "generate_image", hint: "Generate or edit images" },
	{ kind: "skill", id: "impeccable", label: "impeccable", hint: "Frontend design craft" },
	{ kind: "skill", id: "code-health", label: "code-health", hint: "Evidence → simplify → review → prove" },
	{ kind: "skill", id: "autonomy", label: "autonomy", hint: "Create and operate Loops" },
	{ kind: "skill", id: "checkpoint", label: "checkpoint", hint: "Session closeout and handoff" },
	{ kind: "skill", id: "model-intel", label: "model-intel", hint: "Live model rankings and profiles" },
	{ kind: "skill", id: "taste", label: "taste", hint: "Anti-slop landing pages" },
	{ kind: "skill", id: "officecli", label: "officecli", hint: "Word, Excel, PowerPoint" },
	{ kind: "skill", id: "last30days", label: "last30days", hint: "What people said this month" },
	{ kind: "skill", id: "fallow", label: "fallow", hint: "JS/TS codebase intelligence" },
	{ kind: "mcp", id: "palace", label: "palace", hint: "The Memory Palace App" },
	{ kind: "mcp", id: "browser", label: "browser", hint: "A shared browser App" },
	{ kind: "mcp", id: "threejs", label: "threejs", hint: "3D scene App" },
	{ kind: "memory", id: "engram", label: "Engram", hint: "Local recall with a nightly dream" },
	{ kind: "memory", id: "local", label: "Local", hint: "Plain local memory" },
	{ kind: "memory", id: "hindsight", label: "Hindsight", hint: "The Hindsight service" },
	{ kind: "memory", id: "mnemopi", label: "Mnemopi", hint: "The Mnemopi runtime" },
	{ kind: "memory", id: "off", label: "No memory", hint: "Forgets between sessions" },
];

function seed(key: string, patch: Partial<AgentDraft>): AgentDraft {
	return { ...blankDraft(key), ...patch };
}

/**
 * The preview's starting constellation. The NAMES and descriptions are this
 * workbench's real agents; their loadouts here are illustrative, not read from
 * their manifests — the live list comes from the server's `list_agents`.
 */
export const PREVIEW_AGENTS: readonly AgentDraft[] = [
	seed("coding", {
		name: "coding",
		description: "The Code space's default agent — works the repo you opened",
		vibr: "lattice",
		promptMode: "replace",
		thinking: "high",
		tools: ["read", "edit", "write", "bash", "grep", "glob", "lsp", "task", "todo"],
		skills: ["code-health", "checkpoint"],
		charter: "You work the repository this session was opened in. Read before you edit, prove before you claim.",
	}),
	seed("aether", {
		name: "aether",
		description: "The personal cross-project companion, with memory that spans every project",
		vibr: "aurora",
		personality: "friendly",
		memory: "engram",
		memoryScope: "global",
		habitat: "home",
		tools: ["recall", "retain", "palace", "web_search"],
		charter: "You are the person's companion across every project. Remember what matters; bring it back when it helps.",
	}),
	seed("machinist", {
		name: "machinist",
		description: "The workbench's own engineer — configures loops, model profiles, recipes, plugins, skills, and MCP",
		vibr: "cube",
		habitat: "home",
		tools: ["loop", "models", "read", "bash"],
		skills: ["autonomy", "model-intel"],
		charter: "You configure the machine: loops, model roles and profiles, plugins, marketplaces and MCP servers. You never do the user's project work.",
	}),
	seed("designer", {
		name: "designer",
		description: "Builds and refines UI with design judgment; delegates shell work",
		vibr: "siri",
		skills: ["impeccable", "taste"],
		mcp: ["browser"],
		lineage: ["coding"],
		charter: "You design and refine interfaces. Every change is verified on the real surface.",
	}),
	seed("scribe", {
		name: "scribe",
		description: "The workspace writer — terse, precise, dated entries",
		vibr: "static",
		personality: "pragmatic",
		tools: ["read", "write", "palace"],
		memory: "engram",
		charter: "You write terse, precise, dated entries. No filler.",
	}),
	seed("reviewer", {
		name: "reviewer",
		description: "Code review specialist for quality and security analysis",
		vibr: "quasar",
		thinking: "xhigh",
		approval: "always-ask",
		tools: ["read", "grep", "glob", "lsp"],
		skills: ["code-health", "fallow"],
		lineage: ["coding"],
		charter: "You review changes for correctness, security and standards. Findings carry evidence.",
	}),
];
