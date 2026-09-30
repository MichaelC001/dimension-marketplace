// One agent's profile: what a card opens, and where a new agent is made. The
// header says who it is (its live face, its name, what it is for, which tier it
// lives in and where its file is) and carries the host's two switches as a
// plain row, which say where it stands. Below, every part of the agent in
// titled panels, each a list of facts edited in place: Identity, Charter,
// Standing instructions, Home, Memory, Capabilities, Brain, Safety & access,
// Lineage, Advanced.
//
// ONE save. A sticky bar at the foot of the column appears only while something
// is unsaved, and saves all of it: the agent's file and, when edited, its
// standing instructions (AGENTS.md), each guarded by its revision. Its button
// names what it saves. A pack's agent saves nothing; its header offers Extend.
//
// A key that GRANTS the agent something carries the lock, explained once by the
// legend at the top: the Machinist's proposals never touch one (`profile-state.ts`).

import type { ViewAgentFact } from "@dimension/sdk/artifactory";
import { AvatarSelect } from "@fraym/ui/components/avatar-select";
import { Segmented } from "@fraym/ui/components/segmented";
import { Badge } from "@fraym/ui/elements/badge";
import { Button } from "@fraym/ui/elements/button";
import { Field } from "@fraym/ui/elements/field";
import { Input } from "@fraym/ui/elements/input";
import { Select } from "@fraym/ui/elements/select";
import { Switch } from "@fraym/ui/elements/switch";
import { Textarea } from "@fraym/ui/elements/textarea";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentDraft,
	APPROVAL_SETTINGS,
	type ApprovalSetting,
	HABITATS,
	type Habitat,
	heldByExtra,
	MEMORY_BACKENDS,
	type MemoryBackend,
	type MemoryScope,
	manifestDocument,
	NAME_RE,
	normalizeTypedName,
	PERSONALITIES,
	type Personality,
	type PromptMode,
	type ProposableField,
	THINKING_STEPS,
	type Thinking,
} from "../../src/agent-md";
import type { AgentHome, InstructionFile, ListedAgent, Part } from "../../src/contracts";
import { grantPathsIn } from "../../src/extra";
import { AgentFace, errorText, LABEL, PANEL } from "./chrome";
import { faceHue, faceLabel, faceOf, WEARABLE } from "./faces";
import type { ForgeBackend } from "./forge-client";
import { ChipList, ChipPicker, FIELD, Fact, GrantMark, HeldValue, Panel, ProposedBadge, STATUS_BADGE } from "./profile-parts";
import {
	acceptProposal,
	discardProposal,
	fieldErrors,
	isDirty,
	isNew,
	type ProfileState,
	saveBlockers,
	saveTargetOf,
} from "./profile-state";
import { displayName, extraList, extraScalar, heldAvatar, TIER_LABEL, titleOf } from "./roster";

// ── words ───────────────────────────────────────────────────────────────────

const PERSONALITY_LABEL: Readonly<Record<Personality, string>> = {
	default: "Dimension's default",
	friendly: "Friendly",
	pragmatic: "Pragmatic",
	none: "None",
};
/** A matched pair, named so neither choice echoes Lineage, which is a different mechanism. */
const PROMPT_LABEL: Readonly<Record<PromptMode, string>> = {
	replace: "Its charter only",
	append: "Its charter plus Dimension's defaults",
};
/** What the chosen way of speaking does, said for that choice alone. */
const PROMPT_HINT: Readonly<Record<PromptMode, string>> = {
	replace: "It is told its charter and nothing else.",
	append: "Dimension's default instructions come first, then its charter.",
};
const THINKING_LABEL: Readonly<Record<Thinking, string>> = {
	inherit: "Dimension's default",
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Maximum",
};
/** What the gate does, and nothing it cannot promise. */
const APPROVAL_LABEL: Readonly<Record<ApprovalSetting, string>> = {
	"always-ask": "Ask before everything",
	write: "Ask before writes",
	yolo: "Never ask",
	inherit: "Dimension's default",
};
const HABITAT_LABEL: Readonly<Record<Habitat, string>> = {
	bound: "Where it is opened",
	home: "Its own home",
	ephemeral: "A fresh scratch copy each session",
};
const MEMORY_LABEL: Readonly<Record<MemoryBackend, string>> = {
	inherit: "Dimension's default",
	engram: "Engram",
	local: "Local",
	hindsight: "Hindsight",
	mnemopi: "Mnemopi",
	off: "Off: it forgets between sessions",
};
/** The reach switch limits only OTHER projects' rooms (`memory-reach.ts`). */
const REACH_LABEL: Readonly<Record<MemoryScope, string>> = { project: "Not recalled", global: "Recalled" };
const FILE_KIND: Readonly<Record<InstructionFile["kind"], string>> = {
	"workspace-copy": "This project's copy",
	home: "Its home",
	pack: "Shipped with its pack",
	"agent-dir": "Beside agent.md",
};
/** The lanes an agent holds when its manifest names none (`control-scope.ts`). */
const DEFAULT_LANES = ["observe", "create", "steer", "command"] as const;
/** Each control lane as a person says it; a lane this page does not know reads as its id. */
const LANE_LABEL: Readonly<Record<string, string>> = {
	observe: "See sessions",
	create: "Start sessions",
	steer: "Message sessions",
	end: "End sessions",
	command: "Run commands",
	rooms: "Rooms",
	agents: "Manage agents",
};
const laneLabel = (lane: string): string => LANE_LABEL[lane] ?? lane;
/** Where a setting the profile does not draw is changed. */
const IN_ADVANCED = "Set in Other settings, under Advanced.";

