// The design harness: the page exactly as the host mounts it (a workspace
// surface fill with a fenced `store`), over the fixture host, with the real
// `@fraym/ui` kit and the real `@fraym/vibr` faces, and Traction's contributed
// X face painted over the real presence bridge.
import "@fraym/ui/fonts.css";
import "@fraym/ui/theme.css";
import "@fraym/vibr/avatars.css";
import { agentPresenceBindings } from "@fraym/ui";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { GeneralAgentsPage } from "../page/index";
import type { AgentFact, BridgedPresences, FaceBinding } from "../page/types";
import { fixtureStore } from "./fixture";

const params = new URLSearchParams(location.search);
const store = fixtureStore(params);

const tractionVibrs = new URL("../../../../traction/packs/traction-vibrs/dist/avatar.js", import.meta.url).href;
const brandMarks = new URL("../../brand-marks/dist/avatar.js", import.meta.url).href;
const BRIDGED: BridgedPresences = [
	{ id: "plugin:traction-vibrs/x-vibr", componentId: "x-vibr", label: "X", bundleUrl: tractionVibrs },
	{ id: "plugin:traction-vibrs/reddit-vibr", componentId: "reddit-vibr", label: "Reddit", bundleUrl: tractionVibrs },
	{ id: "plugin:traction-vibrs/linkedin-vibr", componentId: "linkedin-vibr", label: "LinkedIn", bundleUrl: tractionVibrs },
	{ id: "plugin:brand-marks/youtube", componentId: "youtube", label: "YouTube", bundleUrl: brandMarks },
];

function Host() {
	const facts = store.watch<readonly AgentFact[]>("agents/list").getSnapshot();
	// The host resolves every agent's face exactly this way (fraym-frame-model-core).
	const agentPresences = useMemo(() => agentPresenceBindings(facts as Parameters<typeof agentPresenceBindings>[0], BRIDGED) as ReadonlyMap<string, FaceBinding>, [facts]);
	return (
		<div className="h-screen bg-fr-bg text-fr-text">
			<GeneralAgentsPage
				store={store}
				avatar="blob"
				agentPresences={agentPresences}
				bridgedPresences={BRIDGED}
				workspace={{ workspaceId: "storefront", path: "~/code/storefront", displayName: "storefront" }}
				onIntent={intent => console.info("[harness] intent", intent)}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("#root missing");
createRoot(root).render(
	<StrictMode>
		<Host />
	</StrictMode>,
);
