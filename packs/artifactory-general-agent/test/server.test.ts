import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentHomeWorkspaceId, parseGeneralAgent } from "@dimension/sdk/general-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parse as parseYaml } from "yaml";
import { type AgentDraft, type AgentProposal, applyProposal, blankDraft, manifestLines } from "../src/agent-md";
import type { AgentHome, AgentListing, DraftCheck, ForgeProposed, InstructionsSaved, ListedAgent, SaveOutcome } from "../src/contracts";
import { grantPathsIn } from "../src/extra";
import { createForgeServer } from "../src/server";
import { WRITE_DIR } from "../src/store";

let root: string;
let workspace: string;
let home: string;
let viewDir: string;
let client: Client;
const open: Client[] = [];

const PACK_AGENT = `---
name: helper
description: A pack-shipped helper
specVersion: 1
gate:
  approval: write
---
You help.
`;

async function put(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

/** A client on a fresh Forge server. `bound` = the agent named its workspace in `forge_open`. */
async function connect(bound: boolean): Promise<Client> {
	const server = await createForgeServer({ viewDir, env: { INSO_HOME: home } });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const connected = new Client({ name: "forge-test", version: "0" });
	await connected.connect(clientSide);
	open.push(connected);
	if (bound) {
		const opened = (await connected.callTool({ name: "forge_open", arguments: { workspace } })) as CallToolResult;
		expect(opened.isError).toBeFalsy();
	}
	return connected;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "forge-"));
	workspace = join(root, "workspace");
	home = join(root, "home");
	viewDir = join(root, "view");
	await mkdir(workspace, { recursive: true });
	await put(join(viewDir, "index.html"), "<!doctype html><div id=root></div>");
	await put(join(home, "plugins", "node_modules", "helper-pack", "general-agents", "helper", "agent.md"), PACK_AGENT);
	client = await connect(true);
});

