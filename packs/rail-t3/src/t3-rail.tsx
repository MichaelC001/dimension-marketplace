import {
	cn,
	Icon,
	type IconName,
	type RailActionDef,
	type RailImplementation,
	type RailSlotProps,
	type RepoGroup,
	type SessionItem,
	type ShellIntent,
	SURFACE,
	type SurfaceId,
} from "@fraym/ui";
import { type MouseEvent, memo, type ReactElement, type RefObject, useCallback, useState } from "react";
import { partitionSessions, type T3Status, t3Status } from "./partition";

/** Map rail action targets to their mounted surfaces.
 *  Reference: fraym/packages/ui/src/shell/fraym-frame-rail-core.tsx:406-411 (RAIL_TARGET_SURFACE)
 *  Note: This is a community-authored rail outside fraym; the mapping is replicated per doc 56 §3.3.1 gap #2.
 */
const RAIL_TARGET_SURFACE: Partial<Record<string, SurfaceId>> = {
	loops: SURFACE.autonomy,
	models: SURFACE.models,
	memory: SURFACE.palace,
	lab: SURFACE.lab,
};

/** Determine a rail action's active state based on its target and activeSurface. */
function railActionActive(action: RailActionDef, activeSurface: SurfaceId): boolean {
	const mountSurface = action.target === "surface" ? action.surface : RAIL_TARGET_SURFACE[action.target];
	return mountSurface !== undefined && mountSurface === activeSurface;
}

/** Map a rail action's target onto a ShellIntent for emission.
 *  Reference: fraym/packages/ui/src/shell/fraym-frame-rail-core.tsx:427-451 (railActionClick)
 *  Note: This is a community-authored rail; the mapping is replicated per doc 56 §3.3.1 gap #2.
 */
function railActionIntent(
	action: RailActionDef,
	onIntent: (intent: ShellIntent) => void,
	onNewSession?: () => void,
): void {
	if (action.disabled) return;
	const mountSurface = RAIL_TARGET_SURFACE[action.target];
	if (mountSurface) {
		onIntent({ t: "mount", surface: mountSurface });
		return;
	}
	switch (action.target) {
		case "new-session":
			onIntent({ t: "create" });
			onNewSession?.();
			return;
		case "plugins":
			onIntent({ t: "door", route: "settings", pane: "mcp" });
			return;
		case "surface": {
			if (action.surface) {
				onIntent({ t: "mount", surface: action.surface });
			}
			return;
		}
		default:
			onIntent({ t: "door", route: "settings" });
	}
}

/** Status treatment — OURS, not T3's (owner 2026-08-03: "don't copy blatantly;
 *  we have a vibr that shows working"). Color stays reserved for act-now, and
 *  only act-now gets WORDS: attention/failed speak, working is a quiet breathing
 *  dot (the product's own dot language — the Vibr narrates activity elsewhere),
 *  done is a bare check glyph. Ready stays unmarked. */
function statusDisplay(status: T3Status): {
	color?: string;
	label?: string;
	dot?: boolean;
	icon?: IconName;
} {
	switch (status) {
		case "attention":
			return { color: "var(--fr-warn)", label: "Needs you" };
		case "failed":
			return { color: "var(--fr-del)", label: "Failed" };
		case "working":
			return { color: "var(--fr-blue)", dot: true };
		case "done":
			return { color: "var(--fr-add)", icon: "check" };
		default:
			return {};
	}
}

