// The aside's two newest tabs, and the host's visibility instruments.
//
//   Everything else — every manifest key the orrery does not draw, as YAML text.
//   Home            — the agent's home, the AGENTS.md it runs by, where its memory reads.
//
// Both draw what the SERVER resolved (`agent_home`, `validate_agent`): the View
// never re-derives a home id, an instruction tier or a YAML verdict.
import type { ViewAgentFact } from "@dimension/sdk/artifactory";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentDraft, Habitat } from "../../src/agent-md";
import { grantPathsIn } from "../../src/extra";
import type { AgentHome, InstructionFile, ListedAgent } from "../../src/contracts";
import type { AgentVisibility } from "./forge-client";
import { Instrument, Segments } from "./instruments";

// ── Everything else ─────────────────────────────────────────────────────────

/** The keys that live in Everything else, for the reference under the editor. */
const EXTRA_KEYS: readonly { key: string; note: string }[] = [
	{ key: "title · defaultEnabled · defaultListed", note: "the display name, and whether a pack agent is on and shown in the rail before you say otherwise" },
	{ key: "engine.model · profile · roles", note: "which models it runs on" },
	{ key: "capabilities.control", note: "the Dimension Control lanes it holds — `agents` lets it create agents" },
	{ key: "capabilities.plugins · optIn · autoloadSkills · slashCommands · ignore", note: "plugin, skill and command reach" },
	{ key: "memory.namespace", note: "isolates the bank only under mnemopi; Engram ignores it" },
	{ key: "subagents · loop · routing", note: "delegation limits, eager tools, and what wakes it in a room" },
	{ key: "harness · allowedHarnesses · gate.policy", note: "reserved bodies and policy" },
	{ key: "avatar · engine.thinkingLevel · workspace.reach …", note: "a drawn key the orrery cannot draw (a skinned avatar, thinkingLevel: auto, a reach that lists workspaces) waits here, untouched" },
];

export function ExtraPanel({ draft, held, problems, onChange }: { draft: AgentDraft; held: ReadonlySet<string>; problems: readonly string[]; onChange: (extra: string) => void }) {
	const grants = grantPathsIn(draft.extra);
	return (
		<div className="fg-extra">
			<p className="fg-aside-lede">
				Every manifest key the orrery does not draw, kept exactly as written and merged into <code>agent.md</code> when you forge. It is checked as a whole before anything is saved — a parse error is shown here, never written.
			</p>
			{held.size > 0 && (
				<p className="fg-extra-held">
					Held here, so the orrery's own control for it stands aside: <strong>{[...held].join(" · ")}</strong>
				</p>
			)}
			<textarea
				className="fg-extra-text"
				value={draft.extra}
				spellCheck={false}
				aria-label="Everything else — manifest keys the orrery does not draw, as YAML"
				placeholder={"title: Chief Marketing Officer\ncapabilities:\n  control: [agents]\nrouting:\n  card: Marketing questions"}
				onChange={event => onChange(event.target.value)}
			/>
			{problems.length > 0 && (
				<ul className="fg-extra-problems" role="alert">
					{problems.map(problem => (
						<li key={problem}>{problem}</li>
					))}
				</ul>
			)}
			{grants.length > 0 && (
				<p className="fg-extra-grants" role="status">
					You are setting <strong>{grants.join(", ")}</strong>: keys that grant. Only you can; the workshop cannot set them by proposal.
				</p>
			)}
			<details className="fg-extra-keys">
				<summary>What lives here</summary>
				<ul>
					{EXTRA_KEYS.map(entry => (
						<li key={entry.key}>
							<code>{entry.key}</code> — {entry.note}
						</li>
					))}
				</ul>
			</details>
		</div>
	);
}

// ── Home ────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<InstructionFile["kind"], string> = {
	"workspace-copy": "This project's copy",
	home: "Home",
	pack: "Shipped with the pack",
	"agent-dir": "Beside agent.md",
};

