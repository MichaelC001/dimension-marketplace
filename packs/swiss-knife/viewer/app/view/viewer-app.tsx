// The View's root: an optional tab strip, one pane per open document, and the notice that floats over them. The root
// is `position: relative` and owns the whole frame, so a layer that must cover the viewer (the annotation overlay the
// annotation slice adds) mounts as a sibling of the panes inside `data-slot="viewer-root"`.
import type { App } from "@modelcontextprotocol/ext-apps";
import { Icon } from "@fraym/ui/icons";
import { useEffect, useState } from "react";
import { DocPane, FailedPane, Message } from "./doc-pane";
import { FirstWait, Opening } from "./opening";
import type { Theme } from "./renderers/types";
import { TabStrip } from "./tab-strip";
import { type ViewerStore, useViewerState } from "./tabs";

/**
 * How long a connected View waits for the tool result that tells it what to open before it says nothing is open. The
 * host sends that result the moment the handshake completes, so this is a ceiling for a host that never does, not a
 * delay anything normal waits out.
 */
const RESULT_WAIT_MS = 8000;

export function ViewerApp({ app, store }: { readonly app: App; readonly store: ViewerStore }) {
	const state = useViewerState(store);
	const theme: Theme = app.getHostContext()?.theme === "light" ? "light" : "dark";
	// What this View was first told to open, or `null` while it has been told nothing. An empty store BEFORE that is a
	// View still waiting on its first tool result; only AFTER it is the real empty state (every document closed). The
	// files it was first told about are the first wait's (see `opening.tsx`); every file opened later waits on its own.
	const [first, setFirst] = useState<ReadonlySet<string> | null>(null);
	if (first === null && (state.tabs.length > 0 || state.notice !== null)) setFirst(new Set(state.tabs.map(tab => tab.key)));
	return (
		<div data-slot="viewer-root" className="relative flex h-full min-h-0 flex-col bg-fr-bg text-fr-text">
			{state.tabs.length > 1 ? (
				<TabStrip
					tabs={state.tabs}
					activeKey={state.activeKey}
					onActivate={key => store.dispatch({ type: "activate", key })}
					onClose={key => store.dispatch({ type: "close", key })}
				/>
			) : null}
			<div className="relative min-h-0 flex-1">
				{state.tabs.length === 0 ? (
					state.notice !== null ? (
						<Message title="This file could not be opened" body={state.notice} />
					) : (
						<EmptyPane heard={first !== null} />
					)
				) : null}
				{state.tabs.map(tab => (
					<div key={tab.key} className={tab.key === state.activeKey ? "absolute inset-0" : "hidden"}>
						{tab.failure === undefined ? (
							<FirstWait of={first?.has(tab.key) === true}>
								<DocPane app={app} tab={tab} active={tab.key === state.activeKey} theme={theme} />
							</FirstWait>
						) : (
							<FailedPane tab={tab} failure={tab.failure} active={tab.key === state.activeKey} />
						)}
					</div>
				))}
				{/* With nothing open the notice is the pane's own card (above); this is for news about a file that is NOT the one on screen. It floats over the pane instead of sitting above it: a banner in the flow shoves a pane the human is looking at. */}
				{state.notice !== null && state.tabs.length > 0 ? (
					<div
						role="alert"
						className="absolute inset-x-2 top-2 z-20 flex animate-in items-start gap-2 rounded-md border border-fr-del-line bg-fr-del-bg px-3 py-2 text-fr-sm text-fr-del shadow-md fade-in-0 duration-[var(--fr-motion-base)]"
					>
						<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{state.notice}</span>
						<button type="button" aria-label="Dismiss" onClick={() => store.dispatch({ type: "dismiss" })} className="shrink-0 rounded-sm p-0.5 hover:bg-fr-surface-3">
							<Icon name="x" size={13} />
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * Nothing is open. Before the View has been told anything that is not yet true (the tool result that names the file
 * is a message away, and "Nothing open" painted for that frame is a flash of the wrong words): the opening surface's
 * connect stage stands in, and only a host that never sends one gets the statement after {@link RESULT_WAIT_MS}.
 */
function EmptyPane({ heard }: { readonly heard: boolean }) {
	const [gaveUp, setGaveUp] = useState(false);
	useEffect(() => {
		if (heard) return;
		const timer = setTimeout(() => setGaveUp(true), RESULT_WAIT_MS);
		return () => clearTimeout(timer);
	}, [heard]);
	if (!heard && !gaveUp) {
		return (
			<FirstWait>
				<Opening name="" stage="connect" />
			</FirstWait>
		);
	}
	return (
		<div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
			<p className="text-fr-md font-semibold text-fr-text">Nothing open</p>
			<p className="max-w-[40ch] text-fr-sm text-fr-text-3">Ask the assistant to open a file and it appears here.</p>
		</div>
	);
}
