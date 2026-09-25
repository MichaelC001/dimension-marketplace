// General Agents on disk: where they are read from, how a file becomes a Forge
// draft, and the one way a draft becomes a file.
//
// Classification is `@dimension/sdk/general-agent`'s `parseGeneralAgent` — the
// same function the engine's catalog uses (`general-agent-contributions.ts`),
// so a file this server lists or writes cannot be read differently there.
// Precedence mirrors that catalog too: workspace (`.inso/`, then legacy
// `.omp/`) before packs, first-wins by name.
import { randomBytes } from "node:crypto";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
	GENERAL_AGENT_FILE,
	GENERAL_AGENTS_DIR,
	type GeneralAgentDecl,
	parseGeneralAgent,
} from "@dimension/sdk/general-agent";
import {
	type AgentDraft,
	draftProblems,
	type Habitat,
	HABITATS,
	MEMORY_BACKENDS,
	type MemoryBackend,
	type Thinking,
	THINKING_STEPS,
	toAgentMd,
	VIBRS,
	type Vibr,
} from "./agent-md.js";
import type { AgentListing, ListedAgent, SaveOutcome } from "./contracts.js";

/**
 * The project config dir the Forge writes to — the ENGINE's own rule
 * (`getConfigDirName` in omp utils: `PI_CONFIG_DIR`, else `.inso` in the product),
 * because the General Agents catalog reads `<workspace>/<that dir>/agents`. A
 * hardcoded `.inso` wrote files a dev engine (`.inso-dev`) never listed. Then the
 * legacy dir it only reads.
 */
export const WRITE_DIR = process.env.PI_CONFIG_DIR?.trim() || ".inso";
const LEGACY_DIR = ".omp";

/**
 * Every installed plugin root under the engine's plugin store: the OMP store's
 * `node_modules/<name>` (npm, bundled and `plugins:link` junctions) plus each
 * marketplace install's `installPath` from `installed_plugins.json`. Installed
 * is not enabled — the pack agents it yields are listed for lineage and
 * reading, never for editing.
 */
export async function installedPluginRoots(pluginsDir: string): Promise<Map<string, string>> {
	const roots = new Map<string, string>();
	const modules = join(pluginsDir, "node_modules");
	for (const entry of await listDirs(modules)) {
		if (entry.startsWith("@")) {
			for (const scoped of await listDirs(join(modules, entry))) roots.set(`${entry}/${scoped}`, join(modules, entry, scoped));
		} else if (!entry.startsWith(".")) roots.set(entry, join(modules, entry));
	}
	try {
		const installed = JSON.parse(await readFile(join(pluginsDir, "installed_plugins.json"), "utf8")) as {
			plugins?: Record<string, readonly { installPath?: unknown }[]>;
		};
		for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
			const installPath = entries.find(entry => typeof entry.installPath === "string")?.installPath;
			if (typeof installPath === "string" && !roots.has(id)) roots.set(id, installPath);
		}
	} catch {
		// No marketplace installs yet: the registry file is created on the first.
	}
	return roots;
}

async function listDirs(dir: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	// A `plugins:link` install is a junction/symlink: it counts as a directory.
	return entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name);
}

// ── a file → a draft ────────────────────────────────────────────────────────

/** The manifest keys the Forge draws, per section. Anything else in a file is
 *  a setting the orrery cannot show and a save would drop. */
const MODELED: Readonly<Record<string, readonly string[] | null>> = {
	specVersion: null,
	extends: null,
	identity: ["personality", "prompt"],
	engine: ["model", "thinkingLevel"],
	capabilities: ["tools", "skills", "mcp"],
	gate: ["approval"],
	memory: ["backend", "vault"],
	workspace: ["policy", "id"],
};

function allowlist(value: string[] | "*" | undefined, key: string, unshown: string[]): string[] {
	if (value === "*") unshown.push(`${key}: "*"`);
	return Array.isArray(value) ? [...value] : [];
}

/**
 * The Forge draft for a parsed agent, plus every reason the draft would NOT
 * write the same agent back. An empty `unshown` means `toAgentMd(draft)`
 * re-parses to the same manifest (identity.prompt made explicit, an absent
 * avatar filled with the draft's vibr — both additive).
 */