afterEach(async () => {
	for (const connected of open.splice(0)) await connected.close();
	await rm(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>, on: Client = client): Promise<CallToolResult> {
	return (await on.callTool({ name, arguments: args })) as CallToolResult;
}

function draft(patch: Partial<AgentDraft> = {}): AgentDraft {
	return {
		...blankDraft("k1"),
		name: "release-herald",
		description: "Writes changelogs in my voice",
		charter: "You write the changelog.\n\nNever invent a change.",
		tools: ["read", "grep"],
		skills: ["code-health"],
		approval: "write",
		vibr: "quasar",
		...patch,
	};
}

/** The user tier: where a new agent is written and where it has a home. */
const userFile = (name: string) => join(home, "agent", "agents", name, "agent.md");
/** The project tier: `<workspace>/<config dir>/agents`. */
const projectFile = (name: string) => join(workspace, WRITE_DIR, "agents", name, "agent.md");
const homeDirOf = (name: string) => join(home, "workspaces", agentHomeWorkspaceId(name));

async function listing(on: Client = client): Promise<AgentListing> {
	return (await call("list_agents", {}, on)).structuredContent as unknown as AgentListing;
}

async function listed(name: string, on: Client = client): Promise<ListedAgent> {
	const found = (await listing(on)).agents.find(agent => agent.name === name);
	if (!found) throw new Error(`${name} was not listed`);
	return found;
}

/** Reforge a listed agent the way the View does: its tier and the revision it was listed at. */
async function reforge(agent: ListedAgent, patch: Partial<AgentDraft> = {}): Promise<CallToolResult> {
	if (agent.source === "pack") throw new Error("a pack agent is never rewritten");
	return call("save_agent", { draft: { ...agent.draft, ...patch }, create: false, tier: agent.source, revision: agent.revision });
}

async function manifestAt(path: string, name: string) {
	const parsed = parseGeneralAgent(await readFile(path, "utf8"), path, name);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.decl;
}

describe("save_agent — the user tier", () => {
	test("a new agent is written beside the ones agent_create writes, carrying the human's tools and gate", async () => {
		const result = await call("save_agent", { draft: draft(), create: true });
		expect(result.isError).toBeFalsy();
		const outcome = result.structuredContent as unknown as SaveOutcome;
		expect(outcome).toMatchObject({ path: userFile("release-herald"), relativePath: "agent/agents/release-herald/agent.md", created: true, tier: "user" });

		const decl = await manifestAt(outcome.path, "release-herald");
		expect(decl.description).toBe("Writes changelogs in my voice");
		expect(decl.avatar).toEqual({ id: "quasar" });
		expect(decl.manifest.capabilities?.tools).toEqual(["read", "grep"]);
		expect(decl.manifest.gate?.approval).toBe("write");
		expect(decl.body).toBe("You write the changelog.\n\nNever invent a change.");

		// Not the project: the workspace was bound and stays untouched.
		expect(await readdir(workspace)).toEqual([]);
		// What it wrote, it lists as a user agent and can edit again.
		expect(await listed("release-herald")).toMatchObject({ source: "user", editable: true });
	});

	test("a new agent speaks only as itself unless the human chooses otherwise (#1355)", async () => {
		// The manifest default: the charter IS the persona. `append` would put it after the whole coding prompt.
		expect(blankDraft("k").promptMode).toBe("replace");
		await call("save_agent", { draft: draft({ promptMode: blankDraft("k2").promptMode }), create: true });
		expect((await manifestAt(userFile("release-herald"), "release-herald")).manifest.identity?.prompt).toBe("replace");
		expect(await readFile(userFile("release-herald"), "utf8")).toContain("  prompt: replace\n");

		await call("save_agent", { draft: draft({ name: "builder", promptMode: "append" }), create: true });
		expect((await manifestAt(userFile("builder"), "builder")).manifest.identity?.prompt).toBe("append");
	});

	test("Lives = home writes the id the engine registers — never agent-<name> — and an older file reads as the same switch", async () => {
		await call("save_agent", { draft: draft({ name: "homebody", habitat: "home" }), create: true });
		const decl = await manifestAt(userFile("homebody"), "homebody");
		expect(decl.manifest.workspace).toEqual({ policy: "home", id: agentHomeWorkspaceId("homebody") });
		expect(decl.manifest.workspace?.id).not.toBe("agent-homebody");

		// An older Forge wrote `agent-<name>`: still read as "Own home", and reforging repairs it.
		const legacy = "---\nname: elder-home\ndescription: written by an older Forge\nspecVersion: 1\ngate:\n  approval: write\nworkspace:\n  policy: home\n  id: agent-elder-home\n---\nAt home.\n";
		await put(userFile("elder-home"), legacy);
		const opened = await listed("elder-home");
		expect(opened).toMatchObject({ editable: true, draft: { habitat: "home" } });
		expect(opened.draft.extra).toBe("");
		expect((await reforge(opened)).isError).toBeFalsy();
		expect((await manifestAt(userFile("elder-home"), "elder-home")).manifest.workspace).toEqual({ policy: "home", id: agentHomeWorkspaceId("elder-home") });
	});

	test("refuses a name already taken on create — in any tier — and writes nothing", async () => {
		const handWritten = "---\nname: release-herald\ndescription: mine\nspecVersion: 1\ngate:\n  approval: always-ask\n---\nHand written.\n";
		await put(userFile("release-herald"), handWritten);
		const collision = await call("save_agent", { draft: draft(), create: true });
		expect(collision.isError).toBe(true);
		expect(await readFile(userFile("release-herald"), "utf8")).toBe(handWritten);

		await put(projectFile("scoped"), handWritten.replace("release-herald", "scoped"));
		expect((await call("save_agent", { draft: draft({ name: "scoped" }), create: true })).isError).toBe(true);

		expect((await call("save_agent", { draft: draft({ name: "helper" }), create: true })).isError).toBe(true);
		expect(await readdir(join(home, "agent", "agents"))).toEqual(["release-herald"]);
	});

	test("refuses a bad name and writes nothing", async () => {
		for (const name of ["Release Herald", "x", "../escape", "-lead", ""]) {
			const result = await call("save_agent", { draft: draft({ name }), create: true });
			expect(result.isError).toBe(true);
		}
		expect(await readdir(workspace)).toEqual([]);
		await expect(readdir(join(home, "agent"))).rejects.toThrow();
	});

	test("never writes an autonomy trigger, however the draft is dressed — even through Everything else", async () => {
		const smuggled = {
			...draft({
				description: "x\nautonomy:\n  trigger:\n    schedule: '* * * * *'",
				charter: "---\nautonomy:\n  trigger:\n    schedule: '* * * * *'\n---\nRun forever.",
			}),
			autonomy: { trigger: { schedule: "* * * * *" } },
		};
		const result = await call("save_agent", { draft: smuggled, create: true });
		expect(result.isError).toBeFalsy();
		const text = await readFile(userFile("release-herald"), "utf8");
		expect(parseGeneralAgent(text, userFile("release-herald"), "release-herald").ok).toBe(true);
		const frontmatter = parseYaml(text.split(/^---$/m)[1] ?? "") as Record<string, unknown>;
		expect(frontmatter.autonomy).toBeUndefined();

		const viaExtra = await call("save_agent", { draft: draft({ name: "looper", extra: "autonomy:\n  trigger:\n    schedule: '* * * * *'" }), create: true });
		expect(viaExtra.isError).toBe(true);
		expect(JSON.stringify(viaExtra.content)).toContain("loop");
		await expect(stat(userFile("looper"))).rejects.toThrow();
	});

	test("does not rewrite a Loop that sits where the agent would", async () => {
		const loop = "---\nname: nightly\ndescription: a loop\nspecVersion: 1\nautonomy:\n  trigger:\n    schedule: '0 3 * * *'\n---\nRun.\n";
		await put(projectFile("nightly"), loop);
		const result = await call("save_agent", { draft: draft({ name: "nightly" }), create: false, tier: "workspace", revision: "0000" });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("is a Loop");
		expect(await readFile(projectFile("nightly"), "utf8")).toBe(loop);
	});

	test("a rewrite is refused when the file changed since it was listed, and the hand edit survives", async () => {
		await call("save_agent", { draft: draft(), create: true });
		const opened = await listed("release-herald");
		const edited = `${await readFile(userFile("release-herald"), "utf8")}\n`.replace("---\n", "---\ntitle: Added by hand\n");
		await writeFile(userFile("release-herald"), edited);
		const result = await reforge(opened, { description: "Something else" });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("changed on disk");
		expect(await readFile(userFile("release-herald"), "utf8")).toBe(edited);
	});
});

describe("tiers and the door with no workspace", () => {
	test("lists pack and user agents, and creates into the user tier, with no workspace ever named", async () => {
		await put(userFile("mine"), "---\nname: mine\ndescription: my own\nspecVersion: 1\ngate:\n  approval: write\n---\nMine.\n");
		const bare = await connect(false);
		const opened = await call("forge_open", {}, bare);
		expect(opened.isError).toBeFalsy();
		expect(opened.structuredContent).toMatchObject({ view: "forge", agent: null, workspace: null });

		const seen = await listing(bare);
		expect(seen.workspace).toBeNull();
		expect(seen.userAgentsDir).toBe(join(home, "agent", "agents"));
		expect(seen.agents.map(agent => [agent.name, agent.source]).sort()).toEqual([
			["helper", "pack"],
			["mine", "user"],
		]);

		const made = await call("save_agent", { draft: draft(), create: true }, bare);
		expect(made.isError).toBeFalsy();
		expect((made.structuredContent as unknown as SaveOutcome).tier).toBe("user");
		expect((await listing(bare)).agents.some(agent => agent.name === "release-herald")).toBe(true);
	});

	test("project agents are listed and editable once a workspace is bound, and say which tier they are in", async () => {
		await put(projectFile("project-bot"), "---\nname: project-bot\ndescription: one project's agent\nspecVersion: 1\ngate:\n  approval: write\n---\nThis project only.\n");
		await call("save_agent", { draft: draft(), create: true });
		const tiers = Object.fromEntries((await listing()).agents.map(agent => [agent.name, agent.source]));
		expect(tiers).toEqual({ helper: "pack", "project-bot": "workspace", "release-herald": "user" });

		const project = await listed("project-bot");
		expect(project.editable).toBe(true);
		expect((await reforge(project, { description: "renamed purpose" })).isError).toBeFalsy();
		expect((await manifestAt(projectFile("project-bot"), "project-bot")).description).toBe("renamed purpose");

		// Pack agents stay read-only.
		expect(await listed("helper")).toMatchObject({ source: "pack", editable: false });
	});

	test("a pack owns its names: a project file taking one is shadowed, not listed in its place", async () => {
		await put(projectFile("helper"), "---\nname: helper\ndescription: an impostor\nspecVersion: 1\ngate:\n  approval: yolo\n---\nImpostor.\n");
		const seen = await listing();
		expect(seen.agents.find(agent => agent.name === "helper")).toMatchObject({ source: "pack" });
		expect(seen.notices.join("\n")).toContain("shadowed");
	});
});

describe("Everything else", () => {
	const RICH = `---
title: Chief Marketing Officer
name: cmo
description: Runs the marketing desk
defaultListed: false
specVersion: 1
avatar:
  id: mochi
  skin: pearl
extends: [coding]
identity:
  prompt: replace
engine:
  thinkingLevel: auto
  profile: fast-and-cheap
capabilities:
  tools: []
  skills: [campaign-planner]
  # the lane that lets it make other agents
  control: [observe, agents]
  autoloadSkills: [campaign-planner]
gate:
  approval: write
memory:
  backend: engram
  namespace: cmo-room
workspace:
  policy: bound
  reach: [inso, docs]
subagents:
  maxDepth: 2
routing:
  card: Marketing questions
loop:
  maxTurns: 5
---
You run the desk.
`;
	const base = "---\nname: coding\ndescription: the base\nspecVersion: 1\ngate:\n  approval: write\n---\nCode.\n";

	async function seedRich(): Promise<void> {
		await put(userFile("coding"), base);
		await put(userFile("cmo"), RICH);
	}

	test("every key the orrery does not draw opens as text, keeps the agent editable, and survives a rewrite byte for byte", async () => {
		await seedRich();
		const opened = await listed("cmo");
		expect(opened.editable).toBe(true);
		expect(opened.readOnlyReason).toBeUndefined();
		// What the orrery cannot draw is held as written — comments included.
		for (const line of [
			"title: Chief Marketing Officer",
			"defaultListed: false",
			"avatar:\n  id: mochi\n  skin: pearl",
			"  thinkingLevel: auto",
			"  profile: fast-and-cheap",
			"  tools: []",
			"  # the lane that lets it make other agents\n  control: [observe, agents]",
			"  autoloadSkills: [campaign-planner]",
			"  namespace: cmo-room",
			"  reach: [inso, docs]",
			"subagents:\n  maxDepth: 2",
			"routing:\n  card: Marketing questions",
			"loop:\n  maxTurns: 5",
		]) {
			expect(opened.draft.extra).toContain(line);
		}
		// …and what it CAN draw is not repeated there.
		for (const drawn of ["name:", "description:", "gate:", "approval:", "backend:", "skills: [campaign-planner]\n"]) expect(opened.draft.extra).not.toContain(drawn);

		expect((await reforge(opened)).isError).toBeFalsy();
		const first = await readFile(userFile("cmo"), "utf8");
		for (const line of opened.draft.extra.split("\n")) expect(first).toContain(line);

		// Same manifest as the original file, bar the two additive facts (none here: the prompt and avatar were explicit).
		const before = parseGeneralAgent(RICH, userFile("cmo"), "cmo");
		const after = parseGeneralAgent(first, userFile("cmo"), "cmo");
		if (!before.ok || !after.ok) throw new Error("did not parse");
		expect(after.decl.manifest).toEqual(before.decl.manifest);
		expect(after.decl).toMatchObject({ title: "Chief Marketing Officer", defaultListed: false, avatar: { id: "mochi", skin: "pearl" }, body: "You run the desk." });

		// A second pass over what it just wrote changes nothing: byte-stable.
		expect((await reforge(await listed("cmo"))).isError).toBeFalsy();
		expect(await readFile(userFile("cmo"), "utf8")).toBe(first);
	});

	test("an empty allowlist still means none after a rewrite — it is held, not flipped to 'every tool'", async () => {
		await seedRich();
		await reforge(await listed("cmo"));
		expect((await manifestAt(userFile("cmo"), "cmo")).manifest.capabilities?.tools).toEqual([]);
	});

	test("editing the text edits the file; the orrery's own keys and the text merge into one section", async () => {
		await seedRich();
		const opened = await listed("cmo");
		const extra = opened.draft.extra.replace("title: Chief Marketing Officer", "title: Head of Growth").replace("loop:\n  maxTurns: 5", "loop:\n  maxTurns: 9");
		expect((await reforge(opened, { extra, skills: ["campaign-planner", "taste"] })).isError).toBeFalsy();
		const decl = await manifestAt(userFile("cmo"), "cmo");
		expect(decl.title).toBe("Head of Growth");
		expect(decl.manifest.loop?.maxTurns).toBe(9);
		// One `capabilities:` — the orrery's skills and the author's control lane live in it together.
		const text = await readFile(userFile("cmo"), "utf8");
		expect(text.match(/^capabilities:/gm)).toHaveLength(1);
		expect(decl.manifest.capabilities?.skills).toEqual(["campaign-planner", "taste"]);
		expect(decl.manifest.capabilities?.control).toEqual({ lanes: ["observe", "agents"] });
	});

	test("a key written in Everything else that the orrery also draws wins, and is not written twice", async () => {
		const made = await call("save_agent", { draft: draft({ approval: "always-ask", extra: "gate:\n  approval: yolo\ntitle: Quick" }), create: true });
		expect(made.isError).toBeFalsy();
		const text = await readFile(userFile("release-herald"), "utf8");
		expect(text.match(/approval:/g)).toHaveLength(1);
		expect((await manifestAt(userFile("release-herald"), "release-herald")).manifest.gate?.approval).toBe("yolo");
	});

	test("an absent approval stays absent — inheriting is a state, not a side effect of saving", async () => {
		await put(userFile("quiet"), "---\nname: quiet\ndescription: inherits the gate\nspecVersion: 1\n---\nQuiet.\n");
		const opened = await listed("quiet");
		expect(opened.draft.approval).toBe("inherit");
		expect((await reforge(opened)).isError).toBeFalsy();
		expect((await manifestAt(userFile("quiet"), "quiet")).manifest.gate).toBeUndefined();
	});

	test("a thinking level is read from the file — the SDK's manifest never carries it — and survives a rewrite", async () => {
		await put(userFile("deep"), "---\nname: deep\ndescription: thinks hard\nspecVersion: 1\nengine:\n  thinkingLevel: high\ngate:\n  approval: write\n---\nThink.\n");
		const opened = await listed("deep");
		expect(opened.draft.thinking).toBe("high");
		expect((await reforge(opened)).isError).toBeFalsy();
		expect(await readFile(userFile("deep"), "utf8")).toContain("  thinkingLevel: high\n");
	});

	test("YAML that does not parse is shown as a problem and never saved", async () => {
		await seedRich();
		const opened = await listed("cmo");
		const original = await readFile(userFile("cmo"), "utf8");
		for (const extra of ["title: [unclosed", "just some words", "loop:\n  maxTurns: 5\n---\nbody: oops"]) {
			const check = (await call("validate_agent", { draft: { ...opened.draft, extra } })).structuredContent as unknown as DraftCheck;
			expect(check.problems.length).toBeGreaterThan(0);
			expect((await reforge(opened, { extra })).isError).toBe(true);
			expect(await readFile(userFile("cmo"), "utf8")).toBe(original);
		}
		// A valid text is accepted by the same check.
		expect(((await call("validate_agent", { draft: opened.draft })).structuredContent as unknown as DraftCheck).problems).toEqual([]);
	});

	test("Other settings cannot take over the name, the description, the lineage or the charter's prompt mode", async () => {
		const clean = (await call("validate_agent", { draft: draft() })).structuredContent as unknown as DraftCheck;
		expect(clean.problems).toEqual([]);
		for (const extra of ["name: someone-else", "description: hijacked", "extends: [coding]", "identity:\n  prompt: append", "specVersion: 2"]) {
			const check = (await call("validate_agent", { draft: draft({ extra }) })).structuredContent as unknown as DraftCheck;
			expect(check.problems.length).toBeGreaterThan(0);
		}
	});

	test("a section written inline cannot join the orrery's own keys — it is refused, not half-merged", async () => {
		const check = (await call("validate_agent", { draft: draft({ extra: "capabilities: { control: [agents] }" }) })).structuredContent as unknown as DraftCheck;
		expect(check.problems.join(" ")).toContain("inline");
		// With nothing of the orrery's in that section it is carried as written.
		const plain = draft({ tools: [], skills: [], mcp: [], extra: "capabilities: { control: [agents] }" });
		expect((await call("save_agent", { draft: plain, create: true })).isError).toBeFalsy();
		expect((await manifestAt(userFile("release-herald"), "release-herald")).manifest.capabilities?.control).toEqual({ lanes: ["agents"] });
	});

	test("a hand-written flow section opens as a block and keeps every key", async () => {
		await put(userFile("flowy"), "---\nname: flowy\ndescription: flow style\nspecVersion: 1\ncapabilities: { skills: [a], control: [agents] }\ngate: { approval: yolo }\n---\nFlowing.\n");
		const opened = await listed("flowy");
		expect(opened.draft).toMatchObject({ skills: ["a"], approval: "yolo" });
		expect(opened.draft.extra).toContain("control:");
		expect((await reforge(opened)).isError).toBeFalsy();
		const decl = await manifestAt(userFile("flowy"), "flowy");
		expect(decl.manifest.capabilities).toMatchObject({ skills: ["a"], control: { lanes: ["agents"] } });
		expect(decl.manifest.gate?.approval).toBe("yolo");
	});

	test("keys written at another indent still join the orrery's own section, and a key's own comments and lists ride along", async () => {
		await put(
			userFile("wide"),
			"---\nname: wide\ndescription: four-space indent\nspecVersion: 1\ncapabilities:\n    skills: [a]\n    control:\n        - observe\n        - agents   # trailing note\ngate:\n    approval: write\n---\nWide.\n",
		);
		const opened = await listed("wide");
		expect(opened.draft.skills).toEqual(["a"]);
		expect((await reforge(opened, { skills: ["a", "b"] })).isError).toBeFalsy();
		const text = await readFile(userFile("wide"), "utf8");
		expect(text).toContain("  control:\n      - observe\n      - agents   # trailing note\n");
		const decl = await manifestAt(userFile("wide"), "wide");
		expect(decl.manifest.capabilities?.skills).toEqual(["a", "b"]);
		expect(decl.manifest.capabilities?.control).toEqual({ lanes: ["observe", "agents"] });
	});

	test("the live agent.md shows exactly the lines that will be written", async () => {
		await seedRich();
		const opened = await listed("cmo");
		const shown = manifestLines(opened.draft, agentHomeWorkspaceId("cmo"))
			.map(line => line.text)
			.join("\n");
		await reforge(opened);
		expect(`${shown}\n`).toBe(await readFile(userFile("cmo"), "utf8"));
	});
});

describe("forge_propose", () => {
	test("offers the model no tools, mcp, approval or recall-scope field, and carries none into the draft", async () => {
		const { tools } = await client.listTools();
		const schema = tools.find(tool => tool.name === "forge_propose")?.inputSchema.properties ?? {};
		expect(Object.keys(schema)).not.toContain("tools");
		expect(Object.keys(schema)).not.toContain("mcp");
		expect(Object.keys(schema)).not.toContain("approval");
		expect(Object.keys(schema)).not.toContain("memoryScope");

		const result = await call("forge_propose", { name: "scout", description: "Finds things", skills: ["fallow"], tools: ["bash"], mcp: ["palace"], approval: "yolo", memoryScope: "global" });
		expect(result.isError).toBeFalsy();
		const { proposal } = result.structuredContent as unknown as ForgeProposed;
		expect(proposal).toEqual({ name: "scout", description: "Finds things", skills: ["fallow"] });
	});

	test.each([
		["capabilities.control", "capabilities:\n  control: [agents]"],
		["capabilities.plugins", "capabilities:\n  plugins: [browser]"],
		["capabilities.mcp", "capabilities:\n  mcp: [palace]"],
		["capabilities.tools", "capabilities:\n  tools: [bash]"],
		["capabilities.optIn", "capabilities:\n  optIn: [browser]"],
		["subagents.allowed", "subagents:\n  allowed: '*'"],
		["gate", "gate:\n  approval: yolo"],
		["gate", "gate:\n  policy: open"],
		["workspace", "workspace:\n  policy: bound\n  reach: all"],
		["harness", "harness: my-body"],
		["allowedHarnesses", "allowedHarnesses: [my-body]"],
		["tools", "tools: [bash]"],
		["spawns", "spawns: '*'"],
		["capabilities (inline)", "capabilities: { control: [agents] }"],
		["capabilities (inline)", "capabilities:\n  {control: [spaces], tools: [bash, write]}"],
		["subagents (inline)", 'subagents:\n  ? allowed\n  : ["*"]'],
		["capabilities.control", "title: Friendly\ncapabilities:\n  autoloadSkills: [x]\n  control: [agents]"],
	])("refuses an Everything-else proposal that sets %s — the whole proposal, not just the key", async (named, extra) => {
		const result = await call("forge_propose", { name: "scout", description: "Finds things", extra });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain(named);
		expect(result.structuredContent).toBeUndefined();
	});

	// `grantPathsIn` reads lines, so a spelling of YAML it cannot place slips past it;
	// the server's second reader resolves the text to the keys the engine will read.
	test.each([
		["capabilities.tools", "capabilities:\n  title: x\n  ? tools\n  : [bash]"],
		["capabilities.tools", "capabilities:\n  title: x\n  &a tools: [bash]"],
		["capabilities.control", "title: x\n? capabilities\n: {control: [agents]}"],
		["capabilities.plugins", "{capabilities: {plugins: [browser]}}"],
		["gate", "? gate\n: {approval: yolo}"],
	])("refuses %s however the YAML spells it: %j", async (named, extra) => {
		const result = await call("forge_propose", { name: "scout", description: "Finds things", extra });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain(named);
		expect(result.structuredContent).toBeUndefined();
	});

	test("a proposal cannot change capabilities.mcp — by field, through extra, or merged into a draft", async () => {
		// By field: undeclared in the schema, so the model's `mcp` never reaches the proposal.
		const byField = await call("forge_propose", { name: "scout", mcp: ["palace"] });
		expect(byField.isError).toBeFalsy();
		expect((byField.structuredContent as unknown as ForgeProposed).proposal).toEqual({ name: "scout" });
		// Through extra: refused whole.
		const viaExtra = await call("forge_propose", { name: "scout", extra: "capabilities:\n  mcp: [palace]" });
		expect(viaExtra.isError).toBe(true);
		expect(JSON.stringify(viaExtra.content)).toContain("capabilities.mcp");
		// Merged into a draft: a forged `mcp` (an older server, a hostile event) changes nothing.
		const base = draft({ mcp: ["browser"] });
		expect(applyProposal(base, { name: "release-herald", mcp: ["palace", "threejs"] } as AgentProposal).mcp).toEqual(["browser"]);
	});

	// The panel's "You are setting …" warning is `grantPathsIn` on the text being typed.
	test("the warning names a mixed section written as a flow mapping or explicit keys on the next line, and stays silent on plain harmless keys", () => {
		expect(grantPathsIn("capabilities:\n  {control: [spaces], tools: [bash, write]}")).toEqual(["capabilities (inline)"]);
		expect(grantPathsIn('subagents:\n  ? allowed\n  : ["*"]')).toEqual(["subagents (inline)"]);
		expect(grantPathsIn("capabilities:\n  # only a comment\n")).toEqual([]);
		expect(grantPathsIn("capabilities:\n  autoloadSkills: [fallow]\nsubagents:\n  maxDepth: 2")).toEqual([]);
	});

	test("carries the harmless keys of Everything else through, and refuses YAML that is not a mapping", async () => {
		const extra = "title: Scout\nrouting:\n  card: Finds things\nengine:\n  profile: fast\ncapabilities:\n  autoloadSkills: [fallow]\nsubagents:\n  maxDepth: 2";
		const result = await call("forge_propose", { name: "scout", extra });
		expect(result.isError).toBeFalsy();
		expect((result.structuredContent as unknown as ForgeProposed).proposal.extra).toBe(extra);

		expect((await call("forge_propose", { name: "scout", extra: "- a\n- b" })).isError).toBe(true);
		expect((await call("forge_propose", { name: "scout", extra: "title: [unclosed" })).isError).toBe(true);
	});

	test("merged into a draft, a proposal leaves the human's tools, gate, recall scope and grants alone", () => {
		const base = draft({ tools: ["read"], mcp: ["browser"], approval: "always-ask", memoryScope: "project", extra: "capabilities:\n  control: [agents]\ntitle: Old" });
		const hostile = { name: "release-herald", charter: "New charter", tools: ["bash"], mcp: ["palace"], approval: "yolo", memoryScope: "global" } as AgentProposal;
		const merged = applyProposal(base, hostile);
		expect(merged.tools).toEqual(["read"]);
		expect(merged.mcp).toEqual(["browser"]);
		expect(merged.approval).toBe("always-ask");
		expect(merged.memoryScope).toBe("project");
		expect(merged.charter).toBe("New charter");

		// Even if a grant-class proposal reaches the View (an older server, a forged event), it is not applied.
		const smuggled = applyProposal(base, { name: "release-herald", extra: "capabilities:\n  control: [agents, rooms]\ngate:\n  approval: yolo" });
		expect(smuggled.extra).toBe(base.extra);
		// Nor when the grant is a flow mapping or explicit keys on the line after the section's key.
		for (const extra of ["capabilities:\n  {control: [spaces], tools: [bash, write]}", 'subagents:\n  ? allowed\n  : ["*"]']) {
			expect(applyProposal(base, { name: "release-herald", extra }).extra).toBe(base.extra);
		}
		// A harmless one lays over the human's own text key by key, keeping their grant.
		const overlaid = applyProposal(base, { name: "release-herald", extra: "title: New\ncapabilities:\n  autoloadSkills: [fallow]" });
		const decl = parseYaml(overlaid.extra) as { title: string; capabilities: Record<string, unknown> };
		expect(decl.title).toBe("New");
		expect(decl.capabilities).toEqual({ control: ["agents"], autoloadSkills: ["fallow"] });
	});
});

describe("list_agents", () => {
	test("marks pack agents read-only, and lists project agents with settings the orrery cannot draw as editable", async () => {
		await call("save_agent", { draft: draft(), create: true });
		const handTuned = "---\nname: tuned\ndescription: has a loop budget\nspecVersion: 1\ngate:\n  approval: write\nloop:\n  maxTurns: 5\n---\nTuned.\n";
		await put(projectFile("tuned"), handTuned);

		const byName = new Map((await listing()).agents.map(agent => [agent.name, agent]));
		expect(byName.get("helper")).toMatchObject({ source: "pack", pack: "helper-pack", editable: false });
		expect(byName.get("release-herald")).toMatchObject({ source: "user", editable: true });
		expect(byName.get("tuned")).toMatchObject({ source: "workspace", editable: true });

		// Rewriting it loses nothing: the loop budget is held in Everything else.
		const tuned = byName.get("tuned");
		if (!tuned) throw new Error("tuned not listed");
		expect(tuned.draft.extra).toBe("loop:\n  maxTurns: 5");
		expect((await reforge(tuned)).isError).toBeFalsy();
		expect((await manifestAt(projectFile("tuned"), "tuned")).manifest.loop?.maxTurns).toBe(5);
	});

	test("the legacy .omp/agents tier is read-only", async () => {
		await put(join(workspace, ".omp", "agents", "old", "agent.md"), "---\nname: old\ndescription: legacy\nspecVersion: 1\ngate:\n  approval: write\n---\nOld.\n");
		if (WRITE_DIR === ".omp") return;
		expect(await listed("old")).toMatchObject({ source: "workspace", editable: false });
	});
});

describe("the project config dir", () => {
	// The engine's General Agents catalog reads `<workspace>/<PI_CONFIG_DIR>/agents`
	// (`.inso-dev` on a dev engine). The live proof caught the Forge writing
	// `.inso/agents` there, where that engine never listed it. WRITE_DIR is fixed
	// at module load, so the rule is exercised in a child with the env set.
	test("the listing reads and a rewrite writes under PI_CONFIG_DIR, where the engine reads", async () => {
		const ws = await mkdtemp(join(tmpdir(), "forge-cfgdir-"));
		try {
			await put(join(ws, ".inso-dev", "agents", "dev-herald", "agent.md"), "---\nname: dev-herald\ndescription: d\nspecVersion: 1\ngate:\n  approval: write\n---\nc\n");
			const script = `
				const { saveAgent, listAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/store.ts"))});
				const roots = { workspace: ${JSON.stringify(ws)}, home: ${JSON.stringify(home)} };
				const listing = await listAgents(roots);
				const found = listing.agents.find(a => a.name === "dev-herald");
				const saved = await saveAgent({ roots, draft: { ...found.draft, description: "again" }, target: { create: false, tier: "workspace", revision: found.revision } });
				console.log(JSON.stringify({ rel: saved.relativePath, configDir: listing.configDir, source: found.source }));`;
			const child = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, PI_CONFIG_DIR: ".inso-dev" } });
			const out = JSON.parse(new TextDecoder().decode(child.stdout).trim().split("\n").pop() ?? "{}");
			expect(out).toEqual({ rel: ".inso-dev/agents/dev-herald/agent.md", configDir: ".inso-dev", source: "workspace" });
			expect(await readdir(join(ws, ".inso-dev", "agents"))).toEqual(["dev-herald"]);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});
});

