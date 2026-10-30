import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useState } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import { DocPane } from "../doc-pane";
import { FOCUS } from "../focus-ring";
import type { SharedLayer } from "../pane-shared";
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
 * A document the Viewer opened as its own tab. The document shows at once; when the library holds the file (every
 * file the agent presents is stamped into it) the library's bar joins above it with Share, Comments and Details and
 * its comments are drawn on it, the same as opening it from the library. The pane is never remounted for that.
 */
export function LibraryDocTab({ app, tab, active, theme }: LibraryDocTabProps) {
	const tools = useMemo(() => createLibraryTools(app), [app]);
	const now = useMinuteClock();
	const [item, setItem] = useState<LibraryItem | null>(null);
	const [shared, setShared] = useState<SharedLayer | undefined>(undefined);
	const [toast, setToast] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `tab.revision` is the file changing on disk; its links' staleness is read again.
	useEffect(() => {
		let live = true;
		tools.itemAt(tab.key).then(
			found => {
				if (live) setItem(found);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [tools, tab.key, tab.revision]);

	const held = item !== null && item.state !== "discarded";
	return (
		<>
			{held ? (
				<ArtifactSurface
					app={app}
					tools={tools}
					item={item}
					thumb={null}
					active={active}
					now={now}
					theme={theme}
					onLayer={setShared}
					onPatched={setItem}
					onRestored={setItem}
					onDiscarded={() => {
						setItem(null);
						setShared(undefined);
					}}
					onShares={shares => setItem(current => (current === null ? current : { ...current, shares }))}
					onError={setToast}
				/>
			) : null}
			<DocPane app={app} tab={tab} active={active} theme={theme} embedded={held} {...(held && shared !== undefined ? { shared } : {})} />
			{toast === null ? null : (
				<div role="status" className="absolute inset-x-0 bottom-3 z-40 mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-lg border border-fr-border bg-fr-surface px-3 py-2 text-fr-sm text-fr-text shadow-lg">
					<span className="min-w-0 [overflow-wrap:anywhere]">{toast}</span>
					<button type="button" aria-label="Dismiss" onClick={() => setToast(null)} className={cn("shrink-0 rounded-sm p-0.5 text-fr-text-3 hover:bg-fr-surface-3", FOCUS)}>
						<Icon name="x" size={12} />
					</button>
				</div>
			)}
		</>
	);
}
