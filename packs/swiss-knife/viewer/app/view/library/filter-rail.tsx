import type { PresentedKind } from "@dimension/sdk/presentation";
import { Icon, type IconName } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { useState } from "react";
import type { LibraryFacets } from "../../../../src/library/types";
import { FOCUS } from "../focus-ring";
import { folderName, KIND_LOOK, KIND_ORDER } from "./kinds";
import { hasTag, type LibraryFilter, type LibraryScope } from "./query";

export interface FilterRailProps {
	readonly filter: LibraryFilter;
	readonly facets: LibraryFacets | null;
	readonly workspaces: LibraryFacets["workspaces"];
	readonly onScope: (scope: LibraryScope) => void;
	readonly onKind: (kind: PresentedKind) => void;
	readonly onClearKinds: () => void;
	readonly onTag: (tag: string) => void;
	readonly onClearTags: () => void;
	readonly onWorkspace: (workspace: string | undefined) => void;
}

function RailButton({ icon, label, count, active, onClick, title }: { readonly icon?: IconName; readonly label: string; readonly count?: number; readonly active: boolean; readonly onClick: () => void; readonly title?: string }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			title={title ?? label}
			onClick={onClick}
			className={cn(
				"flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-fr-sm",
				active ? "bg-fr-surface-3 text-fr-text" : "text-fr-text-2 hover:bg-fr-surface hover:text-fr-text",
				FOCUS,
			)}
		>
			{icon === undefined ? null : <Icon name={icon} size={14} className="shrink-0" />}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count === undefined ? null : <span className="shrink-0 text-fr-xs tabular-nums text-fr-text-3">{count.toLocaleString()}</span>}
		</button>
	);
}

function Heading({ children }: { readonly children: string }) {
	return <div className="px-2 pb-1 pt-4 text-fr-2xs font-semibold uppercase tracking-wide text-fr-text-3">{children}</div>;
}

const TAGS_PREVIEW = 12;

export function FilterRail({ filter, facets, workspaces, onScope, onKind, onClearKinds, onTag, onClearTags, onWorkspace }: FilterRailProps) {
	const [allTags, setAllTags] = useState(false);
	const kindCounts = facets?.kinds ?? {};
	let all = 0;
	for (const kind of KIND_ORDER) all += kindCounts[kind] ?? 0;
	const present = KIND_ORDER.filter(kind => (kindCounts[kind] ?? 0) > 0 || filter.kinds.includes(kind));
	const tagFacets = facets?.tags ?? [];
	const chosen = filter.tags.filter(tag => !tagFacets.some(facet => hasTag([facet.tag], tag)));
	const crowded = tagFacets.length > TAGS_PREVIEW;
	const listed = crowded && !allTags ? tagFacets.filter((facet, index) => index < TAGS_PREVIEW || hasTag(filter.tags, facet.tag)) : tagFacets;
	return (
		<nav aria-label="Library filters" data-slot="library-rail" className="flex h-full min-h-0 flex-col overflow-y-auto px-2 pb-3 pt-2">
			<RailButton icon="layers" label="All artifacts" count={filter.scope === "discarded" ? undefined : all} active={filter.scope === "all"} onClick={() => onScope("all")} />
			<RailButton icon="star" label="Starred" count={facets?.starred} active={filter.scope === "starred"} onClick={() => onScope("starred")} />
			<RailButton icon="link" label="Shared" count={facets?.shared} active={filter.scope === "shared"} onClick={() => onScope("shared")} />
			<RailButton icon="trash" label="Recently discarded" count={facets?.discarded} active={filter.scope === "discarded"} onClick={() => onScope("discarded")} />
			{present.length > 0 ? (
				<>
					<div className="flex items-center justify-between pr-1">
						<Heading>Kinds</Heading>
						{filter.kinds.length > 0 ? (
							<button type="button" onClick={onClearKinds} className={cn("mt-3 rounded-sm px-1 text-fr-2xs text-fr-text-3 hover:text-fr-text", FOCUS)}>
								Clear
							</button>
						) : null}
					</div>
					{present.map(kind => (
						<RailButton key={kind} icon={KIND_LOOK[kind].icon} label={KIND_LOOK[kind].plural} count={kindCounts[kind] ?? 0} active={filter.kinds.includes(kind)} onClick={() => onKind(kind)} />
					))}
				</>
			) : null}
			{tagFacets.length > 0 || chosen.length > 0 ? (
				<>
					<div className="flex items-center justify-between pr-1">
						<Heading>Tags</Heading>
						{filter.tags.length > 0 ? (
							<button type="button" onClick={onClearTags} className={cn("mt-3 rounded-sm px-1 text-fr-2xs text-fr-text-3 hover:text-fr-text", FOCUS)}>
								Clear
							</button>
						) : null}
					</div>
					{chosen.map(tag => (
						<RailButton key={tag} icon="hash" label={tag} active onClick={() => onTag(tag)} />
					))}
					{listed.map(facet => (
						<RailButton key={facet.tag} icon="hash" label={facet.tag} count={facet.count} active={hasTag(filter.tags, facet.tag)} onClick={() => onTag(facet.tag)} />
					))}
					{crowded ? (
						<button type="button" onClick={() => setAllTags(open => !open)} className={cn("mt-0.5 h-6 rounded-md px-2 text-left text-fr-xs text-fr-text-3 hover:bg-fr-surface hover:text-fr-text", FOCUS)}>
							{allTags ? "Show fewer" : `Show all ${tagFacets.length}`}
						</button>
					) : null}
				</>
			) : null}
			{workspaces.length > 0 ? (
				<>
					<Heading>Workspaces</Heading>
					<RailButton icon="folder" label="All workspaces" active={filter.workspace === undefined} onClick={() => onWorkspace(undefined)} />
					{workspaces.map(workspace => (
						<RailButton
							key={workspace.path}
							label={folderName(workspace.path)}
							title={workspace.path}
							count={workspace.count}
							active={filter.workspace === workspace.path}
							onClick={() => onWorkspace(workspace.path)}
						/>
					))}
				</>
			) : null}
		</nav>
	);
}
