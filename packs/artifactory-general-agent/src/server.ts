// The Forge as an MCP App (doc 45 §7): one View, two model-facing tools that
// carry it, three App-only tools the View reads and writes through.
//
// WHERE THE WORKSPACE COMES FROM. The engine spawns this server ONCE per
// engine process, from the PLUGIN's root (`plugin-servers.ts`: `cwd: entry.cwd
// ?? root`), and lends it to every session; its environment carries only the
// engine's home (`INSO_HOME`, `INSO_VAULT_DIR`, `INSO_ENV` — `app-host.ts`
// `engineHomeEnv`). A call's `_meta["ai.insodimension/session"]` names the
// session but not its workspace (`workspaceId` is reserved, never emitted). So
// neither the cwd nor any variable is the workspace, and the one party that
// knows it is the agent: `forge_open { workspace }` binds the session's
// workspace here, and every later call from that session — the model's or the
// View's, both stamped with the same session id — resolves against it.
// `DIMENSION_FORGE_WORKSPACE`, when set, is the fallback for a session that
// never named one (a harness spawning this over stdio from a checkout, a test).
//
// SECURITY (doc 58 §3). `capabilities.tools` and `gate.approval` change only by
// a human's gesture in the View. `forge_propose` — the model's only way to
// shape a draft — has neither field in its schema, and copies only the
// proposable fields out of what it is given; `save_agent` is App-only, so the
// model cannot write a file at all.
import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	APPROVALS,
	HABITATS,
	MEMORY_BACKENDS,
	MEMORY_SCOPES,
	NAME_RE,
	PERSONALITIES,
	PROMPT_MODES,
	THINKING_STEPS,
	VIBRS,
} from "./agent-md.js";
import type { ForgeOpened, ForgeProposed } from "./contracts.js";
import { listParts } from "./parts.js";
import { listAgents, SaveRefused, saveAgent } from "./store.js";

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
	vibr: z.enum(VIBRS),
	personality: z.enum(PERSONALITIES),
	promptMode: z.enum(PROMPT_MODES),
	models: names,
	thinking: z.enum(THINKING_STEPS),
	tools: names,
	skills: names,
	mcp: names,
	memory: z.enum(MEMORY_BACKENDS),
	memoryScope: z.enum(MEMORY_SCOPES),
	approval: z.enum(APPROVALS),
	habitat: z.enum(HABITATS),
	lineage: z.array(agentName).max(16),
	charter: z.string().max(40_000),
});

/** `forge_propose`'s schema: the proposable fields and NOTHING else. */
const proposalShape = {
	name: agentName.describe("the agent's name: lowercase letters, digits, dashes"),
	description: z.string().max(400).optional().describe("one line: what it is for"),
	charter: z.string().max(40_000).optional().describe("the instructions it runs by (the agent.md body), markdown"),
	vibr: z.enum(VIBRS).optional().describe("the body it wears"),
	skills: names.optional().describe("skill allowlist; omit to keep every skill"),
	mcp: names.optional().describe("MCP server allowlist; omit to keep every server"),
	memory: z.enum(MEMORY_BACKENDS).optional(),
	lineage: z.array(agentName).max(16).optional().describe("agents whose brain it extends"),
	thinking: z.enum(THINKING_STEPS).optional(),
	personality: z.enum(PERSONALITIES).optional(),
	habitat: z.enum(HABITATS).optional().describe("bound: where opened; home: its own workspace; ephemeral: a scratch worktree"),
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
	/** Defaults to `process.env`: `INSO_HOME` locates the plugin store and the
	 *  user's skills; `DIMENSION_FORGE_WORKSPACE` is the fallback workspace. */
	readonly env?: NodeJS.ProcessEnv;
}

