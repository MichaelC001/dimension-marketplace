// The chrome above a document: what it is, its size, page and zoom controls, and
// copy-path. Controls appear only when the mounted renderer offers them.
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import type { ViewerKind } from "../../src/contract";
import type { AnnotateMode } from "./pane-extras";
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
	/** The markup toggle: shown only when a layer on top of the viewer offers modes for this kind. */
	readonly modes?: { readonly available: readonly AnnotateMode[]; readonly mode: AnnotateMode | null; readonly onChange: (mode: AnnotateMode | null) => void };
	readonly pager?: { readonly page: number; readonly count: number; readonly onGoto: (page: number) => void };
}

const MODE_LABEL: Record<AnnotateMode, string> = { marks: "Markup", comments: "Comment", elements: "Pick", timeline: "Mark" };

export function Toolbar({ filename, path, kind, size, shownBytes, zoom, pager, modes }: ToolbarProps) {
	const { copied, copy } = useCopied(path);
	return (
		<>
			{/* One row where the View is wide enough. Where it is not, the controls wrap to a row of their own, whole groups
			    at a time and in the order they are read: nothing is clipped, scrolled to or taken away. A row is one touch
			    target tall (40 px, the icon buttons'), so the bar is 40 px per row, the rule under it drawn inside the last
			    row (a border would make one row 41). The name and the size stay together on the first row, and the name
			    gives way first (truncated), then the size. */}
			<div data-slot="viewer-toolbar" className="flex shrink-0 flex-wrap items-center gap-x-3 px-3 shadow-[inset_0_-1px_0_var(--fr-border-soft)]">
				<div className="flex min-h-10 min-w-0 flex-1 basis-40 items-center gap-3">
					{kind === undefined ? null : <span className="shrink-0 rounded-sm bg-fr-surface-3 px-1.5 py-0.5 text-fr-2xs font-medium text-fr-text-2">{KIND_LABEL[kind]}</span>}
					<span className="min-w-0 flex-1 truncate text-fr-sm text-fr-text" title={path}>
						{filename}
					</span>
					{size === undefined ? null : (
						<span className="min-w-0 truncate text-fr-xs text-fr-text-3">
							{formatBytes(size)}
							{shownBytes === undefined ? "" : ` · showing the first ${formatBytes(shownBytes)}`}
						</span>
					)}
				</div>
				{modes ? (
					<div className="flex shrink-0 items-center gap-0.5 rounded-md bg-fr-surface p-0.5" role="group" aria-label="Markup">
						{modes.available.map(option => (
							<button
								key={option}
								type="button"
								aria-pressed={modes.mode === option}
								onClick={() => modes.onChange(modes.mode === option ? null : option)}
								className={cn(
									"inline-flex h-6 min-w-6 items-center justify-center rounded-sm px-2 text-fr-xs",
									FOCUS,
									modes.mode === option ? "bg-fr-accent-dim text-fr-accent-text" : "text-fr-text-2 hover:text-fr-text",
								)}
							>
								{MODE_LABEL[option]}
							</button>
						))}
					</div>
				) : null}
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
				<IconButton className={cn("ml-auto size-7", FOCUS)} aria-label={copied ? "Path copied" : "Copy path"} title={copied ? "Path copied" : "Copy path"} onClick={copy}>
					<Icon name={copied ? "check" : "copy"} size={14} />
				</IconButton>
			</div>
			{/* A mode's own tools dock here (`Strip` in pane-shared), in the flow between this bar and the document. */}
			<div data-slot="viewer-mode-strip" className="shrink-0 empty:hidden" />
		</>
	);
}
