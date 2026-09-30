// One agent's profile — what a card opens, and where a new agent is made. The
// header says who it is (its live face, its name, what it is for, which tier it
// lives in and where it stands) and holds the page's one action (Save changes,
// Create agent, or — for a pack's agent — Extend as a new agent) beside the
// host's two switches. Below, every part of the agent in titled cards, each a
// list of facts edited in place: Identity, Charter, Standing instructions,
// Home, Memory, Capabilities, Brain, Safety & access, Lineage, Advanced.
//
// A key that GRANTS the agent something is marked "only you can change this":
// the Machinist's proposals never touch one (`profile-state.ts`).

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
import { AgentFace, errorText, LABEL } from "./chrome";
import { faceLabel, faceOf, WEARABLE } from "./faces";
import type { ForgeBackend } from "./forge-client";
import { ChipList, ChipPicker, Fact, GrantMark, HeldValue, Panel } from "./profile-parts";
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
import { displayName, extraList, extraScalar, heldAvatar, standingOf, TIER_LABEL } from "./roster";

// ── words ───────────────────────────────────────────────────────────────────

const PERSONALITY_LABEL: Readonly<Record<Personality, string>> = {
	default: "The host's default",
	friendly: "Friendly",
	pragmatic: "Pragmatic",
	none: "None",
};
const PROMPT_LABEL: Readonly<Record<PromptMode, string>> = {
	replace: "Speaks only as itself",
	append: "Builds on the default agent",
};
const THINKING_LABEL: Readonly<Record<Thinking, string>> = {
	inherit: "The host's default",
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Maximum",
};
const APPROVAL_LABEL: Readonly<Record<ApprovalSetting, string>> = {
	"always-ask": "Ask before every action",
	write: "Ask before it changes anything",
	yolo: "Never ask — reversible work only",
	inherit: "The host's own approval mode",
};
const HABITAT_LABEL: Readonly<Record<Habitat, string>> = {
	bound: "Where it is opened",
	home: "Its own home",
	ephemeral: "A scratch worktree each session",
};
const MEMORY_LABEL: Readonly<Record<MemoryBackend, string>> = {
	inherit: "The host's default",
	engram: "Engram",
	local: "Local",
	hindsight: "Hindsight",
	mnemopi: "Mnemopi",
	off: "Off — it forgets between sessions",
};
const REACH_LABEL: Readonly<Record<MemoryScope, string>> = { project: "This project", global: "Every project" };
const FILE_KIND: Readonly<Record<InstructionFile["kind"], string>> = {
	"workspace-copy": "This project's copy",
	home: "Its home",
	pack: "Shipped with its pack",
	"agent-dir": "Beside agent.md",
};
/** The lanes an agent holds when its manifest names none (`control-scope.ts`). */
const DEFAULT_LANES = ["observe", "create", "steer", "command"] as const;

function fileState(file: InstructionFile): string {
	if (file.wins) return file.bytes === 0 && file.exists ? "In force · empty" : "In force";
	if (!file.exists) return "Not there";
	if (file.kind === "home" && file.bytes === 0) return "Empty — skipped";
	return "Shadowed";
}

/** Where its recall reads (`memory-reach.ts`): its room, its home room, the global lane, or every room. */
function memoryReads(draft: AgentDraft, held: ReadonlySet<string>, room: string | null): string[] {
	if (draft.memory === "off") return ["Nothing — memory is off for this agent."];
	if (!held.has("workspace.reach") && draft.memoryScope === "global") return ["Every project's room", "The global lane"];
	return [
		"The room of the project it works in",
		...(room !== null ? [`Its home room, ${room} — it follows the agent from project to project`] : []),
		"The global lane",
		...(held.has("workspace.reach") ? ["The rooms of the workspaces its reach lists"] : []),
	];
}

/** The well a face sits in: the hero card's wash and dot field, at profile size. */
const WELL_STYLE: CSSProperties = {
	background: [
		"radial-gradient(160px 120px at 50% 55%, color-mix(in oklab, var(--fr-text-3) 24%, transparent), transparent 72%)",
		"linear-gradient(to bottom, color-mix(in oklab, var(--fr-text-3) 7%, transparent), transparent)",
	].join(", "),
};

