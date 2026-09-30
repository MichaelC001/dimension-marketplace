import type { ViewAgentFact } from "@dimension/sdk/artifactory";
import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	type AgentDraft,
	type AgentProposal,
	APPROVAL_SETTINGS,
	type ApprovalSetting,
	applyProposal,
	blankDraft,
	draftProblems,
	HABITATS,
	type Habitat,
	heldByExtra,
	manifestDocument,
	type MemoryScope,
	NAME_RE,
	normalizeTypedName,
	PERSONALITIES,
	PROPOSABLE_FIELDS,
	THINKING_STEPS,
	type Thinking,
	VIBRS,
	type Vibr,
} from "../../src/agent-md";
import type { AgentHome, AgentListing, ListedAgent, Part, PartKind, PartListing, SaveTarget } from "../../src/contracts";
import type { ForgeBackend, ForgeEvent } from "./forge-client";
import { Instrument, Meter, Segments } from "./instruments";
import { attachPart, detachPart, hasPart, type Satellite } from "./model";
import { ExtraPanel, HomePanel, VisibilityInstruments } from "./panels";
import { VIBR_STYLES } from "./stage/palette";
import { NEW_AGENT_KEY, type OrbAgent, Stage, type StageEvents } from "./stage/stage";

const PART_MIME = "application/x-forge-part";

/** A tool result routed to this View, numbered so the same event twice is two events. */
export interface IncomingEvent {
	readonly event: ForgeEvent;
	readonly seq: number;
}

/** A workshop proposal the human has not yet accepted: what it changed, and
 *  the draft to go back to if they discard it (null = it started from nothing). */
interface PendingProposal {
	readonly fields: readonly string[];
	readonly before: AgentDraft | null;
}

type View =
	| { readonly kind: "constellation" }
	| {
			readonly kind: "forge";
			readonly draft: AgentDraft;
			readonly isNew: boolean;
			/** The listed agent being reforged; absent for a new one. Its tier and revision are what a save names. */
			readonly agent?: ListedAgent;
			/** Why this agent cannot be forged here, when it cannot. */
			readonly readOnly?: string;
			readonly proposal?: PendingProposal;
	  };

const TRAY_GROUPS: readonly { kind: PartKind; label: string; lede: string }[] = [
	{ kind: "tool", label: "Tools", lede: "Leave the orbit empty and it keeps every tool. Add one and it becomes an allowlist." },
	{ kind: "skill", label: "Skills", lede: "Playbooks it can load. Empty orbit = every skill." },
	{ kind: "mcp", label: "MCP", lede: "App servers it may call. Empty orbit = every server." },
	{ kind: "memory", label: "Memory", lede: "One memory well. Drop a new one to replace it." },
	{ kind: "lineage", label: "Lineage", lede: "Agents whose brain this one extends. Its own charter always wins." },
];

const THINKING_LABEL: Record<Thinking, string> = {
	inherit: "Inherit",
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Max",
};
const APPROVAL_LABEL: Record<ApprovalSetting, { label: string; hint: string }> = {
	"always-ask": { label: "Ask first", hint: "Asks before every action" },
	write: { label: "Ask on writes", hint: "Reads freely, asks before it changes anything" },
	yolo: { label: "Free", hint: "Never asks — only for reversible work" },
	inherit: { label: "Host's", hint: "Says nothing: the host's own approval mode applies until you pick one" },
};
/** The manifest path each part kind writes — a part cannot land where Everything else holds that key. */
const PART_PATH: Record<PartKind, string | null> = { tool: "capabilities.tools", skill: "capabilities.skills", mcp: "capabilities.mcp", memory: "memory.backend", lineage: null };
const TIER_LABEL = { pack: "Pack agent", user: "Your agent", workspace: "Project agent" } as const;
const TIER_SHORT = { pack: "pack", user: "yours", workspace: "project" } as const;
const PANEL_TABS = [
	{ id: "charter", label: "Charter" },
	{ id: "manifest", label: "agent.md" },
	{ id: "extra", label: "Everything else" },
	{ id: "home", label: "Home" },
] as const;
type PanelId = (typeof PANEL_TABS)[number]["id"];
const HABITAT_LABEL: Record<Habitat, { label: string; hint: string }> = {
	bound: { label: "Where opened", hint: "Runs in whichever workspace you open it in" },
	home: { label: "Own home", hint: "Always runs in its own managed workspace" },
	ephemeral: { label: "Scratch", hint: "A fresh throwaway worktree every session" },
};
/** The Recall toggle writes `workspace.reach`, so its hint names the whole grant. */
const RECALL_LABEL: Record<MemoryScope, { label: string; hint: string }> = {
	project: { label: "This project", hint: "Recalls this project, its own home and what you made global" },
	global: { label: "Every project", hint: "May recall across every project — and its control tools may reach every workspace (workspace.reach: all)" },
};
/** The manifest line ids each proposable field renders, so a proposal's lines are marked. */
const PROPOSAL_LINES: Record<(typeof PROPOSABLE_FIELDS)[number], readonly string[]> = {
	name: ["name"],
	description: ["description"],
	charter: ["body"],
	vibr: ["avatar"],
	skills: ["capabilities.skills"],
	mcp: ["capabilities.mcp"],
	memory: ["memory.backend"],
	lineage: ["extends"],
	thinking: ["engine.thinkingLevel"],
	personality: ["identity.personality"],
	habitat: ["workspace.policy", "workspace.id"],
	extra: [],
};

