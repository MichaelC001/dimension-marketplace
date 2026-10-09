// The Simulator panel — the dock's Simulator tab. One job: put the device pane
// beside the conversation the person is in.
//
//   THE IMPORT SURFACE: `react` + the granted `@fraym/ui` bricks.
//
// INTENT: `store.act("openArtifactoryView", { tool: "device_open", args })`,
// admitted by the `artifactory:open` grant the manifest declares. The host
// resolves the server itself (this pack's artifactory) and opens the View in the
// seat's session; a refusal is the host's console warning, never a throw.
//
// Phone: `none`. The pane is a desktop surface; on a phone the host draws its
// own "Open on your computer" card for it.

import { Button } from "@fraym/ui";
import { useMemo } from "react";

/** The Store's contract shape, restated by the members this panel uses. */
export interface SimulatorStoreShape {
	act(intent: string, payload?: unknown): void;
}

export interface SimulatorDockProps {
	readonly sessionId: string | null;
	readonly store?: SimulatorStoreShape;
}

export function SimulatorDock({ sessionId, store }: SimulatorDockProps) {
	// The View opens in the seat's session, so with none there is nowhere to open it.
	const open = useMemo<(() => void) | null>(() => (store && sessionId ? () => store.act("openArtifactoryView", { tool: "device_open", args: {} }) : null), [store, sessionId]);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3" data-slot="simulator-dock">
			<p className="text-fr-sm text-fr-text-2">An Android emulator beside your chat. Watch it, tap and type on it, and let your agent drive the same device.</p>
			<div>
				<Button type="button" size="sm" disabled={!open} onClick={() => open?.()}>
					Open simulator
				</Button>
			</div>
			{!open ? (
				<p className="text-fr-xs text-fr-text-3" data-slot="simulator-dock-hint">
					Start or open a chat first — the simulator opens beside it.
				</p>
			) : null}
		</div>
	);
}