const MONO_PATH = "min-w-0 font-mono text-fr-xs text-fr-text-2 [overflow-wrap:anywhere]";

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

	// ── saving ───────────────────────────────────────────────────────────────
	const [attempted, setAttempted] = useState(false);
	const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(null);
	const errors = fieldErrors(state, agents);
	const shown = (field: keyof typeof errors) => (attempted || touched.has(field) ? errors[field] : undefined);
	const touch = (field: string) => setTouched(previous => new Set([...previous, field]));
	const blockers = saveBlockers(state, agents, serverProblems, userAgentsDir !== null);
	const dirty = isDirty(state);

	const save = async () => {
		setAttempted(true);
		if (blockers.length > 0) {
			setStatus({ tone: "error", text: blockers.length === 1 ? (blockers[0] ?? "") : `${blockers.length} things to fix first — ${blockers[0]}` });
			return;
		}
		const target = saveTargetOf(state);
		if (typeof target === "string") {
			setStatus({ tone: "error", text: target });
			return;
		}
		setSaving(true);
		setStatus(null);
		try {
			const outcome = await backend.save(draft, target);
			setStatus({
				tone: "info",
				text: backend.mode === "host" ? `Saved to ${outcome.path}` : `Saved in the preview only — nothing was written to ${outcome.relativePath}.`,
			});
			await onSaved(draft.name);
		} catch (cause) {
			setStatus({ tone: "error", text: `Not saved: ${errorText(cause)}` });
		} finally {
			setSaving(false);
		}
	};

	// A page that opens in place of the list says so to a keyboard: focus lands on the title.
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => heading.current?.focus(), [draft.key]);

	const title = creating ? draft.name || "New agent" : displayName({ name: draft.name, draft }, fact);
	const standing = agent === undefined ? null : standingOf(agent, fact);
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
	const heldFace = draft.vibr === "" ? heldAvatar(draft.extra) : null;

	return (
		<div data-slot="agent-profile" data-agent={draft.name} data-mode={creating ? "create" : locked ? "read-only" : "edit"} className="flex flex-col gap-6">
			<nav aria-label="Breadcrumb" className="-mb-1 flex min-w-0 items-center gap-1.75 text-fr-sm text-fr-text-3">
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

			{/* The header is its own container, and its grid is the child that
			    asks it: face beside the words from 36rem, the action column beside
			    both from 56rem, the action row under them below that. */}
			<header data-slot="profile-header" className="@container/head rounded-2xl border border-fr-border-soft bg-fr-surface/85">
				<div className="grid gap-x-6 gap-y-5 p-5 @xl/head:grid-cols-[10rem_minmax(0,1fr)] @4xl/head:grid-cols-[10rem_minmax(0,1fr)_16rem]">
				<div aria-hidden className="relative grid size-40 place-items-center overflow-hidden rounded-2xl border border-fr-border-soft @xl/head:row-span-2 @4xl/head:row-span-1" style={WELL_STYLE}>
					<span className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(color-mix(in_oklab,var(--fr-text-3)_28%,transparent)_1px,transparent_1px)] [background-size:14px_14px] [mask-image:radial-gradient(120px_90px_at_50%_55%,black,transparent_75%)]" />
					<AgentFace {...faceOf(draft)} size="xl" live />
				</div>
				<div className="flex min-w-0 flex-col gap-2 @xl/head:pt-1">
					<h1 ref={heading} tabIndex={-1} className="m-0 text-fr-2xl leading-tight font-semibold tracking-[-0.01em] text-fr-text [overflow-wrap:anywhere] focus-visible:outline-none">
						{title}
					</h1>
					<div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
						{draft.name !== "" && title !== draft.name ? <span className="font-mono text-fr-xs text-fr-text-2">{draft.name}</span> : null}
						<Badge tone="mute" variant="soft">
							{agent === undefined ? "New · yours" : TIER_LABEL[agent.source]}
						</Badge>
						{draft.lineage.length > 0 ? (
							<span className="text-fr-xs text-fr-text-2">Extends {draft.lineage.join(", ")}</span>
						) : null}
						{standing !== null ? (
							<span data-slot="profile-standing" className="flex items-center gap-1.5 text-fr-xs text-fr-text-2">
								<span aria-hidden className={cn("size-1.5 rounded-full", standing.tone === "ready" ? "bg-fr-add" : standing.tone === "idle" ? "bg-fr-text-3" : "hidden")} />
								{standing.label}
							</span>
						) : null}
					</div>
					<p className="m-0 max-w-[62ch] text-fr-base leading-relaxed text-pretty text-fr-text-2">
						{draft.description || (creating ? "Say in one line what it is for — under Identity." : "No description yet.")}
					</p>
					<p className={cn("m-0", MONO_PATH)} title={agent?.path}>
						{path}
					</p>
				</div>
				<div className="flex min-w-0 flex-col gap-3 @xl/head:col-start-2 @xl/head:max-w-80 @4xl/head:col-start-3 @4xl/head:row-start-1 @4xl/head:max-w-none">
					<PrimaryAction
						creating={creating}
						locked={locked}
						extendable={agent?.source === "pack"}
						dirty={dirty}
						saving={saving}
						onSave={() => void save()}
						onExtend={() => onExtend(draft)}
					/>
					<Switches backend={backend} name={agent?.name ?? null} fact={fact} onError={text => setStatus({ tone: "error", text })} />
					<p role="status" aria-live="polite" className={cn("m-0 min-h-4.5 text-fr-xs leading-snug text-pretty", status?.tone === "error" ? "text-fr-warn" : "text-fr-text-2")}>
						{status?.text ?? (dirty && !creating && !locked ? "Unsaved changes" : "")}
					</p>
				</div>
				</div>
			</header>

			{readOnly !== undefined ? (
				<div role="note" data-slot="profile-read-only" className="-mt-2 flex items-start gap-3 rounded-lg border border-fr-border-soft bg-fr-surface-2/70 px-4 py-3">
					<Icon name="lock" size={14} strokeWidth={1.9} className="mt-0.5 shrink-0 text-fr-text-2" />
					<p className="m-0 text-fr-sm leading-relaxed text-pretty text-fr-text-2">{readOnly}</p>
				</div>
			) : null}

			{proposal !== undefined ? (
				<div
					role="region"
					aria-label="Proposed by the Machinist"
					data-slot="profile-proposal"
					className="-mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-fr-accent-line bg-fr-accent-dim px-4 py-3"
				>
					<div className="flex min-w-0 flex-[1_1_24rem] items-start gap-3">
						<Icon name="spark" size={15} strokeWidth={1.9} className="mt-0.5 shrink-0 text-fr-accent" />
						<div className="flex min-w-0 flex-col gap-0.5">
							<span className="text-fr-sm font-semibold text-fr-text">Proposed by the Machinist</span>
							<span className="text-fr-xs leading-relaxed text-pretty text-fr-text-2">
								{proposal.fields.length > 0 ? `It changed ${proposal.fields.map(field => FIELD_WORD[field]).join(", ")} — marked below.` : "It named this agent."} Nothing
								is saved until you accept it and save. It cannot change tools, servers, the approval gate or where the agent lives.
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

			<div data-slot="profile-sections" className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
				<Panel title="Identity" lede="Who it is: its name, its face, and how it speaks." wide>
					<Fact label="Name" hint={creating ? "Its folder's name. It cannot change once the agent is created." : "Its folder's name — fixed once created."}>
						{creating ? (
							<Field error={shown("name")}>
								<Input
									value={draft.name}
									placeholder="release-herald"
									aria-label="Name"
									className="max-w-80 font-mono"
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
								onChange={event => set({ description: event.target.value.replace(/[\r\n]+/g, " ") })}
								onBlur={() => touch("description")}
							/>
						</Field>
					</Fact>
					<Fact label="Face" tall={!held.has("avatar")} proposed={proposed.has("vibr")} hint={heldFace === null ? "Its live vibr, wherever its sessions are drawn." : undefined}>
						{held.has("avatar") ? (
							<HeldValue>{heldFace === null ? "Its own face" : `${faceLabel(heldFace.id)}${heldFace.skin !== undefined ? ` · ${heldFace.skin}` : ""}`}</HeldValue>
						) : (
							<div className={cn("flex", locked && "pointer-events-none opacity-60")} aria-disabled={locked || undefined}>
								<AvatarSelect
									title="Its face"
									description="The vibr its sessions wear in the rail, the dock and the chat."
									value={faceOf(draft).avatar}
									onChange={id => set({ vibr: id })}
									options={WEARABLE.map(id => ({ id, label: faceLabel(id), preview: <AgentFace avatar={id} size={40} live={false} /> }))}
								/>
							</div>
						)}
					</Fact>
					<Fact label="Personality" proposed={proposed.has("personality")}>
						<Select
							value={draft.personality}
							disabled={locked}
							aria-label="Personality"
							className="max-w-80"
							options={PERSONALITIES.map(value => ({ value, label: PERSONALITY_LABEL[value] }))}
							onChange={event => set({ personality: event.target.value as Personality })}
						/>
					</Fact>
					<Fact
						label="Speaks as"
						hint={
							draft.promptMode === "replace"
								? "Its charter is its whole prompt — right for a CMO, a scribe, anything that is not a coder."
								: "Its charter follows the full default coding prompt — right for an agent that extends coding."
						}
					>
						<div className={cn("flex", locked && "pointer-events-none opacity-60")}>
							<Segmented options={["replace", "append"] as const} value={draft.promptMode} label={value => PROMPT_LABEL[value]} onChange={promptMode => set({ promptMode })} />
						</div>
					</Fact>
				</Panel>

				<Panel title="Charter" lede="The instructions it runs by — the body of its agent.md." wide>
					<Fact label="Charter" proposed={proposed.has("charter")}>
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
					</Fact>
				</Panel>

				<InstructionsPanel
					backend={backend}
					name={draft.name}
					exists={agent !== undefined}
					info={homeInfo}
					error={home !== null && home.name === draft.name ? home.error : null}
					onSaved={() => setHomeTick(tick => tick + 1)}
				/>

				<Panel title="Home" lede="The folder that follows it from project to project.">
					{homeInfo === null ? (
						<Fact label="Home">
							<span className="text-fr-sm text-fr-text-2">{draft.name === "" ? "Name it, and its home appears here." : home?.error ?? "Reading its home…"}</span>
						</Fact>
					) : (
						<>
							<Fact label="Id">
								{homeInfo.hasHome ? <span className="font-mono text-fr-sm text-fr-text">{homeInfo.homeId}</span> : <span className="text-fr-sm text-fr-text-2">No home</span>}
							</Fact>
							{homeInfo.folder !== null ? (
								<Fact label="Folder" hint={homeInfo.folderExists ? "The folder exists." : "Made the first time it is opened."}>
									<span className={MONO_PATH}>{homeInfo.folder}</span>
								</Fact>
							) : null}
							<Fact label="Stands there">
								<span className="text-fr-sm leading-relaxed text-pretty text-fr-text">
									{held.has("workspace.policy")
										? "It names its own workspace (set in Everything else) and stands there."
										: draft.habitat === "home"
											? "Yes — every session starts in its home."
											: `No — it only reads its home. Sessions start ${draft.habitat === "bound" ? "where it is opened" : "in a scratch worktree"}; its instructions and memory still follow it.`}
								</span>
							</Fact>
							<Fact label="Why">
								<span className="text-fr-sm leading-relaxed text-pretty text-fr-text-2">{homeInfo.homeNote}</span>
							</Fact>
						</>
					)}
				</Panel>

				<Panel title="Memory" lede="What it remembers, and how far its recall reaches.">
					<Fact label="Backend" proposed={proposed.has("memory")}>
						{held.has("memory.backend") ? (
							<HeldValue>{extraScalar(draft.extra, "memory.backend") ?? "Its own"}</HeldValue>
						) : (
							<Select
								value={draft.memory}
								disabled={locked}
								aria-label="Memory backend"
								className="max-w-80"
								options={MEMORY_BACKENDS.map(value => ({ value, label: MEMORY_LABEL[value] }))}
								onChange={event => set({ memory: event.target.value as MemoryBackend })}
							/>
						)}
					</Fact>
					<Fact
						label="Recall reach"
						grant
						hint={draft.memoryScope === "global" ? "Every project also lets its control tools reach every workspace — one grant (workspace.reach: all)." : undefined}
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
							{memoryReads(draft, held, homeInfo?.memoryRoom ?? null).map(line => (
								<li key={line} className="text-fr-sm leading-relaxed text-fr-text">
									{line}
								</li>
							))}
						</ul>
					</Fact>
					<Fact label="Namespace">
						<span className="text-fr-sm leading-relaxed text-pretty text-fr-text-2">
							{extraScalar(draft.extra, "memory.namespace") !== null ? (
								<>
									<span className="font-mono text-fr-text">{extraScalar(draft.extra, "memory.namespace")}</span> —{" "}
								</>
							) : null}
							Only the Mnemopi runtime isolates by namespace; Engram keeps an agent apart by its reach and its home room.
						</span>
					</Fact>
				</Panel>

				<Panel title="Capabilities" lede="What it can use. An empty list means everything of that kind." wide>
					<Fact label="Tools" grant>
						{held.has("capabilities.tools") ? (
							<HeldValue>{(extraList(draft.extra, "capabilities.tools") ?? []).length === 0 ? "No tools" : "Its own list"}</HeldValue>
						) : (
							<ChipPicker label="Tools" value={draft.tools} options={partsOf("tool")} empty="Every tool" free disabled={locked} onChange={tools => set({ tools })} />
						)}
					</Fact>
					<Fact label="Skills" proposed={proposed.has("skills")}>
						{held.has("capabilities.skills") ? (
							<HeldValue>Its own list</HeldValue>
						) : (
							<ChipPicker label="Skills" value={draft.skills} options={partsOf("skill")} empty="Every skill" free disabled={locked} onChange={skills => set({ skills })} />
						)}
					</Fact>
					<Fact label="MCP servers" grant>
						{held.has("capabilities.mcp") ? (
							<HeldValue>Its own list</HeldValue>
						) : (
							<ChipPicker label="MCP servers" value={draft.mcp} options={partsOf("mcp")} empty="Every server" free disabled={locked} onChange={mcp => set({ mcp })} />
						)}
					</Fact>
					<Fact label="Plugins" grant hint="Set in Everything else, under Advanced (capabilities.plugins).">
						<ChipList values={extraList(draft.extra, "capabilities.plugins") ?? []} empty="Every plugin" />
					</Fact>
				</Panel>

				<Panel title="Brain" lede="The models it runs on and how hard it thinks.">
					<Fact label="Models" hint={extraList(draft.extra, "engine.model") === null ? undefined : "First available wins. Set in Everything else (engine.model)."}>
						<ChipList values={extraList(draft.extra, "engine.model") ?? []} empty="The host's default models" />
					</Fact>
					<Fact label="Thinking" proposed={proposed.has("thinking")}>
						{held.has("engine.thinkingLevel") ? (
							<HeldValue>{extraScalar(draft.extra, "engine.thinkingLevel") ?? "Its own"}</HeldValue>
						) : (
							<Select
								value={draft.thinking}
								disabled={locked}
								aria-label="Thinking"
								className="max-w-80"
								options={THINKING_STEPS.map(value => ({ value, label: THINKING_LABEL[value] }))}
								onChange={event => set({ thinking: event.target.value as Thinking })}
							/>
						)}
					</Fact>
				</Panel>

				<Panel title="Safety & access" lede="What it may do without asking, and where it may act.">
					<Fact label="Approval" grant>
						{held.has("gate.approval") ? (
							<HeldValue>{extraScalar(draft.extra, "gate.approval") ?? "Its own"}</HeldValue>
						) : (
							<Select
								value={draft.approval}
								disabled={locked}
								aria-label="Approval"
								className="max-w-80"
								options={APPROVAL_SETTINGS.map(value => ({ value, label: APPROVAL_LABEL[value] }))}
								onChange={event => set({ approval: event.target.value as ApprovalSetting })}
							/>
						)}
					</Fact>
					<Fact
						label="Where it runs"
						grant
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
								className="max-w-80"
								options={HABITATS.map(value => ({
									value,
									label: HABITAT_LABEL[value],
									disabled: value === "home" && homeInfo !== null && !homeInfo.canStandAtHome,
								}))}
								onChange={event => set({ habitat: event.target.value as Habitat })}
							/>
						)}
					</Fact>
					<Fact label="Control lanes" grant hint="The Dimension Control verbs it holds. Set in Everything else (capabilities.control).">
						<ChipList values={extraList(draft.extra, "capabilities.control") ?? [...DEFAULT_LANES]} empty="None" />
					</Fact>
				</Panel>

				<Panel title="Lineage" lede="Agents whose settings it builds on. Its own always win; a charter is never inherited." wide>
					<Fact label="Extends" proposed={proposed.has("lineage")}>
						<ChipPicker
							label="Agents"
							value={draft.lineage}
							options={others.map(other => ({ id: other.name, hint: other.description }))}
							empty="Nothing — it stands on its own"
							disabled={locked}
							onChange={lineage => set({ lineage })}
						/>
					</Fact>
				</Panel>

				<Panel title="Advanced" lede="Every other key of its manifest, as YAML, and the agent.md that will be written." wide>
					<div className="grid min-w-0 gap-5 py-3.5 @3xl/panel:grid-cols-2">
						<div className="flex min-w-0 flex-col gap-2">
							<span className={cn(LABEL, "flex items-center gap-2")}>
								Everything else
								{proposed.has("extra") ? (
									<Badge tone="accent" variant="soft">
										Proposed
									</Badge>
								) : null}
							</span>
							<Textarea
								value={draft.extra}
								disabled={locked}
								resize="vertical"
								spellCheck={false}
								aria-label="Everything else — manifest keys the profile does not draw, as YAML"
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
							{grants.length > 0 ? (
								<span className="flex items-start gap-1.5 text-fr-xs leading-relaxed text-fr-text-2">
									<GrantMark />
									<span>
										— you are setting <span className="font-mono text-fr-text">{grants.join(", ")}</span>.
									</span>
								</span>
							) : null}
						</div>
						<div className="flex min-w-0 flex-col gap-2">
							<span className={LABEL}>agent.md</span>
							<pre
								aria-label="agent.md, as it will be written"
								className="m-0 max-h-96 min-h-56 overflow-auto rounded-[var(--fr-textarea-r)] border border-fr-border-soft bg-fr-bg px-3 py-2.5 font-mono text-fr-xs leading-relaxed text-fr-text-2"
							>
								{document.lines.map(line => line.text).join("\n")}
							</pre>
						</div>
					</div>
				</Panel>
			</div>
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
	memory: "the memory backend",
	lineage: "the lineage",
	thinking: "thinking",
	personality: "the personality",
	habitat: "where it runs",
	extra: "Everything else",
};

/** The page's one action. */
function PrimaryAction({
	creating,
	locked,
	extendable,
	dirty,
	saving,
	onSave,
	onExtend,
}: {
	readonly creating: boolean;
	readonly locked: boolean;
	readonly extendable: boolean;
	readonly dirty: boolean;
	readonly saving: boolean;
	readonly onSave: () => void;
	readonly onExtend: () => void;
}) {
	if (locked) {
		return extendable ? (
			<Button data-slot="profile-action" onClick={onExtend}>
				<Icon name="branch" strokeWidth={2} />
				Extend as a new agent
			</Button>
		) : null;
	}
	return (
		<Button data-slot="profile-action" loading={saving} loadingText={creating ? "Creating…" : "Saving…"} disabled={saving || (!creating && !dirty)} onClick={onSave}>
			{creating ? <Icon name="plus" strokeWidth={2} /> : <Icon name="check" strokeWidth={2.2} />}
			{creating ? "Create agent" : "Save changes"}
		</Button>
	);
}

/** Enabled and Show in rail — the host's own switches, flipped exactly as the
 *  Capabilities page flips them (`agents:configure`). Where the host does not
 *  lend them, or the agent is not saved yet, they say why instead of pretending. */
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
				? "This host does not lend these switches here — use Capabilities → General Agents."
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
		<label className="flex items-center justify-between gap-3 text-fr-sm text-fr-text">
			{label}
			<Switch data-slot={slot} aria-label={label} checked={checked} disabled={why !== null || busy} onCheckedChange={change} />
		</label>
	);
	return (
		<div data-slot="profile-switches" className="flex flex-col gap-2.5 rounded-lg border border-fr-border-soft px-3.5 py-3">
			{row("Enabled", fact?.enabled ?? name === null, value => void flip({ enabled: value }), "profile-enabled")}
			{row("Show in rail", (fact?.enabled ?? true) && (fact?.listed ?? name === null), value => void flip({ listed: value }), "profile-listed")}
			{why !== null ? <span className="text-fr-xs leading-snug text-pretty text-fr-text-2">{why}</span> : null}
		</div>
	);
}