function orbOf(agent: ListedAgent, fact: ViewAgentFact | undefined): OrbAgent {
	const { draft } = agent;
	const families = [draft.tools, draft.skills, draft.mcp].filter(list => list.length > 0).length + (draft.memory === "inherit" ? 0 : 1);
	const status = fact === undefined ? undefined : !fact.enabled ? "off" : !fact.listed ? "hidden" : undefined;
	return { key: draft.key, name: draft.name, description: draft.description, vibr: draft.vibr, lineage: draft.lineage, rings: families, tier: TIER_SHORT[agent.source], ...(status !== undefined ? { status } : {}) };
}

function newKey(): string {
	return `draft-${Date.now().toString(36)}`;
}

export function ForgeApp({ backend, incoming }: { backend: ForgeBackend; incoming: IncomingEvent | null }) {
	const [listing, setListing] = useState<AgentListing | null>(null);
	const [partListing, setPartListing] = useState<PartListing | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [view, setView] = useState<View>({ kind: "constellation" });
	const [picking, setPicking] = useState(false);
	const [panelOpen, setPanelOpen] = useState(false);
	const [previewVibr, setPreviewVibr] = useState<Vibr | null>(null);
	const [selected, setSelected] = useState<Satellite | null>(null);
	const [trayKind, setTrayKind] = useState<PartKind>("tool");
	const [filter, setFilter] = useState("");
	const [panel, setPanel] = useState<PanelId>("manifest");
	const [dragKind, setDragKind] = useState<PartKind | null>(null);
	const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
	const [incantation, setIncantation] = useState("");
	const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
	const [saving, setSaving] = useState(false);
	/** An agent the model asked to open, waiting for the listing that has it. */
	const [pendingOpen, setPendingOpen] = useState<string | null>(null);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<Stage | null>(null);
	const agents = useMemo(() => listing?.agents ?? [], [listing]);
	/** The host's record of who is enabled and shown in the rail. */
	const facts = useSyncExternalStore(backend.visibility.subscribe, backend.visibility.read);
	const [home, setHome] = useState<{ name: string; info: AgentHome | null; error: string | null } | null>(null);
	const [serverCheck, setServerCheck] = useState<{ signature: string; problems: readonly string[] } | null>(null);

	const refresh = useCallback(async () => {
		try {
			const [nextAgents, nextParts] = await Promise.all([backend.listAgents(), backend.listParts()]);
			setListing(nextAgents);
			setPartListing(nextParts);
			setLoadError(null);
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : String(error));
		}
	}, [backend]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), notice.tone === "error" ? 9000 : 6500);
		return () => clearTimeout(timer);
	}, [notice]);

	const draft = view.kind === "forge" ? view.draft : null;
	const updateDraft = useCallback((change: (current: AgentDraft) => AgentDraft) => {
		setView(current => (current.kind === "forge" ? { ...current, draft: change(current.draft) } : current));
	}, []);

	/** The drawn keys Everything else holds: their orrery controls stand aside. */
	const held = useMemo(() => (draft ? heldByExtra(draft) : new Set<string>()), [draft]);
	const draftName = draft?.name ?? "";
	const [homeTick, setHomeTick] = useState(0);
	const inForge = view.kind === "forge";

	// The home the engine would give this name — id, folder, AGENTS.md tiers — asked of the server, never derived here.
	useEffect(() => {
		if (!inForge || !NAME_RE.test(draftName)) {
			setHome(null);
			return;
		}
		let live = true;
		const timer = setTimeout(() => {
			backend.home(draftName).then(
				info => live && setHome({ name: draftName, info, error: null }),
				error => live && setHome({ name: draftName, info: null, error: error instanceof Error ? error.message : String(error) }),
			);
		}, 200);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [backend, inForge, draftName, homeTick, listing]);

	// Whether the merged agent.md would load — the server's own verdict, live, so a YAML error shows before Forge it.
	const signature = draft ? JSON.stringify(draft) : "";
	useEffect(() => {
		if (!draft || draftProblems(draft).length > 0) {
			setServerCheck(null);
			return;
		}
		let live = true;
		const timer = setTimeout(() => {
			backend.validate(draft).then(
				check => live && setServerCheck({ signature, problems: check.problems }),
				() => {},
			);
		}, 350);
		return () => {
			live = false;
			clearTimeout(timer);
		};
		// `signature` is the draft, serialised: the effect runs per edit, not per render.
	}, [backend, signature]);

	const openListed = useCallback((agent: ListedAgent) => {
		setSelected(null);
		setPicking(false);
		setView({ kind: "forge", draft: { ...agent.draft }, isNew: false, agent, ...(agent.editable ? {} : { readOnly: agent.readOnlyReason ?? "This agent is read-only here." }) });
		setPanel("manifest");
	}, []);

	const openAgent = useCallback(
		(key: string) => {
			setSelected(null);
			setPicking(false);
			if (key === NEW_AGENT_KEY) {
				setView({ kind: "forge", draft: blankDraft(newKey()), isNew: true });
				setPanel("charter");
				return;
			}
			const agent = agents.find(candidate => candidate.draft.key === key);
			if (agent) openListed(agent);
		},
		[agents, openListed],
	);

	/** A read-only agent's way forward: a new agent that extends it. */
	const extendAgent = (base: AgentDraft) => {
		setView({ kind: "forge", draft: { ...blankDraft(newKey()), vibr: base.vibr, lineage: [base.name] }, isNew: true });
		setPanel("charter");
	};

	const backToConstellation = useCallback(() => {
		setPicking(false);
		setPreviewVibr(null);
		setSelected(null);
		setView({ kind: "constellation" });
	}, []);

	// ── what the agent sends: forge_open lands, forge_propose drafts ─────────

	const receiveProposal = useCallback(
		(proposal: AgentProposal) => {
			const fields = PROPOSABLE_FIELDS.filter(field => field !== "name" && proposal[field] !== undefined);
			setSelected(null);
			setPicking(false);
			setPanel("manifest");
			setView(current => {
				// The open draft is the one being talked about when it is this agent, or
				// a new one still without a name; otherwise the listed agent of that
				// name; otherwise a new agent.
				const listed = agents.find(agent => agent.name === proposal.name);
				let base: AgentDraft;
				let isNew: boolean;
				let agent: ListedAgent | undefined;
				let readOnly: string | undefined;
				let before: AgentDraft | null;
				if (current.kind === "forge" && (current.draft.name === proposal.name || (current.isNew && current.draft.name === ""))) {
					base = current.draft;
					isNew = current.isNew;
					agent = current.agent;
					readOnly = current.readOnly;
					before = current.proposal?.before ?? current.draft;
				} else if (listed !== undefined && listed.editable) {
					base = listed.draft;
					isNew = false;
					agent = listed;
					before = listed.draft;
				} else {
					base = blankDraft(newKey());
					isNew = true;
					before = null;
				}
				const merged = new Set([...(current.kind === "forge" ? (current.proposal?.fields ?? []) : []), ...fields]);
				return {
					kind: "forge",
					draft: applyProposal(base, proposal),
					isNew,
					...(agent !== undefined ? { agent } : {}),
					...(readOnly !== undefined ? { readOnly } : {}),
					proposal: { fields: [...merged], before },
				};
			});
		},
		[agents],
	);

	useEffect(() => {
		if (incoming === null) return;
		const { event } = incoming;
		if (event.kind === "proposal") receiveProposal(event.proposal);
		else {
			// forge_open may have just told the server which workspace this is.
			void refresh();
			if (event.opened.agent !== null) setPendingOpen(event.opened.agent);
		}
		// Only a NEW event acts; the listing changing must not replay it.
	}, [incoming]);

	useEffect(() => {
		if (pendingOpen === null || listing === null) return;
		const agent = agents.find(candidate => candidate.name === pendingOpen);
		if (agent) openListed(agent);
		setPendingOpen(null);
	}, [pendingOpen, listing, agents, openListed]);

	// A proposal decided: the same forge view, without the proposal riding on it.
	const settled = (current: Extract<View, { kind: "forge" }>, draft: AgentDraft): View => ({
		kind: "forge",
		draft,
		isNew: current.isNew,
		...(current.agent !== undefined ? { agent: current.agent } : {}),
		...(current.readOnly !== undefined ? { readOnly: current.readOnly } : {}),
	});
	const acceptProposal = () => setView(current => (current.kind === "forge" ? settled(current, current.draft) : current));
	const discardProposal = () => {
		if (view.kind !== "forge" || view.proposal === undefined) return;
		const { before } = view.proposal;
		if (before === null) backToConstellation();
		else setView(settled(view, before));
	};

	// The Stage calls back through a ref so it is created exactly once.
	const handlers = useRef<StageEvents | null>(null);
	handlers.current = {
		pickAgent: openAgent,
		selectSatellite: setSelected,
		releaseSatellite: satellite => {
			updateDraft(current => detachPart(current, satellite));
			setSelected(null);
		},
		thinkingStep: delta =>
			updateDraft(current => {
				if (heldByExtra(current).has("engine.thinkingLevel")) return current;
				const index = THINKING_STEPS.indexOf(current.thinking);
				const next = THINKING_STEPS[Math.min(THINKING_STEPS.length - 1, Math.max(0, index + delta))];
				return next === undefined || next === current.thinking ? current : { ...current, thinking: next };
			}),
		openVibr: () => {
			if (draft !== null && held.has("avatar")) setNotice({ tone: "info", text: "Its avatar is set in Everything else (a skin, an accent or a contributed face), so the wheel leaves it alone. Edit or remove `avatar` there." });
			else setPicking(true);
		},
		previewVibr: setPreviewVibr,
		pickVibr: vibr => {
			updateDraft(current => ({ ...current, vibr }));
			setPreviewVibr(null);
			setPicking(false);
		},
	};

	useEffect(() => {
		const canvas = canvasRef.current;
		const overlay = overlayRef.current;
		if (!canvas || !overlay) return;
		const relay: StageEvents = {
			pickAgent: key => handlers.current?.pickAgent(key),
			selectSatellite: satellite => handlers.current?.selectSatellite(satellite),
			releaseSatellite: satellite => handlers.current?.releaseSatellite(satellite),
			thinkingStep: delta => handlers.current?.thinkingStep(delta),
			openVibr: () => handlers.current?.openVibr(),
			previewVibr: vibr => handlers.current?.previewVibr(vibr),
			pickVibr: vibr => handlers.current?.pickVibr(vibr),
		};
		const stage = new Stage(canvas, overlay, relay);
		stageRef.current = stage;
		const observer = new MutationObserver(() => stage.refreshPalette());
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "style"] });
		return () => {
			observer.disconnect();
			stage.dispose();
			stageRef.current = null;
		};
	}, []);

	const orbs = useMemo(() => agents.map(agent => orbOf(agent, facts.find(fact => fact.name === agent.name))), [agents, facts]);
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		if (view.kind === "forge") stage.setScene({ mode: "forge", draft: view.draft, vibr: previewVibr ?? view.draft.vibr, picking });
		else stage.setScene({ mode: "constellation", agents: orbs });
	}, [view, orbs, picking, previewVibr]);

	useEffect(() => {
		stageRef.current?.setSelected(selected);
	}, [selected]);
	useEffect(() => {
		stageRef.current?.setDragKind(dragKind);
	}, [dragKind]);

	// Flash exactly the agent.md lines a gesture changed.
	const homeId = home !== null && home.name === draftName && home.info !== null ? home.info.homeId : null;
	const lines = useMemo(() => (draft ? manifestDocument(draft, homeId).lines : []), [draft, homeId]);
	const previousLines = useRef<Map<string, string>>(new Map());
	const draftKey = draft?.key ?? null;
	const previousKey = useRef<string | null>(null);
	useEffect(() => {
		const byField = new Map<string, string>();
		for (const line of lines) byField.set(line.field, `${byField.get(line.field) ?? ""}\n${line.text}`);
		const sameDraft = previousKey.current === draftKey;
		previousKey.current = draftKey;
		const changed = new Set<string>();
		if (sameDraft) for (const [field, text] of byField) if (previousLines.current.get(field) !== text) changed.add(field);
		previousLines.current = byField;
		if (changed.size === 0) return;
		setFlash(changed);
		const timer = setTimeout(() => setFlash(new Set()), 1400);
		return () => clearTimeout(timer);
	}, [lines, draftKey]);

	const proposal = view.kind === "forge" ? view.proposal : undefined;
	const proposedLines = useMemo(() => new Set((proposal?.fields ?? []).flatMap(field => PROPOSAL_LINES[field as keyof typeof PROPOSAL_LINES] ?? [])), [proposal]);
	/** Everything else is one proposable field, but its lines carry per-key ids: all of them are the workshop's while it is pending. */
	const proposedExtra = proposal?.fields.includes("extra") ?? false;

	// ── parts ────────────────────────────────────────────────────────────────

	const parts = useMemo<Part[]>(() => {
		const lineage: Part[] = agents
			.filter(agent => agent.draft.key !== draft?.key)
			.map(agent => ({ kind: "lineage", id: agent.name, label: agent.name, hint: agent.description }));
		return [...(partListing?.parts ?? []), ...lineage];
	}, [agents, partListing, draft?.key]);
	const needle = filter.trim().toLowerCase();
	const trayParts = parts.filter(part => part.kind === trayKind && (needle === "" || part.label.toLowerCase().includes(needle) || part.hint.toLowerCase().includes(needle)));
	const counts = useMemo(() => {
		const out: Record<PartKind, number> = { tool: 0, skill: 0, mcp: 0, memory: 0, lineage: 0 };
		if (draft) for (const part of parts) if (hasPart(draft, part)) out[part.kind]++;
		return out;
	}, [draft, parts]);

	/** A part cannot land where Everything else holds that key: say so, rather than change nothing. */
	const refuseHeld = (kind: PartKind): boolean => {
		const path = PART_PATH[kind];
		if (path === null || !held.has(path)) return false;
		setNotice({ tone: "info", text: `${path} is set in Everything else, so the orrery leaves it alone. Edit it there.` });
		return true;
	};

	const togglePart = (part: Part) => {
		if (!draft || refuseHeld(part.kind)) return;
		updateDraft(current => (hasPart(current, part) ? detachPart(current, part) : attachPart(current, part)));
	};

	const onPartDragStart = (event: DragEvent<HTMLButtonElement>, part: Part) => {
		event.dataTransfer.setData(PART_MIME, JSON.stringify({ kind: part.kind, id: part.id }));
		event.dataTransfer.effectAllowed = "copy";
		setDragKind(part.kind);
	};

	const onCanvasDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer.types.includes(PART_MIME)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const onCanvasDrop = (event: DragEvent<HTMLDivElement>) => {
		const raw = event.dataTransfer.getData(PART_MIME);
		setDragKind(null);
		if (!raw || !draft) return;
		event.preventDefault();
		const dropped = JSON.parse(raw) as { kind: PartKind; id: string };
		const part = parts.find(candidate => candidate.kind === dropped.kind && candidate.id === dropped.id);
		if (!part || refuseHeld(part.kind)) return;
		stageRef.current?.markDrop(part.kind, part.id, event.clientX, event.clientY);
		updateDraft(current => attachPart(current, part));
	};

	// ── forging ────────────────────────────────────────────────────────────────

	const problems = draft ? draftProblems(draft) : [];
	const serverProblems = serverCheck !== null && serverCheck.signature === signature && problems.length === 0 ? serverCheck.problems : [];
	const extraProblems = draft ? manifestDocument(draft).problems : [];
	const nameTaken = draft !== null && view.kind === "forge" && view.isNew && agents.some(agent => agent.name === draft.name);
	const blockers = [
		...(view.kind === "forge" && view.readOnly !== undefined ? [view.readOnly] : []),
		...(proposal !== undefined ? ["Accept or discard the workshop's proposal first."] : []),
		...(nameTaken ? [`An agent named “${draft?.name}” already exists.`] : []),
		...(view.kind === "forge" && view.isNew && listing?.userAgentsDir === null ? ["The Forge does not know where your agents live (INSO_HOME is unset), so it cannot create one."] : []),
		...problems,
		...serverProblems,
	];

	const forge = async () => {
		if (!draft || view.kind !== "forge" || blockers.length > 0 || saving) return;
		setSaving(true);
		try {
			const agent = view.agent;
			const target: SaveTarget | null = view.isNew ? { create: true } : agent !== undefined && agent.source !== "pack" && agent.revision !== undefined ? { create: false, tier: agent.source, revision: agent.revision } : null;
			if (target === null) throw new Error("This agent was opened without its tier and revision, so it cannot be rewritten; reopen it from the constellation.");
			const outcome = await backend.save(draft, target);
			const verb = outcome.created ? "Forged" : "Reforged";
			setNotice({
				tone: "info",
				text:
					backend.mode === "host"
						? `${verb} ${draft.name} → ${outcome.path}`
						: `${verb} ${draft.name} in the preview — kept in this browser only; nothing was written to ${outcome.relativePath}.`,
			});
			await refresh();
			backToConstellation();
		} catch (error) {
			setNotice({ tone: "error", text: `${draft.name} was not forged: ${error instanceof Error ? error.message : String(error)}` });
		} finally {
			setSaving(false);
		}
	};

	const speak = async () => {
		const text = incantation.trim();
		if (text === "") return;
		const about = draft === null ? "" : `\n\n(Said in the Forge about ${draft.name ? `the agent “${draft.name}”` : "a new agent"} — propose the change with forge_propose.)`;
		try {
			await backend.speak(`${text}${about}`);
			setIncantation("");
			setNotice({ tone: "info", text: "Sent to your agent. Its proposal appears here, marked as the workshop's, for you to accept." });
		} catch (error) {
			setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
		if (event.key === "Escape") {
			if (picking) {
				setPicking(false);
				setPreviewVibr(null);
			} else if (selected) setSelected(null);
			else if (view.kind === "forge" && !typing) backToConstellation();
			return;
		}
		if (!typing && selected && (event.key === "Delete" || event.key === "Backspace")) {
			handlers.current?.releaseSatellite(selected);
		}
	};

	const shownVibr = draft ? (previewVibr ?? draft.vibr) : null;
	const tierOf = view.kind === "forge" ? (view.agent?.source ?? "user") : "user";
	const newAgentDir = listing?.userAgentsDir ?? null;
	const sep = newAgentDir?.includes("\\") ? "\\" : "/";
	const pathOf = view.kind === "forge" ? (view.agent?.path ?? (newAgentDir === null ? "where your agents live is unknown (INSO_HOME is unset)" : [newAgentDir.replace(/[\\/]$/, ""), draft?.name || "<name>", "agent.md"].join(sep))) : "";
	const saveInstructions = async (text: string) => {
		if (!draft) return;
		try {
			const saved = await backend.saveInstructions(draft.name, text);
			setNotice({ tone: "info", text: `Saved ${saved.path}` });
			setHomeTick(tick => tick + 1);
		} catch (error) {
			setNotice({ tone: "error", text: `The instructions were not saved: ${error instanceof Error ? error.message : String(error)}` });
		}
	};
	/** An instrument whose key Everything else holds reads as that, not as a value it does not control. */
	const heldValue = (path: string, value: string) => (held.has(path) ? "In Everything else" : value);
	const canStandAtHome = home === null || home.name !== draftName || home.info === null || home.info.canStandAtHome;
	const trayNote = trayKind === "tool" ? partListing?.omitted.find(note => note.startsWith("The full tool list")) : undefined;

	return (
		<div className="fg-root" data-view={view.kind} data-panel-open={panelOpen || undefined} onKeyDown={onKeyDown}>
			<div className="fg-stage" onDragOver={onCanvasDragOver} onDrop={onCanvasDrop} data-dragging={dragKind ?? undefined}>
				<canvas
					ref={canvasRef}
					className="fg-canvas"
					aria-label={draft ? `The ${draft.name || "new"} agent's orrery. Drag parts onto it; drag the core up or down to change how hard it thinks.` : "Your General Agents as a constellation. Select one to open it in the Forge."}
				/>
				<div ref={overlayRef} className="fg-overlay" aria-hidden="true" />
			</div>

			{view.kind === "constellation" ? (
				<ConstellationHud
					listing={listing}
					facts={facts}
					offered={backend.visibility.offered()}
					loadError={loadError}
					preview={backend.mode === "preview"}
					onOpen={openAgent}
					incantation={incantation}
					setIncantation={setIncantation}
					speak={speak}
				/>
			) : (
				draft && (
					<>
						<header className="fg-forge-head">
							<button type="button" className="fg-back" onClick={backToConstellation}>
								<span aria-hidden="true">←</span> All agents
							</button>
							<div className="fg-nameplate">
								<input
									className="fg-name"
									value={draft.name}
									placeholder="name-your-agent"
									spellCheck={false}
									readOnly={!view.isNew}
									title={view.isNew ? undefined : "An agent's name is its directory; forge a new agent to use another."}
									aria-label="Agent name"
									onChange={event => updateDraft(current => ({ ...current, name: normalizeTypedName(event.target.value) }))}
								/>
								<input
									className="fg-purpose"
									value={draft.description}
									placeholder="One line: what is it for?"
									aria-label="What this agent is for"
									onChange={event => updateDraft(current => ({ ...current, description: event.target.value }))}
								/>
								<span className="fg-path" data-tier={tierOf}>
									<span className="fg-tier">{TIER_LABEL[tierOf]}</span>
									{pathOf}
								</span>
								<button type="button" className="fg-chip fg-panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen(open => !open)}>
									{panelOpen ? "Hide the panel" : "Charter, agent.md & more"}
								</button>
							</div>
						</header>

						<aside className="fg-tray" aria-label="Parts">
							<div className="fg-tray-tabs" role="tablist">
								{TRAY_GROUPS.map(group => (
									<button
										key={group.kind}
										type="button"
										role="tab"
										aria-selected={trayKind === group.kind}
										className="fg-tray-tab"
										data-kind={group.kind}
										onClick={() => setTrayKind(group.kind)}
									>
										<span className="fg-glyph" data-kind={group.kind} aria-hidden="true" />
										{group.label}
										{counts[group.kind] > 0 && <span className="fg-count">{counts[group.kind]}</span>}
									</button>
								))}
							</div>
							<p className="fg-tray-lede">{TRAY_GROUPS.find(group => group.kind === trayKind)?.lede}</p>
							{trayNote !== undefined && <p className="fg-tray-note">{trayNote}</p>}
							<input className="fg-filter" value={filter} placeholder="Filter" aria-label="Filter parts" onChange={event => setFilter(event.target.value)} />
							<div className="fg-parts">
								{trayParts.map(part => {
									const attached = hasPart(draft, part);
									return (
										<button
											key={`${part.kind}:${part.id}`}
											type="button"
											draggable
											className="fg-part"
											data-kind={part.kind}
											data-attached={attached || undefined}
											aria-pressed={attached}
											title={attached ? `${part.hint} — in orbit. Click to release.` : `${part.hint} — drag onto the agent, or click.`}
											onDragStart={event => onPartDragStart(event, part)}
											onDragEnd={() => setDragKind(null)}
											onClick={() => togglePart(part)}
										>
											<span className="fg-glyph" data-kind={part.kind} aria-hidden="true" />
											<span className="fg-part-text">
												<span className="fg-part-label">{part.label}</span>
												<span className="fg-part-hint">{part.hint}</span>
											</span>
											{attached && <span className="fg-orbit-dot" aria-hidden="true" />}
										</button>
									);
								})}
								{trayParts.length === 0 && <p className="fg-empty">{needle === "" ? "Nothing to offer here yet." : `Nothing matches “${filter}”.`}</p>}
							</div>
						</aside>

						<aside className="fg-panel" aria-label="Charter, manifest, everything else and home">
							<div className="fg-panel-tabs" role="tablist">
								{PANEL_TABS.map(tab => (
									<button key={tab.id} type="button" role="tab" aria-selected={panel === tab.id} onClick={() => setPanel(tab.id)}>
										{tab.label}
										{tab.id === "extra" && draft.extra.trim() !== "" && <span className="fg-count">•</span>}
									</button>
								))}
							</div>
							{panel === "extra" ? (
								<ExtraPanel draft={draft} held={held} problems={[...extraProblems, ...serverProblems]} onChange={extra => updateDraft(current => ({ ...current, extra }))} />
							) : panel === "home" ? (
								<HomePanel draft={draft} agent={view.agent} held={held} info={home !== null && home.name === draftName ? home.info : null} error={home !== null && home.name === draftName ? home.error : null} onSaveInstructions={saveInstructions} />
							) : panel === "charter" ? (
								<div className="fg-charter">
									<div className="fg-prompt-mode" role="radiogroup" aria-label="How the charter meets the default prompt">
										<button type="button" role="radio" aria-checked={draft.promptMode === "append"} onClick={() => updateDraft(current => ({ ...current, promptMode: "append" }))}>
											Builds on the default agent
										</button>
										<button type="button" role="radio" aria-checked={draft.promptMode === "replace"} onClick={() => updateDraft(current => ({ ...current, promptMode: "replace" }))}>
											Speaks only as itself
										</button>
									</div>
									<p className="fg-aside-lede fg-prompt-hint">
										{draft.promptMode === "replace"
											? "The charter is the agent's whole prompt — right for a specialist with its own voice."
											: "The charter is added after the full default coding prompt — right only for an agent that builds on coding."}
									</p>
									<textarea
										className="fg-charter-text"
										value={draft.charter}
										placeholder={"Who is it, and how does it work?\n\nWrite it the way you would brief a new colleague — or tell your agent below and watch it appear."}
										aria-label="Charter"
										onChange={event => updateDraft(current => ({ ...current, charter: event.target.value }))}
									/>
								</div>
							) : (
								<pre className="fg-manifest" aria-label="The agent.md this writes">
									{lines.map((line, index) => (
										<span
											key={`${line.field}-${index}`}
											className="fg-line"
											data-field={line.field}
											data-flash={flash.has(line.field) || undefined}
											data-proposed={proposedLines.has(line.field) || (proposedExtra && line.field.startsWith("extra.")) || undefined}
											data-comment={line.text.trimStart().startsWith("#") || undefined}
										>
											{line.text || " "}
										</span>
									))}
								</pre>
							)}
						</aside>

						<div className="fg-instruments" aria-label="The agent's mind">
							<Instrument label="Vibr" value={VIBR_STYLES[shownVibr ?? draft.vibr].label} hint={picking ? "Pick a body on the wheel — or here" : "Double-click the core, or open the wheel"}>
								<button type="button" className="fg-chip" aria-expanded={picking} disabled={held.has("avatar")} onClick={() => (picking ? (setPicking(false), setPreviewVibr(null)) : setPicking(true))}>
									{held.has("avatar") ? "In Everything else" : picking ? "Close wheel" : "Change"}
								</button>
							</Instrument>
							<Instrument label="Thinks" value={heldValue("engine.thinkingLevel", THINKING_LABEL[draft.thinking])} hint="Drag the core up or down">
								<Meter steps={THINKING_STEPS} value={draft.thinking} disabled={held.has("engine.thinkingLevel")} onChange={value => updateDraft(current => ({ ...current, thinking: value }))} labels={THINKING_LABEL} />
							</Instrument>
							<Instrument label="Gate" value={heldValue("gate.approval", APPROVAL_LABEL[draft.approval].label)} hint={APPROVAL_LABEL[draft.approval].hint}>
								<Segments options={APPROVAL_SETTINGS} value={held.has("gate.approval") ? null : draft.approval} disabled={held.has("gate.approval")} labels={Object.fromEntries(APPROVAL_SETTINGS.map(a => [a, APPROVAL_LABEL[a].label])) as Record<ApprovalSetting, string>} onChange={value => updateDraft(current => ({ ...current, approval: value }))} />
							</Instrument>
							<Instrument label="Lives" value={heldValue("workspace.policy", HABITAT_LABEL[draft.habitat].label)} hint={canStandAtHome ? HABITAT_LABEL[draft.habitat].hint : "A project agent belongs to one project, so it has no home to live in. Extend it as a user agent for that."}>
								<Segments options={HABITATS} value={held.has("workspace.policy") ? null : draft.habitat} disabled={held.has("workspace.policy")} disabledOptions={canStandAtHome ? [] : ["home"]} labels={Object.fromEntries(HABITATS.map(h => [h, HABITAT_LABEL[h].label])) as Record<Habitat, string>} onChange={value => updateDraft(current => ({ ...current, habitat: value }))} />
							</Instrument>
							<Instrument label="Temper" value={heldValue("identity.personality", draft.personality === "default" ? "Default" : draft.personality[0]?.toUpperCase() + draft.personality.slice(1))} hint="The personality it speaks with">
								<Segments options={PERSONALITIES} value={draft.personality} disabled={held.has("identity.personality")} labels={{ default: "Default", friendly: "Friendly", pragmatic: "Pragmatic", none: "Plain" }} onChange={value => updateDraft(current => ({ ...current, personality: value }))} />
							</Instrument>
							{draft.memory !== "off" && (
								<Instrument label="Recall" value={heldValue("workspace.reach", RECALL_LABEL[draft.memoryScope].label)} hint={RECALL_LABEL[draft.memoryScope].hint}>
									<Segments options={["project", "global"] as const} value={held.has("workspace.reach") ? null : draft.memoryScope} disabled={held.has("workspace.reach")} labels={{ project: RECALL_LABEL.project.label, global: RECALL_LABEL.global.label }} onChange={value => updateDraft(current => ({ ...current, memoryScope: value }))} />
								</Instrument>
							)}
							{!view.isNew && <VisibilityInstruments name={draft.name} visibility={backend.visibility} onError={message => setNotice({ tone: "error", text: message })} />}
						</div>

						{picking && (
							<div className="fg-vibr-list" role="listbox" aria-label="Vibr">
								{VIBRS.map(vibr => (
									<button
										key={vibr}
										type="button"
										role="option"
										aria-selected={draft.vibr === vibr}
										onMouseEnter={() => setPreviewVibr(vibr)}
										onMouseLeave={() => setPreviewVibr(null)}
										onFocus={() => setPreviewVibr(vibr)}
										onClick={() => handlers.current?.pickVibr(vibr)}
										title={VIBR_STYLES[vibr].hint}
									>
										{VIBR_STYLES[vibr].label}
									</button>
								))}
								<p className="fg-vibr-hint">{VIBR_STYLES[shownVibr ?? draft.vibr].hint}</p>
							</div>
						)}

						{selected && (
							<div className="fg-selection" role="status">
								<span className="fg-glyph" data-kind={selected.kind} aria-hidden="true" />
								<strong>{selected.id}</strong>
								<span className="fg-selection-kind">{TRAY_GROUPS.find(group => group.kind === selected.kind)?.label} · in orbit</span>
								<button type="button" className="fg-chip" onClick={() => handlers.current?.releaseSatellite(selected)}>
									Release
								</button>
								<span className="fg-selection-tip">or fling it off the orbit</span>
							</div>
						)}

						<div className="fg-forge-actions">
							{proposal !== undefined && (
								<div className="fg-proposal" role="status" aria-live="polite">
									<span className="fg-proposal-mark">Proposed by the workshop</span>
									<span className="fg-proposal-fields">{proposal.fields.length > 0 ? proposal.fields.join(" · ") : "a name"}</span>
									<div className="fg-proposal-actions">
										<button type="button" className="fg-chip" onClick={discardProposal}>
											Discard
										</button>
										<button type="button" className="fg-chip fg-chip-accept" onClick={acceptProposal}>
											Accept
										</button>
									</div>
								</div>
							)}
							<ForgeButton blockers={blockers} onForge={() => void forge()} isNew={view.isNew} saving={saving} />
							{view.readOnly !== undefined && !view.isNew && (
								<button type="button" className="fg-chip" onClick={() => extendAgent(draft)}>
									Extend it as a new agent
								</button>
							)}
						</div>

						<Incantation value={incantation} onChange={setIncantation} onSubmit={() => void speak()} placeholder={draft.name ? `Tell your agent how ${draft.name} should change…` : "Describe the agent you want — your agent drafts it here…"} />
					</>
				)
			)}

			{notice && (
				<div className="fg-notice" role="status" aria-live="polite" data-tone={notice.tone}>
					{notice.text}
				</div>
			)}
			{backend.mode === "preview" && (
				<span className="fg-preview-pill" title="Running on its own with seeded agents kept in this browser. Inside Dimension this View reads and writes real agent.md files.">
					Preview · nothing is written
				</span>
			)}
		</div>
	);
}

