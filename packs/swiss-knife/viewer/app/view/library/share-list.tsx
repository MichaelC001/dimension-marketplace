import { Button } from "@fraym/ui/elements/button";
import { Icon, type IconName } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { useEffect, useRef, useState } from "react";
import type { ShareSummary } from "../../../../src/library/types";
import { copyText } from "../copy";
import { errorText, type LibraryTools } from "./library-tools";
import { accessLabel, fileChanged, shareDetail, shareStatus, shortDate } from "./share-options";

export interface AccessListProps {
	readonly tools: LibraryTools;
	readonly shares: readonly ShareSummary[];
	readonly now: number;
	/** The file's own modification time: a link made before it shows an older version and offers to update. */
	readonly mtimeMs: number;
	readonly canShare: boolean;
	readonly onShare: () => void;
	readonly onManage: (shareId: string) => void;
	readonly onUpdated: (share: ShareSummary) => void;
}

function Badge({ icon, muted }: { readonly icon: IconName; readonly muted?: boolean }) {
	return (
		<span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", muted === true ? "bg-fr-surface-2 text-fr-text-3" : "bg-fr-surface-3 text-fr-text-2")}>
			<Icon name={icon} size={15} />
		</span>
	);
}

export function AccessList({ tools, shares, now, mtimeMs, canShare, onShare, onManage, onUpdated }: AccessListProps) {
	const links = useRef(new Map<string, string>());
	const [copied, setCopied] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const timer = useRef(0);
	useEffect(() => () => window.clearTimeout(timer.current), []);

	const live = shares.filter(share => shareStatus(share, now) === "live");
	const stopped = shares.filter(share => shareStatus(share, now) !== "live");

	const copyLink = async (shareId: string): Promise<void> => {
		setError(null);
		let link = links.current.get(shareId);
		if (link === undefined) {
			setBusy(shareId);
			try {
				link = await tools.link(shareId);
				links.current.set(shareId, link);
			} catch (cause) {
				setError(errorText(cause));
				return;
			} finally {
				setBusy(null);
			}
		}
		if (!(await copyText(link))) {
			setError("The browser blocked the copy. Press Copy link again.");
			return;
		}
		setCopied(shareId);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied(null), 1800);
	};

	const update = (shareId: string): void => {
		setError(null);
		setBusy(`update:${shareId}`);
		tools.newVersion(shareId).then(
			summary => {
				setBusy(null);
				onUpdated(summary);
			},
			cause => {
				setBusy(null);
				setError(errorText(cause));
			},
		);
	};

	return (
		<div className="flex flex-col gap-3">
			{live.length === 0 ? (
				<div className="flex items-center gap-2.5">
					<Badge icon="lock" muted />
					<div className="min-w-0 flex-1">
						<div className="text-fr-sm text-fr-text">Only you</div>
						<div className="text-fr-xs text-fr-text-3">{stopped.length === 0 ? "Not shared yet" : "No link is open right now"}</div>
					</div>
					{canShare ? (
						<Button type="button" size="sm" variant="link" className="px-1" onClick={onShare}>
							Share
						</Button>
					) : null}
				</div>
			) : (
				live.map(share => (
					<div key={share.id} data-slot="library-share-row" className="flex items-start gap-2.5">
						<Badge icon={share.audience.kind === "link" ? "globe" : "user"} />
						<div className="min-w-0 flex-1">
							<div className="truncate text-fr-sm text-fr-text" title={accessLabel(share.audience)}>
								{accessLabel(share.audience)}
							</div>
							<div className="text-fr-xs leading-snug text-fr-text-3">{shareDetail(share, now)}</div>
							{canShare && fileChanged(share, mtimeMs) ? (
								<div data-slot="library-share-stale" className="mt-1.5 flex items-center gap-2 rounded-md bg-fr-warn/10 px-2 py-1 text-fr-xs text-fr-warn">
									<span className="min-w-0 flex-1">The file changed since this link shows version {share.version}.</span>
									<Button type="button" size="sm" className="h-6 shrink-0 px-2 text-fr-xs" loading={busy === `update:${share.id}`} onClick={() => update(share.id)}>
										<Icon name="refresh" size={12} />
										Update link
									</Button>
								</div>
							) : null}
							<div className="-ml-1.5 mt-1 flex items-center gap-1">
								<Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-fr-xs" loading={busy === share.id} onClick={() => void copyLink(share.id)}>
									<Icon name={copied === share.id ? "check" : "link"} size={12} />
									{copied === share.id ? "Link copied" : "Copy link"}
								</Button>
								<Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-fr-xs" onClick={() => onManage(share.id)}>
									Manage access
								</Button>
							</div>
						</div>
					</div>
				))
			)}
			{error === null ? null : (
				<p role="alert" className="text-fr-xs text-fr-del">
					{error}
				</p>
			)}
			{stopped.length === 0 ? null : (
				<details className="group text-fr-xs">
					<summary className="flex cursor-pointer list-none items-center gap-1 text-fr-text-3 hover:text-fr-text-2 [&::-webkit-details-marker]:hidden">
						<Icon name="caretR" size={12} className="transition-transform duration-[var(--fr-motion-fast)] group-open:rotate-90" />
						Stopped links ({stopped.length})
					</summary>
					<ul className="mt-2 flex flex-col gap-1.5 pl-4">
						{stopped.map(share => (
							<li key={share.id} className="flex min-w-0 items-baseline gap-2 text-fr-text-3">
								<span className="min-w-0 flex-1 truncate text-fr-text-2">{accessLabel(share.audience)}</span>
								<span className="shrink-0">{share.revokedAt !== undefined ? `Stopped ${shortDate(share.revokedAt, now)}` : `Expired ${shortDate(share.expiresAt ?? now, now)}`}</span>
							</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}
