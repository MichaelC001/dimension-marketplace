// The chrome above a document: what it is, its size, page and zoom controls, and
// copy-path. Controls appear only when the mounted renderer offers them.
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import type { ViewerKind } from "../../src/contract";
import { FOCUS } from "./focus-ring";
import { formatBytes } from "./format";
import { useCopied } from "./use-copied";
import { MAX_ZOOM, MIN_ZOOM } from "./zoom";

export const KIND_LABEL: Record<ViewerKind, string> = {
	image: "Image",
	pdf: "PDF",
	html: "HTML",
	markdown: "Markdown",
	docx: "Word",
	pptx: "PowerPoint",
	xlsx: "Excel",
	text: "Text",
	audio: "Audio",
	video: "Video",
	binary: "File",
};

export interface ToolbarProps {
	readonly filename: string;
	readonly path: string;
	/** Absent for a file that did not open: nothing is known of what it is or how big. */
	readonly kind?: ViewerKind;
	readonly size?: number;
	/** Set when only the head of a large text file was read. */
	readonly shownBytes?: number;
	readonly zoom?: { readonly factor: number; readonly onStep: (direction: "in" | "out") => void; readonly onReset: () => void };
	readonly pager?: { readonly page: number; readonly count: number; readonly onGoto: (page: number) => void };
}

export function Toolbar({ filename, path, kind, size, shownBytes, zoom, pager }: ToolbarProps) {
	const { copied, copy } = useCopied(path);
	return (
		<>
			{/* One row where the View is wide enough, two at most where it is not: the bar is two items and no more, the file
			    (its kind, name, size and Copy path) and the controls (pages, zoom), so it can never wrap to a third row.
			    The file's group is the one that gives (the name truncates first, then the size) and its basis is what it
			    needs to be useful: a badge, a name that can be read, a size, the copy button. A View too narrow for that and
			    the controls on one line puts the controls underneath, whole, and the name keeps the rest of the file's
			    facts on its row. A row is one touch target tall, the rule under it drawn inside the last row (a border
			    would make one row 41). The DOM order is the reading order and the tab order in both layouts. */}
			<div data-slot="viewer-toolbar" className="flex shrink-0 flex-wrap items-center gap-x-3 px-3 shadow-[inset_0_-1px_0_var(--fr-border-soft)]">
				<div data-slot="viewer-toolbar-file" className="flex min-h-10 min-w-0 flex-1 basis-72 items-center gap-3">
					{kind === undefined ? null : <span className="shrink-0 rounded-sm bg-fr-surface-3 px-1.5 py-0.5 text-fr-2xs font-medium text-fr-text-2">{KIND_LABEL[kind]}</span>}
					<span className="min-w-0 flex-1 truncate text-fr-sm text-fr-text" title={size === undefined ? path : `${path} · ${formatBytes(size)}`}>
						{filename}
					</span>
					{shownBytes === undefined ? null : (
						<span className="min-w-0 truncate text-fr-xs text-fr-text-3">showing the first {formatBytes(shownBytes)}</span>
					)}
					<IconButton className={cn("size-7", FOCUS)} aria-label={copied ? "Path copied" : "Copy path"} title={copied ? "Path copied" : "Copy path"} onClick={copy}>
						<Icon name={copied ? "check" : "copy"} size={14} />
					</IconButton>
				</div>
				{pager || zoom ? (
					<div data-slot="viewer-toolbar-controls" className="flex min-h-10 max-w-full flex-wrap items-center gap-x-3">
						{pager ? (
							<div className="flex shrink-0 items-center gap-1" role="group" aria-label="Pages">
								<IconButton className={cn("size-7", FOCUS)} aria-label="Previous page" title="Previous page" disabled={pager.page <= 1} onClick={() => pager.onGoto(pager.page - 1)}>
									<Icon name="arrowU" size={14} />
								</IconButton>
								<span className="min-w-12 text-center text-fr-xs tabular-nums text-fr-text-2">
									{pager.page} / {pager.count}
								</span>
								<IconButton className={cn("size-7", FOCUS)} aria-label="Next page" title="Next page" disabled={pager.page >= pager.count} onClick={() => pager.onGoto(pager.page + 1)}>
									<Icon name="arrowD" size={14} />
								</IconButton>
							</div>
						) : null}
						{zoom ? (
							<div className="flex shrink-0 items-center gap-1" role="group" aria-label="Zoom">
								<IconButton className={cn("size-7", FOCUS)} aria-label="Zoom out" title="Zoom out" disabled={zoom.factor <= MIN_ZOOM} onClick={() => zoom.onStep("out")}>
									<Icon name="minus" size={14} />
								</IconButton>
								<button
									type="button"
									className={cn("min-w-11 rounded-md px-1 py-1 text-center text-fr-xs tabular-nums text-fr-text-2 hover:bg-fr-surface hover:text-fr-text", FOCUS)}
									title="Reset zoom"
									aria-label={`Zoom ${Math.round(zoom.factor * 100)} percent. Reset zoom`}
									onClick={zoom.onReset}
								>
									{Math.round(zoom.factor * 100)}%
								</button>
								<IconButton className={cn("size-7", FOCUS)} aria-label="Zoom in" title="Zoom in" disabled={zoom.factor >= MAX_ZOOM} onClick={() => zoom.onStep("in")}>
									<Icon name="plus" size={14} />
								</IconButton>
							</div>
						) : null}
					</div>
				) : null}
			</div>
			{/* The annotation tools dock here (`Strip` in pane-shared), in the flow between this bar and the document. */}
			<div data-slot="viewer-mode-strip" className="shrink-0 empty:hidden" />
		</>
	);
}
