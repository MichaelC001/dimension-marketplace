// The seam a layer on top of the viewer plugs into: notes on a picture, on a document,
// on a page or a recording. Deliberately its own file: the pane imports `PaneExtras`
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
	AnnotationNotice,
	AnnotationToolbar,
	DocumentCommentLayer,
	DocumentNotes,
	MarkupIcon,
	MarkupOverlay,
	markupToolGroups,
	useDocumentComments,
	useImageMarkup,
	useMarkupShortcuts,
} from "@dimension/mcp-app-kit/annotate/react";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ViewerKind } from "../../src/contract";
import { annotationModes } from "./annotate-modes";
import { loadDocumentBytes } from "./document-bytes";
import { ElementPicks } from "./pane-extras-element";
import { TimelineMarks } from "./pane-extras-timeline";
import { type AnnotateMode, Footer, type PaneExtrasProps, revisionOf, Strip, useSlot } from "./pane-shared";

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

/** The layer that seats each mode (docs/design/88 section 5): which modes a kind offers is `annotate-modes.ts`. */
const LAYERS: Readonly<Record<AnnotateMode, (props: PaneExtrasProps) => ReactNode>> = {
	marks: PictureMarkup,
	comments: TextComments,
	elements: ElementPicks,
	timeline: TimelineMarks,
};

export function PaneExtras(props: PaneExtrasProps): ReactNode {
	const mode = annotationModes(props.tab.kind)[0];
	if (mode === undefined) return null;
	const Layer = LAYERS[mode];
	return <Layer {...props} />;
}

function PictureMarkup({ app, tab, active, ready, frame, mode }: PaneExtrasProps) {
	const picture = useSlot(frame, ready, PICTURE);
	const up = mode === "marks";
	const session = useImageMarkup({
		app,
		file: tab.path,
		rev: revisionOf(tab),
		autoStage: active && up,
		// The document cache the pane already fills: the original bytes, not what the screen shows.
		loadBytes: async () => (await loadDocumentBytes(app, tab)).bytes,
	});
	const { setTool } = session;

	// The layer comes up with Box in the hand, so a drag draws at once; it goes down with the layer (a file that did
	// not open) and the marks stay. Escape, or pressing the armed tool again, puts the pen down to scroll, zoom and
	// read (an armed overlay owns every touch and drag, so a finger has no other way); it is the human's to pick up
	// again (a tool button, a number key): a changed file or theme reloads the picture and must not take or give it.
	useEffect(() => {
		setTool(up ? "box" : null);
	}, [up, setTool]);

	// The card's Annotate action is the one ask that picks the pen up again, in the tool the human last held.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `annotateRequests` is the trigger; the tool is read as it stands.
	useEffect(() => {
		if (tab.annotateRequests > 0 && up) setTool(session.tool ?? "box");
	}, [tab.annotateRequests]);

	useMarkupShortcuts({
		enabled: active && up,
		onTool: setTool,
		onUndo: session.markup.undo,
		onRedo: session.markup.redo,
		onExit: () => setTool(null),
	});

	return (
		<>
			{picture === null
				? null
				: createPortal(
						<MarkupOverlay
							marks={session.markup.marks}
							tool={session.tool}
							onShape={session.onShape}
							onNote={session.markup.setNote}
							onRemove={session.markup.remove}
							label={`Draw on ${tab.filename}`}
						/>,
						picture,
					)}
			{up ? (
				<Strip frame={frame}>
					<AnnotationToolbar
						label="Annotation tools"
						placement="strip"
						groups={markupToolGroups({
							tool: session.tool,
							onTool: setTool,
							canUndo: session.markup.canUndo,
							canRedo: session.markup.canRedo,
							onUndo: session.markup.undo,
							onRedo: session.markup.redo,
							onClear: session.markup.clear,
							hasMarks: session.markup.marks.length > 0,
						})}
					/>
				</Strip>
			) : null}
			{up ? (
				<Footer frame={frame}>
					<AnnotationNotice status={session.status} />
				</Footer>
			) : null}
		</>
	);
}

function TextComments({ app, tab, active, ready, frame, mode }: PaneExtrasProps) {
	const textRoot = useSlot(frame, ready, TEXT_ROOT);
	const commenting = mode === "comments";
	// The bar's Comment asks the layer to comment on the selection, as Ctrl+Alt+M does.
	const [request, setRequest] = useState(0);
	const session = useDocumentComments({
		app,
		file: tab.path,
		kind: KIND_WORDS[tab.kind] ?? "document",
		...(PAGE_WORDS[tab.kind] === undefined ? {} : { pageWord: PAGE_WORDS[tab.kind] }),
		rev: revisionOf(tab),
		autoStage: active && commenting,
	});

	const [ranges, setRanges] = useState<ReadonlyMap<number, Range>>(() => new Map());
	const [hoveredId, setHoveredId] = useState<number | null>(null);
	const notesHost = active ? frame : null;
	return (
		<>
			{/* Only the tab on screen paints: the highlights are one registry for the whole document. */}
			<DocumentCommentLayer
				root={active ? textRoot : null}
				onRanges={setRanges}
				comments={session.comments}
				activeId={session.openId ?? hoveredId}
				onComment={session.onComment}
				onResolved={session.setStates}
				interactive={commenting}
				request={request}
			/>
			{notesHost && textRoot && createPortal(
				<DocumentNotes
					root={textRoot}
					notesHost={notesHost}
					ranges={ranges}
					comments={session.comments}
					states={session.states}
					openId={session.openId}
					onOpen={session.setOpenId}
					onNote={session.setNote}
					onRemove={session.remove}
					onActive={setHoveredId}
				/>,
				notesHost,
			)}
			{commenting ? (
				<Strip frame={frame}>
					{/* Comment is the one tool of a text, so it is always the armed one: the ring says what the bar is for. */}
					<AnnotationToolbar
						label="Annotation tools"
						placement="strip"
						groups={[
							{
								id: "comment",
								label: "Comment tool",
								kind: "pick",
								armed: "comment",
								tools: [
									{
										id: "comment",
										label: "Comment",
										text: "Comment",
										icon: <MarkupIcon name="comment" size={15} />,
										key: "Ctrl+Alt+M",
										keepFocus: true,
										onSelect: () => setRequest(count => count + 1),
									},
								],
							},
						]}
					/>
				</Strip>
			) : null}
			{commenting ? (
				<Footer frame={frame}>
					<AnnotationNotice status={session.status} />
				</Footer>
			) : null}
		</>
	);
}
