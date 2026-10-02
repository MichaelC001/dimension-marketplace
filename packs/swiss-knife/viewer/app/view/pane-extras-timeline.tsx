// The layer for audio and video (docs/design/88 section 3): the transport that plays a
// recording, and - once the layer is up - the notes on it.
//
// What lives HERE is the seating and the rules that come from the pane rather than the kit:
//   * the transport is ALWAYS shown, mounted into the dock the renderer left under the
//     element (`viewer-media-dock`): a recording is played with it, annotating or not;
//   * the pane's one toolbar (`AnnotationToolbar`, the same bar every kind has) is seated in the mode strip from the
//     moment the layer is up: Moment and Stretch for a sound; for a video those, then the drawing tools and
//     undo - nothing to switch on first;
//   * notes belong to the recording and outlive the renderer: the session sits in the component that never
//     unmounts, and the element and dock are looked up again each time the renderer says `ready` (a theme change
//     re-mounts it);
//   * a recording the player has failed on cannot be marked: no tools that make notes, no keys that make them -
//     only the notes already made, if there are any, so they are not lost;
//   * only the tab on screen plays and paints: a hidden tab's media is paused, its frames are not animated, its
//     waveform is not started and its filmstrip is not taken (one already running finishes).
import {
	formatMarkTime,
	formatTimecode,
	type MarkShape,
	type MarkTool,
	MAX_TIMELINE_MARKS,
	markNear,
	SHAPE_WORD,
} from "@dimension/mcp-app-kit/annotate";
import {
	AnnotationPanel,
	AnnotationToolbar,
	markupToolGroups,
	type PanelItem,
	type ToolGroupDef,
	useTimelineMarks,
} from "@dimension/mcp-app-kit/annotate/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DrawLayer } from "./media-draw";
import { useFilmstrip } from "./media-filmstrip";
import {
	DEFAULT_FRAME_SECONDS,
	FrameClock,
	FrameGrabber,
	drawnOnFrame,
	frameAt,
	frameSize,
	frameStepTarget,
	insideFrame,
} from "./media-frame";
import { useDuration, useFailed, useWaveform } from "./media-hooks";
import { decideKey, keyOwner } from "./media-keys";
import { readLength, seekTarget } from "./media-length";
import { FULL_SENTENCE, MediaTransport, type TransportMarking, togglePlayback } from "./media-transport";
import { Column, type PaneExtrasProps, revisionOf, Strip, useSlot } from "./pane-shared";

const MEDIA = '[data-slot="viewer-media"]';
const DOCK = '[data-slot="viewer-media-dock"]';
/** How long a line of help stays under the buttons. */
const HINT_MS = 4000;
/** Cells the film lane is drawn with until it has measured itself and said what its width holds. */
const FILM_SLOTS_AT_FIRST = 8;

/**
 * Whether the page is visible at all: a View the host has folded away animates nothing. It does NOT pause the
 * recording: a folded panel keeps playing like any player in a background tab, and only choosing another tab
 * inside the viewer stops the sound.
 */