export async function createForgeServer(options: ForgeServerOptions = {}): Promise<McpServer> {
	const env = options.env ?? process.env;
	const home = env.INSO_HOME !== undefined && env.INSO_HOME !== "" ? env.INSO_HOME : null;
	const pluginsDir = home === null ? null : join(home, "plugins");
	const agentDir = home === null ? null : join(home, "agent");
	const fallback = env.DIMENSION_FORGE_WORKSPACE !== undefined && isDirectory(env.DIMENSION_FORGE_WORKSPACE) ? resolve(env.DIMENSION_FORGE_WORKSPACE) : null;
	/** Session id → the workspace its agent named in `forge_open`. */
	const workspaces = new Map<string, string>();
	const workspaceOf = (session: string) => workspaces.get(session) ?? fallback;
	const NO_WORKSPACE = "No workspace yet: ask the agent to open the Forge — it names the workspace it is working in.";

	const server = new McpServer({ name: "dimension-community-general-agent", version: "0.1.0" });
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
			description:
				"Open the Forge in the artifact view: every General Agent in the workspace (and the ones installed packs ship) as a constellation the user can open, reshape and forge — or one agent, by name. Pass `workspace`: the absolute path of the directory you are working in; the Forge reads and writes `<workspace>/.inso/agents/<name>/agent.md` there. It writes nothing itself — the user forges.",
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
			const root = workspaceOf(session);
			const listing = await listAgents({ workspace: root, pluginsDir, ...(root === null ? { workspaceMissing: NO_WORKSPACE } : {}) });
			const found = agent === undefined ? undefined : listing.agents.find(candidate => candidate.name === agent);
			const opened: ForgeOpened = { view: "forge", agent: found?.name ?? null, workspace: root };
			const where = root === null ? "no workspace (pass `workspace`)" : root;
			const text =
				agent !== undefined && found === undefined
					? `No General Agent named "${agent}" in ${where}; the Forge opened on the constellation (${listing.agents.length} agents).`
					: found !== undefined
						? `The Forge opened on ${found.name} (${found.editable ? "editable" : "read-only"}) in ${where}.`
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
				"Propose a General Agent draft to the user in the Forge — talk-to-build. Name it and give any of: description, charter, vibr, skills, mcp, memory, lineage, thinking, personality, habitat. The draft appears in the Forge marked as proposed by the workshop; the user accepts it, changes it, and forges it. Nothing is written by this call. A proposal cannot set the agent's tools or its approval gate — only the user sets those, in the Forge.",
			inputSchema: proposalShape,
			_meta: { ui: { resourceUri: FORGE_VIEW_URI } },
		},
		async proposal => {
			// The SCHEMA is the guard: `proposalShape` declares no `tools`, no
			// `approval`, no `autonomy`, and the SDK strips undeclared keys before
			// this runs — so what arrives here is only ever proposable.
			const proposed: ForgeProposed = { view: "proposal", proposal };
			const fields = Object.keys(proposal).filter(field => field !== "name");
			return json(
				proposed,
				`Proposed ${proposal.name} to the Forge${fields.length > 0 ? ` (${fields.join(", ")})` : ""}. The user accepts or discards it there; nothing is written until they forge it. Tools and the approval gate are theirs to set.`,
			);
		},
	);

	// ── the View's doors (App-only) ─────────────────────────────────────────
	server.registerTool(
		"list_agents",
		{ description: "The workspace's General Agents plus the ones installed packs ship, each marked editable or read-only.", inputSchema: {}, annotations: READ_ONLY, _meta: APP_ONLY },
		async (_args, extra) => {
			const root = workspaceOf(sessionOf(extra));
			const listing = await listAgents({ workspace: root, pluginsDir, ...(root === null ? { workspaceMissing: NO_WORKSPACE } : {}) });
			return json(listing, `${listing.agents.length} agents`);
		},
	);

	server.registerTool(
		"list_parts",
		{ description: "The skills, MCP servers, tool names and memory backends the tray can offer, with where each list was read and what could not be.", inputSchema: {}, annotations: READ_ONLY, _meta: APP_ONLY },
		async (_args, extra) => {
			const root = workspaceOf(sessionOf(extra));
			const { agents } = await listAgents({ workspace: root, pluginsDir });
			const listing = await listParts({ workspace: root, pluginsDir, agentDir, agents });
			return json(listing, `${listing.parts.length} parts`);
		},
	);

	server.registerTool(
		"save_agent",
		{
			description: "Write the draft to <workspace>/.inso/agents/<name>/agent.md. `create: true` refuses a name that is taken; `create: false` rewrites an existing editable workspace agent.",
			inputSchema: { draft: draftSchema, create: z.boolean() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: APP_ONLY,
		},
		async ({ draft, create }, extra) => {
			const root = workspaceOf(sessionOf(extra));
			if (root === null) return fail(NO_WORKSPACE);
			try {
				const { agents } = await listAgents({ workspace: null, pluginsDir });
				const takenNames = new Set(agents.map(agent => agent.name));
				const outcome = await saveAgent({ workspace: root, draft, create, takenNames });
				return json(outcome, `Wrote ${outcome.relativePath}`);
			} catch (error) {
				if (error instanceof SaveRefused) return fail(error.message);
				throw error;
			}
		},
	);

	return server;
}
