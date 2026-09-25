// The Forge View's entry: the standard handshake, or the preview.
//
// Inside a host, `useApp` (the public `@modelcontextprotocol/ext-apps/react`)
// creates the App, opens the PostMessageTransport and runs `ui/initialize`;
// `useHostStyles` applies the host's CSS variables and fonts, so the Stage's
// palette reads the host's own tokens. Every agent and part then comes over the
// bridge from the pack's App-only tools.
//
// With no host — `vite dev`, a top-level window, or `?preview` — there is no
// one to shake hands with, and the View runs its preview backend instead
// (seeded agents in localStorage), saying so on screen.
import { useApp, useDocumentTheme, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ForgeApp, type IncomingEvent } from "./forge-app";
import { eventFromToolResult, hostBackend, previewBackend } from "./forge-client";
import "./style.css";

function HostedForge() {
	// The mounting tool result (and every later one the host routes here —
	// a `forge_propose`) is how the agent reaches this View.
	const [incoming, setIncoming] = useState<IncomingEvent | null>(null);
	const { app, isConnected, error } = useApp({
		appInfo: { name: "general-agent-forge", version: "0.1.0" },
		capabilities: {},
		onAppCreated: created => {
			// Registered before `connect()` runs, so the mounting result is not missed.
			created.addEventListener("toolresult", result => {
				const event = eventFromToolResult(result);
				if (event !== null) setIncoming(previous => ({ event, seq: (previous?.seq ?? 0) + 1 }));
			});
		},
	});
	useHostStyles(app, app?.getHostContext());
	const theme = useDocumentTheme();
	const backend = useMemo(() => (app === null ? null : hostBackend(app)), [app]);

	if (error !== null) {
		return (
			<div className="fg-boot" role="alert">
				<h1>The Forge could not connect</h1>
				<p>{error.message}</p>
			</div>
		);
	}
	if (!isConnected || backend === null) {
		return (
			<div className="fg-boot" role="status" aria-live="polite">
				Connecting to the host…
			</div>
		);
	}
	return (
		<div className="fg-host" data-theme={theme}>
			<ForgeApp backend={backend} incoming={incoming} />
		</div>
	);
}

const hosted = window.parent !== window && !new URLSearchParams(window.location.search).has("preview");

const container = document.getElementById("root");
if (!container) throw new Error("forge view: missing #root");
createRoot(container).render(<StrictMode>{hosted ? <HostedForge /> : <ForgeApp backend={previewBackend()} incoming={null} />}</StrictMode>);
