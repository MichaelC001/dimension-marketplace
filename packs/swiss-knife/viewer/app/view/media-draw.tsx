// Drawing on a video's frame: the kit's markup overlay laid over the picture the video actually DRAWS, showing
// only the drawings that belong to the frame on screen.
//
// A drawing is a note on one frame (`TimelineMark.shape`). Three things about a video make it more than an image:
//   * the element is bigger than the picture: the video is contained in its box, so there are bars beside or above
//     the picture, and a drawing is placed in the PICTURE's space or it lands on a different pixel when the box
//     is resized (`drawnRect`, re-measured whenever the box or the picture's size changes);
//   * the picture moves: the overlay shows a drawing only while its frame is on screen (`drawnOnFrame`), read from
//     the playhead without drawing the pane again for every frame - only when the set of visible drawings changes;
//   * drawing stops the film: the first press or key on the overlay pauses it, because a box drawn on a frame that
//     is already gone is a box on the wrong picture;
//   * a drawing's note is written where it was drawn: the overlay opens its popover beside the shape, over the picture,
//     and the note belongs to the frame - it closes when the playhead leaves it, and one chosen from the strip waits
//     for the pane to seek to its frame (a drawing that is not on screen has no place to hang a popover from).
// The overlay is the kit's: it takes no input unless a tool is armed, so with none in hand a click on the picture
// still plays and pauses it, and the badges on the drawings are the only parts of it a press reaches.
import { frameKey, type MarkShape, type MarkTool, type TimelineMark } from "@dimension/mcp-app-kit/annotate";
import { MarkupOverlay } from "@dimension/mcp-app-kit/annotate/react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { type DrawnRect, drawnOnFrame, drawnRect } from "./media-frame";
import { useMediaPosition, useMediaState } from "./media-transport";

const NO_RECT: DrawnRect = { left: 0, top: 0, width: 0, height: 0 };

/** Tenths of a pixel are enough; finer would make every sub-pixel layout shift a render. */
const tenth = (value: number): number => Math.round(value * 10) / 10;

/** What says the picture's own size is now something else: the first metadata, and a change of resolution mid-stream. */
const SIZE_EVENTS = ["loadedmetadata", "resize"] as const;

/**
 * Where the video's picture is, in px from the corner of the box the video is positioned in (its stage). Measured
 * on mount and again whenever the video or its stage changes size, or the picture's own size changes: on the first
 * metadata, and on `resize` - a capture or a joined recording changes resolution mid-stream with the box unmoved, and
 * a drawing placed on the old picture's rectangle would land on a different region than the one drawn on.
 */
export function useDrawnRect(video: HTMLVideoElement): DrawnRect {
	const [rect, setRect] = useState<DrawnRect>(NO_RECT);
	useLayoutEffect(() => {
		const measure = (): void => {
			const inBox = drawnRect(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight);
			const next: DrawnRect = {
				left: tenth(video.offsetLeft + inBox.left),
				top: tenth(video.offsetTop + inBox.top),
				width: tenth(inBox.width),
				height: tenth(inBox.height),
			};
			setRect(previous =>
				previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height
					? previous
					: next,
			);
		};
		measure();
		for (const type of SIZE_EVENTS) video.addEventListener(type, measure);
		const stopListening = (): void => {
			for (const type of SIZE_EVENTS) video.removeEventListener(type, measure);
		};
		if (typeof ResizeObserver === "undefined") return stopListening;
		const observer = new ResizeObserver(measure);
		observer.observe(video);
		// The video is centred in its stage: the stage growing moves the picture without the video changing size.
		if (video.parentElement !== null) observer.observe(video.parentElement);
		return () => {
			stopListening();
			observer.disconnect();
		};
	}, [video]);
	return rect;
}