/** Card row for live sessions. */
const LiveCard = memo(function LiveCard({
	item,
	group,
	status,
	isActive,
	onSelect,
	onContextMenu,
}: {
	readonly item: SessionItem;
	readonly group: RepoGroup;
	readonly status: T3Status;
	readonly isActive: boolean;
	readonly onSelect?: (item: SessionItem) => void;
	readonly onContextMenu: (item: SessionItem, event: MouseEvent<HTMLButtonElement>) => void;
}) {
	const display = statusDisplay(status);
	const emphatic = status === "attention" || status === "failed" || item.active;

	return (
		<button
			onClick={() => onSelect?.(item)}
			onContextMenu={e => {
				e.preventDefault();
				onContextMenu(item, e as unknown as MouseEvent<HTMLButtonElement>);
			}}
			className={cn(
				// a CARD — its own surface and hairline, so the live band reads as
				// a division of the rail rather than a run of rows
				"w-full rounded-lg border px-2.5 py-2 text-left transition-colors duration-[var(--fr-motion-fast)]",
				isActive
					? "border-fr-border bg-fr-surface-2"
					: "border-fr-border-soft bg-fr-surface-1/50 hover:bg-fr-surface-2/60",
			)}
			style={{ contentVisibility: "auto" }}
		>
			{/* Line 1: group glyph + repo label · right: the status voice */}
			<div className="mb-1 flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-1.5">
					{group.image ? (
						<img src={group.image} alt="" className="h-4 w-4 shrink-0 rounded" />
					) : group.emoji ? (
						<span className="h-4 w-4 shrink-0 text-center text-xs leading-4">{group.emoji}</span>
					) : (
						<Icon name={group.icon ?? "folder"} className="h-4 w-4 shrink-0" />
					)}
					<span className="truncate font-secondary text-[10px] text-fr-text-3">{group.repo}</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{display.label ? (
						<span className="font-secondary text-[10px] font-medium" style={{ color: display.color }}>
							{display.label}
						</span>
					) : display.icon ? (
						<Icon name={display.icon} className="h-3 w-3" style={{ color: display.color }} />
					) : display.dot ? (
						<span
							className="h-1.5 w-1.5 rounded-full animate-pulse motion-reduce:animate-none"
							style={{ background: display.color }}
						/>
					) : null}
					{item.time && <span className="font-secondary text-fr-2xs text-fr-text-3">{item.time}</span>}
				</div>
			</div>

			{/* Line 2: title */}
			<div
				className={cn(
					"mb-1 truncate text-fr-sm",
					emphatic ? "font-medium text-fr-text" : "font-normal text-fr-text-2",
				)}
			>
				{item.title}
			</div>

			{/* Line 3: branch, mono, quiet */}
			<div className="truncate font-secondary text-fr-2xs text-fr-text-3">
				{item.worktreeBranch || item.branch || group.branch || ""}
			</div>
		</button>
	);
});