function fileState(file: InstructionFile): string {
	if (file.wins) return file.bytes === 0 && file.exists ? "In force · empty" : "In force";
	if (!file.exists) return "Not there";
	if (file.kind === "home" && file.bytes === 0) return "Empty, skipped";
	return "Shadowed";
}

/** Where its recall reads (`memory-reach.ts`). This project's notes, its home's
 *  and the shared ones are always read; the reach switch adds only the OTHER
 *  projects' notes (or the workspaces a held reach lists). */
function memoryReads(draft: AgentDraft, held: ReadonlySet<string>, homeRoom: boolean): string[] {
	if (draft.memory === "off") return ["Nothing. Memory is off for this agent."];
	return [
		"Notes from this project",
		...(homeRoom ? ["Notes from its home"] : []),
		"Notes shared across all projects",
		...(held.has("workspace.reach")
			? ["Notes from the workspaces it lists"]
			: draft.memoryScope === "global"
				? ["Notes from every other project"]
				: []),
	];
}

/** The well a face sits in: a faint wash in the face's own colour when it pinned
 *  one (the card's rule), else a token neutral. */
function wellStyle(hue: string | undefined): CSSProperties {
	const wash = hue ?? "var(--fr-text-3)";
	return {
		background: [
			`radial-gradient(closest-side, color-mix(in oklab, ${wash} 22%, transparent), transparent)`,
			`linear-gradient(to bottom, color-mix(in oklab, ${wash} 6%, transparent), transparent)`,
		].join(", "),
	};
}

const MONO_PATH = "min-w-0 font-mono text-fr-xs text-fr-text-2 [overflow-wrap:anywhere]";

type Status = { readonly tone: "info" | "error"; readonly text: string };

// ── the page ────────────────────────────────────────────────────────────────

