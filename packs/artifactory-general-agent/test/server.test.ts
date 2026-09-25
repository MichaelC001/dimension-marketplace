import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGeneralAgent } from "@dimension/sdk/general-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parse as parseYaml } from "yaml";
import { type AgentDraft, type AgentProposal, applyProposal, blankDraft } from "../src/agent-md";
import type { AgentListing, ForgeProposed, SaveOutcome } from "../src/contracts";
import { createForgeServer } from "../src/server";

let root: string;
let workspace: string;
let client: Client;

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

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "forge-"));
	workspace = join(root, "workspace");
	const home = join(root, "home");
	const viewDir = join(root, "view");
	await mkdir(workspace, { recursive: true });
	await put(join(viewDir, "index.html"), "<!doctype html><div id=root></div>");
	await put(join(home, "plugins", "node_modules", "helper-pack", "general-agents", "helper", "agent.md"), PACK_AGENT);
	const server = await createForgeServer({ viewDir, env: { INSO_HOME: home } });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	client = new Client({ name: "forge-test", version: "0" });
	await client.connect(clientSide);
	// The agent names its workspace the way it does in a session.
	const opened = (await client.callTool({ name: "forge_open", arguments: { workspace } })) as CallToolResult;
	expect(opened.isError).toBeFalsy();
});

