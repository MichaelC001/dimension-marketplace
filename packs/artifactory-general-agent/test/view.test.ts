// The General Agents page's rules, read without a DOM: which cards a facet
// shows, what stops a draft from saving, and what a Machinist proposal may and
// may not change when it is accepted or discarded.
import { describe, expect, test } from "bun:test";
import type { ViewAgentFact } from "@dimension/sdk/artifactory";
import { type AgentDraft, type AgentProposal, blankDraft } from "../src/agent-md";
import type { AgentSource, ListedAgent } from "../src/contracts";
import {
	acceptProposal,
	discardProposal,
	fieldErrors,
	openBlank,
	openListed,
	type ProfileState,
	receiveProposal,
	saveBlockers,
} from "../app/view/profile-state";
import { filterAgents } from "../app/view/roster";

function listed(name: string, source: AgentSource, patch: Partial<AgentDraft> = {}): ListedAgent {
	const draft: AgentDraft = { ...blankDraft(`${source}::${name}`), name, description: `${name} agent`, charter: `You are ${name}.`, ...patch };
	return {
		name,
		description: draft.description,
		source,
		path: `/agents/${name}/agent.md`,
		editable: source !== "pack",
		...(source === "pack" ? { pack: "dimension-agents", readOnlyReason: "It ships in a pack." } : { revision: "r1" }),
		draft,
	};
}

function fact(name: string, enabled: boolean, listed = true): ViewAgentFact {
	return { name, provenance: "local", enabled, listed, defaultEnabled: true, defaultListed: true };
}

const ROSTER = [listed("machinist", "pack"), listed("coding", "pack"), listed("herald", "user"), listed("scribe", "user"), listed("reviewer", "workspace")];

describe("facets", () => {
	const names = (agents: readonly ListedAgent[]) => agents.map(agent => agent.name);

	test("each tier facet shows exactly that tier's agents", () => {
		expect(names(filterAgents(ROSTER, [], "yours"))).toEqual(["herald", "scribe"]);
		expect(names(filterAgents(ROSTER, [], "packs"))).toEqual(["machinist", "coding"]);
		expect(names(filterAgents(ROSTER, [], "project"))).toEqual(["reviewer"]);
		expect(names(filterAgents(ROSTER, [], "all"))).toHaveLength(ROSTER.length);
	});

	test("Off is the host's word: only agents the host reports disabled, never ones it says nothing about", () => {
		const facts = [fact("scribe", false), fact("coding", true, false), fact("herald", true)];
		expect(names(filterAgents(ROSTER, facts, "off"))).toEqual(["scribe"]);
		expect(filterAgents(ROSTER, [], "off")).toEqual([]);
	});
});

describe("draft validation", () => {
	test("a new agent needs a valid, free name, a description and a charter", () => {
		const blank = openBlank();
		expect(Object.keys(fieldErrors(blank, ROSTER)).sort()).toEqual(["charter", "description", "name"]);

		const bad = { ...blank, draft: { ...blank.draft, name: "-lead", description: "d", charter: "c" } };
		expect(fieldErrors(bad, ROSTER).name).toBeDefined();

		const taken = { ...blank, draft: { ...blank.draft, name: "herald", description: "d", charter: "c" } };
		expect(fieldErrors(taken, ROSTER).name).toContain("already exists");

		const good = { ...blank, draft: { ...blank.draft, name: "release-herald", description: "Writes notes", charter: "You write." } };
		expect(fieldErrors(good, ROSTER)).toEqual({});
		expect(saveBlockers(good, ROSTER, [], true)).toEqual([]);
	});

	test("an existing agent keeps its name; a blank description or charter still blocks the save", () => {
		const opened = openListed(listed("herald", "user"));
		expect(saveBlockers(opened, ROSTER, [], true)).toEqual([]);
		const emptied: ProfileState = { ...opened, draft: { ...opened.draft, charter: "  " } };
		expect(fieldErrors(emptied, ROSTER)).toEqual({ charter: expect.any(String) });
		expect(saveBlockers(emptied, ROSTER, [], true)).toHaveLength(1);
	});

	test("a read-only agent, a host that cannot create, an undecided proposal and the server's verdict each block", () => {
		expect(saveBlockers(openListed(listed("coding", "pack")), ROSTER, [], true)).toEqual(["It ships in a pack."]);
		const good = { ...openBlank(), draft: { ...openBlank().draft, name: "new-one", description: "d", charter: "c" } };
		expect(saveBlockers(good, ROSTER, [], false)).toHaveLength(1);
		expect(saveBlockers(good, ROSTER, ["does not load"], true)).toEqual(["does not load"]);
		const proposed = receiveProposal(openListed(listed("herald", "user")), { name: "herald", description: "New line" }, ROSTER);
		expect(saveBlockers(proposed, ROSTER, [], true)).toHaveLength(1);
	});
});

describe("a Machinist proposal", () => {
	const guarded = (draft: AgentDraft) => ({ tools: draft.tools, mcp: draft.mcp, approval: draft.approval, memoryScope: draft.memoryScope, extra: draft.extra });
	const base = listed("herald", "user", {
		tools: ["read"],
		mcp: ["palace"],
		approval: "always-ask",
		memoryScope: "project",
		extra: "capabilities:\n  control: [observe]",
	});
	// Everything a hostile model might smuggle past its schema, typed away.
	const hostile = {
		name: "herald",
		description: "Proposed line",
		charter: "Proposed charter",
		tools: ["bash", "write"],
		mcp: ["browser"],
		approval: "yolo",
		memoryScope: "global",
		extra: "capabilities:\n  control: [observe, agents]",
	} as unknown as AgentProposal;

	test("lands on the agent it names, changes what it may, and marks those fields", () => {
		const received = receiveProposal(null, hostile, ROSTER.map(agent => (agent.name === "herald" ? base : agent)));
		expect(received.agent?.name).toBe("herald");
		expect(received.draft.description).toBe("Proposed line");
		expect(received.draft.charter).toBe("Proposed charter");
		// The grant-bearing `extra` changed nothing, so it is not claimed as proposed.
		expect(received.proposal?.fields).toEqual(["description", "charter"]);
	});

	test("accepting keeps the proposal's words and never a grant it carried", () => {
		const received = receiveProposal(openListed(base), hostile, [base]);
		const accepted = acceptProposal(received);
		expect(accepted.proposal).toBeUndefined();
		expect(accepted.draft.description).toBe("Proposed line");
		expect(guarded(accepted.draft)).toEqual(guarded(base.draft));
	});

	test("discarding restores the draft from before it, grants included", () => {
		const edited: ProfileState = { ...openListed(base), draft: { ...base.draft, tools: ["read", "grep"] } };
		const discarded = discardProposal(receiveProposal(edited, hostile, [base]));
		expect(discarded?.proposal).toBeUndefined();
		expect(discarded?.draft).toEqual(edited.draft);
	});

	test("a second proposal before a decision still discards to the draft before the first", () => {
		const first = receiveProposal(openListed(base), { name: "herald", description: "One" }, [base]);
		const second = receiveProposal(first, { name: "herald", charter: "Two" }, [base]);
		expect(second.proposal?.fields).toEqual(["description", "charter"]);
		expect(discardProposal(second)?.draft).toEqual(base.draft);
	});

	test("one that starts a new agent discards to no profile at all", () => {
		const fresh = receiveProposal(null, { name: "brand-new", description: "x" }, [base]);
		expect(fresh.agent).toBeUndefined();
		expect(discardProposal(fresh)).toBeNull();
	});
});