export function AgentProfile({
	backend,
	state,
	agents,
	parts,
	facts,
	userAgentsDir,
	onChange,
	onClose,
	onBack,
	onSaved,
	onExtend,
}: {
	readonly backend: ForgeBackend;
	readonly state: ProfileState;
	readonly agents: readonly ListedAgent[];
	readonly parts: readonly Part[];
	readonly facts: readonly ViewAgentFact[];
	/** Where new agents are written; null when the host did not say, and none can be created. */
	readonly userAgentsDir: string | null;
	readonly onChange: (next: ProfileState) => void;
	/** The profile has nothing left to show (a discarded proposal for a new agent). */
	readonly onClose: () => void;
	readonly onBack: () => void;
	readonly onSaved: (name: string) => Promise<void>;
	readonly onExtend: (base: AgentDraft) => void;
}) {
	const { draft, agent, readOnly, proposal } = state;
	const creating = isNew(state);
	const locked = readOnly !== undefined;
	/** The lock means "only you can change this": on an agent nobody can change
	 *  here it says nothing, so it is drawn only where it holds. */
	const grantable = !locked;
	const fact = agent === undefined ? undefined : facts.find(candidate => candidate.name === agent.name);
	const held = useMemo(() => heldByExtra(draft), [draft]);
	const proposed = useMemo(() => new Set<ProposableField>(proposal?.fields ?? []), [proposal]);
	const set = (patch: Partial<AgentDraft>) => onChange({ ...state, draft: { ...draft, ...patch } });

	// ── the server's reads: the home, and whether the merged file would load ──
	const [home, setHome] = useState<{ readonly name: string; readonly info: AgentHome | null; readonly error: string | null } | null>(null);
	const [homeTick, setHomeTick] = useState(0);
	useEffect(() => {
		if (!NAME_RE.test(draft.name)) {
			setHome(null);
			return;
		}
		let live = true;
		const timer = window.setTimeout(() => {
			backend.home(draft.name).then(
				info => live && setHome({ name: draft.name, info, error: null }),
				(cause: unknown) => live && setHome({ name: draft.name, info: null, error: errorText(cause) }),
			);
		}, 200);
		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [backend, draft.name, homeTick]);
	const homeInfo = home !== null && home.name === draft.name ? home.info : null;

	const signature = JSON.stringify(draft);
	const [serverCheck, setServerCheck] = useState<{ readonly signature: string; readonly problems: readonly string[] } | null>(null);
	useEffect(() => {
		if (locked) return;
		let live = true;
		const timer = window.setTimeout(() => {
			backend.validate(draft).then(
				check => live && setServerCheck({ signature, problems: check.problems }),
				() => {},
			);
		}, 350);
		return () => {
			live = false;
			window.clearTimeout(timer);
		};
		// `signature` is the draft serialised: this runs per edit, not per render.
	}, [backend, signature, locked]);
	const serverProblems = serverCheck !== null && serverCheck.signature === signature ? serverCheck.problems : [];

	// ── the standing instructions: the AGENTS.md a save writes, edited here ──
	const loadedInstructions = homeInfo?.instructions.text ?? "";
	const instructionsTarget = homeInfo?.instructions.target ?? null;
	const [instructions, setInstructions] = useState(loadedInstructions);
	useEffect(() => setInstructions(loadedInstructions), [loadedInstructions, instructionsTarget?.path]);
	const instructionsEditable = agent !== undefined && !locked && homeInfo !== null && homeInfo.instructions.editable && instructionsTarget !== null;

	// ── saving ───────────────────────────────────────────────────────────────
	const [attempted, setAttempted] = useState(false);
	const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<Status | null>(null);
	const errors = fieldErrors(state, agents);
	const shown = (field: keyof typeof errors) => (attempted || touched.has(field) ? errors[field] : undefined);
	const touch = (field: string) => setTouched(previous => new Set([...previous, field]));
	const blockers = saveBlockers(state, agents, serverProblems, userAgentsDir !== null);
	const agentDirty = !locked && isDirty(state);
	const instructionsDirty = instructionsEditable && instructions !== loadedInstructions;
	const dirty = agentDirty || instructionsDirty;

	const save = async () => {
		setAttempted(true);
		const target = agentDirty ? saveTargetOf(state) : null;
		if (agentDirty) {
			if (blockers.length > 0) {
				setStatus({ tone: "error", text: blockers.length === 1 ? (blockers[0] ?? "") : `${blockers.length} things to fix first. ${blockers[0]}` });
				return;
			}
			if (typeof target === "string") {
				setStatus({ tone: "error", text: target });
				return;
			}
		}
		setSaving(true);
		setStatus(null);
		const said: string[] = [];
		try {
			if (target !== null && typeof target !== "string") {
				try {
					const outcome = await backend.save(draft, target);
					said.push(backend.mode === "host" ? `Saved to ${outcome.path}.` : `Saved in the preview only. Nothing was written to ${outcome.relativePath}.`);
				} catch (cause) {
					setStatus({ tone: "error", text: `Not saved: ${errorText(cause)}` });
					return;
				}
			}
			if (instructionsDirty && instructionsTarget !== null) {
				try {
					const written = await backend.saveInstructions(draft.name, instructions, instructionsTarget.revision);
					said.push(`Instructions saved to ${written.path}.`);
				} catch (cause) {
					// The revision guard: what is on disk now is read back, never overwritten.
					setStatus({ tone: "error", text: `Instructions not saved: ${errorText(cause)} What is on disk now has been reloaded.` });
					setHomeTick(tick => tick + 1);
					if (target !== null) await onSaved(draft.name);
					return;
				}
				setHomeTick(tick => tick + 1);
			}
			if (target !== null) await onSaved(draft.name);
			setStatus({ tone: "info", text: said.join(" ") });
		} finally {
			setSaving(false);
		}
	};
	const saveLabel = creating
		? "Create agent"
		: agentDirty && instructionsDirty
			? "Save agent and instructions"
			: instructionsDirty
				? "Save instructions"
				: "Save agent";

	// A page that opens in place of the list says so to a keyboard: focus lands on the title.
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => heading.current?.focus(), [draft.key]);

	const title = draft.name === "" ? "New agent" : displayName({ name: draft.name, draft }, fact);
	/** Another agent, named the way its card names it; the id stays a tooltip. */
	const agentTitle = (id: string) => titleOf(id, agents, facts);
	const path =
		agent?.path ??
		(userAgentsDir === null
			? "Where your agents live is unknown here, so none can be created."
			: [userAgentsDir.replace(/[\\/]$/, ""), draft.name === "" ? "<name>" : draft.name, "agent.md"].join(userAgentsDir.includes("\\") ? "\\" : "/"));
	const others = agents.filter(candidate => candidate.name !== draft.name);
	const partsOf = (kind: Part["kind"]) => parts.filter(part => part.kind === kind).map(part => ({ id: part.id, hint: part.hint }));
	const homeId = homeInfo?.homeId ?? null;
	const document = useMemo(() => manifestDocument(draft, homeId), [draft, homeId]);
	const grants = grantPathsIn(draft.extra);
	const face = faceOf(draft);
	const heldFace = draft.vibr === "" ? heldAvatar(draft.extra) : null;
	const namespace = extraScalar(draft.extra, "memory.namespace");

	return (
		<div data-slot="agent-profile" data-agent={draft.name} data-mode={creating ? "create" : locked ? "read-only" : "edit"} className="flex flex-col gap-6">
			<div className="flex flex-col gap-4">
				<nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-fr-sm text-fr-text-3">
					<button
						type="button"
						data-slot="profile-back"
						onClick={onBack}
						className="shrink-0 rounded-sm text-fr-text-3 fr-t-colors hover:text-fr-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line"
					>
						General Agents
					</button>
					<Icon name="caretR" size={12} strokeWidth={2} aria-hidden="true" />
					<span className="min-w-0 fr-overflow text-fr-text">{title}</span>
				</nav>

				{/* The header is its own container: the face beside the words from 36rem, above them below it. */}
				<header data-slot="profile-header" className={cn("@container/head", PANEL)}>
					<div className="grid gap-x-6 gap-y-5 p-6 @xl/head:grid-cols-[10rem_minmax(0,1fr)]">
						<div aria-hidden className="grid size-40 place-items-center rounded-lg border border-fr-border-soft" style={wellStyle(faceHue(face))}>
							<AgentFace {...face} size="xl" live />
						</div>
						<div className="flex min-w-0 flex-col gap-2">
							<div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
								<h1
									ref={heading}
									tabIndex={-1}
									className="m-0 min-w-0 text-fr-2xl leading-tight font-semibold tracking-fr-tight text-fr-text [overflow-wrap:anywhere] focus-visible:outline-none"
								>
									{title}
								</h1>
								{locked && agent?.source === "pack" ? (
									<Button data-slot="profile-extend" variant="outline" onClick={() => onExtend(draft)}>
										<Icon name="branch" strokeWidth={2} />
										Extend as a new agent
									</Button>
								) : null}
							</div>
							<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
								<Badge tone="mute" variant="soft" className={STATUS_BADGE}>
									{agent === undefined ? "New · yours" : TIER_LABEL[agent.source]}
								</Badge>
								{draft.lineage.length > 0 ? (
									<span className="text-fr-xs text-fr-text-2" title={draft.lineage.join(", ")}>
										Extends {draft.lineage.map(agentTitle).join(", ")}
									</span>
								) : null}
							</div>
							<p className="m-0 max-w-prose text-fr-base leading-relaxed text-pretty text-fr-text-2">
								{draft.description || (creating ? "Say in one line what it is for, under Identity." : "No description yet.")}
							</p>
							<p className={cn("m-0", MONO_PATH)} title={agent?.path}>
								{path}
							</p>
							<Switches backend={backend} name={agent?.name ?? null} fact={fact} onError={text => setStatus({ tone: "error", text })} />
							{/* Outside an edit, what the last save or switch said. While something
							    is unsaved the save bar says it instead. */}
							<p
								role="status"
								aria-live="polite"
								data-slot="profile-status"
								className={cn("m-0 text-fr-xs leading-relaxed text-pretty empty:hidden", status?.tone === "error" ? "text-fr-warn" : "text-fr-text-2")}
							>
								{dirty ? "" : (status?.text ?? "")}
							</p>
						</div>
					</div>
				</header>

				{readOnly !== undefined ? (
					<div role="note" data-slot="profile-read-only" className={cn(PANEL, "flex items-center gap-3 px-4 py-3")}>
						<Icon name="lock" size={14} strokeWidth={1.9} className="shrink-0 text-fr-text-2" />
						<p className="m-0 text-fr-sm leading-relaxed text-pretty text-fr-text-2">{readOnly}</p>
					</div>
				) : (
					<p data-slot="profile-legend" className="m-0 flex items-center gap-2 text-fr-xs leading-relaxed text-fr-text-2">
						<Icon name="lock" size={12} strokeWidth={2} className="shrink-0 text-fr-text-2" aria-hidden="true" />
						The lock marks settings only you can change; the Machinist can suggest everything else.
					</p>
				)}

				{proposal !== undefined ? (
					<div
						role="region"
						aria-label="Proposed by the Machinist"
						data-slot="profile-proposal"
						className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-fr-accent-line bg-fr-accent-dim px-4 py-3"
					>
						<div className="flex min-w-0 flex-[1_1_24rem] items-start gap-3">
							<Icon name="spark" size={16} strokeWidth={1.9} className="shrink-0 text-fr-accent" />
							<div className="flex min-w-0 flex-col gap-1">
								<span className="text-fr-sm leading-none font-semibold text-fr-text">Proposed by the Machinist</span>
								<span className="text-fr-xs leading-relaxed text-pretty text-fr-text-2">
									{proposal.fields.length > 0 ? `It changed ${proposal.fields.map(field => FIELD_WORD[field]).join(", ")}, marked below.` : "It named this agent."}{" "}
									Nothing is saved until you accept it and save. It cannot change tools, servers, the approval gate or where the agent lives.
								</span>
							</div>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									const next = discardProposal(state);
									if (next === null) onClose();
									else onChange(next);
								}}
							>
								Discard
							</Button>
							<Button size="sm" variant="outline" onClick={() => onChange(acceptProposal(state))}>
								<Icon name="check" strokeWidth={2.2} />
								Accept
							</Button>
						</div>
					</div>
				) : null}
			</div>

			<div data-slot="profile-sections" className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
				<Panel title="Identity" lede="Who it is, what it is for, and how it speaks." wide>
					<Fact label="Id" hint="Its folder's name. It cannot change once the agent is created.">
						{creating ? (
							<Field error={shown("name")}>
								<Input
									value={draft.name}
									placeholder="release-herald"
									aria-label="Id"
									className={cn(FIELD, "font-mono")}
									onChange={event => set({ name: normalizeTypedName(event.target.value) })}
									onBlur={() => touch("name")}
								/>
							</Field>
						) : (
							<span className="font-mono text-fr-sm text-fr-text">{draft.name}</span>
						)}
					</Fact>
					<Fact label="Description" proposed={proposed.has("description")}>
						<Field error={shown("description")}>
							<Input
								value={draft.description}
								disabled={locked}
								placeholder="What it is for, in one line"
								aria-label="Description"
								className={cn(FIELD, "font-primary")}
								onChange={event => set({ description: event.target.value.replace(/[\r\n]+/g, " ") })}
								onBlur={() => touch("description")}
							/>
						</Field>
					</Fact>
					<Fact label="Face" tall={!held.has("avatar")} proposed={proposed.has("vibr")} hint={heldFace === null ? "How it looks in the rail and in its sessions." : undefined}>
						{held.has("avatar") ? (
							<HeldValue>{heldFace === null ? "Its own face" : `${faceLabel(heldFace.id)}${heldFace.skin !== undefined ? ` · ${heldFace.skin}` : ""}`}</HeldValue>
						) : (
							<div className={cn("flex", FIELD, locked && "pointer-events-none opacity-60")} aria-disabled={locked || undefined}>
								<AvatarSelect
									className="w-full [&>button]:w-full"
									title="Its face"
									description="The face its sessions wear in the rail, the dock and the chat."
									value={face.avatar}
									onChange={id => set({ vibr: id })}
									// The trigger's face slot is 2rem: the face is painted at that size.
									options={WEARABLE.map(id => ({ id, label: faceLabel(id), preview: <AgentFace avatar={id} size={32} live={false} /> }))}
								/>
							</div>
						)}
					</Fact>
					<Fact label="Personality" proposed={proposed.has("personality")}>
						<Select
							value={draft.personality}
							disabled={locked}
							aria-label="Personality"
							className={FIELD}
							options={PERSONALITIES.map(value => ({ value, label: PERSONALITY_LABEL[value] }))}
							onChange={event => set({ personality: event.target.value as Personality })}
						/>
					</Fact>
					<Fact label="Speaks as" hint={PROMPT_HINT[draft.promptMode]}>
						<div className={cn("flex", locked && "pointer-events-none opacity-60")}>
							<Segmented options={["replace", "append"] as const} value={draft.promptMode} label={value => PROMPT_LABEL[value]} onChange={promptMode => set({ promptMode })} />
						</div>
					</Fact>
				</Panel>

				<Panel title="Charter" lede="Who it is and what its job is: the body of its agent.md." wide list={false} proposed={proposed.has("charter")}>
					<div className="py-4">
						<Field error={shown("charter")}>
							<Textarea
								value={draft.charter}
								disabled={locked}
								resize="vertical"
								spellCheck
								aria-label="Charter"
								placeholder={"You write the release notes.\n\n- Read what merged, never branch names.\n- One line per change."}
								className="max-h-none min-h-64 font-primary text-fr-sm leading-relaxed"
								onChange={event => set({ charter: event.target.value })}
								onBlur={() => touch("charter")}
							/>
						</Field>
					</div>
				</Panel>

				<InstructionsPanel
					name={draft.name}
					exists={agent !== undefined}
					info={homeInfo}
					error={home !== null && home.name === draft.name ? home.error : null}
					text={instructions}
					editable={instructionsEditable}
					onText={setInstructions}
				/>

				<Panel title="Home" lede="The folder that follows it from project to project.">
					{homeInfo === null ? (
						<Fact label="Home">
							<span className="text-fr-sm text-fr-text-2">{draft.name === "" ? "Give it an id, and its home appears here." : (home?.error ?? "Reading its home…")}</span>
						</Fact>
					) : (
						<>
							{/* The Id and Folder rows say what a plain home's note would; the
							    note stays only where it tells something they do not. */}
							<Fact label="Id" hint={homeInfo.hasHome && homeInfo.folder !== null ? undefined : homeInfo.homeNote}>
								{homeInfo.hasHome ? <span className="font-mono text-fr-sm text-fr-text">{homeInfo.homeId}</span> : <span className="text-fr-sm text-fr-text-2">No home</span>}
							</Fact>
							{homeInfo.folder !== null ? (
								<Fact label="Folder" hint={homeInfo.folderExists ? "The folder exists." : "Made the first time it is opened."}>
									<span className={MONO_PATH}>{homeInfo.folder}</span>
								</Fact>
							) : null}
						</>
					)}
				</Panel>

				<Panel title="Memory" lede="What it remembers, and how far its recall reaches.">
					<Fact label="Memory engine" proposed={proposed.has("memory")}>
						{held.has("memory.backend") ? (
							<HeldValue>{extraScalar(draft.extra, "memory.backend") ?? "Its own"}</HeldValue>
						) : (
							<Select
								value={draft.memory}
								disabled={locked}
								aria-label="Memory engine"
								className={FIELD}
								options={MEMORY_BACKENDS.map(value => ({ value, label: MEMORY_LABEL[value] }))}
								onChange={event => set({ memory: event.target.value as MemoryBackend })}
							/>
						)}
					</Fact>
					<Fact
						label="Other projects"
						grant={grantable}
						hint={draft.memoryScope === "global" && !held.has("workspace.reach") ? "Recalled also lets its control tools reach every workspace." : undefined}
					>
						{held.has("workspace.reach") ? (
							<HeldValue>The workspaces it lists</HeldValue>
						) : (
							<div className={cn("flex", (locked || draft.memory === "off") && "pointer-events-none opacity-60")}>
								<Segmented options={["project", "global"] as const} value={draft.memoryScope} label={value => REACH_LABEL[value]} onChange={memoryScope => set({ memoryScope })} />
							</div>
						)}
					</Fact>
					<Fact label="Reads from">
						<ul className="m-0 flex list-none flex-col gap-1 p-0">
							{memoryReads(draft, held, (homeInfo?.memoryRoom ?? null) !== null).map(line => (
								<li key={line} className="text-fr-sm leading-relaxed text-fr-text">
									{line}
								</li>
							))}
						</ul>
					</Fact>
					{namespace !== null ? (
						<Fact label="Namespace">
							<HeldValue>
								<span className="font-mono">{namespace}</span>
							</HeldValue>
						</Fact>
					) : null}
				</Panel>

				<Panel title="Capabilities" lede="What it can use. An empty list means everything of that kind." wide>
					<Fact label="Tools" grant={grantable}>
						{held.has("capabilities.tools") ? (
							<HeldValue>{(extraList(draft.extra, "capabilities.tools") ?? []).length === 0 ? "No tools" : "Its own list"}</HeldValue>
						) : (
							<ChipPicker label="Tools" noun="tools" value={draft.tools} options={partsOf("tool")} empty="Every tool" free disabled={locked} onChange={tools => set({ tools })} />
						)}
					</Fact>
					<Fact label="Skills" proposed={proposed.has("skills")}>
						{held.has("capabilities.skills") ? (
							<HeldValue>Its own list</HeldValue>
						) : (
							<ChipPicker label="Skills" noun="skills" value={draft.skills} options={partsOf("skill")} empty="Every skill" free disabled={locked} onChange={skills => set({ skills })} />
						)}
					</Fact>
					<Fact label="MCP servers" grant={grantable}>
						{held.has("capabilities.mcp") ? (
							<HeldValue>Its own list</HeldValue>
						) : (
							<ChipPicker label="MCP servers" noun="MCP servers" value={draft.mcp} options={partsOf("mcp")} empty="Every server" free disabled={locked} onChange={mcp => set({ mcp })} />
						)}
					</Fact>
					<Fact label="Plugins" grant={grantable} hint={IN_ADVANCED}>
						<ChipList values={extraList(draft.extra, "capabilities.plugins") ?? []} empty="Every plugin" />
					</Fact>
				</Panel>

				<Panel title="Brain" lede="The models it runs on and how hard it thinks.">
					<Fact label="Models" hint={extraList(draft.extra, "engine.model") === null ? IN_ADVANCED : `The first available one runs it. ${IN_ADVANCED}`}>
						<ChipList values={extraList(draft.extra, "engine.model") ?? []} empty="Dimension's default models" />
					</Fact>
					<Fact label="Thinking" proposed={proposed.has("thinking")}>
						{held.has("engine.thinkingLevel") ? (
							<HeldValue>{extraScalar(draft.extra, "engine.thinkingLevel") ?? "Its own"}</HeldValue>
						) : (
							<Select
								value={draft.thinking}
								disabled={locked}
								aria-label="Thinking"
								className={FIELD}
								options={THINKING_STEPS.map(value => ({ value, label: THINKING_LABEL[value] }))}
								onChange={event => set({ thinking: event.target.value as Thinking })}
							/>
						)}
					</Fact>
				</Panel>

				<Panel title="Safety & access" lede="What it may do without asking, and where it may act.">
					<Fact label="Approval" grant={grantable}>
						{held.has("gate.approval") ? (
							<HeldValue>{extraScalar(draft.extra, "gate.approval") ?? "Its own"}</HeldValue>
						) : (
							<Select
								value={draft.approval}
								disabled={locked}
								aria-label="Approval"
								className={FIELD}
								options={APPROVAL_SETTINGS.map(value => ({ value, label: APPROVAL_LABEL[value] }))}
								onChange={event => set({ approval: event.target.value as ApprovalSetting })}
							/>
						)}
					</Fact>
					<Fact
						label="Where it runs"
						grant={grantable}
						proposed={proposed.has("habitat")}
						hint={homeInfo !== null && !homeInfo.canStandAtHome ? "A project's own agent has no home to run in." : undefined}
					>
						{held.has("workspace.policy") ? (
							<HeldValue>{extraScalar(draft.extra, "workspace.id") ?? "Its own workspace"}</HeldValue>
						) : (
							<Select
								value={draft.habitat}
								disabled={locked}
								aria-label="Where it runs"
								className={FIELD}
								options={HABITATS.map(value => ({
									value,
									label: HABITAT_LABEL[value],
									disabled: value === "home" && homeInfo !== null && !homeInfo.canStandAtHome,
								}))}
								onChange={event => set({ habitat: event.target.value as Habitat })}
							/>
						)}
					</Fact>
					<Fact label="Can manage sessions" grant={grantable} hint={`What it may do to other sessions and agents. ${IN_ADVANCED}`}>
						<ChipList values={extraList(draft.extra, "capabilities.control") ?? [...DEFAULT_LANES]} empty="None" labelOf={laneLabel} />
					</Fact>
				</Panel>

				<Panel title="Lineage" lede="Agents whose settings it builds on. Its own always win; a charter is never inherited." wide>
					<Fact label="Extends" proposed={proposed.has("lineage")}>
						<ChipPicker
							label="Agents"
							noun="agents"
							value={draft.lineage}
							options={others.map(other => ({ id: other.name, hint: other.description }))}
							labelOf={agentTitle}
							empty="Nothing. It stands on its own."
							disabled={locked}
							onChange={lineage => set({ lineage })}
						/>
					</Fact>
				</Panel>

				<Panel title="Advanced" lede="Every other key of its manifest, as YAML, and the agent.md that will be written." wide list={false}>
					<div className="grid min-w-0 gap-5 py-4 @3xl/panel:grid-cols-2">
						<div className="flex min-w-0 flex-col gap-2">
							<span className={cn(LABEL, "flex items-center gap-2")}>
								Other settings
								{proposed.has("extra") ? <ProposedBadge /> : null}
							</span>
							<Textarea
								value={draft.extra}
								disabled={locked}
								resize="vertical"
								spellCheck={false}
								aria-label="Other settings: settings this page does not show, as YAML"
								placeholder={"title: Chief Marketing Officer\ncapabilities:\n  control: [agents]\nrouting:\n  card: Marketing questions"}
								className="max-h-none min-h-56 font-mono text-fr-xs leading-relaxed"
								onChange={event => set({ extra: event.target.value })}
							/>
							{document.problems.length > 0 || serverProblems.length > 0 ? (
								<ul role="alert" className="m-0 flex list-none flex-col gap-1 p-0">
									{[...document.problems, ...serverProblems].map(problem => (
										<li key={problem} className="text-fr-xs leading-relaxed text-fr-warn">
											{problem}
										</li>
									))}
								</ul>
							) : (
								<span className="text-fr-xs text-fr-text-2">Checked as you type: it loads as a General Agent.</span>
							)}
							{grants.length > 0 && grantable ? (
								<span className="flex items-baseline gap-2 text-fr-xs leading-relaxed text-fr-text-2">
									<GrantMark />
									<span>
										Only you can set these: <span className="font-mono text-fr-text">{grants.join(", ")}</span>.
									</span>
								</span>
							) : null}
						</div>
						<div className="flex min-w-0 flex-col gap-2">
							<span className={LABEL}>agent.md</span>
							<pre
								aria-label="agent.md, as it will be written"
								className="m-0 max-h-96 min-h-56 overflow-auto rounded-[var(--fr-textarea-r)] border border-fr-border-soft bg-fr-bg px-[var(--fr-textarea-px)] py-[var(--fr-textarea-py)] font-mono text-fr-xs leading-relaxed text-fr-text-2"
							>
								{document.lines.map(line => line.text).join("\n")}
							</pre>
						</div>
					</div>
				</Panel>
			</div>

			{dirty ? (
				<SaveBar
					label={saveLabel}
					creating={creating}
					saving={saving}
					status={status}
					onSave={() => void save()}
				/>
			) : null}
		</div>
	);
}

