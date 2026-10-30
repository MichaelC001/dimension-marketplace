import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useState } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import { DocPane } from "../doc-pane";
import { FOCUS } from "../focus-ring";
import { Opening } from "../opening";
import type { Theme } from "../renderers/types";
import type { DocTab } from "../tabs";
import { ArtifactSurface, useMinuteClock } from "./artifact-surface";
import { createLibraryTools } from "./library-tools";

export interface LibraryDocTabProps {
	readonly app: App;
	readonly tab: DocTab;
	readonly active: boolean;
	readonly theme: Theme;
}

/**
 * A document the Viewer opened as its own tab. When the library holds the file (every file the agent presents is
 * stamped into it), the tab wears the library's page around the document: Share, Comments and Details, the same as
 * opening it from the library. A file the library does not hold, or discarded, is the plain document.
 */
export function LibraryDocTab({ app, tab, active, theme }: LibraryDocTabProps) {
	const tools = useMemo(() => createLibraryTools(app), [app]);
	const now = useMinuteClock();
	const [item, setItem] = useState<LibraryItem | null | undefined>(undefined);
	const [toast, setToast] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `tab.revision` is the file changing on disk; its links' staleness is read again.
	useEffect(() => {
		let live = true;
		tools.itemAt(tab.key).then(
			found => {
				if (live) setItem(found);
			},
			() => {
				if (live) setItem(null);
			},
		);
		return () => {
			live = false;
		};
	}, [tools, tab.key, tab.revision]);

	if (item === undefined) return <Opening name={tab.filename} stage="read" />;
	if (item === null || item.state === "discarded") return <DocPane app={app} tab={tab} active={active} theme={theme} />;
	return (
		<div className={active ? "absolute inset-0" : "hidden"}>
			<ArtifactSurface
				app={app}
				tools={tools}
				item={item}
				thumb={null}
				active={active}
				now={now}
				theme={theme}
				tab={tab}
				onPatched={setItem}
				onRestored={setItem}
				onDiscarded={() => setItem(null)}
				onShares={shares => setItem(current => (current === null || current === undefined ? current : { ...current, shares }))}
				onError={setToast}
			/>
			{toast === null ? null : (
				<div role="status" className="absolute inset-x-0 bottom-3 z-40 mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-lg border border-fr-border bg-fr-surface px-3 py-2 text-fr-sm text-fr-text shadow-lg">
					<span className="min-w-0 [overflow-wrap:anywhere]">{toast}</span>
					<button type="button" aria-label="Dismiss" onClick={() => setToast(null)} className={cn("shrink-0 rounded-sm p-0.5 text-fr-text-3 hover:bg-fr-surface-3", FOCUS)}>
						<Icon name="x" size={12} />
					</button>
				</div>
			)}
		</div>
	);
}