export function draftFromDecl(decl: GeneralAgentDecl, key: string): { draft: AgentDraft; unshown: string[] } {
	const manifest = decl.manifest;
	const unshown: string[] = [];
	// The parser materialises absent keys as `undefined`; only a present value is a setting.
	for (const [section, value] of Object.entries(manifest)) {
		if (value === undefined) continue;
		if (!(section in MODELED)) {
			unshown.push(section);
			continue;
		}
		const keys = MODELED[section];
		if (keys === null || keys === undefined || typeof value !== "object" || value === null) continue;
		for (const [sub, setting] of Object.entries(value)) if (setting !== undefined && !keys.includes(sub)) unshown.push(`${section}.${sub}`);
	}

	const avatar = decl.avatar;
	let vibr: Vibr = "nebula";
	if (avatar !== undefined) {
		if ((VIBRS as readonly string[]).includes(avatar.id) && avatar.skin === undefined && avatar.accent === undefined) {
			vibr = avatar.id as Vibr;
		} else unshown.push(`avatar: ${avatar.id}${avatar.skin || avatar.accent ? " (skin/accent)" : ""}`);
	}

	const thinkingLevel = manifest.engine?.thinkingLevel;
	let thinking: Thinking = "inherit";
	if (thinkingLevel !== undefined) {
		if ((THINKING_STEPS as readonly string[]).includes(String(thinkingLevel)) && thinkingLevel !== "inherit") {
			thinking = thinkingLevel as Thinking;
		} else unshown.push(`engine.thinkingLevel: ${String(thinkingLevel)}`);
	}

	const backend = manifest.memory?.backend;
	let memory: MemoryBackend = "inherit";
	if (backend !== undefined) {
		if ((MEMORY_BACKENDS as readonly string[]).includes(backend) && backend !== "inherit") memory = backend as MemoryBackend;
		else unshown.push(`memory.backend: ${backend}`);
	}
	const vault = manifest.memory?.vault;
	if (vault !== undefined && !(vault === "global" && memory !== "off")) unshown.push(`memory.vault: ${vault}`);

	const policy = manifest.workspace?.policy;
	let habitat: Habitat = "bound";
	if (policy !== undefined) {
		if ((HABITATS as readonly string[]).includes(policy)) habitat = policy as Habitat;
		else unshown.push(`workspace.policy: ${policy}`);
	}
	const workspaceId = manifest.workspace?.id;
	if (workspaceId !== undefined && !(habitat === "home" && workspaceId === `agent-${decl.name}`)) {
		unshown.push(`workspace.id: ${workspaceId}`);
	}

	const approval = manifest.gate?.approval;
	// An absent approval INHERITS the host's; the Forge always writes one, and
	// the security field changes only by a human's hand — never as a side effect.
	if (approval === undefined) unshown.push("gate.approval (inherited)");
	if (decl.description.trim() === "") unshown.push("an empty description");
	if (decl.body.trim() === "") unshown.push("an empty charter");

	const draft: AgentDraft = {
		key,
		name: decl.name,
		description: decl.description,
		vibr,
		personality: manifest.identity?.personality ?? "default",
		promptMode: manifest.identity?.prompt ?? "replace",
		models: [...(manifest.engine?.model ?? [])],
		thinking,
		tools: allowlist(manifest.capabilities?.tools, "capabilities.tools", unshown),
		skills: allowlist(manifest.capabilities?.skills, "capabilities.skills", unshown),
		mcp: allowlist(manifest.capabilities?.mcp, "capabilities.mcp", unshown),
		memory,
		memoryScope: vault === "global" ? "global" : "project",
		approval: approval ?? "always-ask",
		habitat,
		lineage: [...(manifest.extends ?? [])],
		charter: decl.body,
	};
	return { draft, unshown };
}

// ── listing ─────────────────────────────────────────────────────────────────

interface Found {
	readonly name: string;
	readonly path: string;
	readonly decl: GeneralAgentDecl;
}

/** Every General Agent directly under `dir` (`<dir>/<name>/agent.md`). Loops
 *  and manifest-less files are ordinary residents and skipped silently; an
 *  agent an author got wrong is reported. */
async function scanAgents(dir: string, notices: string[]): Promise<Found[]> {
	const found: Found[] = [];
	for (const name of await listDirs(dir)) {
		const path = join(dir, name, GENERAL_AGENT_FILE);
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch {
			continue;
		}
		const parsed = parseGeneralAgent(content, path, name);
		if (parsed.ok) found.push({ name, path, decl: parsed.decl });
		else if (parsed.reason === "invalid") notices.push(`${path} is not a valid General Agent: ${parsed.errors.join("; ")}`);
	}
	return found;
}

export interface ListOptions {
	readonly workspace: string | null;
	/** The engine's plugin store (`$INSO_HOME/plugins`); null = unreachable. */
	readonly pluginsDir: string | null;
	/** Why `workspace` is null, when it is. */
	readonly workspaceMissing?: string;
}

