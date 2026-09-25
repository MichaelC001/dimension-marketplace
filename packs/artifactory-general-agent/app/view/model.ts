// The Forge's gestures over a draft: which parts orbit the core, and how a
// part lands in or leaves a draft. The document itself — the draft type and
// the agent.md serializer — is `src/agent-md.ts`, shared with the server.
import type { AgentDraft, MemoryBackend } from "../../src/agent-md";
import type { Part, PartKind } from "../../src/contracts";

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
