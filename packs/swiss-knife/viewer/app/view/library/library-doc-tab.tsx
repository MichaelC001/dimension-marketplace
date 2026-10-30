import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useState } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import { DocPane } from "../doc-pane";
import type { SharedLayer } from "../pane-shared";
import type { Theme } from "../renderers/types";
import type { DocTab } from "../tabs";
import { ArtifactSurface, useMinuteClock } from "./artifact-surface";
import { LibraryToast } from "./library-toast";
import { createLibraryTools } from "./library-tools";

export interface LibraryDocTabProps {
	readonly app: App;
	readonly tab: DocTab;
	readonly active: boolean;
	readonly theme: Theme;
}

/**
 * A document the Viewer opened as its own tab. The document shows at once; when the library holds the file (every
 * file the agent presented is stamped into it) the library's bar joins above it with Share, Comments and Details and
 * its comments are drawn on it, the same as opening it from the library. The pane is never remounted for that, and a
 * tab the person has not looked at yet asks nothing of the library or of the share hosts.
 */
export function LibraryDocTab({ app, tab, active, theme }: LibraryDocTabProps) {
	const tools = useMemo(() => createLibraryTools(app), [app]);
	const now = useMinuteClock();
	const [seen, setSeen] = useState(active);
	const [item, setItem] = useState<LibraryItem | null>(null);
	const [shared, setShared] = useState<SharedLayer | undefined>(undefined);
	const [toast, setToast] = useState<string | null>(null);

	if (active && !seen) setSeen(true);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `tab.revision` is the file changing on disk; its links' staleness is read again.
	useEffect(() => {
		if (!seen) return;
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
	}, [tools, seen, tab.key, tab.revision]);

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
					onShares={change => setItem(current => (current === null ? current : { ...current, shares: change(current.shares) }))}
					onError={setToast}
				/>
			) : null}
			<DocPane app={app} tab={tab} active={active} theme={theme} embedded={held} {...(held && shared !== undefined ? { shared } : {})} />
			{toast === null ? null : <LibraryToast text={toast} onDismiss={() => setToast(null)} />}
		</>
	);
}