export async function listAgents(options: ListOptions): Promise<AgentListing> {
	const notices: string[] = [];
	const agents: ListedAgent[] = [];
	const claimed = new Map<string, string>();
	const claim = (found: Found): boolean => {
		const winner = claimed.get(found.name);
		if (winner !== undefined) {
			notices.push(`${found.path} is shadowed by ${winner} (same name "${found.name}").`);
			return false;
		}
		claimed.set(found.name, found.path);
		return true;
	};

	if (options.workspace === null) notices.push(options.workspaceMissing ?? "No workspace is known, so no workspace agents are listed.");
	else {
		for (const dirName of [WRITE_DIR, LEGACY_DIR]) {
			for (const found of await scanAgents(join(options.workspace, dirName, "agents"), notices)) {
				if (!claim(found)) continue;
				const { draft, unshown } = draftFromDecl(found.decl, `workspace::${found.name}`);
				const legacy = dirName === LEGACY_DIR;
				const readOnlyReason = legacy
					? `It lives in the legacy ${LEGACY_DIR}/agents; the Forge writes only ${WRITE_DIR}/agents.`
					: unshown.length > 0
						? `It carries settings the Forge cannot show yet (${unshown.join(", ")}); saving here would drop them. Edit the file by hand.`
						: undefined;
				agents.push({
					name: found.name,
					description: found.decl.description,
					source: "workspace",
					path: found.path,
					editable: readOnlyReason === undefined,
					...(readOnlyReason !== undefined ? { readOnlyReason } : {}),
					draft,
				});
			}
		}
	}

	if (options.pluginsDir === null) notices.push("Pack agents are not listed: the engine did not tell this server where its plugins live (INSO_HOME is unset).");
	else {
		for (const [pack, root] of await installedPluginRoots(options.pluginsDir)) {
			for (const found of await scanAgents(join(root, GENERAL_AGENTS_DIR), notices)) {
				if (!claim(found)) continue;
				agents.push({
					name: found.name,
					description: found.decl.description,
					source: "pack",
					pack,
					path: found.path,
					editable: false,
					readOnlyReason: `It ships in the ${pack} pack. Extend it to make your own.`,
					draft: draftFromDecl(found.decl, `pack:${pack}:${found.name}`).draft,
				});
			}
		}
	}
	return { workspace: options.workspace, configDir: WRITE_DIR, agents, notices };
}

// ── a draft → a file ────────────────────────────────────────────────────────

/** A refusal `save_agent` reports verbatim; nothing was written. */
export class SaveRefused extends Error {
	override readonly name = "SaveRefused";
}

export interface SaveOptions {
	readonly workspace: string;
	readonly draft: AgentDraft;
	/** True: a new agent — refused when the name is taken. False: rewrite the
	 *  workspace agent of that name, which must exist and be editable. */
	readonly create: boolean;
	/** The names already taken beyond the workspace dir (pack agents). */
	readonly takenNames?: ReadonlySet<string>;
}

/**
 * Write one agent.md, atomically: the bytes are the View's own serializer's,
 * re-parsed with `parseGeneralAgent` BEFORE anything touches disk (it must be a
 * General Agent — never a Loop, never invalid), then written to a temp file
 * beside the target and renamed over it.
 */
export async function saveAgent(options: SaveOptions): Promise<SaveOutcome> {
	const { workspace, draft, create } = options;
	const problems = draftProblems(draft);
	if (problems.length > 0) throw new SaveRefused(problems.join(" "));

	const agentsDir = join(workspace, WRITE_DIR, "agents");
	const dir = join(agentsDir, draft.name);
	const path = join(dir, GENERAL_AGENT_FILE);
	const content = toAgentMd(draft);
	const parsed = parseGeneralAgent(content, path, draft.name);
	if (!parsed.ok) throw new SaveRefused(`The agent.md would not load as a General Agent (${parsed.reason}): ${parsed.errors.join("; ")}`);

	if (create) {
		if (options.takenNames?.has(draft.name)) {
			throw new SaveRefused(`An agent named "${draft.name}" already exists (a pack ships it). Pick another name.`);
		}
		if (existsSync(join(workspace, LEGACY_DIR, "agents", draft.name))) {
			throw new SaveRefused(`An agent named "${draft.name}" already exists in ${LEGACY_DIR}/agents. Pick another name.`);
		}
		await mkdir(agentsDir, { recursive: true });
		// Non-recursive: EEXIST is the collision check, atomic with the claim.
		try {
			await mkdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new SaveRefused(`${relative(workspace, dir).replaceAll("\\", "/")} already exists. Pick another name.`);
			}
			throw error;
		}
	} else {
		let existing: string;
		try {
			existing = await readFile(path, "utf8");
		} catch {
			throw new SaveRefused(`There is no ${relative(workspace, path).replaceAll("\\", "/")} to update. Forge it as a new agent.`);
		}
		const current = parseGeneralAgent(existing, path, draft.name);
		if (!current.ok) {
			throw new SaveRefused(
				current.reason === "loop"
					? `${draft.name} is a Loop, not a General Agent — the Forge does not rewrite Loops.`
					: `${draft.name}'s agent.md does not parse (${current.errors.join("; ")}); fix it by hand first.`,
			);
		}
		const { unshown } = draftFromDecl(current.decl, draft.key);
		if (unshown.length > 0) throw new SaveRefused(`${draft.name} carries settings the Forge cannot show (${unshown.join(", ")}); saving would drop them.`);
	}

	const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		// A claimed-but-unwritten directory would block the next attempt at this name.
		if (create) await rm(dir, { recursive: true, force: true });
		throw error;
	}
	return { path, relativePath: relative(workspace, path).replaceAll("\\", "/"), created: create };
}