function usePageVisible(): boolean {
	const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
	useEffect(() => {
		const update = (): void => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}

// ── the glyphs of the two tools only a recording has ─────────────────────

function ToolGlyph({ path }: { readonly path: string }): ReactNode {
	return (
		<svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
			<path d={path} />
		</svg>
	);
}

const MOMENT = "M6 20.5V4M6 5h11l-2.5 3.5L17 12H6";
const STRETCH = "M4 7v10M20 7v10M4 12h16M8 9l-4 3 4 3M16 9l4 3-4 3";
const CANCEL = "M6 6l12 12M18 6 6 18";

export function TimelineMarks({ app, tab, active, ready, frame, mode }: PaneExtrasProps): ReactNode {
	const kind = tab.kind === "video" ? "video" : "audio";
	const slot = useSlot(frame, ready, MEDIA);
	const media = slot instanceof HTMLMediaElement ? slot : null;
	const video = media instanceof HTMLVideoElement ? media : null;
	const dock = useSlot(frame, ready, DOCK);
	const duration = useDuration(media);
	const failed = useFailed(media);
	const visible = usePageVisible();
	const live = active && visible;
	// Notes can be made on a recording that plays; the list shows while they can be made or there are some to keep.
	const markable = mode === "timeline" && !failed;
	const drawable = markable && video !== null;

	// Which frame is showing and how long one is, learned from frames reaching the screen. Costs nothing while hidden.
	const clock = useRef<FrameClock | null>(null);
	useEffect(() => {
		if (video === null || !live) return;
		const watcher = new FrameClock(video);
		clock.current = watcher;
		return () => {
			watcher.dispose();
			clock.current = null;
		};
	}, [video, live]);
	const frameSeconds = useCallback(() => clock.current?.frameSeconds ?? DEFAULT_FRAME_SECONDS, []);
	// The time a drawing made with the playhead at `playhead` is stamped with: the start of the frame on screen (`frameAt`).
	// The draw layer reads it too, so the number on a shape while it is drawn is the place it takes once it is a note.
	const drawingTime = useCallback(
		(playhead: number) => frameAt(clock.current?.showing ?? playhead, playhead, frameSeconds()),
		[frameSeconds],
	);

	// Pictures come from silent second elements, so the player never moves while "Request edits" works or the film
	// lane fills in, and the filmstrip's long line of small pictures never holds up the few big ones a send needs.
	// Each is made when the element is found and let go of when the element goes (a theme change re-mounts it) or the
	// pane does: a picture being taken then stops at once, and the note it was for goes as a time (and boxes) only.
	const [grabber, setGrabber] = useState<FrameGrabber | null>(null);
	const [stripGrabber, setStripGrabber] = useState<FrameGrabber | null>(null);
	useEffect(() => {
		if (video === null) {
			setGrabber(null);
			setStripGrabber(null);
			return;
		}
		const stills = new FrameGrabber(video);
		const strip = new FrameGrabber(video);
		setGrabber(stills);
		setStripGrabber(strip);
		return () => {
			stills.dispose();
			strip.dispose();
		};
	}, [video]);
	const stillSize = useCallback(
		() => (video === null || video.videoWidth === 0 ? null : frameSize(video.videoWidth, video.videoHeight)),
		[video],
	);
	const session = useTimelineMarks({
		app,
		file: tab.path,
		rev: revisionOf(tab),
		mediaKind: kind,
		duration,
		...(grabber === null ? {} : { grabFrame: (at: number) => grabber.grab(insideFrame(at, frameSeconds())) }),
		stillSize,
	});
	const { marks, addMark, addSpan, addShape, focusMark, setActiveId } = session;
	const full = marks.length >= MAX_TIMELINE_MARKS;

	// Only the tab on screen plays. Coming back does not resume: the human pressed pause by leaving.
	useEffect(() => {
		if (!active) media?.pause();
	}, [active, media]);

	// ── the lane's pictures: a sound's waveform, a video's filmstrip ───────────────────────────────────────
	const waveform = useWaveform(app, tab, kind === "audio" && live && ready, media);
	const [slots, setSlots] = useState(FILM_SLOTS_AT_FIRST);
	const filmstrip = useFilmstrip({
		source: stripGrabber,
		key: `${tab.path}\u0000${revisionOf(tab)}`,
		duration,
		slots,
		enabled: video !== null && live && !failed,
	});
	// A player that failed takes no pictures either: its empty cells are not waiting for any.
	const film = useMemo(
		() => ({ frames: filmstrip.frames, failed: filmstrip.failed || failed, slots, onSlots: setSlots }),
		[filmstrip, failed, slots],
	);

	// ── marking ─────────────────────────────────────────────────────────────────
	const [inPoint, setInPoint] = useState<number | null>(null);
	const [hint, setHint] = useState<string | null>(null);
	const [tool, setTool] = useState<MarkTool | null>(null);
	const hintTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(hintTimer.current), []);
	const say = useCallback((text: string) => {
		setHint(text);
		window.clearTimeout(hintTimer.current);
		hintTimer.current = window.setTimeout(() => setHint(null), HINT_MS);
	}, []);
	// A different recording: a stretch begun on the old one is not begun here.
	const identity = `${tab.path}\u0000${revisionOf(tab)}`;
	const previous = useRef(identity);
	useEffect(() => {
		if (previous.current === identity) return;
		previous.current = identity;
		setInPoint(null);
		setHint(null);
	}, [identity]);

	// The pen goes down with the layer (a recording that failed, or would not open) and is the human's to pick up
	// again; the card's Annotate action is the one ask that picks it up for them, in the tool they last held.
	useEffect(() => {
		if (!drawable) setTool(null);
	}, [drawable]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `annotateRequests` is the trigger; the tool is read as it stands.
	useEffect(() => {
		if (tab.annotateRequests > 0 && drawable) setTool(tool ?? "box");
	}, [tab.annotateRequests]);

	const seekTo = useCallback(
		(seconds: number) => {
			if (media !== null) media.currentTime = seekTarget(seconds, readLength(media));
		},
		[media],
	);

	const markHere = useCallback(() => {
		if (media === null) return;
		const at = media.currentTime;
		const already = markNear(marks, at);
		const id = addMark(at);
		if (id === undefined) say(FULL_SENTENCE);
		else if (already !== undefined) say(`Note ${[...marks].findIndex(mark => mark.id === already.id) + 1} is already here.`);
	}, [media, marks, addMark, say]);

	const makeSpan = useCallback(
		(from: number, to: number) => {
			if (addSpan(from, to) === undefined) say(FULL_SENTENCE);
		},
		[addSpan, say],
	);

	const stretch = useCallback(() => {
		if (media === null) return;
		const at = media.currentTime;
		if (inPoint === null) {
			setInPoint(at);
			return;
		}
		if (Math.abs(at - inPoint) < 0.1) {
			say("Move the playhead on from where the stretch starts, then end it.");
			return;
		}
		makeSpan(inPoint, at);
		setInPoint(null);
	}, [media, inPoint, makeSpan, say]);

	// The lane's own gesture for a note (a double-click on the wave, its Comment button): the lane opens a field for the
	// words itself, so the list must not also take the caret.
	const commentAt = useCallback(
		(at: number): number | null => {
			const id = addMark(at, { focusNote: false });
			if (id === undefined) {
				say(FULL_SENTENCE);
				return null;
			}
			setActiveId(id);
			return id;
		},
		[addMark, say, setActiveId],
	);

	// A finished shape on the frame on screen. Drawing stops the film first: the frame is the one the human saw. The shape
	// is stamped at that frame's start, and a layer shows it only while the playhead is inside the frame (`drawnOnFrame`):
	// a pause lands anywhere in the frame (and a refresh late), so the paused playhead is put just inside the frame the shape
	// belongs to, or the box would vanish the moment the pen is lifted. Nothing moves when it is there already.
	const drawShape = useCallback(
		(shape: MarkShape, aspect: number) => {
			if (video === null) return;
			video.pause();
			const seconds = frameSeconds();
			const at = drawingTime(video.currentTime);
			if (addShape(shape, at, aspect) === undefined) {
				if (full) say(FULL_SENTENCE);
				return;
			}
			if (!drawnOnFrame(at, video.currentTime, seconds)) seekTo(insideFrame(at, seconds));
		},
		[video, addShape, drawingTime, frameSeconds, seekTo, full, say],
	);

	// Where a note is looked at: a drawing on the frame it was drawn on (a tenth of a frame inside, so the seek lands on
	// it and not on the one before), with the film held there so it is there to be seen.
	const goTo = useCallback(
		(id: number) => {
			const mark = marks.find(entry => entry.id === id);
			if (mark === undefined) return;
			if (mark.shape === undefined) {
				seekTo(mark.at);
				return;
			}
			media?.pause();
			seekTo(insideFrame(mark.at, frameSeconds()));
		},
		[marks, media, seekTo, frameSeconds],
	);

	const selectMark = useCallback(
		(id: number) => {
			goTo(id);
			setActiveId(id);
			focusMark(id);
		},
		[goTo, setActiveId, focusMark],
	);

	const stepFrame = useCallback(
		(direction: 1 | -1) => {
			if (video === null) return;
			video.pause();
			const target = frameStepTarget(clock.current?.showing ?? video.currentTime, frameSeconds(), direction);
			video.currentTime = seekTarget(target, readLength(video));
		},
		[video, frameSeconds],
	);

	// ── the keyboard ────────────────────────────────────────────────────────────
	const { undo, redo } = session;
	useEffect(() => {
		if (!active || media === null) return;
		const onKey = (event: KeyboardEvent): void => {
			// Something already answered it (the scrubber's own arrows, the drawing surface's), or it is Alt's.
			if (event.defaultPrevented || event.altKey) return;
			// Whose key it is comes first: text being typed, a button's Space, a slider's or tab bar's arrows and Home and End are theirs.
			const action = decideKey({
				key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
				shift: event.shiftKey,
				modifier: event.ctrlKey || event.metaKey,
				repeat: event.repeat,
				position: media.currentTime,
				length: readLength(media),
				kind,
				marking: markable,
				drawing: drawable,
				armed: tool !== null,
				inPoint,
				owner: keyOwner(event.target),
			});
			if (action === null) return;
			switch (action.do) {
				case "toggle":
					event.preventDefault();
					togglePlayback(media);
					break;
				case "seek":
					event.preventDefault();
					media.currentTime = action.to;
					break;
				case "step":
					event.preventDefault();
					stepFrame(action.direction);
					break;
				case "mark":
					event.preventDefault();
					markHere();
					break;
				case "set-in":
					event.preventDefault();
					setInPoint(media.currentTime);
					break;
				case "needs-start":
					event.preventDefault();
					say("Press I where the stretch starts, then O where it ends.");
					break;
				case "end-stretch":
					event.preventDefault();
					stretch();
					break;
				case "cancel-stretch":
					setInPoint(null);
					break;
				case "disarm":
					setTool(null);
					break;
				case "tool":
					event.preventDefault();
					setTool(action.tool);
					break;
				case "undo":
					event.preventDefault();
					undo();
					break;
				case "redo":
					event.preventDefault();
					redo();
					break;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active, media, kind, markable, drawable, tool, inPoint, markHere, stretch, stepFrame, say, undo, redo]);

	// ── what is drawn ──────────────────────────────────────────────────────────
	const items = useMemo<PanelItem[]>(
		() =>
			marks.map(mark => ({
				id: mark.id,
				heading: mark.shape === undefined ? formatMarkTime(mark) : `${formatMarkTime(mark)} · ${SHAPE_WORD[mark.shape.kind]}`,
				headingStyle: "code",
				note: mark.note,
			})),
		[marks],
	);
	const transportMarking = useMemo<TransportMarking | null>(
		() =>
			markable
				? { full, inPoint, hint, onSpan: makeSpan, onComment: commentAt, onRemove: session.remove }
				: null,
		[markable, full, inPoint, hint, makeSpan, commentAt, session.remove],
	);

	// The one toolbar: the two tools a recording has, and for a video the picture's drawing tools and undo.
	const groups = useMemo<ToolGroupDef[]>(
		() => [
			{
				id: "timeline",
				label: "Moment and stretch",
				kind: "act",
				tools: [
					{ id: "moment", label: "Moment", icon: <ToolGlyph path={MOMENT} />, key: "M", disabled: full || failed, onSelect: markHere },
					{
						id: "stretch",
						label: inPoint === null ? "Stretch" : "End stretch",
						icon: <ToolGlyph path={STRETCH} />,
						...(inPoint === null ? {} : { text: `from ${formatTimecode(inPoint)}` }),
						key: inPoint === null ? "I" : "O",
						disabled: full || failed,
						onSelect: stretch,
					},
					...(inPoint === null
						? []
						: [{ id: "cancel-stretch", label: "Cancel stretch", icon: <ToolGlyph path={CANCEL} />, key: "Esc", onSelect: () => setInPoint(null) }]),
				],
			},
			...(kind === "video"
				? markupToolGroups({
						tool,
						onTool: picked => setTool(drawable ? picked : null),
						canUndo: session.canUndo,
						canRedo: session.canRedo,
						onUndo: undo,
						onRedo: redo,
						onClear: session.clear,
						hasMarks: marks.length > 0,
					})
				: []),
		],
		[full, failed, inPoint, kind, tool, drawable, markHere, stretch, undo, redo, session.canUndo, session.canRedo, session.clear, marks.length],
	);
	const toolbarHint = full
		? FULL_SENTENCE
		: kind === "audio"
			? "Double-click the wave to add a note"
			: tool === null
				? "Pick a tool to draw"
				: "Drag to draw · press the tool again, or Esc, to play and scroll";

	return (
		<>
			{media === null || dock === null
				? null
				: createPortal(
						<MediaTransport
							media={media}
							kind={kind}
							filename={tab.filename}
							live={live}
							marks={marks}
							activeId={session.activeId}
							onSelectMark={selectMark}
							onNote={session.setNote}
							{...(waveform === undefined ? {} : { waveform })}
							{...(kind === "video" ? { film } : {})}
							marking={transportMarking}
						/>,
						dock,
					)}
			{video === null ? null : (
				<DrawLayer
					video={video}
					live={live}
					marks={marks}
					tool={tool}
					activeId={session.activeId}
					filename={tab.filename}
					frameSeconds={frameSeconds}
					drawingTime={drawingTime}
					onBegin={() => video.pause()}
					onShape={drawShape}
				/>
			)}
			{mode === "timeline" ? (
				<Strip frame={frame}>
					<AnnotationToolbar label="Annotation tools" placement="strip" groups={groups} trailing={toolbarHint} />
				</Strip>
			) : null}
			{mode === "timeline" && (markable || marks.length > 0) ? (
				<Column frame={frame}>
					<AnnotationPanel
						title="Notes"
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
						rowActions={item => {
							const mark = marks.find(entry => entry.id === item.id);
							return mark === undefined ? null : (
								<button type="button" className="dam-tl-go" onClick={() => goTo(mark.id)} aria-label={`Go to ${formatTimecode(mark.at)}`} title={`Move the playhead to ${formatTimecode(mark.at)}`}>
									Go to
								</button>
							);
						}}
						emptyHint={
							<>
								<strong>Add a note</strong>
								<span>
									{kind === "video" ? (
										<>
											Pick a tool and draw on the picture, press <kbd>M</kbd> where something should change, or drag along the strip to select a stretch. <kbd>I</kbd> and <kbd>O</kbd> set a stretch from the keyboard.
										</>
									) : (
										<>
											Double-click the wave where something should change, or press <kbd>M</kbd>. Drag along it with a modifier to select a stretch, or use <kbd>I</kbd> and <kbd>O</kbd>.
										</>
									)}
								</span>
							</>
						}
					/>
				</Column>
			) : null}
		</>
	);
}