function ConstellationHud({
	listing,
	facts,
	offered,
	loadError,
	preview,
	onOpen,
	incantation,
	setIncantation,
	speak,
}: {
	listing: AgentListing | null;
	facts: readonly ViewAgentFact[];
	/** Whether the host lends the enabled/listed facts at all. */
	offered: boolean;
	loadError: string | null;
	preview: boolean;
	onOpen: (key: string) => void;
	incantation: string;
	setIncantation: (value: string) => void;
	speak: () => void;
}) {
	const agents = listing?.agents ?? [];
	const lede =
		loadError !== null
			? `The agents could not be read: ${loadError}`
			: listing === null
				? "Reading the agents…"
				: `${agents.length} ${agents.length === 1 ? "mind" : "minds"}${listing.workspace ? ` in ${listing.workspace}` : preview ? " in this preview" : ""}. Lines between them are lineage — who extends whom.`;
	return (
		<>
			<header className="fg-hero">
				<h1>General Agents</h1>
				<p>{lede}</p>
				{listing !== null && !offered && !preview && <p className="fg-hero-note">This host does not lend the Forge which agents are enabled or hidden from the rail, so none are marked here.</p>}
				{listing !== null && listing.notices.length > 0 && (
					<ul className="fg-notes">
						{listing.notices.map(note => (
							<li key={note}>{note}</li>
						))}
					</ul>
				)}
			</header>
			<nav className="fg-roster" aria-label="Agents">
				{agents.map(agent => (
					<button key={agent.draft.key} type="button" onClick={() => onOpen(agent.draft.key)} title={agent.editable ? agent.path : `${agent.path} — ${agent.readOnlyReason ?? "read-only"}`}>
						<span className="fg-roster-name">{agent.name}</span>
						<span className="fg-roster-sub">
							{[TIER_SHORT[agent.source], ...(agent.source !== "pack" && !agent.editable ? ["read-only"] : []), ...statusOf(facts.find(fact => fact.name === agent.name))].join(" · ")}
						</span>
					</button>
				))}
				<button type="button" className="fg-roster-new" onClick={() => onOpen(NEW_AGENT_KEY)}>
					<span aria-hidden="true">＋</span> Forge a new agent
				</button>
			</nav>
			<Incantation value={incantation} onChange={setIncantation} onSubmit={speak} placeholder="Describe an agent — “a release herald that writes changelogs in my voice”…" />
		</>
	);
}

