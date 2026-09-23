// The View's entry point: the standard handshake, nothing else.
//
// `useApp` (from the public `@modelcontextprotocol/ext-apps/react`) creates the
// App, opens the PostMessageTransport to the host and runs `ui/initialize`;
// `useHostStyles` applies the host's own CSS variables and fonts, and
// `useDocumentTheme` reports the theme the host set on the document. No private
// kit, no host window access, no hard-coded endpoint — every byte of state
// comes over the bridge.
import { useApp, useDocumentTheme, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserState } from "../../src/contracts";
import { BrowserApp } from "./browser-app";
import { stateFromToolResult } from "./browser-client";
import "@fraym/ui/theme.css"
import "./style.css";

function Root() {
	// The mounting tool result (and any later one the host routes to this View)
	// carries the BrowserState — the only place this View learns a browserId.
	const [toolState, setToolState] = useState<{ state: BrowserState; seq: number } | null>(null);

	const { app, isConnected, error } = useApp({
		appInfo: { name: "browser", version: "0.1.0" },
		capabilities: {},
		onAppCreated: created => {
			// `addEventListener` rather than the deprecated `ontoolresult` setter:
			// it composes with any other listener instead of replacing it, and it
			// is registered here so it is in place before `connect()` runs.
			created.addEventListener("toolresult", result => {
				const state = stateFromToolResult(result);
				if (state !== null) setToolState(previous => ({ state, seq: (previous?.seq ?? 0) + 1 }));
			});
		},
	});
	useHostStyles(app, app?.getHostContext());
	const theme = useDocumentTheme();

	if (error !== null) {
		return (
			<div className="bx-boot" role="alert">
				<h1>Browser view could not connect</h1>
				<p>{error.message}</p>
			</div>
		);
	}
	if (!isConnected || app === null) {
		return (
			<div className="bx-boot" role="status" aria-live="polite">
				Connecting to the host…
			</div>
		);
	}
	return (
		<div className="bx-root" data-theme={theme}>
			<BrowserApp app={app} toolState={toolState} />
		</div>
	);
}

const container = document.getElementById("root");
if (!container) throw new Error("browser view: missing #root");
createRoot(container).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
