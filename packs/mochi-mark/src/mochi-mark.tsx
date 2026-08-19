// Mochi Mark — the first REAL third-party component of the assembly spine
// (doc 68 §9 Phase 1: "prove it on `mark`, never `rail`").
//
// THE EXTERNALS CONTRACT THIS COMPONENT SETTLES (doc 68 §9.1 Q1, board
// mszuswhfoqpcmm): for the `mark` contract the import map grants a component
// exactly ONE external — `react` — and NOTHING from `@fraym/ui`. The props
// are typed STRUCTURALLY against the published `mark` convention
// (doc 68 §4.1: Data in — item · size · active · hovered · animate), so this
// file compiles with no kit dependency at all. Every value it draws with is
// self-contained; the host's reduced-motion judgement arrives as `animate`,
// already decided (a mark that had to ask could forget to).
import type { ReactNode } from "react";

/** The `mark` slot contract's data, restated structurally (the convention is
 *  the contract — matching is by slot NAME, never by a shared type import). */
export interface MochiMarkProps {
	readonly item: { readonly id: string; readonly label: string };
	readonly size: number;
	readonly active: boolean;
	readonly hovered: boolean;
	readonly animate: boolean;
}

/** A soft pink mochi that squints when its space is active and perks up on
 *  hover. Pure inline drawing — no kit imports, no stylesheet, no assets. */
export function MochiMark({ item, size, active, hovered, animate }: MochiMarkProps): ReactNode {
	const face = active ? "≧◡≦" : hovered ? "◕◡◕" : "•ᴗ•";
	return (
		<div
			data-slot="mochi-mark"
			data-active={active || undefined}
			title={item.label}
			style={{
				width: size,
				height: size,
				borderRadius: size * 0.42,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontSize: Math.max(8, size * 0.32),
				lineHeight: 1,
				userSelect: "none",
				background: active
					? "linear-gradient(145deg, #f7b8d0, #ef8fb6)"
					: "linear-gradient(145deg, #f6d6e4, #eec3d6)",
				color: "#7a3a57",
				boxShadow: active ? "0 0 0 2px #ef8fb6, 0 2px 6px rgba(239,143,182,.45)" : "0 1px 3px rgba(0,0,0,.25)",
				transition: animate ? "background .2s ease, box-shadow .2s ease, transform .2s ease" : "none",
				transform: hovered && animate ? "scale(1.08)" : "none",
			}}
		>
			{face}
		</div>
	);
}
