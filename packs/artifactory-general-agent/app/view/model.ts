// The Forge's document: one General Agent draft, and the agent.md it writes.
//
// Field names and value sets mirror the canonical schema in
// omp/packages/coding-agent/src/config/agent-manifest.ts. That parser REJECTS
// unknown keys inside a known section, so this serializer only ever emits keys
// the schema accepts today. The one field the Forge needs that the schema does
// not have yet — the agent's vibr — is written as a YAML comment until
// dimension#1042 lands its top-level `avatar:` (id | { id, skin?, accent? }).

export type Personality = "default" | "friendly" | "pragmatic" | "none";
export type PromptMode = "replace" | "append";
export type Approval = "always-ask" | "write" | "yolo";
export type Thinking = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type Habitat = "bound" | "home" | "ephemeral";
export type MemoryBackend = "inherit" | "engram" | "local" | "hindsight" | "mnemopi" | "off";
export type MemoryScope = "project" | "global";

/** The vibr roster (`@fraym/vibr` AvatarId, minus `none`). */
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

export const THINKING_STEPS: readonly Thinking[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];
export const APPROVALS: readonly Approval[] = ["always-ask", "write", "yolo"];
export const HABITATS: readonly Habitat[] = ["bound", "home", "ephemeral"];

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

export type PartKind = "tool" | "skill" | "mcp" | "memory" | "model" | "lineage";

export interface Part {
	readonly kind: PartKind;
	readonly id: string;
	readonly label: string;
	readonly hint: string;
}

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

/** Which draft list a part lands in; `memory`/`model` are single-slot. */
export function hasPart(draft: AgentDraft, part: Pick<Part, "kind" | "id">): boolean {
	switch (part.kind) {
		case "tool":
			return draft.tools.includes(part.id);
		case "skill":
			return draft.skills.includes(part.id);
		case "mcp":
			return draft.mcp.includes(part.id);
		case "lineage":
			return draft.lineage.includes(part.id);
		case "model":
			return draft.models.includes(part.id);
		case "memory":
			return draft.memory === part.id;
	}
}

export function attachPart(draft: AgentDraft, part: Pick<Part, "kind" | "id">): AgentDraft {
	if (hasPart(draft, part)) return draft;
	switch (part.kind) {
		case "tool":
			return { ...draft, tools: [...draft.tools, part.id] };
		case "skill":
			return { ...draft, skills: [...draft.skills, part.id] };
		case "mcp":
			return { ...draft, mcp: [...draft.mcp, part.id] };
		case "lineage":
			return part.id === draft.name ? draft : { ...draft, lineage: [...draft.lineage, part.id] };
		case "model":
			return { ...draft, models: [...draft.models, part.id] };
		case "memory":
			return { ...draft, memory: part.id as MemoryBackend };
	}
}

export function detachPart(draft: AgentDraft, part: Pick<Part, "kind" | "id">): AgentDraft {
	const without = (list: string[]) => list.filter(id => id !== part.id);
	switch (part.kind) {
		case "tool":
			return { ...draft, tools: without(draft.tools) };
		case "skill":
			return { ...draft, skills: without(draft.skills) };
		case "mcp":
			return { ...draft, mcp: without(draft.mcp) };
		case "lineage":
			return { ...draft, lineage: without(draft.lineage) };
		case "model":
			return { ...draft, models: without(draft.models) };
		case "memory":
			return draft.memory === part.id ? { ...draft, memory: "inherit" } : draft;
	}
}

/** Everything that orbits the core, in ring order — the Stage draws exactly this. */
export interface Satellite {
	readonly kind: PartKind;
	readonly id: string;
}

export function satellitesOf(draft: AgentDraft): Satellite[] {
	const out: Satellite[] = [];
	for (const id of draft.tools) out.push({ kind: "tool", id });
	for (const id of draft.skills) out.push({ kind: "skill", id });
	for (const id of draft.mcp) out.push({ kind: "mcp", id });
	if (draft.memory !== "inherit") out.push({ kind: "memory", id: draft.memory });
	for (const id of draft.lineage) out.push({ kind: "lineage", id });
	return out;
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
	push("avatar", `# avatar: ${draft.vibr}  (dimension#1042 — pending)`);
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
export function manifestPath(draft: AgentDraft): string {
	return `.inso/agents/${draft.name || "<name>"}/agent.md`;
}
