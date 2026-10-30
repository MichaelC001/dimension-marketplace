import { FULL_SENTENCE, type MarkShape, type MarkTool } from "@dimension/mcp-app-kit/annotate";
import {
	AnnotationNotice,
	AnnotationToolbar,
	markupToolGroups,
	type ToolGroupDef,
	useTimelineMarks,
	useTimelineTools,
} from "@dimension/mcp-app-kit/annotate/react";
import { frameSize, insideFrame, keyOwner, readLength } from "@dimension/mcp-app-kit/media";
import { useFilmstrip, useFrameGrabber, useMediaPlayer, useMediaSelect, usePageVisible } from "@dimension/mcp-app-kit/media/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DrawLayer } from "./media-draw";
import { decideKey } from "./media-keys";
import { MediaTransport, type TransportMarking } from "./media-transport";
import { useWaveform } from "./media-waveform";
import { SharedFrameMarks, SharedLane } from "./pane-extras-shared";
import { Footer, type PaneExtrasProps, revisionOf, Strip, useSlot } from "./pane-shared";

const MEDIA = '[data-slot="viewer-media"]';
const DOCK = '[data-slot="viewer-media-dock"]';
const FILM_SLOTS_AT_FIRST = 8;
const NO_TIMES: readonly never[] = [];

