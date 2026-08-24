// Minimal Environment — the worked example of the contributed WIDGET lane
// ("type": "component", "slot": "workspace-surface", doc 56 §3.2). A space pins
// it through `widgets.pinned` and it parks at a corner post of the workspace
// pane, exactly where the shipped environment card sits.
//
//   THE ENTIRE IMPORT SURFACE: `react`. Nothing else.
//
// This is the honest half of the environment card: everything it draws comes
// from the HOST PROPS — the active session's catalogue snapshot (its SCM ledger,
// recap and task roll-up) and the workspace ref. No driver, no capability
// surface, no Store write. What the shipped card has that this does not is the
// live repository scan, which rides the workspace capability set; a widget at
// the zero-import floor deliberately shows only what the host already published.

import type { CSSProperties, ReactNode } from "react";

/** Structural subset of the published `SessionScmLedgerSummary`. */
interface LedgerShape {
	readonly commits?: number;
	readonly filesTouched?: number;
	readonly touchedCount?: number;
	readonly updatedAt?: string;
	readonly recentTouchedPaths?: readonly string[];
	readonly recentCommits?: readonly { readonly subject?: string }[];
}

/** Structural subset of one catalogue snapshot row. */
interface SnapshotShape {
	readonly ref?: { readonly sessionId?: string; readonly workspaceId?: string };
	readonly title?: string;
	readonly scmLedger?: LedgerShape | null;
	readonly recap?: { readonly text?: string } | null;
	readonly tasks?: readonly { readonly name?: string; readonly status?: string }[] | null;
	readonly hasBackgroundWork?: boolean;
	readonly workspace?: WorkspaceShape | null;
}

interface WorkspaceShape {
	readonly workspaceId?: string;
	readonly path?: string;
	readonly displayName?: string;
	readonly git?: { readonly worktree?: boolean; readonly currentBranch?: string } | null;
}

/** The structural subset of the widget host props this card reads. */
export interface MinimalEnvironmentProps {
	readonly sessionRef?: { readonly sessionId: string; readonly workspaceId: string } | null;
	readonly sessionCatalog?: readonly SnapshotShape[];
	readonly workspace?: WorkspaceShape | null;
}

const card: CSSProperties = {
	pointerEvents: "auto",
	width: 300,
	maxHeight: "100%",
	overflowY: "auto",
	display: "flex",
	flexDirection: "column",
	gap: 8,
	padding: 12,
	borderRadius: 12,
	border: "1px solid var(--fr-border)",
	background: "var(--fr-surface)",
	fontSize: 12,
	color: "var(--fr-text)",
};

const label: CSSProperties = { fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--fr-text-3)" };
const rowStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8 };
const quiet: CSSProperties = { color: "var(--fr-text-2)" };
const mono: CSSProperties = { fontFamily: "var(--fr-font-mono, ui-monospace)", fontSize: 11 };

function Line({ name, value }: { readonly name: string; readonly value: ReactNode }): ReactNode {
	return (
		<div style={rowStyle}>
			<span style={quiet}>{name}</span>
			<span style={mono}>{value}</span>
		</div>
	);
}

/**
 * The pinned environment widget.
 *
 * Absence is stated, never faked: with no session bound, or a session whose
 * journal carries no SCM facts yet, the card says so instead of drawing a
 * confident zero (the shipped card's own rule — an unverified answer is worse
 * than an honest skeleton).
 */
export function MinimalEnvironment(props: MinimalEnvironmentProps) {
	const ref = props.sessionRef;
	const snapshot = ref
		? props.sessionCatalog?.find(row => row.ref?.sessionId === ref.sessionId && row.ref?.workspaceId === ref.workspaceId)
		: undefined;
	const checkout = snapshot?.workspace ?? props.workspace ?? null;
	const ledger = snapshot?.scmLedger ?? null;
	const tasks = snapshot?.tasks ?? [];
	const running = tasks.filter(task => task.status === "in_progress" || task.status === "running").length;

	return (
		<div style={card} data-slot="env-minimal">
			<div style={label}>Environment</div>
			{checkout ? (
				<>
					<Line name="checkout" value={checkout.displayName ?? checkout.path ?? "unknown"} />
					<Line name="branch" value={checkout.git?.currentBranch ?? "—"} />
					<Line name="worktree" value={checkout.git?.worktree ? "yes" : "no"} />
				</>
			) : (
				<span style={quiet}>No workspace bound.</span>
			)}
			<div style={label}>This session</div>
			{ledger ? (
				<>
					<Line name="commits" value={ledger.commits ?? 0} />
					<Line name="files touched" value={ledger.filesTouched ?? ledger.touchedCount ?? 0} />
					{ledger.recentTouchedPaths && ledger.recentTouchedPaths.length > 0 ? (
						<div style={{ ...quiet, ...mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
							{ledger.recentTouchedPaths.slice(0, 3).join(" · ")}
						</div>
					) : null}
				</>
			) : (
				// The journal carries no SCM facts for this session yet — say that,
				// rather than rendering zeros that read as "nothing changed".
				<span style={quiet}>No source-control facts recorded yet.</span>
			)}
			{tasks.length > 0 ? <Line name="tasks" value={`${running} running / ${tasks.length}`} /> : null}
			{snapshot?.hasBackgroundWork ? <span style={quiet}>Background work in flight.</span> : null}
			{snapshot?.recap?.text ? <span style={quiet}>{snapshot.recap.text.slice(0, 140)}</span> : null}
		</div>
	);
}