export interface DrawLayerProps {
	readonly video: HTMLVideoElement;
	/** The pane is on screen and the page is visible: only then is the playhead animated. */
	readonly live: boolean;
	/** Every note on the recording, in time order; the ones with a shape are the drawings. */
	readonly marks: readonly TimelineMark[];
	/** The armed drawing tool, or `null` to show the drawings without taking input. */
	readonly tool: MarkTool | null;
	readonly activeId: number | null;
	readonly filename: string;
	/** How long one frame is, read afresh each time it matters (the clock learns it while the video plays). */
	readonly frameSeconds: () => number;
	/**
	 * The time a drawing made with the playhead at the given time would be stamped with (the start of the frame on screen).
	 * The one place that decides it - the pane stamps a finished shape with it too - so that the number a shape wears while
	 * it is drawn is the place it takes once it is a note.
	 */
	readonly drawingTime: (playhead: number) => number;
	/** The human began to draw: stop the film. */
	readonly onBegin: () => void;
	/** A finished shape, with the picture's width / height; answers with the id of the note it became (`undefined`: none was made). */
	readonly onShape: (shape: MarkShape, aspect: number) => number | undefined;
	/** The note open on a drawing, or `null`. It stays shut until its drawing is on screen. */
	readonly openId: number | null;
	/** The human opened a note (`id`) or closed the open one (`null`) on the picture. */
	readonly onOpen: (id: number | null) => void;
	/** A key was typed in the open note. */
	readonly onNote: (id: number, note: string) => void;
	/** The open note's trash button. */
	readonly onRemove: (id: number) => void;
}

export function DrawLayer({ video, live, marks, tool, activeId, filename, frameSeconds, drawingTime, onBegin, onShape, openId, onOpen, onNote, onRemove }: DrawLayerProps): ReactNode {
	const stage = video.parentElement;
	const state = useMediaState(video);
	const playhead = useMediaPosition(video, state.playing, live);
	const rect = useDrawnRect(video);

	// What the playhead says that the layer draws, as a string, so it is drawn again when THAT changes and not each frame:
	// how many notes lie at or before where a shape drawn now would be stamped (the number it would wear: marks are kept
	// in whole milliseconds, so the stamp is counted in them too, or a mark in the same millisecond is on the wrong side)
	// and which drawings are on screen.
	const reading = useSyncExternalStore(playhead.subscribe, () => {
		const now = playhead.get();
		const seconds = frameSeconds();
		const stamp = frameKey(drawingTime(now));
		const shown = marks.filter(mark => mark.shape !== undefined && drawnOnFrame(mark.at, now, seconds)).map(mark => mark.id);
		return `${marks.filter(mark => frameKey(mark.at) <= stamp).length}|${shown.join(",")}`;
	});
	const [behind = "0", visibleIds = ""] = reading.split("|");
	const visible = useMemo(() => {
		const ids = new Set(visibleIds === "" ? [] : visibleIds.split(",").map(Number));
		return marks.flatMap(mark => (mark.shape !== undefined && ids.has(mark.id) ? [{ id: mark.id, shape: mark.shape, note: mark.note }] : []));
	}, [marks, visibleIds]);

	// The number on a drawing is its place among ALL the notes - the number the message gives it - not its place among
	// the few on this frame; a shape being drawn wears the number it will have once it is a note.
	const ordinals = useMemo(() => new Map(marks.map((mark, index) => [mark.id, index + 1])), [marks]);
	const draftOrdinal = Number(behind) + 1;

	// The popover is the overlay's while its drawing is on screen. The note belongs to the frame: once its drawing has
	// been on screen and is not (the playhead moved on), the note is closed - not before, or a note chosen from the
	// strip would close while the pane is still seeking to its frame.
	const shown = openId !== null && visible.some(mark => mark.id === openId) ? openId : null;
	const wasShown = useRef<number | null>(null);
	useEffect(() => {
		if (openId === null) {
			wasShown.current = null;
		} else if (shown !== null) {
			wasShown.current = shown;
		} else if (wasShown.current === openId) {
			wasShown.current = null;
			onOpen(null);
		}
	}, [openId, shown, onOpen]);

	if (stage === null || rect.width === 0 || rect.height === 0) return null;
	return createPortal(
		<div
			data-slot="viewer-video-draw"
			style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: "none" }}
			onPointerDownCapture={tool === null ? undefined : onBegin}
			onKeyDownCapture={tool === null ? undefined : onBegin}
		>
			<MarkupOverlay
				marks={visible}
				tool={tool}
				onShape={onShape}
				activeId={activeId}
				label={`Draw on ${filename}`}
				ordinalOf={id => ordinals.get(id) ?? 0}
				draftOrdinal={draftOrdinal}
				openId={shown}
				onOpenChange={onOpen}
				onNote={onNote}
				onRemove={onRemove}
			/>
		</div>,
		stage,
	);
}
