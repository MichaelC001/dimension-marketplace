import { useMemo, useSyncExternalStore } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/pulse-mark.tsx
/** The structural subset of ONE `sessions/list` entry this beacon reads.
*
*  `liveStatus`, not `status` — and that distinction is the whole reason this
*  pack sat broken. The published field is `CatalogEntry.liveStatus`
*  (`packages/app/src/session-catalog.ts:36`, written by
*  `publishSessionCatalog`); this file read `status`, which no entry carries.
*  Invisible for as long as the mark path passed no store at all — `undefined`
*  store and wrong field name produce the SAME resting beacon, so the second
*  defect could only surface once the first was fixed (2026-09-02). A
*  structural type is not a spelling checker; the host's key is. */
var NO_SESSIONS = [];
var noopSubscribe = () => () => {};
/** An activity beacon: a quiet ring that ignites while ANY session is
*  working. Fact from the Store; pixels the author's own. */
function PulseMark({ size, active, hovered, animate, store }) {
	const observable = useMemo(() => store?.watch("sessions/list"), [store]);
	const working = useSyncExternalStore(observable?.subscribe ?? noopSubscribe, () => observable?.getSnapshot() ?? NO_SESSIONS, () => NO_SESSIONS).some((session) => session.liveStatus === "running");
	const glow = working ? "#34d399" : hovered ? "#a3a3a3" : "#525252";
	return /* @__PURE__ */ jsxs("div", {
		"data-slot": "pulse-mark",
		"aria-label": working ? "Sessions working" : "All quiet",
		style: {
			width: size,
			height: size,
			display: "flex",
			alignItems: "center",
			justifyContent: "center"
		},
		children: [/* @__PURE__ */ jsx("div", { style: {
			width: size * .52,
			height: size * .52,
			borderRadius: "9999px",
			border: `2px solid ${glow}`,
			boxShadow: working ? `0 0 ${size * .35}px ${glow}` : "none",
			opacity: active ? 1 : .75,
			transition: animate ? "box-shadow 300ms ease, border-color 300ms ease" : "none",
			...working && animate ? { animation: "pulse-mark-beat 1.6s ease-in-out infinite" } : {}
		} }), working && animate ? /* @__PURE__ */ jsx("style", { children: "@keyframes pulse-mark-beat{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}" }) : null]
	});
}
//#endregion
export { PulseMark, PulseMark as default };
