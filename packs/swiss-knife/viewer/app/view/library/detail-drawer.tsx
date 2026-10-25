import { Button } from "@fraym/ui/elements/button";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Input } from "@fraym/ui/elements/input";
import { Textarea } from "@fraym/ui/elements/textarea";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type ReactNode, useEffect, useState } from "react";
import type { LibraryItem, ShareSummary } from "../../../../src/library/types";
import { FOCUS } from "../focus-ring";
import { formatBytes } from "../format";
import { useCopied } from "../use-copied";
import { folderName, formatDuration, fullDate, KIND_LOOK } from "./kinds";
import { ThumbOrIcon } from "./library-item";
import type { ArtifactPatchInput, LibraryTools } from "./library-tools";
import { parseTags } from "./query";
import { ShareList } from "./share-list";

export interface DetailDrawerProps {
	readonly tools: LibraryTools;
	readonly item: LibraryItem;
	readonly thumb: string | null;
	readonly active: boolean;
	readonly now: number;
	readonly onClose: () => void;
	readonly onPatch: (patch: ArtifactPatchInput) => void;
	readonly onOpen: () => void;
	readonly onShare: () => void;
	readonly onDiscard: () => void;
	readonly onRestore: () => void;
	readonly onShares: (shares: readonly ShareSummary[]) => void;
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
	return (
		<>
			<dt className="text-fr-text-3">{label}</dt>
			<dd className="min-w-0 truncate text-fr-text-2">{children}</dd>
		</>
	);
}

function EditableField({ label, value, placeholder, multiline, onCommit }: { readonly label: string; readonly value: string; readonly placeholder: string; readonly multiline?: boolean; readonly onCommit: (value: string) => void }) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const commit = (): void => {
		if (draft.trim() !== value.trim()) onCommit(draft.trim());
	};
	const shared = {
		"aria-label": label,
		placeholder,
		value: draft,
		onBlur: commit,
		spellCheck: multiline === true,
	};
	return multiline ? (
		<Textarea {...shared} rows={2} onChange={event => setDraft(event.target.value)} className="resize-none text-fr-sm" />
	) : (
		<Input
			{...shared}
			size="sm"
			onChange={event => setDraft(event.target.value)}
			onKeyDown={event => {
				if (event.key === "Enter") event.currentTarget.blur();
				if (event.key === "Escape") {
					setDraft(value);
					event.stopPropagation();
				}
			}}
		/>
	);
}

export function DetailDrawer({ tools, item, thumb, active, now, onClose, onPatch, onOpen, onShare, onDiscard, onRestore, onShares }: DetailDrawerProps) {
	const { copied, copy } = useCopied(item.path);
	const look = KIND_LOOK[item.kind];
	const discarded = item.state === "discarded";
	return (
		<aside aria-label="Artifact details" data-slot="library-drawer" className="flex h-full min-h-0 w-full flex-col bg-fr-bg">
			<div className="flex h-10 shrink-0 items-center gap-1 border-b border-fr-border-soft pl-3 pr-1.5">
				<span className="rounded-sm bg-fr-surface-3 px-1.5 py-0.5 text-fr-2xs font-medium text-fr-text-2">{look.label}</span>
				<span className="min-w-0 flex-1" />
				{discarded ? null : (
					<IconButton className={cn("size-7", FOCUS)} toggled={item.starred} aria-label={item.starred ? "Unstar" : "Star"} title={item.starred ? "Unstar (s)" : "Star (s)"} onClick={() => onPatch({ starred: !item.starred })}>
						<Icon name="star" size={14} filled={item.starred} />
					</IconButton>
				)}
				<IconButton className={cn("size-7", FOCUS)} aria-label="Close details" title="Close (Esc)" onClick={onClose}>
					<Icon name="x" size={14} />
				</IconButton>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
				<button type="button" onClick={onOpen} title="Open" className={cn("mt-3 block aspect-video w-full overflow-hidden rounded-lg border border-fr-border-soft", FOCUS)}>
					<ThumbOrIcon item={item} thumb={thumb} iconSize={40} className="object-contain" />
				</button>
				{item.state === "missing" ? (
					<p className="mt-2 flex items-start gap-1.5 rounded-md bg-fr-warn/10 px-2 py-1.5 text-fr-xs text-fr-warn">
						<Icon name="warnTri" size={13} className="mt-px shrink-0" />
						This file is no longer where it was; it may have been moved, renamed or deleted.
					</p>
				) : null}
				<div className="mt-3 flex flex-col gap-1.5">
					<EditableField label="Title" value={item.title ?? ""} placeholder={item.name} onCommit={title => onPatch({ title: title === "" ? null : title })} />
					<EditableField label="Note" value={item.note ?? ""} placeholder="Add a note" multiline onCommit={note => onPatch({ note: note === "" ? null : note })} />
					<EditableField label="Tags" value={item.tags.join(", ")} placeholder="Tags, separated by commas" onCommit={text => onPatch({ tags: parseTags(text) })} />
				</div>
				<div className="mt-3 flex flex-wrap gap-1.5">
					{discarded ? (
						<Button type="button" size="sm" onClick={onRestore}>
							<Icon name="history" size={12} />
							Restore
						</Button>
					) : (
						<>
							<Button type="button" size="sm" onClick={onOpen}>
								<Icon name="external" size={12} />
								Open
							</Button>
							<Button type="button" size="sm" variant="outline" onClick={onShare} disabled={item.state === "missing"}>
								<Icon name="link" size={12} />
								Share…
							</Button>
							<Button type="button" size="sm" variant="ghost" onClick={onDiscard} className="hover:text-fr-del">
								<Icon name="trash" size={12} />
								Discard…
							</Button>
						</>
					)}
				</div>
				<div className="mt-4 flex min-w-0 items-center gap-1 rounded-md border border-fr-border-soft bg-fr-surface-2 py-0.5 pl-2 pr-0.5">
					<span className="min-w-0 flex-1 truncate font-mono text-fr-2xs text-fr-text-2" title={item.path}>
						{item.path}
					</span>
					<IconButton className={cn("size-6", FOCUS)} aria-label={copied ? "Path copied" : "Copy path"} title={copied ? "Path copied" : "Copy path"} onClick={copy}>
						<Icon name={copied ? "check" : "copy"} size={12} />
					</IconButton>
				</div>
				<dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-fr-xs">
					<Fact label="Size">{formatBytes(item.size)}</Fact>
					{item.width !== undefined && item.height !== undefined ? <Fact label="Dimensions">{`${item.width} × ${item.height}`}</Fact> : null}
					{item.durationMs !== undefined ? <Fact label="Length">{formatDuration(item.durationMs)}</Fact> : null}
					{item.workspace === undefined ? null : (
						<Fact label="Workspace">
							<span title={item.workspace}>{folderName(item.workspace)}</span>
						</Fact>
					)}
					<Fact label="Presented">{fullDate(item.presentedAt)}</Fact>
					<Fact label="Added">{fullDate(item.createdAt)}</Fact>
					{item.openedAt === undefined ? null : <Fact label="Opened">{fullDate(item.openedAt)}</Fact>}
					{item.discardedAt === undefined ? null : <Fact label="Discarded">{fullDate(item.discardedAt)}</Fact>}
					<Fact label="Added by">{item.source === "human" ? "You" : "An agent"}</Fact>
				</dl>
				<h3 className="mb-1.5 mt-5 text-fr-2xs font-semibold uppercase tracking-wide text-fr-text-3">Links and comments</h3>
				<ShareList tools={tools} artifactId={item.id} shares={item.shares} active={active} now={now} onShares={onShares} />
			</div>
		</aside>
	);
}
