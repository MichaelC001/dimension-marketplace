import {
	CommentHighlights,
	CommentMarks,
	CommentTimeline,
	type FrameThread,
	type ThreadReply,
	type TimeThread,
	TrackedLayer,
} from "@dimension/mcp-app-kit/annotate/react";
import type { FrameClockReader, PlayheadSource } from "@dimension/mcp-app-kit/media";
import { useShownOnFrame } from "@dimension/mcp-app-kit/media/react";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PlacedThread } from "./library/artifact-threads";
import { useDrawnRect } from "./media-draw";
import { type PaneExtrasProps, type SharedLayer, useSlot } from "./pane-shared";

const PICTURE = '[data-slot="viewer-picture"]';
const TEXT_ROOT = '[data-slot="viewer-text-root"]';
const PDF_PAGE = ".vw-pdf-page";

const threadIdOf = (thread: { readonly id: string }): string => thread.id;

export function SharedLayers(props: PaneExtrasProps): ReactNode {
	const { shared, tab } = props;
	if (shared === undefined) return null;
	switch (tab.kind) {
		case "image":
			return <PictureThreads {...props} shared={shared} />;
		case "html":
			return <StageThreads {...props} shared={shared} />;
		case "pdf":
			return (
				<>
					<PageThreads {...props} shared={shared} />
					<TextThreads {...props} shared={shared} />
				</>
			);
		case "markdown":
		case "text":
		case "docx":
		case "pptx":
		case "xlsx":
			return <TextThreads {...props} shared={shared} />;
		case "audio":
		case "video":
		case "binary":
			return null;
	}
}

type LayerProps = PaneExtrasProps & { readonly shared: SharedLayer };

function PictureThreads({ frame, ready, active, tab, shared }: LayerProps): ReactNode {
	const picture = useSlot(frame, ready, PICTURE);
	const threads = shared.places.picture;
	if (picture === null || !active || threads.length === 0) return null;
	return createPortal(<CommentMarks threads={threads} openId={shared.openId} onOpenChange={shared.onOpen} onReply={shared.onReply} label={`Comments on ${tab.filename}`} />, picture);
}

function StageThreads({ frame, ready, active, tab, shared }: LayerProps): ReactNode {
	const threads = shared.places.picture;
	if (frame === null || !ready || !active || threads.length === 0) return null;
	return createPortal(<CommentMarks threads={threads} openId={shared.openId} onOpenChange={shared.onOpen} onReply={shared.onReply} label={`Comments on ${tab.filename}`} />, frame);
}

function TextThreads({ frame, ready, active, shared }: LayerProps): ReactNode {
	const textRoot = useSlot(frame, ready, TEXT_ROOT);
	const threads = shared.places.quotes;
	if (threads.length === 0) return null;
	return <CommentHighlights root={active ? textRoot : null} notesHost={active ? frame : null} threads={threads} openId={shared.openId} onOpenChange={shared.onOpen} onReply={shared.onReply} />;
}

function PageThreads({ frame, ready, active, tab, shared }: LayerProps): ReactNode {
	const [pages, setPages] = useState<ReadonlyMap<number, HTMLElement>>(() => new Map());
	useEffect(() => {
		const found = new Map<number, HTMLElement>();
		if (ready && frame !== null) {
			for (const element of frame.querySelectorAll<HTMLElement>(PDF_PAGE)) {
				const page = Number(element.dataset.pageNumber);
				if (Number.isSafeInteger(page)) found.set(page, element);
			}
		}
		setPages(found);
	}, [frame, ready]);

	const open = shared.openId === null ? undefined : shared.threads.find(thread => thread.id === shared.openId);
	const openPage = open?.anchor.page;
	const openId = open?.id;
	useEffect(() => {
		if (!active || openId === undefined || openPage === undefined) return;
		pages.get(openPage)?.scrollIntoView({ block: "center" });
	}, [active, openId, openPage, pages]);

	if (!active || frame === null) return null;
	return [...shared.places.pages].map(([page, threads]) => (
		<TrackedLayer key={page} target={pages.get(page) ?? null} host={frame}>
			<CommentMarks threads={threads} openId={shared.openId} onOpenChange={shared.onOpen} onReply={shared.onReply} label={`Comments on page ${page} of ${tab.filename}`} />
		</TrackedLayer>
	));
}

export interface SharedLaneProps {
	readonly duration: number;
	readonly threads: readonly (PlacedThread & TimeThread)[];
	readonly openId: string | null;
	readonly onSelect: (id: string) => void;
	readonly onOpen: (id: string | null) => void;
	readonly onReply: ThreadReply;
	readonly filename: string;
}

export function SharedLane({ duration, threads, openId, onSelect, onOpen, onReply, filename }: SharedLaneProps): ReactNode {
	if (threads.length === 0) return null;
	return <CommentTimeline duration={duration} threads={threads} openId={openId} onSelect={onSelect} onOpenChange={onOpen} onReply={onReply} label={`Comments on ${filename}`} />;
}

export interface SharedFrameMarksProps {
	readonly video: HTMLVideoElement;
	readonly playhead: PlayheadSource;
	readonly clock: FrameClockReader;
	readonly frames: readonly (PlacedThread & FrameThread)[];
	readonly openId: string | null;
	readonly onOpen: (id: string | null) => void;
	readonly onReply: ThreadReply;
	readonly filename: string;
}

export function SharedFrameMarks({ video, playhead, clock, frames, openId, onOpen, onReply, filename }: SharedFrameMarksProps): ReactNode {
	const stage = video.parentElement;
	const rect = useDrawnRect(video);
	const visible = useShownOnFrame(playhead, clock, frames, threadIdOf);
	const shownOpen = openId !== null && visible.some(thread => thread.id === openId) ? openId : null;

	if (stage === null || rect.width === 0 || rect.height === 0 || visible.length === 0) return null;
	return createPortal(
		<div data-slot="viewer-video-comments" style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: "none", zIndex: 1 }}>
			<CommentMarks threads={visible} openId={shownOpen} onOpenChange={onOpen} onReply={onReply} label={`Comments on this frame of ${filename}`} />
		</div>,
		stage,
	);
}