function stateOf(file: InstructionFile): string {
	if (file.wins) return file.exists && file.bytes === 0 ? "in force · empty" : "in force";
	if (!file.exists) return "not there";
	if (file.kind === "home" && file.bytes === 0) return "empty — falls through";
	return "shadowed by a stronger file";
}

const HABITAT_WORD: Record<Habitat, string> = { bound: "where it is opened", home: "its own home", ephemeral: "a scratch worktree" };

/** Where the agent's recall reads — `memory-reach.ts`: its room, its home room, the global lane, or every room. */
function memoryReads(draft: AgentDraft, held: ReadonlySet<string>, room: string): string[] {
	if (draft.memory === "off") return ["Nothing — memory is off for this agent."];
	if (!held.has("workspace.reach") && draft.memoryScope === "global") return ["Every room (workspace.reach: all)", "the global lane"];
	return [
		"This project's room",
		`its home room, ${room} — it follows the agent from project to project`,
		"the global lane",
		...(held.has("workspace.reach") ? ["the rooms of the workspaces its reach lists (set in Everything else)"] : []),
	];
}

export function HomePanel({
	draft,
	agent,
	held,
	info,
	error,
	onSaveInstructions,
}: {
	draft: AgentDraft;
	agent: ListedAgent | undefined;
	held: ReadonlySet<string>;
	info: AgentHome | null;
	error: string | null;
	onSaveInstructions: (text: string) => Promise<void>;
}) {
	const [text, setText] = useState("");
	const [saving, setSaving] = useState(false);
	const loaded = info?.instructions.text ?? "";
	useEffect(() => {
		setText(loaded);
	}, [loaded, info?.name, info?.instructions.target?.path]);
	if (error !== null) {
		return (
			<div className="fg-home">
				<p className="fg-aside-lede" role="alert">
					{error}
				</p>
			</div>
		);
	}
	if (info === null) {
		return (
			<div className="fg-home">
				<p className="fg-aside-lede">{draft.name === "" ? "Name the agent and its home appears here." : "Reading its home…"}</p>
			</div>
		);
	}
	const { instructions } = info;
	const stands = !held.has("workspace.policy") && draft.habitat === "home";
	const dirty = text !== loaded;
	const save = async () => {
		setSaving(true);
		try {
			await onSaveInstructions(text);
		} finally {
			setSaving(false);
		}
	};
	return (
		<div className="fg-home">
			<section className="fg-home-block">
				<h3>Home</h3>
				{info.hasHome ? (
					<dl className="fg-home-facts">
						<dt>Id</dt>
						<dd>
							<code>{info.homeId}</code>
						</dd>
						{info.folder !== null && (
							<>
								<dt>Folder</dt>
								<dd>
									<code>{info.folder}</code> <span className="fg-home-state">{info.folderExists ? "exists" : "made the first time it is opened"}</span>
								</dd>
							</>
						)}
					</dl>
				) : (
					<p className="fg-home-none">No home.</p>
				)}
				<p className="fg-home-note">{info.homeNote}</p>
				<p className="fg-home-stands" data-stands={stands || undefined}>
					{held.has("workspace.policy")
						? "Where it runs is set in Everything else."
						: stands
							? "It STANDS there: Lives → Own home starts every session in this folder."
							: `It only READS its home: sessions start in ${HABITAT_WORD[draft.habitat]} (Lives → ${draft.habitat}); its instructions and memory still follow it.`}
				</p>
			</section>

			<section className="fg-home-block">
				<h3>Standing instructions</h3>
				<p className="fg-home-note">
					The agent-level <code>AGENTS.md</code> — one file loads per session, the first of these that holds text.
				</p>
				<ol className="fg-home-files">
					{instructions.files.map(file => (
						<li key={file.path} data-wins={file.wins || undefined}>
							<span className="fg-home-kind">{KIND_LABEL[file.kind]}</span>
							<code title={file.path}>{file.path}</code>
							<span className="fg-home-state">{stateOf(file)}</span>
						</li>
					))}
				</ol>
				<textarea
					className="fg-home-text"
					value={text}
					disabled={!instructions.editable || agent === undefined}
					spellCheck={false}
					aria-label="Standing instructions (AGENTS.md) the agent runs by"
					placeholder={agent === undefined ? "Forge the agent first; then write how it should always act." : instructions.editable ? "How this agent always acts, in any workspace…" : ""}
					onChange={event => setText(event.target.value)}
				/>
				<p className="fg-home-note">{instructions.note}</p>
				{instructions.editable && instructions.target !== null && (
					<div className="fg-home-actions">
						<button type="button" className="fg-chip fg-chip-accept" disabled={!dirty || saving} onClick={() => void save()}>
							{saving ? "Saving…" : "Save instructions"}
						</button>
						<span className="fg-home-state" title={instructions.target.path}>
							writes {instructions.target.kind === "home" ? "the home AGENTS.md" : "the AGENTS.md beside agent.md"}
						</span>
					</div>
				)}
			</section>

			<section className="fg-home-block">
				<h3>Memory reads from</h3>
				<ul className="fg-home-reads">
					{memoryReads(draft, held, info.memoryRoom).map(read => (
						<li key={read}>{read}</li>
					))}
				</ul>
				<p className="fg-home-note">
					<code>memory.namespace</code> does not isolate Engram: only the mnemopi runtime applies it. An Engram agent is kept apart by its reach and its home room.
				</p>
			</section>
		</div>
	);
}

