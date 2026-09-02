// Sessions — a mission-control dock panel, and the worked example of the
// contributed dock-COMPONENT lane ("type": "component", "slot": "dock").
// "Instrument" is the ROLE you say out loud (doc 68 §1 ruling 3) — never a
// manifest type.
//
//   THE IMPORT SURFACE: `react`, plus ONE granted host hook.
//
// A dock component's props ARE its context: the kit loader wraps this
// component in one `createElement(Component, ctx)`, so the host's Store
// arrives the same way a slot component's `store` prop does (doc 68 §3.5).
// The board no longer WATCHES a key through it, though — the session list is
// read through channel 3, `useStandardRootFacts()`, the host's ambient
// standard-fact door (doc 68 §3.5 channel 3, granted in `host-externals.ts`).
// Two reasons that is the right channel and the raw watch was not:
//
//  * The fact NAME is the host's (`sessions`), so the pack stops hardcoding a
//    key literal (`"sessions/list"`) it does not own — the key can move and
//    this pack does not care.
//  * The fact arrives already fenced by the dock seat, merged and deduped by
//    the host's one `useSyncExternalStore`, so the pack keeps no subscription
//    machinery of its own.
//
// The `store` prop STAYS, because `act("selectSession", …)` is the board's
// intent channel and channel 3 is read-only. The styling is the author's own,
// drawn on the host's `--fr-*` custom properties so it sits in either theme
// without importing anything (the marketplace house rule: design tokens only,
// color-is-meaning stays the host's).

import { useStandardRootFacts } from "@fraym/ui";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { type BoardRow, type BoardSession, partitionBoard } from "./partition";

/** The Store's contract shape, restated structurally (doc 68 §3.4). Reduced to
 *  the intent channel: reads come from `useStandardRootFacts` now. */
interface HostStoreShape {
	act(intent: string, payload?: unknown): void;
}

/** Channel 3's ambient ROOT facts, restated structurally for the same reason
 *  `HostStoreShape` is: the host's `StandardRootFacts` augmentation lives in
 *  `@fraym/driver`, which a pack does not import. So the pack names the ONE
 *  member it reads, and `BoardSession` (its own structural view of a catalog
 *  entry, in `./partition`) stays the shape it partitions. */
interface RootFacts {
	readonly sessions?: readonly BoardSession[];
}

/** The structural subset of `InstrumentContext` this instrument reads. */
export interface SessionBoardProps {
	/** Handed in by the dock's mount boundary — the board's INTENT channel
	 *  (`act("selectSession", …)`). Absent on a storeless mount: the board then
	 *  states that honestly instead of rendering unclickable rows. */
	readonly store?: HostStoreShape;
}

const NO_SESSIONS: readonly BoardSession[] = [];

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
			// Keyboard parity for the hover affordance (review 2026-08-19): a
			// tabbing user gets the same highlight, not only the UA focus ring.
			onFocus={event => {
				event.currentTarget.style.background = "var(--fr-surface-2, rgba(127,127,127,0.08))";
				event.currentTarget.style.borderColor = "var(--fr-border-soft, transparent)";
			}}
			onBlur={event => {
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
					animation: kind === "working" ? "dimension-session-board-breathe 2.4s ease-in-out infinite" : "none",
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
 * Facts from the host's ambient `sessions` standard fact; pixels the author's
 * own.
 */
export function SessionBoard({ store }: SessionBoardProps): ReactNode {
	// ONE fact, already merged and deduped by the host: the catalog value carries
	// liveStatus + blockedOnInput per entry, so the board needs no per-session
	// facts and no subscription of its own.
	const { sessions } = useStandardRootFacts() as RootFacts;
	const partition = useMemo(() => partitionBoard(sessions ?? NO_SESSIONS), [sessions]);
	const select = (row: BoardRow) =>
		store?.act("selectSession", {
			id: row.id,
			...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
			...(row.harness ? { harness: row.harness } : {}),
		});

	// A mount with no Store has no intent channel AND no fact channel — the host
	// hands both down together, and `useStandardRootFacts` reads the same ambient
	// instance. So this is one honest notice, not two.
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
			{/* `precedence` makes React HOIST and DEDUPE this tag (one copy however
			    many boards mount); the keyframes name is package-namespaced so no
			    other pack's `breathe` can silently win (review 2026-08-19). */}
			<style href="dimension-session-board" precedence="low">{`@keyframes dimension-session-board-breathe{0%,100%{opacity:1}50%{opacity:.45}}@media (prefers-reduced-motion: reduce){[data-slot="session-board"] [data-kind="working"]{animation:none !important}}`}</style>
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
