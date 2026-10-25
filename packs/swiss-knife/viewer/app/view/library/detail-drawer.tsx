import { MenuItem } from "@fraym/ui/components/menu";
import { Button } from "@fraym/ui/elements/button";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Input } from "@fraym/ui/elements/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fraym/ui/elements/tabs";
import { Textarea } from "@fraym/ui/elements/textarea";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { LibraryItem, ShareSummary } from "../../../../src/library/types";
import { FOCUS } from "../focus-ring";
import { formatBytes } from "../format";
import { useCopied } from "../use-copied";
import { folderName, formatDuration, fullDate, KIND_LOOK } from "./kinds";
import { ThumbOrIcon } from "./library-item";
import type { ArtifactPatchInput, LibraryTools } from "./library-tools";
import { MenuSeparator, MoreMenu } from "./more-menu";
import { parseTags } from "./query";
import { CommentsPanel } from "./share-comments";
import { AccessList } from "./share-list";

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
	readonly onManage: (shareId: string) => void;
	readonly onDiscard: () => void;
	readonly onRestore: () => void;
	readonly onShares: (shares: readonly ShareSummary[]) => void;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2.5 border-t border-fr-border-soft pt-4 first:border-t-0 first:pt-0">
			<h3 className="text-fr-xs font-semibold text-fr-text-2">{title}</h3>
			{children}
		</section>
	);
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
	return (
		<>
			<dt className="text-fr-text-3">{label}</dt>
			<dd className="min-w-0 truncate text-fr-text">{children}</dd>
		</>
	);
}

function useDraft(value: string, onCommit: (value: string) => void, onDone: () => void) {
	const [draft, setDraft] = useState(value);
	const cancelled = useRef(false);
	const commit = (): void => {
		if (!cancelled.current && draft.trim() !== value.trim()) onCommit(draft.trim());
		onDone();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, multiline: boolean): void => {
		if (event.key === "Enter" && !(multiline && event.shiftKey)) {
			event.preventDefault();
			event.currentTarget.blur();
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			cancelled.current = true;
			event.currentTarget.blur();
		}
	};
	return { draft, setDraft, commit, onKeyDown };
}

function RenameField({ value, placeholder, onCommit, onDone }: { readonly value: string; readonly placeholder: string; readonly onCommit: (value: string) => void; readonly onDone: () => void }) {
	const { draft, setDraft, commit, onKeyDown } = useDraft(value, onCommit, onDone);
	return (
		<Input
			autoFocus
			size="sm"
			aria-label="Name"
			value={draft}
			placeholder={placeholder}
			spellCheck={false}
			onFocus={event => event.currentTarget.select()}
			onChange={event => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={event => onKeyDown(event, false)}
			className="min-w-0 flex-1"
		/>
	);
}

function DescriptionField({ value, onCommit }: { readonly value: string; readonly onCommit: (value: string) => void }) {
	const [editing, setEditing] = useState(false);
	if (!editing) {
		return (
			<button
				type="button"
				onClick={() => setEditing(true)}
				className={cn("-mx-2 rounded-md px-2 py-1.5 text-left text-fr-sm hover:bg-fr-surface", value === "" ? "text-fr-text-3" : "whitespace-pre-wrap text-fr-text [overflow-wrap:anywhere]", FOCUS)}
			>
				{value === "" ? "Add a description" : value}
			</button>
		);
	}
	return <DescriptionEditor value={value} onCommit={onCommit} onDone={() => setEditing(false)} />;
}

function DescriptionEditor({ value, onCommit, onDone }: { readonly value: string; readonly onCommit: (value: string) => void; readonly onDone: () => void }) {
	const { draft, setDraft, commit, onKeyDown } = useDraft(value, onCommit, onDone);
	return (
		<Textarea
			autoFocus
			rows={3}
			aria-label="Description"
			value={draft}
			placeholder="Add a description"
			onChange={event => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={event => onKeyDown(event, true)}
			className="resize-none text-fr-sm"
		/>
	);
}

function TagEditor({ tags, onCommit }: { readonly tags: readonly string[]; readonly onCommit: (tags: readonly string[]) => void }) {
	const [adding, setAdding] = useState(false);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{tags.map(tag => (
				<span key={tag} className="inline-flex h-6 items-center gap-0.5 rounded-sm bg-fr-surface-3 pl-2 pr-0.5 text-fr-xs text-fr-text-2">
					{tag}
					<button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onCommit(tags.filter(each => each !== tag))} className={cn("rounded-sm p-0.5 text-fr-text-3 hover:bg-fr-surface-2 hover:text-fr-text", FOCUS)}>
						<Icon name="x" size={10} />
					</button>
				</span>
			))}
			{adding ? (
				<TagInput tags={tags} onCommit={onCommit} onDone={() => setAdding(false)} />
			) : (
				<button type="button" onClick={() => setAdding(true)} className={cn("inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-fr-xs text-fr-text-3 hover:bg-fr-surface hover:text-fr-text-2", FOCUS)}>
					<Icon name="plus" size={11} />
					Add tag
				</button>
			)}
		</div>
	);
}