afterEach(async () => {
	await client.close();
	await rm(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
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

const agentFile = (name: string) => join(workspace, ".inso", "agents", name, "agent.md");

describe("save_agent", () => {
	test("writes an agent.md that parseGeneralAgent accepts, carrying the human's tools and gate", async () => {
		const result = await call("save_agent", { draft: draft(), create: true });
		expect(result.isError).toBeFalsy();
		const outcome = result.structuredContent as unknown as SaveOutcome;
		expect(outcome.path).toBe(agentFile("release-herald"));
		expect(outcome.relativePath).toBe(".inso/agents/release-herald/agent.md");

		const parsed = parseGeneralAgent(await readFile(outcome.path, "utf8"), outcome.path, "release-herald");
		if (!parsed.ok) throw new Error(parsed.errors.join("; "));
		expect(parsed.decl.description).toBe("Writes changelogs in my voice");
		expect(parsed.decl.avatar).toEqual({ id: "quasar" });
		expect(parsed.decl.manifest.capabilities?.tools).toEqual(["read", "grep"]);
		expect(parsed.decl.manifest.gate?.approval).toBe("write");
		expect(parsed.decl.body).toBe("You write the changelog.\n\nNever invent a change.");

		// What it wrote, it can edit again: the listing reads it back as editable.
		const listing = (await call("list_agents", {})).structuredContent as unknown as AgentListing;
		expect(listing.agents.find(agent => agent.name === "release-herald")?.editable).toBe(true);
	});

	test("refuses a name already taken on create — in the workspace or by a pack — and writes nothing", async () => {
		const handWritten = "---\nname: release-herald\ndescription: mine\nspecVersion: 1\ngate:\n  approval: always-ask\n---\nHand written.\n";
		await put(agentFile("release-herald"), handWritten);
		const collision = await call("save_agent", { draft: draft(), create: true });
		expect(collision.isError).toBe(true);
		expect(await readFile(agentFile("release-herald"), "utf8")).toBe(handWritten);

		const packName = await call("save_agent", { draft: draft({ name: "helper" }), create: true });
		expect(packName.isError).toBe(true);
		expect(await readdir(join(workspace, ".inso", "agents"))).toEqual(["release-herald"]);
	});

	test("refuses a bad name and writes nothing", async () => {
		for (const name of ["Release Herald", "x", "../escape", "-lead", ""]) {
			const result = await call("save_agent", { draft: draft({ name }), create: true });
			expect(result.isError).toBe(true);
		}
		expect(await readdir(workspace)).toEqual([]);
	});

	test("never writes an autonomy trigger, however the draft is dressed", async () => {
		const smuggled = {
			...draft({
				description: "x\nautonomy:\n  trigger:\n    schedule: '* * * * *'",
				charter: "---\nautonomy:\n  trigger:\n    schedule: '* * * * *'\n---\nRun forever.",
			}),
			autonomy: { trigger: { schedule: "* * * * *" } },
		};
		const result = await call("save_agent", { draft: smuggled, create: true });
		expect(result.isError).toBeFalsy();
		const text = await readFile(agentFile("release-herald"), "utf8");
		const parsed = parseGeneralAgent(text, agentFile("release-herald"), "release-herald");
		expect(parsed.ok).toBe(true);
		const frontmatter = parseYaml(text.split(/^---$/m)[1] ?? "") as Record<string, unknown>;
		expect(frontmatter.autonomy).toBeUndefined();
	});

	test("does not rewrite a Loop that sits where the agent would", async () => {
		const loop = "---\nname: nightly\ndescription: a loop\nspecVersion: 1\nautonomy:\n  trigger:\n    schedule: '0 3 * * *'\n---\nRun.\n";
		await put(agentFile("nightly"), loop);
		const result = await call("save_agent", { draft: draft({ name: "nightly" }), create: false });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("is a Loop");
		expect(await readFile(agentFile("nightly"), "utf8")).toBe(loop);
	});
});

describe("forge_propose", () => {
	test("offers the model no tools or approval field, and carries none into the draft", async () => {
		const { tools } = await client.listTools();
		const schema = tools.find(tool => tool.name === "forge_propose")?.inputSchema.properties ?? {};
		expect(Object.keys(schema)).not.toContain("tools");
		expect(Object.keys(schema)).not.toContain("approval");

		const result = await call("forge_propose", { name: "scout", description: "Finds things", skills: ["fallow"], tools: ["bash"], approval: "yolo" });
		expect(result.isError).toBeFalsy();
		const { proposal } = result.structuredContent as unknown as ForgeProposed;
		expect(proposal).toEqual({ name: "scout", description: "Finds things", skills: ["fallow"] });
	});

	test("merged into a draft, a proposal leaves the human's tools and gate alone", () => {
		const base = draft({ tools: ["read"], approval: "always-ask" });
		const hostile = { name: "release-herald", charter: "New charter", tools: ["bash"], approval: "yolo" } as AgentProposal;
		const merged = applyProposal(base, hostile);
		expect(merged.tools).toEqual(["read"]);
		expect(merged.approval).toBe("always-ask");
		expect(merged.charter).toBe("New charter");
	});
});

describe("list_agents", () => {
	test("marks pack agents read-only, and workspace agents editable unless saving would drop settings", async () => {
		await call("save_agent", { draft: draft(), create: true });
		const handTuned = "---\nname: tuned\ndescription: has a loop budget\nspecVersion: 1\ngate:\n  approval: write\nloop:\n  maxTurns: 5\n---\nTuned.\n";
		await put(agentFile("tuned"), handTuned);

		const listing = (await call("list_agents", {})).structuredContent as unknown as AgentListing;
		const byName = new Map(listing.agents.map(agent => [agent.name, agent]));
		expect(byName.get("helper")).toMatchObject({ source: "pack", pack: "helper-pack", editable: false });
		expect(byName.get("release-herald")).toMatchObject({ source: "workspace", editable: true });
		expect(byName.get("tuned")?.editable).toBe(false);

		// The listing's word is the writer's: the tuned agent is refused, byte-intact.
		const rewrite = await call("save_agent", { draft: { ...byName.get("tuned")!.draft }, create: false });
		expect(rewrite.isError).toBe(true);
		expect(await readFile(agentFile("tuned"), "utf8")).toBe(handTuned);
	});
});

describe("the project config dir", () => {
	// The engine's General Agents catalog reads `<workspace>/<PI_CONFIG_DIR>/agents`
	// (`.inso-dev` on a dev engine). The live proof caught the Forge writing
	// `.inso/agents` there, where that engine never listed it. WRITE_DIR is fixed
	// at module load, so the rule is exercised in a child with the env set.
	test("save_agent writes under PI_CONFIG_DIR, where the engine reads, and the listing reports it", async () => {
		const ws = await mkdtemp(join(tmpdir(), "forge-cfgdir-"));
		try {
			const script = `
				const { saveAgent, listAgents } = await import(${JSON.stringify(join(import.meta.dir, "../src/store.ts"))});
				const { blankDraft } = await import(${JSON.stringify(join(import.meta.dir, "../src/agent-md.ts"))});
				const draft = { ...blankDraft("k"), name: "dev-herald", description: "d", charter: "c" };
				const saved = await saveAgent({ workspace: ${JSON.stringify(ws)}, draft, create: true, takenNames: new Set() });
				const listing = await listAgents({ workspace: ${JSON.stringify(ws)}, pluginsDir: ${JSON.stringify(join(ws, "no-plugins"))} });
				console.log(JSON.stringify({ rel: saved.relativePath, configDir: listing.configDir, names: listing.agents.map(a => a.name) }));`;
			const child = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, PI_CONFIG_DIR: ".inso-dev" } });
			const out = JSON.parse(new TextDecoder().decode(child.stdout).trim().split("\n").pop() ?? "{}");
			expect(out.rel).toBe(".inso-dev/agents/dev-herald/agent.md");
			expect(out.configDir).toBe(".inso-dev");
			expect(out.names).toContain("dev-herald");
			expect(await readdir(join(ws, ".inso-dev", "agents"))).toEqual(["dev-herald"]);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});
});