describe("recall scope", () => {
	// The Recall switch is the agent's `workspace.reach` grant, not a memory
	// key: what the human toggled is what the engine reads back.
	test("'Every project' writes workspace.reach: all, keeps the habitat, and reads back as the same switch", async () => {
		await call("save_agent", { draft: draft({ memory: "engram", memoryScope: "global" }), create: true });
		const decl = await manifestAt(userFile("release-herald"), "release-herald");
		expect(decl.manifest.workspace).toEqual({ policy: "bound", reach: "all" });
		expect(decl.manifest.memory).toEqual({ backend: "engram" });

		const readBack = await listed("release-herald");
		expect(readBack.editable).toBe(true);
		expect(readBack.draft).toMatchObject({ memory: "engram", memoryScope: "global", habitat: "bound" });

		await call("save_agent", { draft: draft({ name: "homebody", memoryScope: "global", habitat: "home" }), create: true });
		expect((await manifestAt(userFile("homebody"), "homebody")).manifest.workspace).toEqual({ policy: "home", id: agentHomeWorkspaceId("homebody"), reach: "all" });
	});

	test("'This project' writes no grant, and an agent with memory off never carries one", async () => {
		await call("save_agent", { draft: draft({ memory: "engram", memoryScope: "project" }), create: true });
		expect((await manifestAt(userFile("release-herald"), "release-herald")).manifest.workspace).toBeUndefined();

		await call("save_agent", { draft: draft({ name: "amnesiac", memory: "off", memoryScope: "global" }), create: true });
		expect((await manifestAt(userFile("amnesiac"), "amnesiac")).manifest.workspace).toBeUndefined();
	});

	test("a manifest that still says memory.vault opens editable, reads as 'This project', and is never written back", async () => {
		const old = "---\nname: elder\ndescription: authored before memory.vault was removed\nspecVersion: 1\ngate:\n  approval: write\nmemory:\n  backend: engram\n  vault: global\n---\nRemember everything.\n";
		await put(userFile("elder"), old);
		const opened = await listed("elder");
		expect(opened.editable).toBe(true);
		expect(opened.draft).toMatchObject({ memory: "engram", memoryScope: "project", extra: "" });

		const result = await reforge(opened);
		expect(result.isError).toBeFalsy();
		const rewritten = await readFile(userFile("elder"), "utf8");
		expect(rewritten).not.toMatch(/^\s*vault:/m);
		expect(rewritten).toContain("backend: engram");
	});

	test("a reach the switch cannot draw opens editable and is kept as written — neither widened nor dropped", async () => {
		const scoped = "---\nname: scoped-reach\ndescription: reads two named workspaces\nspecVersion: 1\ngate:\n  approval: write\nworkspace:\n  policy: bound\n  reach: [inso, docs]\n---\nRead the siblings.\n";
		await put(userFile("scoped-reach"), scoped);
		const opened = await listed("scoped-reach");
		expect(opened.editable).toBe(true);
		expect(opened.draft.memoryScope).toBe("project");
		expect(opened.draft.extra).toBe("workspace:\n  reach: [inso, docs]");
		expect((await reforge(opened)).isError).toBeFalsy();
		expect((await manifestAt(userFile("scoped-reach"), "scoped-reach")).manifest.workspace).toEqual({ policy: "bound", reach: ["inso", "docs"] });
	});
});

