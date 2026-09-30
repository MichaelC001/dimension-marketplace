// The General Agents View's entry. Inside a host, `McpAppShell` (the App kit)
// owns the seat: the standard's handshake, the host's theme and tokens, and
// every tool result the host routes here — the mounting `forge_open` and each
// later `forge_propose`. With no host — `bun run dev`, a top-level window, or
// `?preview` — the page runs on its preview backend instead (`preview.ts`).
import { McpAppShell } from "@dimension/mcp-app-kit/react";
import { ThemeProvider } from "@fraym/ui/theme";
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ForgeApp, type IncomingEvent } from "./app";
import { eventFromToolResult, hostBackend } from "./forge-client";
import { previewBackend } from "./preview";
import "./app.css";

function Hosted() {
	const [incoming, setIncoming] = useState<IncomingEvent | null>(null);
	return (
		<McpAppShell
			appInfo={{ name: "General Agents", version: "0.3.0" }}
			onToolResult={result => {
				const event = eventFromToolResult(result);
				if (event !== null) setIncoming(previous => ({ event, seq: (previous?.seq ?? 0) + 1 }));
			}}
		>
			{app => <Connected app={app} incoming={incoming} />}
		</McpAppShell>
	);
}

function Connected({ app, incoming }: { readonly app: Parameters<typeof hostBackend>[0]; readonly incoming: IncomingEvent | null }) {
	const backend = useMemo(() => hostBackend(app), [app]);
	return <ForgeApp backend={backend} incoming={incoming} />;
}

/** The preview's starting screen, from `?state=` (see `preview.ts`). */
const PREVIEW_OPEN: Readonly<Record<string, string>> = { profile: "release-herald", readonly: "machinist", rich: "cmo", proposal: "release-herald" };

function Preview() {
	const params = new URLSearchParams(window.location.search);
	const backend = useMemo(() => previewBackend(params), []);
	const state = params.get("state") ?? "home";
	// The Machinist's proposal, as `forge_propose` would deliver it.
	const incoming = useMemo<IncomingEvent | null>(
		() =>
			state === "proposal"
				? {
						seq: 1,
						event: {
							kind: "proposal",
							proposal: {
								name: "release-herald",
								description: "Writes the changelog, the release notes and the upgrade guide, from what actually merged",
								skills: ["checkpoint", "officecli"],
								thinking: "high",
							},
						},
					}
				: null,
		[],
	);
	const open = PREVIEW_OPEN[state];
	return (
		<ThemeProvider defaultMode={params.get("theme") === "light" ? "light" : "dark"}>
			<div className="h-screen">
				<ForgeApp backend={backend} incoming={incoming} initial={{ ...(open !== undefined ? { open } : {}), create: state === "create" }} />
			</div>
		</ThemeProvider>
	);
}

const hosted = window.parent !== window && !new URLSearchParams(window.location.search).has("preview");
const root = document.getElementById("root");
if (!root) throw new Error("general agents view: missing #root");
createRoot(root).render(<StrictMode>{hosted ? <Hosted /> : <Preview />}</StrictMode>);
