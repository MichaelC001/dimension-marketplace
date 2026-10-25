import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { memo, useState } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import { formatBytes } from "../format";
import { formatDuration, KIND_LOOK, relativeAge } from "./kinds";
import { liveShares, unreadCount } from "./query";

export interface ItemViewProps {
	readonly item: LibraryItem;
	readonly selected: boolean;
	readonly thumb: string | null;
	readonly now: number;
}

export function ThumbOrIcon({ item, thumb, iconSize, className }: { readonly item: LibraryItem; readonly thumb: string | null; readonly iconSize: number; readonly className?: string }) {
	const [broken, setBroken] = useState<string | null>(null);
	const look = KIND_LOOK[item.kind];
	if (thumb !== null && broken !== thumb) {
		return <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(thumb)} className={cn("size-full object-cover", className)} />;
	}
	return (
		<div className={cn("flex size-full items-center justify-center bg-fr-surface-2 text-fr-text-3", className)}>
			<Icon name={look.icon} size={iconSize} strokeWidth={1.5} />
		</div>
	);
}

function Badges({ item }: { readonly item: LibraryItem }) {
	const unread = unreadCount(item);
	const shared = liveShares(item) > 0;
	return (
		<>
			{item.state === "missing" ? (
				<span title="The file is no longer where it was" className="flex items-center text-fr-warn">
					<Icon name="warnTri" size={12} />
				</span>
			) : null}
			{item.starred ? (
				<span title="Starred" className="flex items-center text-fr-accent">
					<Icon name="star" size={12} filled />
				</span>
			) : null}
			{shared ? (
				<span title="Shared" className="flex items-center text-fr-text-3">
					<Icon name="link" size={12} />
				</span>
			) : null}
			{unread > 0 ? (
				<span title={`${unread} new comment${unread === 1 ? "" : "s"}`} className="rounded-full bg-fr-accent px-1.5 text-fr-2xs font-semibold leading-4 text-fr-accent-ink tabular-nums">
					{unread}
				</span>
			) : null}
		</>
	);
}

function metaLine(item: LibraryItem, now: number): string {
	const parts = [KIND_LOOK[item.kind].label, formatBytes(item.size)];
	if (item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
	parts.push(relativeAge(item.state === "discarded" && item.discardedAt !== undefined ? item.discardedAt : item.presentedAt, now));
	return parts.join(" · ");
}

export const GridCell = memo(function GridCell({ item, selected, thumb, now }: ItemViewProps) {
	const title = item.title ?? item.name;
	return (
		<div
			data-slot="library-cell"
			data-state={item.state}
			className={cn(
				"group flex size-full cursor-default select-none flex-col overflow-hidden rounded-lg border bg-fr-surface transition-colors duration-[var(--fr-motion-fast)]",
				selected ? "border-fr-accent shadow-[0_0_0_1px_var(--fr-accent)]" : "border-fr-border-soft hover:border-fr-border",
			)}
		>
			<div className={cn("relative h-[136px] shrink-0 overflow-hidden border-b border-fr-border-soft", item.state === "missing" && "opacity-50")}>
				<ThumbOrIcon item={item} thumb={thumb} iconSize={30} />
				{item.kind === "video" && item.durationMs !== undefined ? (
					<span className="absolute bottom-1.5 right-1.5 rounded-sm bg-black/65 px-1 text-fr-2xs leading-4 text-white tabular-nums">{formatDuration(item.durationMs)}</span>
				) : null}
			</div>
			<div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 px-2.5">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 flex-1 truncate text-fr-sm font-medium text-fr-text" title={item.path}>
						{title}
					</span>
					<Badges item={item} />
				</div>
				<span className="truncate text-fr-xs text-fr-text-3">{metaLine(item, now)}</span>
			</div>
		</div>
	);
});

export const ListRow = memo(function ListRow({ item, selected, thumb, now }: ItemViewProps) {
	const title = item.title ?? item.name;
	return (
		<div
			data-slot="library-row"
			data-state={item.state}
			className={cn(
				"flex size-full cursor-default select-none items-center gap-3 rounded-md px-2",
				selected ? "bg-fr-accent-dim text-fr-text" : "hover:bg-fr-surface",
			)}
		>
			<div className={cn("size-8 shrink-0 overflow-hidden rounded-sm border border-fr-border-soft", item.state === "missing" && "opacity-50")}>
				<ThumbOrIcon item={item} thumb={thumb} iconSize={15} />
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-fr-sm text-fr-text">{title}</span>
				<span className="truncate text-fr-xs text-fr-text-3" title={item.path}>
					{item.path}
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Badges item={item} />
			</div>
			<span className="hidden w-48 shrink-0 truncate text-right text-fr-xs text-fr-text-3 tabular-nums sm:block">{metaLine(item, now)}</span>
		</div>
	);
});