export function TimelineMarks({ app, tab, active, ready, frame, mode, store, shared }: PaneExtrasProps): ReactNode {
	const kind = tab.kind === "video" ? "video" : "audio";
	const identity = `${tab.path}\u0000${revisionOf(tab)}`;
	const slot = useSlot(frame, ready, MEDIA);
	const media = slot instanceof HTMLMediaElement ? slot : null;
	const video = media instanceof HTMLVideoElement ? media : null;
	const dock = useSlot(frame, ready, DOCK);
	const player = useMediaPlayer(media, { active });
	const duration = useMediaSelect(player, state => state.duration);
	const failed = useMediaSelect(player, state => state.failed !== null);
	const visible = usePageVisible();
	const live = active && visible;
	const markable = mode === "timeline" && !failed;
	const drawable = markable && video !== null;
	const penUp = markable && kind === "video";

	const { playhead, clock } = player;
	const { frameSeconds } = clock;

	const grabber = useFrameGrabber(video);
	const stripGrabber = useFrameGrabber(video);
	const stillSize = useCallback(() => (video === null || video.videoWidth === 0 ? null : frameSize(video.videoWidth, video.videoHeight)), [video]);
	const session = useTimelineMarks({
		app,
		file: tab.path,
		rev: revisionOf(tab),
		mediaKind: kind,
		duration,
		...(grabber === null ? {} : { grabFrame: (at: number) => grabber.grab(insideFrame(at, frameSeconds())) }),
		stillSize,
		autoStage: active && mode === "timeline",
		store,
	});
	const { marks, addShape, writing, openNote, closeNote } = session;
	const tools = useTimelineTools({ media, marks, addMark: session.addMark, addSpan: session.addSpan, markable });
	const { full, say, press, reset } = tools;

	const waveform = useWaveform(app, tab, kind === "audio" && live && ready, player);
	const [slots, setSlots] = useState(FILM_SLOTS_AT_FIRST);
	const filmstrip = useFilmstrip({ source: stripGrabber, key: identity, duration, slots, enabled: video !== null && live && !failed });
	const film = useMemo(() => ({ frames: filmstrip.frames, failed: filmstrip.failed || failed, slots, onSlots: setSlots }), [filmstrip, failed, slots]);

	const [tool, setTool] = useState<MarkTool | null>(null);
	const previous = useRef(identity);
	useEffect(() => {
		if (previous.current === identity) return;
		previous.current = identity;
		reset();
	}, [identity, reset]);

	useEffect(() => {
		if (!penUp) setTool(null);
	}, [penUp]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `annotateRequests` is the trigger; the tool is read as it stands.
	useEffect(() => {
		if (tab.annotateRequests > 0 && penUp) setTool(tool ?? "box");
	}, [tab.annotateRequests]);

	const drawShape = useCallback(
		(shape: MarkShape, aspect: number): number | undefined => {
			if (video === null) return undefined;
			const id = player.stamp(at => addShape(shape, at, aspect));
			if (id === undefined && full) say(FULL_SENTENCE);
			return id;
		},
		[video, player, addShape, full, say],
	);

	const goTo = useCallback(
		(id: number) => {
			const mark = marks.find(entry => entry.id === id);
			if (mark === undefined) return;
			if (mark.shape === undefined) player.seek(mark.at);
			else player.showFrame(mark.at);
		},
		[marks, player],
	);

	const sharedTimes = shared?.places.times ?? NO_TIMES;
	const sharedFrames = shared?.places.frames ?? NO_TIMES;
	const sharedPicked = shared?.openId ?? null;
	const sharedOpen = sharedPicked === null ? undefined : sharedTimes.find(thread => thread.id === sharedPicked);
	const sharedOpenId = sharedOpen?.id;
	const sharedOpenAt = sharedOpen?.at;
	const sharedOpenDrawn = sharedOpen?.drawn === true;
	useEffect(() => {
		if (!active || sharedOpenId === undefined || sharedOpenAt === undefined) return;
		if (sharedOpenDrawn && video !== null) player.showFrame(sharedOpenAt);
		else player.seek(sharedOpenAt);
	}, [active, sharedOpenId, sharedOpenAt, sharedOpenDrawn, video, player]);
	const sharedLaneId = sharedOpen !== undefined && !(sharedOpenDrawn && video !== null) ? sharedOpen.id : null;

	const selectMark = useCallback(
		(id: number) => {
			goTo(id);
			openNote(id);
		},
		[goTo, openNote],
	);

	const { undo, redo } = session;
	const { inPoint } = tools;
	useEffect(() => {
		if (!active || media === null) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.defaultPrevented || event.altKey) return;
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
					player.toggle();
					break;
				case "seek":
					event.preventDefault();
					player.seek(action.to);
					break;
				case "step":
					event.preventDefault();
					player.stepFrame(action.direction);
					break;
				case "mark":
				case "set-in":
				case "needs-start":
				case "end-stretch":
					event.preventDefault();
					press(action.do);
					break;
				case "cancel-stretch":
					press(action.do);
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
	}, [active, media, player, kind, markable, drawable, tool, inPoint, press, undo, redo]);

	const transportMarking = useMemo<TransportMarking | null>(
		() => (markable ? { full, inPoint, hint: tools.hint, onSpan: tools.makeSpan, onComment: tools.commentAt } : null),
		[markable, full, inPoint, tools.hint, tools.makeSpan, tools.commentAt],
	);

	const writingMark = writing === null ? undefined : marks.find(mark => mark.id === writing.id);
	const pictureId = writingMark?.shape !== undefined && drawable ? writingMark.id : null;
	const laneId = writingMark !== undefined && pictureId === null ? writingMark.id : null;
	const onPictureNote = useCallback((id: number | null) => (id === null ? closeNote("outside") : openNote(id)), [openNote, closeNote]);

	const groups = useMemo<ToolGroupDef[]>(
		() => [
			tools.group,
			...(kind === "video"
				? markupToolGroups({
						tool,
						onTool: picked => setTool(penUp ? picked : null),
						canUndo: session.canUndo,
						canRedo: session.canRedo,
						onUndo: undo,
						onRedo: redo,
						onClear: session.clear,
						hasMarks: marks.length > 0,
					})
				: []),
		],
		[tools.group, kind, tool, penUp, undo, redo, session.canUndo, session.canRedo, session.clear, marks.length],
	);
	const toolbarHint = full ? FULL_SENTENCE : undefined;

	return (
		<>
			{media === null || dock === null
				? null
				: createPortal(
						<MediaTransport
							player={player}
							kind={kind}
							filename={tab.filename}
							marks={marks}
							activeId={writingMark?.id ?? null}
							onSelectMark={selectMark}
							onNote={session.setNote}
							openId={laneId}
							onClose={closeNote}
							onRemove={session.remove}
							{...(waveform === undefined ? {} : { waveform })}
							{...(kind === "video" ? { film } : {})}
							marking={transportMarking}
							{...(shared === undefined || sharedTimes.length === 0
								? {}
								: {
										under: (
											<SharedLane
												duration={duration}
												threads={sharedTimes}
												openId={sharedLaneId}
												onSelect={shared.onOpen}
												onOpen={shared.onOpen}
												onReply={shared.onReply}
												filename={tab.filename}
											/>
										),
									})}
						/>,
						dock,
					)}
			{video === null ? null : (
				<DrawLayer
					video={video}
					playhead={playhead}
					marks={marks}
					tool={tool}
					activeId={pictureId}
					filename={tab.filename}
					frameSeconds={frameSeconds}
					drawingTime={player.drawingTime}
					onBegin={() => video.pause()}
					onShape={drawShape}
					openId={pictureId}
					onOpen={onPictureNote}
					onNote={session.setNote}
					onRemove={session.remove}
				/>
			)}
			{video === null || shared === undefined || !active || sharedFrames.length === 0 ? null : (
				<SharedFrameMarks
					video={video}
					playhead={playhead}
					clock={clock}
					frames={shared.places.frames}
					openId={shared.openId}
					onOpen={shared.onOpen}
					onReply={shared.onReply}
					filename={tab.filename}
				/>
			)}
			{mode === "timeline" ? (
				<Strip frame={frame}>
					<AnnotationToolbar label="Annotation tools" placement="strip" groups={groups} trailing={toolbarHint} />
				</Strip>
			) : null}
			{mode === "timeline" && (markable || marks.length > 0) ? (
				<Footer frame={frame}>
					<AnnotationNotice status={session.status} />
				</Footer>
			) : null}
		</>
	);
}