/** Slim row for quiet sessions. */
const QuietRow = memo(function QuietRow({
	item,
	group,
	onSelect,
	onContextMenu,
}: {
	readonly item: SessionItem;
	readonly group: RepoGroup;
	readonly onSelect?: (item: SessionItem) => void;
	readonly onContextMenu: (item: SessionItem, event: MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<button
			onClick={() => onSelect?.(item)}
			onContextMenu={e => {
				e.preventDefault();
				onContextMenu(item, e as unknown as MouseEvent<HTMLButtonElement>);
			}}
			className={cn(
				"flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left",
				"opacity-65 transition-opacity duration-[var(--fr-motion-fast)] hover:opacity-100",
			)}
			style={{ contentVisibility: "auto" }}
		>
			{group.image ? (
				<img src={group.image} alt="" className="h-3.5 w-3.5 shrink-0 rounded" />
			) : group.emoji ? (
				<span className="h-3.5 w-3.5 shrink-0 text-center text-[10px] leading-[14px]">{group.emoji}</span>
			) : (
				<Icon name={group.icon ?? "folder"} className="h-3.5 w-3.5 shrink-0 text-fr-text-3" />
			)}
			<span className="min-w-0 flex-1 truncate text-left text-fr-xs text-fr-text-2">{item.title}</span>
			{item.time && <span className="shrink-0 font-secondary text-fr-2xs text-fr-text-3">{item.time}</span>}
		</button>
	);
});

/** Settled shelf (collapsed by default). */
const SettledShelf = memo(function SettledShelf({
	rows,
	onSelect,
	onContextMenu,
}: {
	readonly rows: readonly {
		readonly item: SessionItem;
		readonly group: RepoGroup;
	}[];
	readonly onSelect?: (item: SessionItem) => void;
	readonly onContextMenu: (item: SessionItem, event: MouseEvent<HTMLButtonElement>) => void;
}) {
	const [open, setOpen] = useState(false);

	if (rows.length === 0) return null;

	return (
		<div className="border-t border-fr-border-soft mt-2 pt-2">
			<button
				onClick={() => setOpen(!open)}
				className="w-full px-2.5 py-1.5 flex items-center gap-2 text-fr-2xs font-semibold text-fr-text-3 uppercase tracking-[0.08em] transition-opacity hover:opacity-75"
			>
				<Icon
					name="caretD"
					className={cn("w-3 h-3 transition-transform duration-[var(--fr-motion-fast)]", !open && "-rotate-90")}
				/>
				Settled ({rows.length})
			</button>
			{open && (
				<div className="space-y-1 mt-2">
					{rows.map(({ item, group }) => (
						<QuietRow key={item.id} item={item} group={group} onSelect={onSelect} onContextMenu={onContextMenu} />
					))}
				</div>
			)}
		</div>
	);
});

/** Pager for quiet rows: initial 10, +25 per click. */
const QuietPager = memo(function QuietPager({
	rows,
	onSelect,
	onContextMenu,
}: {
	readonly rows: readonly {
		readonly item: SessionItem;
		readonly group: RepoGroup;
	}[];
	readonly onSelect?: (item: SessionItem) => void;
	readonly onContextMenu: (item: SessionItem, event: MouseEvent<HTMLButtonElement>) => void;
}) {
	const [limit, setLimit] = useState(10);
	const visible = rows.slice(0, limit);
	const hidden = rows.length - limit;

	return (
		<>
			<div className="space-y-1">
				{visible.map(({ item, group }) => (
					<QuietRow key={item.id} item={item} group={group} onSelect={onSelect} onContextMenu={onContextMenu} />
				))}
			</div>
			{hidden > 0 && (
				<button
					onClick={() => setLimit(l => l + 25)}
					className="w-full mt-2 px-2.5 py-1 text-fr-2xs text-fr-text-3 hover:text-fr-text transition-colors"
				>
					Show {Math.min(25, hidden)} more
				</button>
			)}
		</>
	);
});

export function T3Rail(props: RailSlotProps): ReactElement {
	const compact = props.railMode === "compact";
	const actions = props.spaces.find(s => s.id === props.appMode)?.rail.actions ?? [];
	// Project chips — the up-front division: All, or one project's slice.
	const [projectFilter, setProjectFilter] = useState<string | null>(null);
	const visibleGroups = projectFilter ? props.groups.filter(g => g.repo === projectFilter) : props.groups;
	const partition = partitionSessions(visibleGroups, props.sessionSearch);

	const handleActionClick = useCallback(
		(action: RailActionDef) => {
			railActionIntent(action, props.onIntent, () => props.onNewSession?.(props.groups[0]?.workspace));
		},
		[props],
	);

	return (
		<aside data-slot="session-rail" className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent">
			{/* Header */}
			<div className="px-3 py-2 border-b border-fr-border-soft">
				<div className="flex items-center justify-between">
					<div className="text-fr-sm font-semibold text-fr-text tracking-tight">
						{props.productLabel || "Dimension"}
					</div>
					{!compact && props.version && <div className="text-fr-2xs text-fr-text-3">{props.version}</div>}
				</div>
			</div>

			{/* Actions strip */}
			<div data-slot="rail-actions" className="flex flex-col gap-1 px-1.5 py-2">
				{actions.map(action => {
					const active = railActionActive(action, props.activeSurface);
					const primary = action.primary === true;
					return (
						<button
							key={action.id}
							data-slot="rail-button"
							onClick={() => handleActionClick(action)}
							disabled={action.disabled}
							className={cn(
								"h-8 rounded-md px-2 gap-2 text-fr-xs transition-colors duration-[var(--fr-motion-fast)]",
								compact ? "w-8 justify-center" : "w-full flex items-center",
								"disabled:opacity-50 disabled:cursor-not-allowed",
								primary
									? "primary bg-fr-accent-dim text-fr-accent font-medium hover:bg-fr-accent-dim/80"
									: active
										? "bg-fr-surface-2 text-fr-text hover:bg-fr-surface-2"
										: "text-fr-text-2 hover:bg-fr-surface-3/60 hover:text-fr-text",
							)}
							title={compact ? action.label : undefined}
						>
							{action.icon && <Icon name={action.icon} className="w-4 h-4 shrink-0" />}
							{!compact && <span>{action.label}</span>}
						</button>
					);
				})}
			</div>

			{/* Search — reads as a FIELD even closed, opening into the real input */}
			{!compact && (
				<div className="px-1.5 pb-1 pt-2">
					{props.sessionSearchOpen ? (
						<input
							ref={props.searchInputRef as RefObject<HTMLInputElement>}
							type="text"
							value={props.sessionSearch}
							onChange={e => props.onSessionSearchChange(e.target.value)}
							placeholder="Search sessions…"
							className="h-7 w-full rounded-md border border-fr-border bg-fr-surface-2 px-2.5 text-fr-xs text-fr-text placeholder-fr-text-3 focus:border-fr-accent focus:outline-none"
							autoFocus
						/>
					) : (
						<button
							onClick={() => props.onSessionSearchOpenChange(true)}
							className="flex h-7 w-full items-center gap-2 rounded-md border border-fr-border-soft bg-fr-surface-1/60 px-2.5 text-fr-xs text-fr-text-3 transition-colors hover:border-fr-border hover:text-fr-text-2"
						>
							<Icon name="search" className="h-3.5 w-3.5" />
							<span>Search</span>
						</button>
					)}
				</div>
			)}

			{/* Project chips: the first division — what the list is ABOUT */}
			{!compact && props.groups.length > 1 && (
				<div className="flex items-center gap-1 overflow-x-auto border-b border-fr-border-soft px-1.5 pb-2 pt-1 [scrollbar-width:none]">
					<button
						onClick={() => setProjectFilter(null)}
						className={cn(
							"h-6 shrink-0 rounded-full px-2.5 text-fr-2xs transition-colors",
							projectFilter === null
								? "bg-fr-surface-3 text-fr-text"
								: "text-fr-text-3 hover:bg-fr-surface-2 hover:text-fr-text-2",
						)}
					>
						All
					</button>
					{props.groups.map(group => (
						<button
							key={group.repo}
							onClick={() => setProjectFilter(current => (current === group.repo ? null : group.repo))}
							className={cn(
								"flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-fr-2xs transition-colors",
								projectFilter === group.repo
									? "bg-fr-surface-3 text-fr-text"
									: "text-fr-text-3 hover:bg-fr-surface-2 hover:text-fr-text-2",
							)}
						>
							{group.image ? (
								<img src={group.image} alt="" className="h-3 w-3 rounded-sm" />
							) : group.emoji ? (
								<span className="text-[10px] leading-none">{group.emoji}</span>
							) : (
								<Icon name={group.icon ?? "folder"} className="h-3 w-3" />
							)}
							<span className="max-w-[9ch] truncate">{group.repo}</span>
						</button>
					))}
				</div>
			)}

			{/* Session area */}
			<div
				className="flex-1 min-h-0 overflow-y-auto px-1.5"
				style={{
					scrollbarWidth: "thin",
					scrollbarColor: "var(--fr-border-soft) transparent",
				}}
			>
				<div className="space-y-1 py-2">
					{partition.live.length > 0 ? (
						<div className="space-y-1">
							{partition.live.map(row => (
								<LiveCard
									key={row.item.id}
									item={row.item}
									group={row.group}
									status={row.status}
									isActive={row.item.active || false}
									onSelect={props.onSessionSelect}
									onContextMenu={props.onSessionContextMenu}
								/>
							))}
						</div>
					) : null}

					{partition.quiet.length > 0 && (
						<div className="pt-1">
							{/* the second division: a hairline, then the receded stream */}
							{partition.live.length > 0 && <div className="mx-2.5 my-2 border-t border-fr-border-soft" />}
							<QuietPager
								rows={partition.quiet}
								onSelect={props.onSessionSelect}
								onContextMenu={props.onSessionContextMenu}
							/>
						</div>
					)}

					{partition.settled.length > 0 && (
						<SettledShelf
							rows={partition.settled}
							onSelect={props.onSessionSelect}
							onContextMenu={props.onSessionContextMenu}
						/>
					)}

					{partition.live.length === 0 && partition.quiet.length === 0 && partition.settled.length === 0 && (
						<div className="flex items-center justify-center h-full text-fr-2xs text-fr-text-3">
							No sessions yet.
						</div>
					)}
				</div>
			</div>

			{/* Footer */}
			{!compact && (
				<div className="px-3 py-2 border-t border-fr-border-soft">
					<button
						onClick={e => props.onOpenUserMenu(e as unknown as MouseEvent<HTMLButtonElement>)}
						className="w-full flex items-center gap-2 hover:opacity-75 transition-opacity"
					>
						<div className="h-6 w-6 rounded-full bg-fr-surface-3 grid place-items-center shrink-0 text-[10px] text-fr-text font-semibold">
							{props.userName.charAt(0).toUpperCase()}
						</div>
						<div className="flex-1 min-w-0 text-left">
							<div className="text-fr-xs text-fr-text-2 truncate">{props.userName}</div>
							{props.planLabel && <div className="text-fr-2xs text-fr-text-3 truncate">{props.planLabel}</div>}
						</div>
					</button>
				</div>
			)}
		</aside>
	);
}

export const T3_RAIL: RailImplementation = {
	specVersion: 1,
	id: "rail-t3",
	slot: "rail",
	component: T3Rail,
};