/** Standing instructions: the agent-level AGENTS.md, resolved exactly as OMP
 *  resolves it, and the editor for the file a save writes (guarded by its revision). */
function InstructionsPanel({
	backend,
	name,
	exists,
	info,
	error,
	onSaved,
}: {
	readonly backend: ForgeBackend;
	readonly name: string;
	readonly exists: boolean;
	readonly info: AgentHome | null;
	readonly error: string | null;
	readonly onSaved: () => void;
}) {
	const loaded = info?.instructions.text ?? "";
	const [text, setText] = useState(loaded);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(null);
	useEffect(() => setText(loaded), [loaded, info?.instructions.target?.path]);
	const target = info?.instructions.target ?? null;
	const editable = exists && info !== null && info.instructions.editable && target !== null;
	const save = async () => {
		if (target === null) return;
		setSaving(true);
		try {
			const saved = await backend.saveInstructions(name, text, target.revision);
			setStatus({ tone: "info", text: `Saved to ${saved.path}` });
		} catch (cause) {
			setStatus({ tone: "error", text: `Not saved: ${errorText(cause)} What is on disk now has been reloaded.` });
		} finally {
			setSaving(false);
			onSaved();
		}
	};
	return (
		<Panel
			title="Standing instructions"
			lede="Its own AGENTS.md: how it always acts, in any project."
			wide
			aside={
				editable ? (
					<Button size="sm" variant="outline" loading={saving} disabled={saving || text === loaded} onClick={() => void save()}>
						Save instructions
					</Button>
				) : null
			}
		>
			{info === null ? (
				<Fact label="Files">
					<span className="text-fr-sm text-fr-text-2">{name === "" ? "Name it, and where its instructions live appears here." : error ?? "Reading its instructions…"}</span>
				</Fact>
			) : (
				<>
					<Fact label="Where it looks">
						<ol className="m-0 flex list-none flex-col gap-2 p-0">
							{info.instructions.files.map(file => (
								<li key={file.path} data-wins={file.wins || undefined} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5">
									<span className={cn("text-fr-sm", file.wins ? "font-medium text-fr-text" : "text-fr-text-2")}>{FILE_KIND[file.kind]}</span>
									<span className="row-span-2 self-center">
										{file.wins ? (
											<Badge tone="accent" variant="soft">
												{fileState(file)}
											</Badge>
										) : (
											<span className="font-secondary text-fr-2xs text-fr-text-3">{fileState(file)}</span>
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
							onChange={event => setText(event.target.value)}
						/>
						{status !== null ? (
							<span role="status" className={cn("text-fr-xs", status.tone === "error" ? "text-fr-warn" : "text-fr-text-2")}>
								{status.text}
							</span>
						) : null}
					</Fact>
				</>
			)}
		</Panel>
	);
}