/** A proposable field, as the proposal banner names it. */
const FIELD_WORD: Readonly<Record<ProposableField, string>> = {
	name: "the name",
	description: "the description",
	charter: "the charter",
	vibr: "the face",
	skills: "the skills",
	memory: "the memory engine",
	lineage: "the lineage",
	thinking: "thinking",
	personality: "the personality",
	habitat: "where it runs",
	extra: "Other settings",
};

/** The profile's one save, pinned to the foot of the column while something is
 *  unsaved. Solid ground (it floats over the panels as it scrolls) with the
 *  faintest neutral lift DESIGN.md allows a popover. */
function SaveBar({
	label,
	creating,
	saving,
	status,
	onSave,
}: {
	readonly label: string;
	readonly creating: boolean;
	readonly saving: boolean;
	readonly status: Status | null;
	readonly onSave: () => void;
}) {
	const error = status?.tone === "error" ? status.text : null;
	return (
		<div
			role="region"
			aria-label="Unsaved changes"
			data-slot="profile-save-bar"
			className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-fr-border bg-fr-surface px-4 py-3 shadow-md"
		>
			<p role="status" aria-live="polite" className={cn("m-0 flex min-w-0 flex-[1_1_20rem] items-center gap-2 text-fr-sm leading-relaxed text-pretty", error !== null ? "text-fr-warn" : "text-fr-text-2")}>
				{error === null ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-fr-accent" /> : null}
				{error ?? (creating ? "A new agent. Nothing is written until you create it." : "Unsaved changes")}
			</p>
			<Button data-slot="profile-save" loading={saving} loadingText={creating ? "Creating…" : "Saving…"} disabled={saving} onClick={onSave}>
				{creating ? <Icon name="plus" strokeWidth={2} /> : <Icon name="check" strokeWidth={2.2} />}
				{label}
			</Button>
		</div>
	);
}

/** Enabled and Show in rail: the host's own switches, flipped exactly as the
 *  Capabilities page flips them (`agents:configure`), as a plain row in the
 *  header. Where the host does not lend them, or the agent is not saved yet,
 *  they say why instead of pretending. */
function Switches({
	backend,
	name,
	fact,
	onError,
}: {
	readonly backend: ForgeBackend;
	readonly name: string | null;
	readonly fact: ViewAgentFact | undefined;
	readonly onError: (message: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const offered = backend.visibility.offered();
	const why =
		name === null
			? "On and in the rail once it is created."
			: !offered
				? "This host does not lend these switches here. Use Capabilities, then General Agents."
				: fact === undefined
					? "The host has not listed it yet."
					: null;
	const flip = async (change: { enabled?: boolean; listed?: boolean }) => {
		if (name === null) return;
		setBusy(true);
		try {
			await backend.visibility.configure({ name, ...change });
		} catch (cause) {
			onError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};
	const row = (label: string, checked: boolean, change: (value: boolean) => void, slot: string) => (
		<label className="flex items-center gap-3 text-fr-sm text-fr-text">
			<Switch data-slot={slot} aria-label={label} checked={checked} disabled={why !== null || busy} onCheckedChange={change} />
			{label}
		</label>
	);
	return (
		<div data-slot="profile-switches" className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
			{row("Enabled", fact?.enabled ?? name === null, value => void flip({ enabled: value }), "profile-enabled")}
			{row("Show in rail", (fact?.enabled ?? true) && (fact?.listed ?? name === null), value => void flip({ listed: value }), "profile-listed")}
			{why !== null ? <span className="text-fr-xs leading-relaxed text-pretty text-fr-text-2">{why}</span> : null}
		</div>
	);
}

/** Standing instructions: the agent-level AGENTS.md, resolved exactly as OMP
 *  resolves it, and the editor for the file the profile's save writes. */
function InstructionsPanel({
	name,
	exists,
	info,
	error,
	text,
	editable,
	onText,
}: {
	readonly name: string;
	readonly exists: boolean;
	readonly info: AgentHome | null;
	readonly error: string | null;
	readonly text: string;
	readonly editable: boolean;
	readonly onText: (text: string) => void;
}) {
	return (
		<Panel title="Standing instructions" lede="House rules it follows in every project, kept in its own AGENTS.md." wide>
			{info === null ? (
				<Fact label="Files">
					<span className="text-fr-sm text-fr-text-2">{name === "" ? "Give it an id, and where its instructions live appears here." : (error ?? "Reading its instructions…")}</span>
				</Fact>
			) : (
				<>
					<Fact label="Where it looks">
						<ol className="m-0 flex list-none flex-col gap-2 p-0">
							{info.instructions.files.map(file => (
								<li key={file.path} data-wins={file.wins || undefined} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
									<span className={cn("text-fr-sm", file.wins ? "font-medium text-fr-text" : "text-fr-text-2")}>{FILE_KIND[file.kind]}</span>
									<span className="row-span-2 self-center">
										{file.wins ? (
											<Badge tone="accent" variant="soft" className={STATUS_BADGE}>
												{fileState(file)}
											</Badge>
										) : (
											<span className="font-secondary text-fr-xs text-fr-text-2">{fileState(file)}</span>
										)}
									</span>
									<span className={MONO_PATH} title={file.path}>
										{file.path}
									</span>
								</li>
							))}
						</ol>
					</Fact>
					<Fact label="Instructions" hint={info.instructions.note}>
						<Textarea
							value={text}
							disabled={!editable}
							resize="vertical"
							aria-label="Standing instructions (AGENTS.md)"
							placeholder={exists ? (editable ? "How this agent always acts, in any project…" : "") : "Create the agent first; then write how it always acts."}
							className="max-h-none min-h-32 font-primary text-fr-sm leading-relaxed"
							onChange={event => onText(event.target.value)}
						/>
					</Fact>
				</>
			)}
		</Panel>
	);
}
