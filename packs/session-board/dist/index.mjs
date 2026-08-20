import { useMemo, useSyncExternalStore } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/partition.ts
function toRow(session) {
	const id = session.ref?.sessionId;
	if (!id) return null;
	const git = session.workspace?.git;
	const detail = git?.currentBranch ? `${git.currentBranch}${git.worktree ? " · worktree" : ""}` : git?.worktree ? "worktree" : null;
	return {
		id,
		workspaceId: session.ref?.workspaceId,
		harness: session.ref?.harness,
		title: session.title?.trim() || "Untitled session",
		detail,
		updatedAt: session.updatedAt ?? 0
	};
}
var byRecency = (a, b) => b.updatedAt - a.updatedAt;
/**
* Partition the catalog: blocked → working → idle, each newest-first.
* "Working" is any LIVE state — `running`, `background` (grinding without
* the foreground), `attached` (a live engine child) — because the board's
* question is "who needs me / who is busy", and a session doing background
* work reading as Idle answers it wrongly (review 2026-08-19). Archived
* sessions are the one exclusion — a board that lists the closed shelf
* stops being "what needs me" and becomes history, which the rail's
* settled shelf already owns.
*/
function partitionBoard(sessions) {
	const needsYou = [];
	const working = [];
	const idle = [];
	for (const session of sessions) {
		if (session.archivedAt) continue;
		const row = toRow(session);
		if (!row) continue;
		if (session.blockedOnInput === true) needsYou.push(row);
		else if (session.liveStatus === "running" || session.liveStatus === "background" || session.liveStatus === "attached") working.push(row);
		else idle.push(row);
	}
	needsYou.sort(byRecency);
	working.sort(byRecency);
	idle.sort(byRecency);
	return {
		needsYou,
		working,
		idle
	};
}
//#endregion
//#region src/session-board.tsx
var NO_SESSIONS = [];
var noopSubscribe = () => () => {};
var text = (tone) => ({ color: tone === 1 ? "var(--fr-text)" : `var(--fr-text-${tone})` });
/** Section header: a quiet label with a count, the divider the content is. */
function SectionHead({ label, count, accent }) {
	return /* @__PURE__ */ jsxs("div", {
		style: {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "10px 4px 4px",
			fontSize: 10,
			letterSpacing: "0.08em",
			textTransform: "uppercase",
			color: accent ? "var(--fr-accent, var(--fr-text-2))" : "var(--fr-text-3)",
			fontWeight: 600
		},
		children: [/* @__PURE__ */ jsx("span", { children: label }), /* @__PURE__ */ jsx("span", {
			style: {
				fontWeight: 400,
				opacity: .8
			},
			children: count
		})]
	});
}
function Row({ row, kind, onSelect }) {
	const dot = kind === "needsYou" ? "var(--fr-warning, #d97706)" : kind === "working" ? "var(--fr-success, #16a34a)" : "var(--fr-border, currentColor)";
	return /* @__PURE__ */ jsxs("button", {
		type: "button",
		onClick: () => onSelect(row),
		title: row.detail ? `${row.title} — ${row.detail}` : row.title,
		style: {
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
			font: "inherit"
		},
		onMouseEnter: (event) => {
			event.currentTarget.style.background = "var(--fr-surface-2, rgba(127,127,127,0.08))";
			event.currentTarget.style.borderColor = "var(--fr-border-soft, transparent)";
		},
		onMouseLeave: (event) => {
			event.currentTarget.style.background = "transparent";
			event.currentTarget.style.borderColor = "transparent";
		},
		onFocus: (event) => {
			event.currentTarget.style.background = "var(--fr-surface-2, rgba(127,127,127,0.08))";
			event.currentTarget.style.borderColor = "var(--fr-border-soft, transparent)";
		},
		onBlur: (event) => {
			event.currentTarget.style.background = "transparent";
			event.currentTarget.style.borderColor = "transparent";
		},
		children: [/* @__PURE__ */ jsx("span", {
			"data-kind": kind,
			style: {
				width: 7,
				height: 7,
				borderRadius: "50%",
				flexShrink: 0,
				background: kind === "idle" ? "transparent" : dot,
				border: kind === "idle" ? `1.5px solid ${dot}` : "none",
				animation: kind === "working" ? "dimension-session-board-breathe 2.4s ease-in-out infinite" : "none"
			}
		}), /* @__PURE__ */ jsxs("span", {
			style: {
				minWidth: 0,
				flex: 1
			},
			children: [/* @__PURE__ */ jsx("span", {
				style: {
					display: "block",
					fontSize: 12,
					color: "var(--fr-text, inherit)",
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis"
				},
				children: row.title
			}), row.detail && /* @__PURE__ */ jsx("span", {
				style: {
					display: "block",
					fontSize: 10,
					color: "var(--fr-text-3, inherit)",
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis"
				},
				children: row.detail
			})]
		})]
	});
}
/**
* Every session, partitioned by what it needs from you: blocked first (the
* reason to glance here), then working, then idle — one click switches.
* Facts from the Store's published `sessions/list`; pixels the author's own.
*/
function SessionBoard({ store }) {
	const observable = useMemo(() => store?.watch("sessions/list"), [store]);
	const sessions = useSyncExternalStore(observable?.subscribe ?? noopSubscribe, () => observable?.getSnapshot() ?? NO_SESSIONS, () => NO_SESSIONS);
	const partition = useMemo(() => partitionBoard(sessions), [sessions]);
	const select = (row) => store?.act("selectSession", {
		id: row.id,
		...row.workspaceId ? { workspaceId: row.workspaceId } : {},
		...row.harness ? { harness: row.harness } : {}
	});
	if (!store) return /* @__PURE__ */ jsx("div", {
		style: {
			padding: 16,
			fontSize: 12,
			...text(3)
		},
		children: "This host mounted the board without a Store — nothing to show, honestly."
	});
	const empty = partition.needsYou.length + partition.working.length + partition.idle.length === 0;
	return /* @__PURE__ */ jsxs("div", {
		"data-slot": "session-board",
		style: {
			height: "100%",
			overflowY: "auto",
			padding: "4px 8px 12px"
		},
		children: [/* @__PURE__ */ jsx("style", {
			href: "dimension-session-board",
			precedence: "low",
			children: `@keyframes dimension-session-board-breathe{0%,100%{opacity:1}50%{opacity:.45}}@media (prefers-reduced-motion: reduce){[data-slot="session-board"] [data-kind="working"]{animation:none !important}}`
		}), empty ? /* @__PURE__ */ jsx("div", {
			style: {
				padding: "24px 8px",
				fontSize: 12,
				textAlign: "center",
				...text(3)
			},
			children: "No sessions yet — the board fills as you open them."
		}) : /* @__PURE__ */ jsxs(Fragment, { children: [
			partition.needsYou.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(SectionHead, {
				label: "Needs you",
				count: partition.needsYou.length,
				accent: true
			}), partition.needsYou.map((row) => /* @__PURE__ */ jsx(Row, {
				row,
				kind: "needsYou",
				onSelect: select
			}, row.id))] }),
			partition.working.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(SectionHead, {
				label: "Working",
				count: partition.working.length
			}), partition.working.map((row) => /* @__PURE__ */ jsx(Row, {
				row,
				kind: "working",
				onSelect: select
			}, row.id))] }),
			partition.idle.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(SectionHead, {
				label: "Idle",
				count: partition.idle.length
			}), partition.idle.map((row) => /* @__PURE__ */ jsx(Row, {
				row,
				kind: "idle",
				onSelect: select
			}, row.id))] })
		] })]
	});
}
//#endregion
export { SessionBoard, SessionBoard as default, partitionBoard };