function Incantation({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (value: string) => void; onSubmit: () => void; placeholder: string }) {
	return (
		<form
			className="fg-incantation"
			onSubmit={event => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<span className="fg-incantation-spark" aria-hidden="true" />
			<input value={value} placeholder={placeholder} aria-label="Talk to the workshop" onChange={event => onChange(event.target.value)} />
			<button type="submit" disabled={value.trim() === ""} aria-label="Send to the workshop">
				↵
			</button>
		</form>
	);
}

/** What the host says about an agent, for the roster: nothing when it is on and shown, or unknown. */
function statusOf(fact: ViewAgentFact | undefined): string[] {
	if (fact === undefined) return [];
	return !fact.enabled ? ["off"] : !fact.listed ? ["hidden from rail"] : [];
}

function ForgeButton({ blockers, onForge, isNew, saving }: { blockers: readonly string[]; onForge: () => void; isNew: boolean; saving: boolean }) {
	const ready = blockers.length === 0 && !saving;
	return (
		<div className="fg-forge">
			<button type="button" className="fg-forge-button" disabled={!ready} onClick={onForge}>
				{saving ? "Forging…" : isNew ? "Forge it" : "Reforge"}
			</button>
			{blockers.length > 0 && (
				<ul className="fg-blockers" aria-label="Before it can exist">
					{blockers.map(blocker => (
						<li key={blocker}>{blocker}</li>
					))}
				</ul>
			)}
		</div>
	);
}