// ── the host's switches ─────────────────────────────────────────────────────

const ON_OFF = { on: "On", off: "Off" } as const;
const SHOWN = { shown: "Shown", hidden: "Hidden" } as const;

/**
 * Enabled and Show-in-rail — the host's own record, flipped through the host's
 * own verb (`agents:configure`), so what moves here is what the Capabilities
 * page moves. Drawn only where the host offers them: otherwise one instrument
 * says it does not, rather than two switches that would do nothing.
 */
export function VisibilityInstruments({ name, visibility, onError }: { name: string; visibility: AgentVisibility; onError: (message: string) => void }) {
	const facts = useSyncExternalStore(visibility.subscribe, visibility.read);
	const [busy, setBusy] = useState(false);
	if (!visibility.offered()) {
		return <Instrument label="Rail" value="Not offered" hint="This host does not lend the agents switches to the Forge (the preview, or a Dimension that predates them). Use Capabilities → General Agents." />;
	}
	const fact: ViewAgentFact | undefined = facts.find(candidate => candidate.name === name);
	if (fact === undefined) {
		return <Instrument label="Rail" value="Not known yet" hint="The host has not listed this agent yet — it appears in a moment after it is forged, or it is not one the host can run." />;
	}
	const flip = async (change: { enabled?: boolean; listed?: boolean }) => {
		setBusy(true);
		try {
			await visibility.configure({ name, ...change });
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Instrument label="Enabled" value={fact.enabled ? "On" : "Off"} hint={`Off: sessions cannot be opened as it. Default ${fact.defaultEnabled ? "on" : "off"}.`}>
				<Segments options={["on", "off"] as const} value={fact.enabled ? "on" : "off"} labels={ON_OFF} disabled={busy} onChange={value => void flip({ enabled: value === "on" })} />
			</Instrument>
			<Instrument label="In rail" value={fact.listed ? "Shown" : "Hidden"} hint={`Hidden: the rail drops its row, yet it stays enabled and invocable. Default ${fact.defaultListed ? "shown" : "hidden"}.`}>
				<Segments options={["shown", "hidden"] as const} value={fact.listed ? "shown" : "hidden"} labels={SHOWN} disabled={busy} onChange={value => void flip({ listed: value === "shown" })} />
			</Instrument>
		</>
	);
}