describe("an agent's home and its standing instructions", () => {
	const homeOf = async (name: string): Promise<AgentHome> => (await call("agent_home", { name })).structuredContent as unknown as AgentHome;
	const wins = (home: AgentHome) => home.instructions.files.find(file => file.wins)?.kind ?? null;
	const PACK_DIR = () => join(home, "plugins", "node_modules", "helper-pack", "general-agents", "helper");

	test("a user agent's home is home-<name> under the engine's workspaces; a project agent has none", async () => {
		await call("save_agent", { draft: draft(), create: true });
		await put(projectFile("project-bot"), "---\nname: project-bot\ndescription: one project's\nspecVersion: 1\ngate:\n  approval: write\n---\nHere.\n");

		const mine = await homeOf("release-herald");
		expect(mine).toMatchObject({ exists: true, source: "user", homeId: agentHomeWorkspaceId("release-herald"), canStandAtHome: true, hasHome: true, folder: homeDirOf("release-herald"), folderExists: false, memoryRoom: agentHomeWorkspaceId("release-herald") });
		await mkdir(homeDirOf("release-herald"), { recursive: true });
		expect((await homeOf("release-herald")).folderExists).toBe(true);

		const project = await homeOf("project-bot");
		expect(project).toMatchObject({ source: "workspace", canStandAtHome: false, hasHome: false, folder: null });
		expect(project.homeNote).toContain("no home");

		// A name still being typed is a user agent to be.
		expect(await homeOf("not-yet")).toMatchObject({ exists: false, source: "user", homeId: agentHomeWorkspaceId("not-yet"), canStandAtHome: true });
	});

	test("an agent that names another workspace stands there and has no derived home; an older 'agent-<name>' says so", async () => {
		await put(userFile("aether-like"), "---\nname: aether-like\ndescription: lives in the vault\nspecVersion: 1\ngate:\n  approval: write\nworkspace:\n  policy: pinned\n  id: inso-personal\n---\nVault.\n");
		const pinned = await homeOf("aether-like");
		expect(pinned).toMatchObject({ hasHome: false, folder: null, memoryRoom: "inso-personal" });

		await put(userFile("legacy-home"), "---\nname: legacy-home\ndescription: older Forge\nspecVersion: 1\ngate:\n  approval: write\nworkspace:\n  policy: home\n  id: agent-legacy-home\n---\nOld.\n");
		const note = (await homeOf("legacy-home")).homeNote;
		expect(note).toContain("agent-legacy-home");
		expect(note).toContain("home-legacy-home");
	});

	test("a user agent runs by its home AGENTS.md when it holds text; an empty one falls through to the sibling", async () => {
		await call("save_agent", { draft: draft(), create: true });
		const sibling = join(home, "agent", "agents", "release-herald", "AGENTS.md");
		expect(wins(await homeOf("release-herald"))).toBeNull();
		expect((await homeOf("release-herald")).instructions.text).toBe("");

		await put(sibling, "Beside agent.md.\n");
		expect(wins(await homeOf("release-herald"))).toBe("agent-dir");

		await put(join(homeDirOf("release-herald"), "AGENTS.md"), "");
		expect(wins(await homeOf("release-herald"))).toBe("agent-dir");
		expect((await homeOf("release-herald")).instructions.text).toBe("Beside agent.md.\n");

		await put(join(homeDirOf("release-herald"), "AGENTS.md"), "From home.\n");
		const strong = await homeOf("release-herald");
		expect(wins(strong)).toBe("home");
		expect(strong.instructions.text).toBe("From home.\n");
		expect(strong.instructions.files.map(file => file.kind)).toEqual(["home", "agent-dir"]);
	});

	test("a pack agent: a project's copy beats the home, even empty; a non-empty home beats the pack's own; empty home falls through", async () => {
		const shipped = join(PACK_DIR(), "AGENTS.md");
		const copy = join(workspace, WRITE_DIR, "agents", "helper", "AGENTS.md");
		const homeFile = join(homeDirOf("helper"), "AGENTS.md");
		await put(shipped, "Shipped by the pack.\n");
		expect(wins(await homeOf("helper"))).toBe("pack");

		await put(homeFile, "");
		expect(wins(await homeOf("helper"))).toBe("pack");
		await put(homeFile, "My standing instructions.\n");
		expect(wins(await homeOf("helper"))).toBe("home");

		await put(copy, "");
		const strongest = await homeOf("helper");
		expect(wins(strongest)).toBe("workspace-copy");
		expect(strongest.instructions.files.map(file => file.kind)).toEqual(["workspace-copy", "workspace-copy", "home", "pack"]);
		expect(strongest.instructions.text).toBe("");
		await put(copy, "This project's word.\n");
		expect((await homeOf("helper")).instructions.text).toBe("This project's word.\n");
	});

	test("a project agent has only the AGENTS.md beside its agent.md", async () => {
		await put(projectFile("project-bot"), "---\nname: project-bot\ndescription: one project's\nspecVersion: 1\ngate:\n  approval: write\n---\nHere.\n");
		// A file at a home path is not one this agent reads.
		await put(join(homeDirOf("project-bot"), "AGENTS.md"), "Never read.\n");
		const bare = await homeOf("project-bot");
		expect(bare.instructions.files.map(file => file.kind)).toEqual(["agent-dir"]);
		expect(wins(bare)).toBeNull();
		await put(join(projectFile("project-bot"), "..", "AGENTS.md"), "Project only.\n");
		expect((await homeOf("project-bot")).instructions.text).toBe("Project only.\n");
	});

	/** The revision of the file a save would write, as the View reads it from `agent_home`. */
	const targetRevision = async (name: string): Promise<string> => (await homeOf(name)).instructions.target?.revision ?? "";
	const saveText = async (name: string, text: string, revision: string): Promise<CallToolResult> => call("save_instructions", { name, text, revision });

	test("saving writes the home AGENTS.md once the home exists, the sibling before; a pack agent's is read-only", async () => {
		await call("save_agent", { draft: draft(), create: true });
		const sibling = join(home, "agent", "agents", "release-herald", "AGENTS.md");
		const beforeHome = await saveText("release-herald", "Be brief.", await targetRevision("release-herald"));
		expect(beforeHome.structuredContent as unknown as InstructionsSaved).toEqual({ path: sibling, kind: "agent-dir" });
		expect(await readFile(sibling, "utf8")).toBe("Be brief.\n");

		await mkdir(homeDirOf("release-herald"), { recursive: true });
		const afterHome = await saveText("release-herald", "Be briefer.\n", await targetRevision("release-herald"));
		expect(afterHome.structuredContent as unknown as InstructionsSaved).toEqual({ path: join(homeDirOf("release-herald"), "AGENTS.md"), kind: "home" });
		const now = await homeOf("release-herald");
		expect(wins(now)).toBe("home");
		expect(now.instructions.text).toBe("Be briefer.\n");
		// Nothing half-written is left behind.
		expect((await readdir(homeDirOf("release-herald"))).filter(name => name.endsWith(".tmp"))).toEqual([]);

		const pack = await saveText("helper", "No.", await targetRevision("helper"));
		expect(pack.isError).toBe(true);
		await expect(stat(join(homeDirOf("helper"), "AGENTS.md"))).rejects.toThrow();
		expect((await saveText("ghost-agent", "No.", "0123456789abcdef")).isError).toBe(true);
	});

	test("a save is refused when the file it would write changed since it was read — the edit made elsewhere survives", async () => {
		await call("save_agent", { draft: draft(), create: true });
		const sibling = join(home, "agent", "agents", "release-herald", "AGENTS.md");
		await put(sibling, "As first read.\n");
		const seen = await targetRevision("release-herald");

		await put(sibling, "Edited in another editor.\n");
		const stale = await saveText("release-herald", "The Forge tab's copy.", seen);
		expect(stale.isError).toBe(true);
		expect(await readFile(sibling, "utf8")).toBe("Edited in another editor.\n");

		// Read again, the same text goes through: the guard refuses a stale write, not every write.
		expect((await saveText("release-herald", "The Forge tab's copy.", await targetRevision("release-herald"))).isError).toBeFalsy();
		expect(await readFile(sibling, "utf8")).toBe("The Forge tab's copy.\n");
	});

	test("a save is refused when the home appeared since the text was read — it would have landed in another file", async () => {
		await call("save_agent", { draft: draft(), create: true });
		const sibling = join(home, "agent", "agents", "release-herald", "AGENTS.md");
		await put(sibling, "Beside agent.md.\n");
		const seen = await targetRevision("release-herald");
		expect((await homeOf("release-herald")).instructions.target?.kind).toBe("agent-dir");

		// The engine provisions the home between the read and the save.
		await mkdir(homeDirOf("release-herald"), { recursive: true });
		const moved = await saveText("release-herald", "Edited against the sibling's text.", seen);
		expect(moved.isError).toBe(true);
		await expect(stat(join(homeDirOf("release-herald"), "AGENTS.md"))).rejects.toThrow();
		expect(await readFile(sibling, "utf8")).toBe("Beside agent.md.\n");

		const reread = await homeOf("release-herald");
		expect(reread.instructions.target?.kind).toBe("home");
		expect((await saveText("release-herald", "Edited against the sibling's text.", reread.instructions.target?.revision ?? "")).isError).toBeFalsy();
		expect(await readFile(join(homeDirOf("release-herald"), "AGENTS.md"), "utf8")).toBe("Edited against the sibling's text.\n");
	});

	test("a save that names no revision is refused", async () => {
		await call("save_agent", { draft: draft(), create: true });
		const sibling = join(home, "agent", "agents", "release-herald", "AGENTS.md");
		const outcome = await call("save_instructions", { name: "release-herald", text: "No revision." }).then(
			result => result.isError === true,
			() => true,
		);
		expect(outcome).toBe(true);
		await expect(stat(sibling)).rejects.toThrow();
	});
});
