import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useState } from "react";
import type { DiscardOutcome, LibraryItem, ShareSummary } from "../../../../src/library/types";
import type { SharedLayer } from "../pane-shared";
import type { Theme } from "../renderers/types";
import { ArtifactPage } from "./artifact-page";
import { DiscardDialog } from "./discard-dialog";
import { type ArtifactPatchInput, errorText, type LibraryTools, type LinkedShare } from "./library-tools";
import { ShareDialog } from "./share-dialog";

export interface ArtifactSurfaceProps {
	readonly app: App;
	readonly tools: LibraryTools;
	readonly item: LibraryItem;
	readonly thumb: string | null;
	readonly active: boolean;
	readonly now: number;
	readonly theme: Theme;
	readonly onLayer?: (shared: SharedLayer) => void;
	readonly onBack?: () => void;
	readonly onPatched: (item: LibraryItem, change: ArtifactPatchInput) => void;
	readonly onRestored: (item: LibraryItem) => void;
	readonly onDiscarded: (item: LibraryItem, outcome: DiscardOutcome) => void;
	/**
	 * The item's links changed, as an update to apply to the links as they stand then (a share can take minutes, so never
	 * to the list it started from); `counted` when the set of open links did (a link made or stopped), not only a detail.
	 */
	readonly onShares: (change: (shares: readonly ShareSummary[]) => readonly ShareSummary[], counted: boolean) => void;
	readonly onError: (text: string) => void;
}

type Dialog = { readonly kind: "discard" } | { readonly kind: "share"; readonly shareId: string | null } | null;

function summaryOf(share: ShareSummary | LinkedShare): ShareSummary {
	if (!("link" in share)) return share;
	const { link: _link, outcome: _outcome, ...summary } = share;
	return summary;
}

export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/**
 * One artifact with everything that acts on it: its page (view, comments, share, details) and the share and discard
 * dialogs. The library's grid opens it over itself; a document the Viewer opened as its own tab wears it too, so a file
 * the agent presented shares and shows its comments the same way wherever it is open.
 */
export function ArtifactSurface({ app, tools, item, thumb, active, now, theme, onLayer, onBack, onPatched, onRestored, onDiscarded, onShares, onError }: ArtifactSurfaceProps) {
	const [dialog, setDialog] = useState<Dialog>(null);
	const patch = (change: ArtifactPatchInput): void => {
		tools.update(item.id, change).then(updated => onPatched(updated, change), cause => onError(errorText(cause)));
	};
	const restore = (): void => {
		tools.restore(item.id).then(onRestored, cause => onError(errorText(cause)));
	};
	return (
		<>
			<ArtifactPage
				app={app}
				tools={tools}
				item={item}
				thumb={thumb}
				active={active}
				now={now}
				theme={theme}
				{...(onLayer === undefined ? {} : { onLayer })}
				{...(onBack === undefined ? {} : { onBack })}
				onPatch={patch}
				onShare={() => setDialog({ kind: "share", shareId: null })}
				onManage={shareId => setDialog({ kind: "share", shareId })}
				onDiscard={() => setDialog({ kind: "discard" })}
				onRestore={restore}
				onShares={shares => onShares(() => shares, false)}
			/>
			{dialog?.kind === "discard" ? (
				<DiscardDialog
					tools={tools}
					item={item}
					onClose={() => setDialog(null)}
					onDiscarded={outcome => {
						setDialog(null);
						onDiscarded(item, outcome);
					}}
				/>
			) : null}
			{dialog?.kind === "share" ? (
				<ShareDialog
					tools={tools}
					item={item}
					shareId={dialog.shareId}
					onClose={() => setDialog(null)}
					onCreated={share => onShares(shares => [summaryOf(share), ...shares], true)}
					onChanged={share =>
						onShares(
							shares => shares.map(each => (each.id === share.id ? summaryOf(share) : each)),
							share.revokedAt !== undefined,
						)
					}
				/>
			) : null}
		</>
	);
}
