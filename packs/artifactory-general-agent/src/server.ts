// The Forge as an MCP App (doc 45 §7): one View, two model-facing tools that
// carry it, three App-only tools the View reads and writes through.
//
// WHERE AGENTS ARE READ AND WRITTEN. The engine spawns this server ONCE per
// engine process, from the PLUGIN's root (`plugin-servers.ts`: `cwd: entry.cwd
// ?? root`), and lends it to every session; its environment carries the
// engine's home (`INSO_HOME`, `INSO_VAULT_DIR`, `INSO_ENV`) and its project
// config dir (`PI_CONFIG_DIR`) — `app-host.ts` `engineHomeEnv`. The HOME is
// enough for the tiers that matter: pack agents (`plugins/`) and the user's own
// agents (`agent/agents/`), where new agents are written and which have a home.
// A project's agents need a workspace, and a call's
// `_meta["ai.insodimension/session"]` names the session but not its workspace
// (`workspaceId` is reserved, never emitted): the one party that knows it is
// the agent, so `forge_open { workspace }` binds the session's workspace here,
// and every later call from that session — the model's or the View's, both
// stamped with the same session id — resolves against it. Opened from the rail
// door there is no workspace, and the Forge is still whole: it lists pack and
// user agents and creates into the user tier. `DIMENSION_FORGE_WORKSPACE`, when
// set, is the fallback workspace (a harness spawning this over stdio, a test).
//
// SECURITY (doc 58 §3). `capabilities.tools`, `gate.approval`, `workspace.*`
// and the other grant-class keys (`capabilities.control`, `capabilities.plugins`,
// `capabilities.mcp`, `subagents.allowed`, `harness`, `allowedHarnesses`) change
// only by a human's gesture in the View. `forge_propose` — the model's only way
// to shape a draft — has none of those fields in its schema (`mcp`, which
// servers the agent may call, is one: the user drags it in the View), refuses
// an Everything-else proposal that names one — read as text AND as the YAML it
// parses to, so no spelling of a key slips through — and copies only the
// proposable fields out of what it is given; `save_agent` and the instructions
// writer are App-only, so the model cannot write a file at all.
import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import {
	APPROVAL_SETTINGS,
	HABITATS,
	MEMORY_BACKENDS,
	MEMORY_SCOPES,
	NAME_RE,
	PERSONALITIES,
	PROMPT_MODES,
	THINKING_STEPS,
} from "./agent-md.js";
import type { DraftCheck, ForgeOpened, ForgeProposed, SaveTarget } from "./contracts.js";
import { grantPathsIn, grantPathsInDocument } from "./extra.js";
import { describeHome, INSTRUCTIONS_MAX_BYTES, saveInstructions } from "./home.js";
import { listParts } from "./parts.js";
import { listAgents, pathsOf, type Roots, renderDraft, SaveRefused, saveAgent, WRITE_DIR } from "./store.js";

export const FORGE_VIEW_URI = "ui://general-agent/index.html";
/** The request `_meta` key the engine stamps the calling session under (`app-server.ts` `SESSION_META_KEY`). */
const SESSION_META_KEY = "ai.insodimension/session";

const MIME: Readonly<Record<string, string>> = {
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".json": "application/json",
};
const APP_ONLY = { ui: { visibility: ["app"] as const } };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const entry = z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/, "one line");
const names = z.array(entry).max(64);
const agentName = z.string().regex(NAME_RE, "2–64 lowercase letters, digits or dashes");

const draftSchema = z.object({
	key: z.string().min(1).max(200),
	name: z.string().max(64),
	description: z.string().max(400),
	vibr: z.string().max(80),
	personality: z.enum(PERSONALITIES),
	promptMode: z.enum(PROMPT_MODES),
	thinking: z.enum(THINKING_STEPS),
	tools: names,
	skills: names,
	mcp: names,
	memory: z.enum(MEMORY_BACKENDS),
	memoryScope: z.enum(MEMORY_SCOPES),
	approval: z.enum(APPROVAL_SETTINGS),
	habitat: z.enum(HABITATS),
	lineage: z.array(agentName).max(16),
	charter: z.string().max(40_000),
	extra: z.string().max(40_000),
});