function TagInput({ tags, onCommit, onDone }: { readonly tags: readonly string[]; readonly onCommit: (tags: readonly string[]) => void; readonly onDone: () => void }) {
	const { draft, setDraft, commit, onKeyDown } = useDraft("", text => onCommit(parseTags([...tags, text].join(","))), onDone);
	return <Input autoFocus size="sm" aria-label="New tag" value={draft} placeholder="Tag" spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => onKeyDown(event, false)} className="h-6 w-28" />;
}

function containingFolder(path: string): string {
	return path.replace(/[\\/]+[^\\/]*$/, "");
}

export function DetailDrawer({ tools, item, thumb, active, now, onClose, onPatch, onOpen, onShare, onManage, onDiscard, onRestore, onShares }: DetailDrawerProps) {
	const { copied, copy } = useCopied(item.path);
	const [renaming, setRenaming] = useState(false);
	const [tab, setTab] = useState("details");
	const look = KIND_LOOK[item.kind];
	const discarded = item.state === "discarded";
	const missing = item.state === "missing";
	const name = item.title ?? item.name;
	const folder = containingFolder(item.path);
	const comments = item.shares.reduce((sum, share) => sum + share.comments, 0);
	const unread = item.shares.reduce((sum, share) => sum + share.unread, 0);
	const kindLine = [look.label, item.durationMs === undefined ? null : formatDuration(item.durationMs), item.width !== undefined && item.height !== undefined ? `${item.width} × ${item.height}` : null].filter(part => part !== null).join(" · ");

	return (
		<aside aria-label="Artifact details" data-slot="library-drawer" className="flex h-full min-h-0 w-full flex-col bg-fr-bg">
			<div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-fr-border-soft pl-3 pr-1.5">
				<Icon name={look.icon} size={15} className="shrink-0 text-fr-text-3" />
				{renaming ? (
					<RenameField value={item.title ?? ""} placeholder={item.name} onCommit={title => onPatch({ title: title === "" ? null : title })} onDone={() => setRenaming(false)} />
				) : (
					<h2 className="min-w-0 flex-1 truncate text-fr-sm font-semibold text-fr-text" title={name} onDoubleClick={() => setRenaming(true)}>
						{name}
					</h2>
				)}
				{discarded ? null : (
					<IconButton className={cn("size-7", FOCUS)} toggled={item.starred} aria-label={item.starred ? "Unstar" : "Star"} title={item.starred ? "Unstar (s)" : "Star (s)"} onClick={() => onPatch({ starred: !item.starred })}>
						<Icon name="star" size={14} filled={item.starred} />
					</IconButton>
				)}
				<MoreMenu label="More actions">
					<MenuItem icon={<Icon name={copied ? "check" : "copy"} size={14} />} onClick={copy}>
						{copied ? "Path copied" : "Copy path"}
					</MenuItem>
					<MenuItem icon={<Icon name="edit" size={14} />} onClick={() => setRenaming(true)}>
						Rename
					</MenuItem>
					<MenuSeparator />
					{discarded ? (
						<MenuItem icon={<Icon name="history" size={14} />} onClick={onRestore}>
							Restore
						</MenuItem>
					) : (
						<MenuItem icon={<Icon name="trash" size={14} />} onClick={onDiscard} className="text-fr-del hover:bg-fr-del-bg hover:text-fr-del">
							Discard…
						</MenuItem>
					)}
				</MoreMenu>
				<IconButton className={cn("size-7", FOCUS)} aria-label="Close details" title="Close (Esc)" onClick={onClose}>
					<Icon name="x" size={14} />
				</IconButton>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
				<button type="button" onClick={onOpen} title="Open" className={cn("mt-4 block aspect-video w-full overflow-hidden rounded-lg border border-fr-border-soft", FOCUS)}>
					<ThumbOrIcon item={item} thumb={thumb} iconSize={40} className="object-contain" />
				</button>
				{missing ? (
					<p className="mt-2 flex items-start gap-1.5 rounded-md bg-fr-warn/10 px-2 py-1.5 text-fr-xs text-fr-warn">
						<Icon name="warnTri" size={13} className="mt-px shrink-0" />
						This file is no longer where it was; it may have been moved, renamed or deleted.
					</p>
				) : null}
				<div className="mt-3 flex gap-2">
					{discarded ? (
						<Button type="button" size="sm" className="flex-1 justify-center" onClick={onRestore}>
							<Icon name="history" size={13} />
							Restore
						</Button>
					) : (
						<>
							<Button type="button" size="sm" className="flex-1 justify-center" onClick={onOpen}>
								<Icon name="external" size={13} />
								Open
							</Button>
							<Button type="button" size="sm" variant="outline" className="flex-1 justify-center" onClick={onShare} disabled={missing}>
								<Icon name="user" size={13} />
								Share
							</Button>
						</>
					)}
				</div>
				<Tabs value={tab} onValueChange={setTab} className="mt-5">
					<TabsList>
						<TabsTrigger value="details">Details</TabsTrigger>
						<TabsTrigger value="comments">
							Comments
							{comments > 0 ? <span className="tabular-nums text-fr-text-3">{comments}</span> : null}
							{unread > 0 ? (
								<span className="size-1.5 rounded-full bg-fr-accent" title={`${unread} new`}>
									<span className="sr-only">{`${unread} new`}</span>
								</span>
							) : null}
						</TabsTrigger>
					</TabsList>
					<TabsContent value="details" className="mt-5 flex flex-col gap-4">
						<Section title="Who has access">
							<AccessList tools={tools} shares={item.shares} now={now} canShare={!discarded && !missing} onShare={onShare} onManage={onManage} />
						</Section>
						<Section title="File details">
							<dl className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-fr-xs">
								<Fact label="Type">{kindLine}</Fact>
								<Fact label="Size">{formatBytes(item.size)}</Fact>
								<dt className="text-fr-text-3">Location</dt>
								<dd className="flex min-w-0 items-center gap-1">
									<span title={item.path} className="inline-flex min-w-0 items-center gap-1 rounded-sm bg-fr-surface-2 px-1.5 py-0.5 text-fr-text-2">
										<Icon name="folder" size={12} className="shrink-0 text-fr-text-3" />
										<span className="truncate">{folderName(folder)}</span>
									</span>
									<IconButton className={cn("size-6 shrink-0", FOCUS)} aria-label={copied ? "Path copied" : "Copy path"} title={copied ? "Path copied" : item.path} onClick={copy}>
										<Icon name={copied ? "check" : "copy"} size={12} />
									</IconButton>
								</dd>
								{item.workspace === undefined ? null : (
									<Fact label="Workspace">
										<span title={item.workspace}>{folderName(item.workspace)}</span>
									</Fact>
								)}
								<Fact label="Added by">{item.source === "human" ? "You" : "An agent"}</Fact>
								<Fact label="Added">{fullDate(item.createdAt)}</Fact>
								<Fact label="Last presented">{fullDate(item.presentedAt)}</Fact>
								{item.openedAt === undefined ? null : <Fact label="Last opened">{fullDate(item.openedAt)}</Fact>}
								{item.discardedAt === undefined ? null : <Fact label="Discarded">{fullDate(item.discardedAt)}</Fact>}
							</dl>
						</Section>
						<Section title="Description">
							<DescriptionField key={item.note ?? ""} value={item.note ?? ""} onCommit={note => onPatch({ note: note === "" ? null : note })} />
							<TagEditor tags={item.tags} onCommit={tags => onPatch({ tags })} />
						</Section>
					</TabsContent>
					<TabsContent value="comments" className="mt-5">
						<CommentsPanel tools={tools} artifactId={item.id} shares={item.shares} active={active} now={now} onShares={onShares} />
					</TabsContent>
				</Tabs>
			</div>
		</aside>
	);
}
