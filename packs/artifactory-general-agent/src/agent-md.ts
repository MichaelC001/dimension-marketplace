// The Forge's document: one General Agent draft, and the agent.md it writes.
//
// SHARED by the View (which renders these lines live beside the orrery) and the
// server (which writes exactly these bytes in `save_agent`), so what the human
// watched being written is what lands on disk — one serializer, never two.
// It imports nothing: the View bundle must not pull the SDK's YAML parser in.
//
// Field names and value sets mirror the canonical schema in
// omp/packages/coding-agent/src/config/agent-manifest.ts. That parser REJECTS
// unknown keys inside a known section, so this serializer only ever emits keys
// the schema accepts, plus the two Dimension keys `@dimension/sdk/general-agent`
// reads beside it (`name`/`description`, and dimension#1042's `avatar`). It
// never emits `autonomy:` — a manifest with a trigger is a Loop, not an agent.

export type Personality = "default" | "friendly" | "pragmatic" | "none";
export type PromptMode = "replace" | "append";
export type Approval = "always-ask" | "write" | "yolo";
export type Thinking = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type Habitat = "bound" | "home" | "ephemeral";
export type MemoryBackend = "inherit" | "engram" | "local" | "hindsight" | "mnemopi" | "off";
export type MemoryScope = "project" | "global";

/** The vibr roster (`@fraym/vibr` AvatarId, minus `none`) — each one an avatar id. */
export const VIBRS = [
	"blob",
	"nebula",
	"quasar",
	"lattice",
	"aurora",
	"liquid",
	"cube",
	"matrix",
	"static",
	"siri",
	"koi",
	"octo",
] as const;
export type Vibr = (typeof VIBRS)[number];

export const PERSONALITIES: readonly Personality[] = ["default", "friendly", "pragmatic", "none"];
export const PROMPT_MODES: readonly PromptMode[] = ["replace", "append"];
export const THINKING_STEPS: readonly Thinking[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];
export const APPROVALS: readonly Approval[] = ["always-ask", "write", "yolo"];
export const HABITATS: readonly Habitat[] = ["bound", "home", "ephemeral"];
export const MEMORY_BACKENDS: readonly MemoryBackend[] = ["inherit", "engram", "local", "hindsight", "mnemopi", "off"];
export const MEMORY_SCOPES: readonly MemoryScope[] = ["project", "global"];

export interface AgentDraft {
	/** Stable local identity; survives renames. */
	readonly key: string;
	name: string;
	description: string;
	vibr: Vibr;
	personality: Personality;
	promptMode: PromptMode;
	/** `engine.model` — a fallback stack, first wins. */
	models: string[];
	thinking: Thinking;
	/** `capabilities.tools` allowlist. Empty = every tool (key omitted). */
	tools: string[];
	/** `capabilities.skills` allowlist. Empty = every skill (key omitted). */
	skills: string[];
	/** `capabilities.mcp` allowlist. Empty = every server (key omitted). */
	mcp: string[];
	memory: MemoryBackend;
	memoryScope: MemoryScope;
	approval: Approval;
	habitat: Habitat;
	/** `extends` — the agents whose brain this one composes from. */
	lineage: string[];
	/** The markdown body: the charter this agent runs by. */
	charter: string;
}

/** The fields the WORKSHOP (the model, through `forge_propose`) may fill. The
 *  two security fields — `tools` (`capabilities.tools`) and `approval`
 *  (`gate.approval`) — are deliberately absent: doc 58 §3, only a human gesture
 *  in the View changes them. */
export const PROPOSABLE_FIELDS = [
	"name",
	"description",
	"charter",
	"vibr",
	"skills",
	"mcp",
	"memory",
	"lineage",
	"thinking",
	"personality",
	"habitat",
] as const satisfies readonly (keyof AgentDraft)[];
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number];
/** A workshop proposal: a name plus any subset of the proposable fields. */
export type AgentProposal = { name: string } & Partial<Pick<AgentDraft, ProposableField>>;

export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * A name as it is typed: lowercase, anything that is not a letter or digit
 * becomes one dash. A trailing dash survives on purpose — the next keystroke
 * is usually the rest of `release-herald`.
 */
export function normalizeTypedName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 64);
}

export function blankDraft(key: string): AgentDraft {
	return {
		key,
		name: "",
		description: "",
		vibr: "nebula",
		personality: "default",
		promptMode: "append",
		models: [],
		thinking: "inherit",
		tools: [],
		skills: [],
		mcp: [],
		memory: "inherit",
		memoryScope: "project",
		approval: "always-ask",
		habitat: "bound",
		lineage: [],
		charter: "",
	};
}

