// The seam a layer on top of the viewer plugs into: markup on a picture, comments
// on a document. Deliberately its own file: the pane imports these two exports
// and nothing else about what sits on top, and this file is edited without
// touching the pane.
//
// The layer is `@dimension/mcp-app-kit/annotate` (see docs/design/85). What lives
// HERE is only the seating: which kinds offer which mode, where in the pane each
// piece mounts, and the two rules that come from the pane rather than the kit:
//   * every open document keeps its own pane mounted (hidden when not showing),
//     so a layer must stay quiet unless its tab is the active one: the comment
//     highlights are one document-wide registry, and a hidden tab's layer would
//     otherwise paint over the visible tab's;
//   * the renderer re-mounts (theme, a changed file), destroying the element the
//     layer sat in, so the slots are looked up again each time it says `ready`.
import "@dimension/mcp-app-kit/annotate/annotate.css";
import {
	AnnotationPanel,
	DocumentCommentLayer,
	MarkupOverlay,
	MarkupToolbar,
	type PanelItem,
	useDocumentComments,
	useImageMarkup,
	useMarkupShortcuts,
} from "@dimension/mcp-app-kit/annotate/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ViewerKind } from "../../src/contract";
import { loadDocumentBytes } from "./document-bytes";
import type { DocTab } from "./tabs";

/** The toolbar's markup modes: pick marks on a picture, or comments on text. */
export type AnnotateMode = "marks" | "comments";

export interface PaneExtrasProps {
	readonly app: App;
	readonly tab: DocTab;
	/** This document's tab is the one showing. */
	readonly active: boolean;
	/** The renderer has mounted: `frame` now holds the rendered document. */
	readonly ready: boolean;
	/** The `position: relative` frame around the rendered document (`data-slot="viewer-stage-frame"`). */
	readonly frame: HTMLElement | null;
	/** The mode the toolbar toggle is in, or `null` when off. */
	readonly mode: AnnotateMode | null;
	/** Leave or change the mode from inside the layer (Esc, a Done button). */
	readonly onMode: (mode: AnnotateMode | null) => void;
}

const PICTURE = '[data-slot="viewer-picture"]';
const TEXT_ROOT = '[data-slot="viewer-text-root"]';

/** What the human calls each kind, for the sentence that opens the request. */
const KIND_WORDS: Readonly<Partial<Record<ViewerKind, string>>> = {
	markdown: "Markdown document",
	text: "text file",
	pdf: "PDF",
	docx: "Word document",
	pptx: "PowerPoint presentation",
	xlsx: "Excel workbook",
};

/** What a page hint is called in a kind that has one: a PDF's default is "page". */
const PAGE_WORDS: Readonly<Partial<Record<ViewerKind, string>>> = { pptx: "slide", xlsx: "sheet" };

/**
 * Which modes the toolbar offers for a kind. Empty hides the toggle.
 *
 * A kind is listed only when its renderer puts what the human sees where a layer
 * can reach it: a picture in a box sized to its drawn pixels, or text in a
 * `viewer-text-root` element (Word's is an open shadow root: the kit reads it).
 * HTML is drawn in a `sandbox=""` frame, an opaque origin nothing outside can read
 * or select in, so it offers nothing rather than a toggle that cannot work.
 */
export function annotationModes(kind: ViewerKind): readonly AnnotateMode[] {
	if (kind === "image") return ["marks"];
	return KIND_WORDS[kind] === undefined ? [] : ["comments"];
}

/** The element a renderer marked with `selector`, looked up again whenever it re-mounts. */
function useSlot(frame: HTMLElement | null, ready: boolean, selector: string): HTMLElement | null {
	const [element, setElement] = useState<HTMLElement | null>(null);
	useEffect(() => {
		setElement(ready && frame !== null ? frame.querySelector<HTMLElement>(selector) : null);
	}, [frame, ready, selector]);
	return element;
}

/** The revision a marked-up file is keyed to: the same identity the tab uses to reload. */
const revisionOf = (tab: DocTab): string => `${tab.mtimeMs}:${tab.size}`;

export function PaneExtras(props: PaneExtrasProps): ReactNode {
	if (props.tab.kind === "image") return <PictureMarkup {...props} />;
	return KIND_WORDS[props.tab.kind] === undefined ? null : <TextComments {...props} />;
}

/** The right-hand column: the list of what the human has marked, and the send. */
function Column({ children }: { readonly children: ReactNode }) {
	return (
		<aside data-slot="annotate-panel" className="flex w-[300px] min-h-0 shrink-0 flex-col">
			{children}
		</aside>
	);
}

