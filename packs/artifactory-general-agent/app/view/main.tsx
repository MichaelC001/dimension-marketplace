// The Forge View's entry. This slice renders the preview (standalone, seeded
// agents, localStorage). The host handshake — `useApp` from
// `@modelcontextprotocol/ext-apps/react` plus the pack's app-only agent tools —
// arrives with the pack's MCP server, the next slice of the Forge epic.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ForgeApp } from "./forge-app";
import "./style.css";

const container = document.getElementById("root");
if (!container) throw new Error("forge view: missing #root");
createRoot(container).render(
	<StrictMode>
		<ForgeApp />
	</StrictMode>,
);
