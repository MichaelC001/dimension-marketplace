import { formatDuration } from "@dimension/sdk/artifact-share";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { memo, useState } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import { formatBytes } from "../format";
import { KIND_LOOK, relativeAge } from "./kinds";
import { hasTag, liveShares, unreadCount } from "./query";

export interface ItemViewProps {
	readonly item: LibraryItem;
	readonly selected: boolean;
	readonly thumb: string | null;
	readonly now: number;
	readonly activeTags: readonly string[];
	readonly onTag: (tag: string) => void;
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

const GRID_CHIP = "bg-black/65 text-white";
const LIST_CHIP = "bg-fr-surface-3 text-fr-text-2";
const ACTIVE_CHIP = "bg-fr-accent text-fr-accent-ink";

function TagChips({ tags, limit, activeTags, onTag, tone, className }: { readonly tags: readonly string[]; readonly limit: number; readonly activeTags: readonly string[]; readonly onTag: (tag: string) => void; readonly tone: string; readonly className?: string }) {
	if (tags.length === 0) return null;
	const shown = tags.slice(0, limit);
	const hidden = tags.slice(limit);
	return (
		<div className={cn("flex min-w-0 items-center gap-1", className)}>
			{shown.map(tag => {
				const active = hasTag(activeTags, tag);
				return (
					<button
						key={tag}
						type="button"
						tabIndex={-1}
						title={active ? `Stop filtering by “${tag}”` : `Filter by “${tag}”`}
						aria-pressed={active}
						onMouseDown={event => event.preventDefault()}
						onClick={event => {
							event.stopPropagation();
							onTag(tag);
						}}
						className={cn("min-w-0 max-w-24 truncate rounded-sm px-1.5 text-fr-2xs leading-[18px] hover:opacity-80", active ? ACTIVE_CHIP : tone)}
					>
						{tag}
					</button>
				);
			})}
			{hidden.length === 0 ? null : (
				<span title={hidden.join(", ")} className={cn("shrink-0 rounded-sm px-1 text-fr-2xs leading-[18px] tabular-nums", tone)}>
					+{hidden.length}
				</span>
			)}
		</div>
	);
}

function metaLine(item: LibraryItem, now: number): string {
	const parts = [KIND_LOOK[item.kind].label, formatBytes(item.size)];
	if (item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
	parts.push(relativeAge(item.state === "discarded" && item.discardedAt !== undefined ? item.discardedAt : item.presentedAt, now));
	return parts.join(" · ");
}

export const GridCell = memo(function GridCell({ item, selected, thumb, now, activeTags, onTag }: ItemViewProps) {
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
				<TagChips
					tags={item.tags}
					limit={2}
					activeTags={activeTags}
					onTag={onTag}
					tone={GRID_CHIP}
					className={cn("absolute bottom-1.5 left-1.5", item.kind === "video" && item.durationMs !== undefined ? "max-w-[calc(100%-3.75rem)]" : "max-w-[calc(100%-0.75rem)]")}
				/>
			</div>
			<div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 px-2.5">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 flex-1 truncate text-fr-sm font-medium text-fr-text" title={item.note === undefined ? item.path : `${item.note}\n${item.path}`}>
						{title}
					</span>
					<Badges item={item} />
				</div>
				<span className="truncate text-fr-xs text-fr-text-3">{metaLine(item, now)}</span>
			</div>
		</div>
	);
});

export const ListRow = memo(function ListRow({ item, selected, thumb, now, activeTags, onTag }: ItemViewProps) {
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
				<span className="truncate text-fr-sm text-fr-text" title={item.note}>
					{title}
				</span>
				<span className="truncate text-fr-xs text-fr-text-3" title={item.path}>
					{item.path}
				</span>
			</div>
			<TagChips tags={item.tags} limit={2} activeTags={activeTags} onTag={onTag} tone={LIST_CHIP} className="hidden shrink-0 md:flex" />
			<div className="flex shrink-0 items-center gap-1.5">
				<Badges item={item} />
			</div>
			<span className="hidden w-48 shrink-0 truncate text-right text-fr-xs text-fr-text-3 tabular-nums sm:block">{metaLine(item, now)}</span>
		</div>
	);
});