/** `forge_propose`'s schema: the proposable fields and NOTHING else. */
const proposalShape = {
	name: agentName.describe("the agent's name: lowercase letters, digits, dashes"),
	description: z.string().max(400).optional().describe("one line: what it is for"),
	charter: z.string().max(40_000).optional().describe("the instructions it runs by (the agent.md body), markdown"),
	vibr: z.string().max(80).optional().describe("the avatar id it wears — a vibr such as orb, nebula or mochi"),
	skills: names.optional().describe("skill allowlist; omit to keep every skill"),
	memory: z.enum(MEMORY_BACKENDS).optional(),
	lineage: z.array(agentName).max(16).optional().describe("agents whose brain it extends"),
	thinking: z.enum(THINKING_STEPS).optional(),
	personality: z.enum(PERSONALITIES).optional(),
	habitat: z.enum(HABITATS).optional().describe("bound: where opened; home: its own workspace; ephemeral: a scratch worktree"),
	extra: z
		.string()
		.max(20_000)
		.optional()
		.describe(
			"YAML for manifest keys the profile does not draw — title, defaultListed, engine.model/profile/roles, routing, loop, memory.namespace, capabilities.autoloadSkills/slashCommands/ignore, subagents.maxDepth, … One `key: value` per line, sections indented two spaces. It is laid over the draft's own, key by key. Keys that GRANT — capabilities.tools/mcp/plugins/control/optIn, subagents.allowed, gate.*, workspace.*, harness, allowedHarnesses — are refused: only the user sets those.",
		),
};

function json(structuredContent: object, text: string): CallToolResult {
	return { content: [{ type: "text", text }], structuredContent: structuredContent as Record<string, unknown> };
}