/** Lay a workshop proposal over a draft: only the fields it names change, and
 *  `tools`/`approval` never do — whatever the object carries at runtime. */
export function applyProposal(draft: AgentDraft, proposal: AgentProposal): AgentDraft {
	const next: AgentDraft = { ...draft };
	const patch = next as unknown as Record<ProposableField, unknown>;
	for (const field of PROPOSABLE_FIELDS) {
		const value = proposal[field];
		if (value !== undefined) patch[field] = Array.isArray(value) ? [...value] : value;
	}
	return next;
}

/** Why the draft cannot be written yet; empty = it can. */
export function draftProblems(draft: AgentDraft): string[] {
	const problems: string[] = [];
	if (!NAME_RE.test(draft.name)) problems.push("Name it: 2–64 lowercase letters, digits or dashes.");
	if (draft.description.trim() === "") problems.push("Give it one line that says what it is for.");
	if (draft.charter.trim() === "") problems.push("Write its charter — the instructions it runs by.");
	return problems;
}

// ── agent.md ────────────────────────────────────────────────────────────────

const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 _./@:+-]*$/;
const YAML_WORDS = /^(true|false|yes|no|on|off|null|~)$/i;

function scalar(value: string): string {
	if (PLAIN_SCALAR.test(value) && !YAML_WORDS.test(value) && !/:\s/.test(value) && !/\s$/.test(value)) return value;
	return JSON.stringify(value);
}

function list(values: readonly string[]): string {
	return `[${values.map(scalar).join(", ")}]`;
}

/** A named manifest line, so the View can flash exactly the lines a gesture changed. */
export interface ManifestLine {
	readonly text: string;
	/** Stable id of the field this line renders (`capabilities.tools`, `body`, …). */
	readonly field: string;
}

export function manifestLines(draft: AgentDraft): ManifestLine[] {
	const lines: ManifestLine[] = [];
	const push = (field: string, text: string) => lines.push({ field, text });
	push("fence", "---");
	push("name", `name: ${scalar(draft.name || "unnamed")}`);
	push("description", `description: ${scalar(draft.description || "…")}`);
	push("avatar", `avatar: ${draft.vibr}`);
	push("specVersion", "specVersion: 1");
	if (draft.lineage.length > 0) push("extends", `extends: ${list(draft.lineage)}`);

	push("identity", "identity:");
	if (draft.personality !== "default") push("identity.personality", `  personality: ${draft.personality}`);
	push("identity.prompt", `  prompt: ${draft.promptMode}`);

	if (draft.models.length > 0 || draft.thinking !== "inherit") {
		push("engine", "engine:");
		if (draft.models.length > 0) push("engine.model", `  model: ${list(draft.models)}`);
		if (draft.thinking !== "inherit") push("engine.thinkingLevel", `  thinkingLevel: ${draft.thinking}`);
	}

	if (draft.tools.length > 0 || draft.skills.length > 0 || draft.mcp.length > 0) {
		push("capabilities", "capabilities:");
		if (draft.tools.length > 0) push("capabilities.tools", `  tools: ${list(draft.tools)}`);
		if (draft.skills.length > 0) push("capabilities.skills", `  skills: ${list(draft.skills)}`);
		if (draft.mcp.length > 0) push("capabilities.mcp", `  mcp: ${list(draft.mcp)}`);
	}

	push("gate", "gate:");
	push("gate.approval", `  approval: ${draft.approval}`);

	if (draft.memory !== "inherit") {
		push("memory", "memory:");
		push("memory.backend", `  backend: ${draft.memory}`);
		if (draft.memory !== "off" && draft.memoryScope === "global") push("memory.vault", "  vault: global");
	}

	if (draft.habitat !== "bound") {
		push("workspace", "workspace:");
		push("workspace.policy", `  policy: ${draft.habitat}`);
		// `home` REQUIRES an id (agent-manifest.ts AgentWorkspacePolicy); the
		// agent's own name is the managed workspace it is provisioned into.
		if (draft.habitat === "home") push("workspace.id", `  id: ${scalar(`agent-${draft.name || "unnamed"}`)}`);
	}
	push("fence", "---");
	const body = draft.charter.trim() === "" ? ["…"] : draft.charter.replace(/\s+$/, "").split("\n");
	for (const text of body) push("body", text);
	return lines;
}

export function toAgentMd(draft: AgentDraft): string {
	return `${manifestLines(draft)
		.map(line => line.text)
		.join("\n")}\n`;
}

/** Where the file lands in a workspace — the path every discovery walks. */
export function manifestPath(draft: Pick<AgentDraft, "name">): string {
	return `.inso/agents/${draft.name || "<name>"}/agent.md`;
}
