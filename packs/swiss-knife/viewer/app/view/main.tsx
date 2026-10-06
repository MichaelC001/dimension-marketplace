// The View's entry: the standard handshake through the kit's seat, then the viewer.
import { StrictMode, useState } from "react";
import { flushSync } from "react-dom";
import { McpAppShell } from "@dimension/mcp-app-kit/react";
import { createRoot } from "react-dom/client";
import { FirstWait, Opening } from "./opening";
import { actionFromResult } from "./result";
import { createViewerStore } from "./tabs";
import { ViewerApp } from "./viewer-app";
import { finishMediaWork } from "./media-lifecycle";
import "./app.css";

// Module scope, not component state: the tool result that MOUNTED this View lands
// before React's first effect, and a store owned by a component would drop it.
const store = createViewerStore();

// The shell paints this from the View's very first frame until the handshake completes: the same surface the host
// holds over the iframe while it waits (ArtifactOpening), so a host that shows nothing of its own still shows no blank.
// The `relative` box is what the surface fills; it has no name to give yet (the tool result that names the file has not
// arrived). It is the first of the View's openings, so its silence runs from the document's start (see `opening.tsx`).
function Root() {
	const [closing, setClosing] = useState(false);
	return (
		<McpAppShell
			appInfo={{ name: "viewer", version: "0.1.0" }}
			onAppCreated={app => {
				app.onteardown = async () => {
					flushSync(() => setClosing(true));
					await finishMediaWork(app);
					return {};
				};
			}}
			onToolResult={result => store.dispatch(actionFromResult(result))}
			fallback={
				<FirstWait>
					<div className="relative h-full">
						<Opening name="" stage="connect" />
					</div>
				</FirstWait>
			}
		>
			{app => closing ? null : <ViewerApp app={app} store={store} />}
		</McpAppShell>
	);
}

const container = document.getElementById("root");
if (!container) throw new Error("viewer view: missing #root");
const root = createRoot(container);
root.render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
