import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/env-minimal.tsx
var card = {
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
	color: "var(--fr-text)"
};
var label = {
	fontSize: 10,
	letterSpacing: .4,
	textTransform: "uppercase",
	color: "var(--fr-text-3)"
};
var rowStyle = {
	display: "flex",
	justifyContent: "space-between",
	gap: 8
};
var quiet = { color: "var(--fr-text-2)" };
var mono = {
	fontFamily: "var(--fr-font-mono, ui-monospace)",
	fontSize: 11
};
function Line({ name, value }) {
	return /* @__PURE__ */ jsxs("div", {
		style: rowStyle,
		children: [/* @__PURE__ */ jsx("span", {
			style: quiet,
			children: name
		}), /* @__PURE__ */ jsx("span", {
			style: mono,
			children: value
		})]
	});
}
/**
* The pinned environment widget.
*
* Absence is stated, never faked: with no session bound, or a session whose
* journal carries no SCM facts yet, the card says so instead of drawing a
* confident zero (the shipped card's own rule — an unverified answer is worse
* than an honest skeleton).
*/
function MinimalEnvironment(props) {
	const ref = props.sessionRef;
	const snapshot = ref ? props.sessionCatalog?.find((row) => row.ref?.sessionId === ref.sessionId && row.ref?.workspaceId === ref.workspaceId) : void 0;
	const checkout = snapshot?.workspace ?? props.workspace ?? null;
	const ledger = snapshot?.scmLedger ?? null;
	const items = props.tasks ?? [];
	let running = 0;
	for (const task of items) if (task.status === "in_progress") running += 1;
	return /* @__PURE__ */ jsxs("div", {
		style: card,
		"data-slot": "env-minimal",
		children: [
			/* @__PURE__ */ jsx("div", {
				style: label,
				children: "Environment"
			}),
			checkout ? /* @__PURE__ */ jsxs(Fragment, { children: [
				/* @__PURE__ */ jsx(Line, {
					name: "checkout",
					value: checkout.displayName ?? checkout.path ?? "unknown"
				}),
				/* @__PURE__ */ jsx(Line, {
					name: "branch",
					value: checkout.git?.currentBranch ?? "—"
				}),
				/* @__PURE__ */ jsx(Line, {
					name: "worktree",
					value: checkout.git?.worktree === void 0 ? "—" : checkout.git.worktree ? "yes" : "no"
				})
			] }) : /* @__PURE__ */ jsx("span", {
				style: quiet,
				children: "No workspace bound."
			}),
			/* @__PURE__ */ jsx("div", {
				style: label,
				children: "This session"
			}),
			ledger?.available ? /* @__PURE__ */ jsxs(Fragment, { children: [
				/* @__PURE__ */ jsx(Line, {
					name: "commits",
					value: ledger.committedCount ?? 0
				}),
				/* @__PURE__ */ jsx(Line, {
					name: "files touched",
					value: ledger.touchedCount ?? 0
				}),
				/* @__PURE__ */ jsx(Line, {
					name: "unpushed",
					value: ledger.unpushedCount ?? 0
				}),
				ledger.recentTouchedPaths && ledger.recentTouchedPaths.length > 0 ? /* @__PURE__ */ jsx("div", {
					style: {
						...quiet,
						...mono,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis"
					},
					children: ledger.recentTouchedPaths.slice(0, 3).join(" · ")
				}) : null
			] }) : /* @__PURE__ */ jsx("span", {
				style: quiet,
				children: "No source-control facts recorded yet."
			}),
			items.length > 0 ? /* @__PURE__ */ jsx(Line, {
				name: "tasks",
				value: `${running} running / ${items.length}`
			}) : null,
			snapshot?.hasBackgroundWork ? /* @__PURE__ */ jsx("span", {
				style: quiet,
				children: "Background work in flight."
			}) : null,
			snapshot?.recap?.text ? /* @__PURE__ */ jsx("span", {
				style: quiet,
				children: snapshot.recap.text.slice(0, 140)
			}) : null
		]
	});
}
//#endregion
export { MinimalEnvironment, MinimalEnvironment as default };