function fail(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function sessionOf(extra: { _meta?: Record<string, unknown> }): string {
	const meta = extra._meta?.[SESSION_META_KEY];
	if (typeof meta !== "object" || meta === null || !("sessionId" in meta)) return "";
	return typeof meta.sessionId === "string" ? meta.sessionId : "";
}

export interface ForgeServerOptions {
	/** The built View (`app/dist`). */
	readonly viewDir?: string;
	/** Defaults to `process.env`: `INSO_HOME` locates the plugin store, the user's
	 *  agents and skills, and every agent home; `DIMENSION_FORGE_WORKSPACE` is the
	 *  fallback workspace. */
	readonly env?: NodeJS.ProcessEnv;
}

export async function createForgeServer(options: ForgeServerOptions = {}): Promise<McpServer> {
	const env = options.env ?? process.env;
	const home = env.INSO_HOME !== undefined && env.INSO_HOME !== "" ? env.INSO_HOME : null;
	const paths = pathsOf(home);
	const fallback = env.DIMENSION_FORGE_WORKSPACE !== undefined && isDirectory(env.DIMENSION_FORGE_WORKSPACE) ? resolve(env.DIMENSION_FORGE_WORKSPACE) : null;
	/** Session id → the workspace its agent named in `forge_open`. */
	const workspaces = new Map<string, string>();
	const rootsOf = (extra: { _meta?: Record<string, unknown> }): Roots => ({ workspace: workspaces.get(sessionOf(extra)) ?? fallback, home });

	const server = new McpServer({ name: "dimension-community-general-agent", version: "0.3.0" });
	const viewDir = options.viewDir ?? fileURLToPath(new URL("./dist/", import.meta.url));
	// A missing built View is a startup error, not an installed pack that opens blank.
	const html = await readFile(join(viewDir, "index.html"), "utf8");
	const metadata = { ui: { prefersBorder: false } };
	registerAppResource(server, "Forge", FORGE_VIEW_URI, { _meta: metadata }, async () => ({
		contents: [{ uri: FORGE_VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: metadata }],
	}));
	for (const file of await readdir(viewDir, { recursive: true, withFileTypes: true })) {
		if (!file.isFile() || file.name === "index.html") continue;
		const mimeType = MIME[extname(file.name)];
		if (!mimeType) throw new Error(`Unsupported Forge View asset: ${file.name}`);
		const path = join(file.parentPath, file.name);
		const relative = path.slice(viewDir.replace(/[\\/]$/, "").length + 1).replaceAll("\\", "/");
		const uri = `ui://general-agent/${relative}`;
		server.registerResource(relative, uri, { mimeType }, async () => ({ contents: [{ uri, mimeType, blob: (await readFile(path)).toString("base64") }] }));
	}

	// ── the model's two doors (each carries the View) ──────────────────────
	registerAppTool(
		server,
		"forge_open",
		{
			title: "Forge",
			description: `Open the General Agents page: every General Agent — the ones installed packs ship, the user's own, and the workspace's — as cards the user can open, edit and create from, or one agent's profile, by name. \`workspace\` is optional: the absolute path of the directory you are working in, which adds that project's agents (\`<workspace>/${WRITE_DIR}/agents/<name>/agent.md\`); without it the page still lists pack and user agents and creates new ones in the user's own agents. It writes nothing itself — the user saves.`,
			inputSchema: {
				agent: agentName.optional().describe("open this agent directly"),
				workspace: z.string().min(1).max(1024).optional().describe("absolute path of your working directory"),
			},
			_meta: { ui: { resourceUri: FORGE_VIEW_URI } },
		},
		async ({ agent, workspace }, extra) => {
			const session = sessionOf(extra);
			if (workspace !== undefined) {
				if (!isAbsolute(workspace) || !isDirectory(workspace)) return fail(`${workspace} is not an existing absolute directory.`);
				workspaces.set(session, resolve(workspace));
			}
			const roots = rootsOf(extra);
			const listing = await listAgents(roots);
			const found = agent === undefined ? undefined : listing.agents.find(candidate => candidate.name === agent);
			const opened: ForgeOpened = { view: "forge", agent: found?.name ?? null, workspace: roots.workspace };
			const where = roots.workspace === null ? "no workspace (pack and user agents)" : roots.workspace;
			const text =
				agent !== undefined && found === undefined
					? `No General Agent named "${agent}" in ${where}; the page opened on every agent (${listing.agents.length}).`
					: found !== undefined
						? `The Forge opened on ${found.name} (${found.source}, ${found.editable ? "editable" : "read-only"}) in ${where}.`
						: `The Forge opened on ${listing.agents.length} General Agents in ${where}.`;
			return json(opened, text);
		},
	);

	registerAppTool(
		server,
		"forge_propose",
		{
			title: "Forge proposal",
			description:
				"Propose a General Agent draft to the user on the General Agents page — talk-to-build. Name it and give any of: description, charter, vibr, skills, memory, lineage, thinking, personality, habitat, extra (YAML for the manifest keys the profile does not draw). The draft appears on the agent's profile marked as proposed by the Machinist; the user accepts it, changes it, and saves it. Nothing is written by this call. A proposal cannot set anything that grants — the agent's tools, approval gate, workspace, control lanes, plugins, MCP servers, delegation or harness: only the user sets those, on the profile.",
			inputSchema: proposalShape,
			_meta: { ui: { resourceUri: FORGE_VIEW_URI } },
		},
		async proposal => {
			// The SCHEMA is the guard for fields: `proposalShape` declares no `tools`, no
			// `mcp`, no `approval`, no `autonomy`, and the SDK strips undeclared keys
			// before this runs. `extra` is free text, so it is read here, twice: as text
			// (the lines the View can also place) and as the YAML it parses to (the keys
			// the engine will read, whatever their spelling). A grant-class key in
			// either refuses the whole proposal, and so does YAML that is not a mapping.
			if (proposal.extra !== undefined) {
				const textual = grantPathsIn(proposal.extra);
				if (textual.length > 0) {
					return fail(`A proposal cannot set ${textual.join(", ")}: those grant the agent something, so only the user sets them, in the Forge. Propose the rest.`);
				}
				let parsed: unknown;
				try {
					parsed = parseYaml(proposal.extra);
				} catch (error) {
					return fail(`extra is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) return fail("extra must be a YAML mapping: one `key: value` per line.");
				const resolved = grantPathsInDocument(parsed);
				if (resolved.length > 0) {
					return fail(`A proposal cannot set ${resolved.join(", ")}: those grant the agent something, so only the user sets them, in the Forge. Propose the rest.`);
				}
			}
			const proposed: ForgeProposed = { view: "proposal", proposal };
			const fields = Object.keys(proposal).filter(field => field !== "name");
			return json(
				proposed,
				`Proposed ${proposal.name} on the General Agents page${fields.length > 0 ? ` (${fields.join(", ")})` : ""}. The user accepts or discards it there; nothing is written until they save it. Anything that grants — tools, the approval gate, workspace, control lanes — is theirs to set.`,
			);
		},
	);

	// ── the View's doors (App-only) ─────────────────────────────────────────
	server.registerTool(
		"list_agents",
		{ description: "Every General Agent the Forge can see — installed packs', the user's own, the workspace's — each with its tier and marked editable or read-only.", inputSchema: {}, annotations: READ_ONLY, _meta: APP_ONLY },
		async (_args, extra) => {
			const listing = await listAgents(rootsOf(extra));
			return json(listing, `${listing.agents.length} agents`);
		},
	);

	server.registerTool(
		"list_parts",
		{ description: "The skills, MCP servers, tool names and memory backends the profile can offer, with where each list was read and what could not be.", inputSchema: {}, annotations: READ_ONLY, _meta: APP_ONLY },
		async (_args, extra) => {
			const roots = rootsOf(extra);
			const { agents } = await listAgents(roots);
			const listing = await listParts({ workspace: roots.workspace, pluginsDir: paths?.plugins ?? null, agentDir: paths?.agent ?? null, agents });
			return json(listing, `${listing.parts.length} parts`);
		},
	);

	server.registerTool(
		"validate_agent",
		{
			description: "Whether the draft would save: its own problems, then whether the agent.md it writes loads as a General Agent. Writes nothing.",
			inputSchema: { draft: draftSchema },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		async ({ draft }) => {
			const rendered = renderDraft(draft, join(draft.name, "agent.md"));
			const check: DraftCheck = { problems: "problems" in rendered ? rendered.problems : [] };
			return json(check, check.problems.length === 0 ? "It would save." : check.problems.join(" "));
		},
	);

	server.registerTool(
		"save_agent",
		{
			description: `Write the draft. \`create: true\` writes a NEW agent into the user's own agents (\`$INSO_HOME/agent/agents/<name>/agent.md\`, where it gets a home) and refuses a name that is taken anywhere. \`create: false\` rewrites the agent of that name in \`tier\` (\`user\`, or \`workspace\`: <workspace>/${WRITE_DIR}/agents), and is refused unless \`revision\` is the one list_agents gave — the file changed since, otherwise. The merged agent.md must load as a General Agent or nothing is written.`,
			inputSchema: { draft: draftSchema, create: z.boolean(), tier: z.enum(["workspace", "user"]).optional(), revision: z.string().max(64).optional() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: APP_ONLY,
		},
		async ({ draft, create, tier, revision }, extra) => {
			let target: SaveTarget;
			if (create) target = { create: true };
			else if (tier !== undefined && revision !== undefined) target = { create: false, tier, revision };
			else return fail("Rewriting an agent names its tier and its revision — both come from list_agents.");
			try {
				const outcome = await saveAgent({ roots: rootsOf(extra), draft, target });
				return json(outcome, `Wrote ${outcome.relativePath}`);
			} catch (error) {
				if (error instanceof SaveRefused) return fail(error.message);
				throw error;
			}
		},
	);

	server.registerTool(
		"agent_home",
		{
			description: "An agent's home: its id (home-<name>), its folder under the engine's workspaces, whether the engine registers it, the memory room it follows, and its standing instructions — every AGENTS.md OMP looks at, which one wins, what it holds, and the `revision` of the file a save would write (`save_instructions` needs it). Works for a name that does not exist yet (the user tier, where new agents land).",
			inputSchema: { name: agentName },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		async ({ name }, extra) => {
			const home = await describeHome(rootsOf(extra), name);
			return json(home, `${name}: ${home.homeNote}`);
		},
	);

	server.registerTool(
		"save_instructions",
		{
			description: "Write an agent's standing instructions: its home AGENTS.md once the home folder exists, otherwise the AGENTS.md beside its agent.md (which seeds the home on its first provisioning). Only for a user or workspace agent the Forge may edit; the path is derived, never given. `revision` is the target's revision from agent_home: the write is refused unless the file still holds what it held then and the home has not been set up since (a save would land elsewhere) — reopen, so nothing written meanwhile is lost.",
			inputSchema: { name: agentName, text: z.string().max(INSTRUCTIONS_MAX_BYTES), revision: z.string().max(64) },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: APP_ONLY,
		},
		async ({ name, text, revision }, extra) => {
			try {
				const saved = await saveInstructions(rootsOf(extra), name, text, revision);
				return json(saved, `Wrote ${saved.path}`);
			} catch (error) {
				if (error instanceof SaveRefused) return fail(error.message);
				throw error;
			}
		},
	);

	return server;
}
