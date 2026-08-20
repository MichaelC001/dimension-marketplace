import { jsx } from "react/jsx-runtime";
//#region src/mochi-mark.tsx
/** A soft pink mochi that squints when its space is active and perks up on
*  hover. Pure inline drawing — no kit imports, no stylesheet, no assets. */
function MochiMark({ item, size, active, hovered, animate }) {
	const face = active ? "≧◡≦" : hovered ? "◕◡◕" : "•ᴗ•";
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "mochi-mark",
		"data-active": active || void 0,
		title: item.label,
		style: {
			width: size,
			height: size,
			borderRadius: size * .42,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			fontSize: Math.max(8, size * .32),
			lineHeight: 1,
			userSelect: "none",
			background: active ? "linear-gradient(145deg, #f7b8d0, #ef8fb6)" : "linear-gradient(145deg, #f6d6e4, #eec3d6)",
			color: "#7a3a57",
			boxShadow: active ? "0 0 0 2px #ef8fb6, 0 2px 6px rgba(239,143,182,.45)" : "0 1px 3px rgba(0,0,0,.25)",
			transition: animate ? "background .2s ease, box-shadow .2s ease, transform .2s ease" : "none",
			transform: hovered && animate ? "scale(1.08)" : "none"
		},
		children: face
	});
}
//#endregion
export { MochiMark, MochiMark as default };
