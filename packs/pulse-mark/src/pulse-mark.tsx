// Pulse Mark — the STORE's demo component, and the answer to "what does a
// third-party author import?" (doc 68 §3 + §9.1 Q1). This file is written the
// way a stranger with their own design system (shadcn, their own tokens,
// whatever) would write it:
//
//   THE ENTIRE IMPORT SURFACE — three lines, two grants and a type:
//
//   1. `react`                       — the runtime grant every component gets.
//   2. `useStoreKey` from `@fraym/ui` — the ONE granted binding. This is not
//      "using Fraym's UI": no Fraym component, class, token, or style is
//      imported — the kit here is only the door the HOST's Store arrives
//      through (doc 68 §3.7: the kit holds the ~20-line React binding; the
//      instance, the key space, and every writer live in the product).
//   3. `type SessionSnapshot` from `@fraym/driver` — TYPES ONLY, erased at
//      compile; the contract package has zero dependencies precisely so a
//      pack can lean on it without inheriting anything.
//
// Everything drawn below is the author's own: inline styles standing in for
// their design system. Swap them for shadcn primitives and nothing else in
// this file changes — that is the point.
//
// Data flow (the three verbs, doc 68 §3.2): this component NAMES A KEY —
// `sessions/list`, root scope — and selects "is anything running" out of it.
// It re-renders only when that boolean flips (selector-gated), never per
// session event. It never writes: a mark has NO intent channel by contract
// (the host owns the click), so `act` does not appear here.

import type { SessionSnapshot } from "@fraym/driver";
import type { ReactNode } from "react";
import { useStoreKey } from "@fraym/ui";

/** The `mark` slot contract's data, restated STRUCTURALLY — matching is by
 *  slot NAME (doc 68 §4.1), never by a shared type import. */
export interface PulseMarkProps {
	readonly item: { readonly id: string; readonly label: string };
	readonly size: number;
	readonly active: boolean;
	readonly hovered: boolean;
	readonly animate: boolean;
}

/** An activity beacon: a quiet ring that ignites while ANY session is
 *  working. Fact from the Store; pixels the author's own. */
export function PulseMark({ size, active, hovered, animate }: PulseMarkProps): ReactNode {
	// read + watch in one hook, selector-gated: an unrelated catalog change
	// (a rename, a pin, a new idle row) re-renders this component ZERO times.
	const working = useStoreKey<readonly SessionSnapshot[], boolean>(
		"sessions/list",
		sessions => (sessions ?? []).some(session => session.status === "running"),
	);

	const glow = working ? "#34d399" : hovered ? "#a3a3a3" : "#525252";
	return (
		<div
			data-slot="pulse-mark"
			aria-label={working ? "Sessions working" : "All quiet"}
			style={{
				width: size,
				height: size,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<div
				style={{
					width: size * 0.52,
					height: size * 0.52,
					borderRadius: "9999px",
					border: `2px solid ${glow}`,
					boxShadow: working ? `0 0 ${size * 0.35}px ${glow}` : "none",
					opacity: active ? 1 : 0.75,
					transition: animate ? "box-shadow 300ms ease, border-color 300ms ease" : "none",
					...(working && animate ? { animation: "pulse-mark-beat 1.6s ease-in-out infinite" } : {}),
				}}
			/>
			{working && animate ? (
				<style>{"@keyframes pulse-mark-beat{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}"}</style>
			) : null}
		</div>
	);
}
