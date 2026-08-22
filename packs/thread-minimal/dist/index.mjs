import { useMemo, useSyncExternalStore } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/thread-minimal.tsx
var NO_ROWS = [];
var noop = () => {};
var text = (tone) => ({ color: tone === 1 ? "var(--fr-text)" : `var(--fr-text-${tone})` });
/** One transcript row: a quiet role label and the row's text. Tool cards,
*  reasoning, images — deliberately not rendered; this is the MINIMAL thread. */
function Row({ row }) {
	if (row.role === "divider") return /* @__PURE__ */ jsxs("div", {
		style: {
			padding: "6px 0",
			fontSize: 11,
			textAlign: "center",
			...text(3)
		},
		children: [
			"— ",
			row.variant ?? "divider",
			" —"
		]
	});
	const body = row.blocks.filter((block) => block.type === "text" && typeof block.text === "string" && block.text.length > 0).map((block) => block.text).join("\n");
	if (body.length === 0) return null;
	return /* @__PURE__ */ jsxs("div", {
		style: {
			padding: "6px 0",
			borderBottom: "1px solid var(--fr-border-soft)"
		},
		children: [/* @__PURE__ */ jsx("div", {
			style: {
				fontSize: 10,
				letterSpacing: "0.08em",
				textTransform: "uppercase",
				marginBottom: 2,
				...row.role === "user" ? { color: "var(--fr-accent)" } : text(3)
			},
			children: row.role === "user" ? "You" : "Agent"
		}), /* @__PURE__ */ jsx("div", {
			style: {
				fontSize: 12,
				lineHeight: 1.5,
				whiteSpace: "pre-wrap",
				...text(row.role === "user" ? 1 : 2)
			},
			children: body
		})]
	});
}
/**
* The compact transcript: role + text rows from the Store's published
* `session/<id>/transcript` cell, the working verb at the tail from
* `session/<id>/verb`. No wisp, no tool cards — minimal but REAL.
*/
function MinimalThread({ sessionRef, store }) {
	const sessionId = sessionRef?.sessionId;
	const transcriptObservable = useMemo(() => store && sessionId ? store.watch(`session/${sessionId}/transcript`) : null, [store, sessionId]);
	const verbObservable = useMemo(() => store && sessionId ? store.watch(`session/${sessionId}/verb`) : null, [store, sessionId]);
	const rows = useSyncExternalStore((listener) => transcriptObservable?.subscribe(listener) ?? noop, () => transcriptObservable?.getSnapshot() ?? NO_ROWS, () => NO_ROWS);
	const verb = useSyncExternalStore((listener) => verbObservable?.subscribe(listener) ?? noop, () => verbObservable?.getSnapshot() ?? null, () => null);
	if (!store || !sessionId) return /* @__PURE__ */ jsx("div", {
		style: {
			padding: 16,
			fontSize: 12,
			...text(3)
		},
		children: "This host mounted the thread without a Store and a session — nothing to show, honestly."
	});
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "thread-minimal",
		style: {
			height: "100%",
			minHeight: 0,
			flex: 1,
			overflowY: "auto",
			display: "flex",
			flexDirection: "column"
		},
		children: /* @__PURE__ */ jsxs("div", {
			style: {
				width: "100%",
				maxWidth: 680,
				margin: "0 auto",
				padding: "16px 20px 24px"
			},
			children: [rows.length === 0 ? /* @__PURE__ */ jsx("div", {
				style: {
					padding: "24px 8px",
					fontSize: 12,
					textAlign: "center",
					...text(3)
				},
				children: "No messages yet — the transcript fills as the session works."
			}) : rows.map((row) => /* @__PURE__ */ jsx(Row, { row }, row.id)), verb?.visible && verb.message && /* @__PURE__ */ jsxs("div", {
				style: {
					padding: "10px 0 0",
					fontSize: 11,
					fontStyle: "italic",
					color: "var(--fr-accent)"
				},
				children: [verb.message, "…"]
			})]
		})
	});
}
//#endregion
export { MinimalThread, MinimalThread as default };
