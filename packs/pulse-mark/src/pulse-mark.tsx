// Pulse Mark — the Store's demo component, and the answer to "what does a
// third-party author import?" (doc 68 §3 + §3.5).
//
//   THE ENTIRE IMPORT SURFACE: `react`. Nothing else. Look at line 1.
//
// The author's UI library is their own business — the inline styles below
// stand in for shadcn, their tokens, anything. The HOST's facts arrive the
// same way the rest of their props do: the mount boundary (`SlotFill`) hands
// the Store IN as the `store` prop, and React's BUILT-IN
// `useSyncExternalStore` consumes the contract's `{getSnapshot, subscribe}`
// shape directly — the contract is framework-free on purpose (doc 68 §3.4),
// so no kit binding is required to read it. (`useStoreKey` from `@fraym/ui`
// exists as optional sugar — selector-gated re-renders — for authors who
// WANT a dependency; this file demonstrates the floor: zero.)
//
// Both the store handle and the props are typed STRUCTURALLY: matching is by
// slot NAME and published shape (doc 68 §4.1/§3.3), never by a shared type
// import. A component written against a newer host degrades honestly — an
// unknown key reads `undefined`, never a throw.

import { type ReactNode, useMemo, useSyncExternalStore } from "react";

/** The Store's contract shape, restated structurally (doc 68 §3.4 [S-10]). */
interface HostStoreShape {
	watch<T>(key: string): { getSnapshot(): T | undefined; subscribe(listener: () => void): () => void };
}

/** The `mark` slot contract's data + the mount-boundary store hand-in. */
export interface PulseMarkProps {
	readonly item: { readonly id: string; readonly label: string };
	readonly size: number;
	readonly active: boolean;
	readonly hovered: boolean;
	readonly animate: boolean;
	/** Handed in by the host's mount boundary; absent on a storeless mount —
	 *  the beacon then rests dark, which is its honest absence UI. */
	readonly store?: HostStoreShape;
}

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
const NO_SESSIONS: readonly { readonly liveStatus?: string }[] = [];
const noopSubscribe = () => () => {};

/** An activity beacon: a quiet ring that ignites while ANY session is
 *  working. Fact from the Store; pixels the author's own. */
export function PulseMark({ size, active, hovered, animate, store }: PulseMarkProps): ReactNode {
	// read + watch with BARE React: the observable IS what
	// useSyncExternalStore wants (memoized — `watch` may mint a handle per
	// call, and a stable `subscribe` identity is the subscriber's manners).
	// No host, no key → undefined → rest state.
	const observable = useMemo(
		() => store?.watch<readonly { readonly liveStatus?: string }[]>("sessions/list"),
		[store],
	);
	const sessions = useSyncExternalStore(
		observable?.subscribe ?? noopSubscribe,
		() => observable?.getSnapshot() ?? NO_SESSIONS,
		() => NO_SESSIONS,
	);
	const working = sessions.some(session => session.liveStatus === "running");

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
