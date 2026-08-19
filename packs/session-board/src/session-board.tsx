// Sessions — a mission-control dock instrument, and the worked example of the
// CONTRIBUTED INSTRUMENT lane (doc 44 §4.3; doc 68 §16.4 row 4, opened
// 2026-08-19).
//
//   THE ENTIRE IMPORT SURFACE: `react`. Nothing else.
//
// An instrument's props ARE its context: the kit loader wraps this component
// in one `createElement(Component, ctx)`, so the host's Store arrives the
// same way a slot component's `store` prop does (doc 68 §3.5) — read with
// React's BUILT-IN `useSyncExternalStore` over the contract's
// `{getSnapshot, subscribe}` shape. Zero kit imports; the styling is the
// author's own, drawn on the host's `--fr-*` custom properties so it sits in
// either theme without importing anything (the marketplace house rule:
// design tokens only, color-is-meaning stays the host's).

import { type CSSProperties, type ReactNode, useMemo, useSyncExternalStore } from "react";
import { type BoardRow, type BoardSession, partitionBoard } from "./partition";

/** The Store's contract shape, restated structurally (doc 68 §3.4). */
interface HostStoreShape {
	watch<T>(key: string): { getSnapshot(): T | undefined; subscribe(listener: () => void): () => void };
	act(intent: string, payload?: unknown): void;
}

/** The structural subset of `InstrumentContext` this instrument reads. */
export interface SessionBoardProps {
	/** Handed in by the dock's mount boundary; absent on a storeless mount —
	 *  the board then states that honestly instead of rendering nothing. */
	readonly store?: HostStoreShape;
}

const NO_SESSIONS: readonly BoardSession[] = [];
const noopSubscribe = () => () => {};

const text = (tone: 1 | 2 | 3): CSSProperties => ({
	color: tone === 1 ? "var(--fr-text)" : `var(--fr-text-${tone})`,
});

/** Section header: a quiet label with a count, the divider the content is. */
function SectionHead({ label, count, accent }: { label: string; count: number; accent?: boolean }): ReactNode {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "10px 4px 4px",
				fontSize: 10,
				letterSpacing: "0.08em",
				textTransform: "uppercase",
				color: accent ? "var(--fr-accent, var(--fr-text-2))" : "var(--fr-text-3)",
				fontWeight: 600,
			}}
		>
			<span>{label}</span>
			<span style={{ fontWeight: 400, opacity: 0.8 }}>{count}</span>
		</div>
	);
}

function Row({
	row,
	kind,
	onSelect,
}: {
	row: BoardRow;
	kind: "needsYou" | "working" | "idle";
	onSelect: (row: BoardRow) => void;
}): ReactNode {
	const dot =
		kind === "needsYou"
			? "var(--fr-warning, #d97706)"
			: kind === "working"
				? "var(--fr-success, #16a34a)"
				: "var(--fr-border, currentColor)";
	return (
		<button
			type="button"
			onClick={() => onSelect(row)}
			title={row.detail ? `${row.title} — ${row.detail}` : row.title}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				textAlign: "left",
				padding: "6px 8px",
				border: "1px solid transparent",
				borderRadius: 8,
				background: "transparent",
				cursor: "pointer",
				font: "inherit",
			}}
			onMouseEnter={event => {
				event.currentTarget.style.background = "var(--fr-surface-2, rgba(127,127,127,0.08))";
				event.currentTarget.style.borderColor = "var(--fr-border-soft, transparent)";
			}}
			onMouseLeave={event => {
				event.currentTarget.style.background = "transparent";
				event.currentTarget.style.borderColor = "transparent";
			}}
		>
			<span
				data-kind={kind}
				style={{
					width: 7,
					height: 7,
					borderRadius: "50%",
					flexShrink: 0,
					background: kind === "idle" ? "transparent" : dot,
					border: kind === "idle" ? `1.5px solid ${dot}` : "none",
					animation: kind === "working" ? "sb-breathe 2.4s ease-in-out infinite" : "none",
				}}
			/>
			<span style={{ minWidth: 0, flex: 1 }}>
				<span
					style={{
						display: "block",
						fontSize: 12,
						color: "var(--fr-text, inherit)",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{row.title}
				</span>
				{row.detail && (
					<span
						style={{
							display: "block",
							fontSize: 10,
							color: "var(--fr-text-3, inherit)",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						{row.detail}
					</span>
				)}
			</span>
		</button>
	);
}

/**
 * Every session, partitioned by what it needs from you: blocked first (the
 * reason to glance here), then working, then idle — one click switches.
 * Facts from the Store's published `sessions/list`; pixels the author's own.
 */
export function SessionBoard({ store }: SessionBoardProps): ReactNode {
	// One watch, one snapshot: the catalog value already carries liveStatus +
	// blockedOnInput per entry, so the board needs no per-session keys.
	const observable = useMemo(() => store?.watch<readonly BoardSession[]>("sessions/list"), [store]);
	const sessions = useSyncExternalStore(
		observable?.subscribe ?? noopSubscribe,
		() => observable?.getSnapshot() ?? NO_SESSIONS,
		() => NO_SESSIONS,
	);
	const partition = useMemo(() => partitionBoard(sessions), [sessions]);
	const select = (row: BoardRow) =>
		store?.act("selectSession", {
			id: row.id,
			...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
			...(row.harness ? { harness: row.harness } : {}),
		});

	if (!store) {
		return (
			<div style={{ padding: 16, fontSize: 12, ...text(3) }}>
				This host mounted the board without a Store — nothing to show, honestly.
			</div>
		);
	}
	const empty = partition.needsYou.length + partition.working.length + partition.idle.length === 0;
	return (
		<div data-slot="session-board" style={{ height: "100%", overflowY: "auto", padding: "4px 8px 12px" }}>
			<style>{`@keyframes sb-breathe{0%,100%{opacity:1}50%{opacity:.45}}@media (prefers-reduced-motion: reduce){[data-slot="session-board"] [data-kind="working"]{animation:none !important}}`}</style>
			{empty ? (
				<div style={{ padding: "24px 8px", fontSize: 12, textAlign: "center", ...text(3) }}>
					No sessions yet — the board fills as you open them.
				</div>
			) : (
				<>
					{partition.needsYou.length > 0 && (
						<>
							<SectionHead label="Needs you" count={partition.needsYou.length} accent />
							{partition.needsYou.map(row => (
								<Row key={row.id} row={row} kind="needsYou" onSelect={select} />
							))}
						</>
					)}
					{partition.working.length > 0 && (
						<>
							<SectionHead label="Working" count={partition.working.length} />
							{partition.working.map(row => (
								<Row key={row.id} row={row} kind="working" onSelect={select} />
							))}
						</>
					)}
					{partition.idle.length > 0 && (
						<>
							<SectionHead label="Idle" count={partition.idle.length} />
							{partition.idle.map(row => (
								<Row key={row.id} row={row} kind="idle" onSelect={select} />
							))}
						</>
					)}
				</>
			)}
		</div>
	);
}