function PictureMarkup({ app, tab, active, ready, frame, mode, onMode }: PaneExtrasProps) {
	const picture = useSlot(frame, ready, PICTURE);
	const marking = mode === "marks";
	const session = useImageMarkup({
		app,
		file: tab.path,
		rev: revisionOf(tab),
		// The document cache the pane already fills: the original bytes, not what the screen shows.
		loadBytes: async () => (await loadDocumentBytes(app, tab)).bytes,
	});
	const { setTool } = session;

	// Entering the mode arms a tool; leaving it puts the pen down but keeps the marks.
	useEffect(() => {
		setTool(marking ? "box" : null);
	}, [marking, setTool]);

	useMarkupShortcuts({
		enabled: active && marking,
		onTool: session.setTool,
		onUndo: session.markup.undo,
		onRedo: session.markup.redo,
		onExit: () => onMode(null),
	});

	const items = useMemo<PanelItem[]>(() => session.markup.marks.map(mark => ({ id: mark.id, note: mark.note })), [session.markup.marks]);

	return (
		<>
			{picture === null
				? null
				: createPortal(
						<MarkupOverlay
							marks={session.markup.marks}
							tool={session.tool}
							onShape={session.onShape}
							activeId={session.activeId}
							label={`Mark up ${tab.filename}`}
						/>,
						picture,
					)}
			{frame === null || !marking
				? null
				: createPortal(
						<div className="absolute inset-x-0 bottom-4 z-10 flex justify-center">
							<MarkupToolbar
								tool={session.tool}
								onTool={session.setTool}
								canUndo={session.markup.canUndo}
								canRedo={session.markup.canRedo}
								onUndo={session.markup.undo}
								onRedo={session.markup.redo}
								onClear={session.markup.clear}
								hasMarks={session.markup.marks.length > 0}
								onDone={() => onMode(null)}
							/>
						</div>,
						frame,
					)}
			{marking ? (
				<Column>
					<AnnotationPanel
						title="Marks"
						items={items}
						activeId={session.activeId}
						focus={session.focus}
						onActive={session.setActiveId}
						onNote={session.markup.setNote}
						onRemove={session.markup.remove}
						message={session.message}
						onMessage={session.setMessage}
						onSend={() => void session.send()}
						send={{ busy: session.sending, staged: session.staged }}
						status={session.status}
						emptyHint={
							<>
								<strong>Mark up this picture</strong>
								<span>
									Drag to box something, or pick another tool below. Press <kbd>1</kbd>–<kbd>5</kbd> to switch tools.
								</span>
							</>
						}
					/>
				</Column>
			) : null}
		</>
	);
}

function TextComments({ app, tab, active, ready, frame, mode }: PaneExtrasProps) {
	const textRoot = useSlot(frame, ready, TEXT_ROOT);
	const commenting = mode === "comments";
	const session = useDocumentComments({
		app,
		file: tab.path,
		kind: KIND_WORDS[tab.kind] ?? "document",
		...(PAGE_WORDS[tab.kind] === undefined ? {} : { pageWord: PAGE_WORDS[tab.kind] }),
		rev: revisionOf(tab),
	});

	const items = useMemo<PanelItem[]>(
		() =>
			session.comments.map(comment => {
				const state = session.states.get(comment.id);
				return {
					id: comment.id,
					heading: comment.anchor.quote,
					note: comment.note,
					...(state === "orphan" ? { flag: "outdated" as const } : state === "fuzzy" ? { flag: "reworded" as const } : {}),
				};
			}),
		[session.comments, session.states],
	);

	return (
		<>
			{/* Only the tab on screen paints: the highlights are one registry for the whole document. */}
			<DocumentCommentLayer
				root={active ? textRoot : null}
				comments={session.comments}
				activeId={session.activeId}
				onComment={session.onComment}
				onResolved={session.setStates}
				interactive={commenting}
			/>
			{commenting ? (
				<Column>
					<AnnotationPanel
						title="Comments"
						items={items}
						activeId={session.activeId}
						focus={session.focus}
						onActive={session.setActiveId}
						onNote={session.setNote}
						onRemove={session.remove}
						message={session.message}
						onMessage={session.setMessage}
						onSend={() => void session.send()}
						send={{ busy: session.sending, staged: session.staged }}
						status={session.status}
						emptyHint={
							<>
								<strong>Comment on the document</strong>
								<span>
									Select some text, then choose <em>Comment</em>, or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd>.
								</span>
							</>
						}
					/>
				</Column>
			) : null}
		</>
	);
}
