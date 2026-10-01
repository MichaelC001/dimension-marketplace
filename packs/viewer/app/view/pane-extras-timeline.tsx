// The layer for audio and video (docs/design/88 section 3): the transport that plays a
// recording, and - in timeline mode - the marks on it.
//
// What lives HERE is the seating and the rules that come from the pane rather than the kit:
//   * the transport is ALWAYS shown, mounted into the dock the renderer left under the
//     element (`viewer-media-dock`): a recording is played with it, annotating or not;
//   * marks belong to the recording and outlive the mode and the renderer: the session
//     sits in the component that never unmounts, and the element and dock are looked up
//     again each time the renderer says `ready` (a theme change re-mounts it);
//   * only the tab on screen plays and paints: a hidden tab's media is paused, its frames
//     are not animated, its waveform is not decoded.
import { formatMarkTime, formatTimecode, markNear, MAX_TIMELINE_MARKS } from "@dimension/mcp-app-kit/annotate";
import { AnnotationPanel, type PanelItem, useTimelineMarks } from "@dimension/mcp-app-kit/annotate/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadDocumentBytes } from "./document-bytes";
import { FrameClock, FrameGrabber, frameStepTarget } from "./media-frame";
import { decideKey, keyOwner } from "./media-keys";
import { type MediaLength, readLength, sameLength, seekTarget } from "./media-length";
import { FULL_SENTENCE, MediaTransport, type TransportMarking, togglePlayback } from "./media-transport";
import { decodePeaks, WAVEFORM_MAX_BYTES, waveformAllowed } from "./media-waveform";
import { Column, type PaneExtrasProps, revisionOf, useSlot } from "./pane-shared";

const MEDIA = '[data-slot="viewer-media"]';
const DOCK = '[data-slot="viewer-media-dock"]';
const NO_LENGTH: MediaLength = { duration: 0, reach: 0, unbounded: false };
/** What can change the length a recording reports or how far it can be played. */
const LENGTH_EVENTS = ["durationchange", "loadedmetadata", "timeupdate", "seeked", "progress", "emptied"] as const;
/** How long a line of help stays under the buttons. */
const HINT_MS = 4000;

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

/** What the recording says about its own length; nothing until there is an element to ask. */
function useLength(media: HTMLMediaElement | null): MediaLength {
	const [length, setLength] = useState<MediaLength>(NO_LENGTH);
	useEffect(() => {
		if (media === null) {
			setLength(NO_LENGTH);
			return;
		}
		const read = (): void =>
			setLength(previous => {
				const next = readLength(media);
				// The same answer is the same state: a playing recording is asked four times a second.
				return sameLength(previous, next) ? previous : next;
			});
		for (const type of LENGTH_EVENTS) media.addEventListener(type, read);
		read();
		return () => {
			for (const type of LENGTH_EVENTS) media.removeEventListener(type, read);
		};
	}, [media]);
	return length;
}

export function TimelineMarks({ app, tab, active, ready, frame, mode, onMode }: PaneExtrasProps): ReactNode {
	const kind = tab.kind === "video" ? "video" : "audio";
	const slot = useSlot(frame, ready, MEDIA);
	const media = slot instanceof HTMLMediaElement ? slot : null;
	const dock = useSlot(frame, ready, DOCK);
	const length = useLength(media);
	const visible = usePageVisible();
	const live = active && visible;
	const marking = mode === "timeline";

	// Stills come from a silent second element, so the player never moves while "Request edits" works. It is made
	// when the element is found and let go of when the element goes (a theme change re-mounts it) or the pane does:
	// a still being taken then stops at once, and the mark it was for goes as a time only.
	const [grabber, setGrabber] = useState<FrameGrabber | null>(null);
	useEffect(() => {
		if (!(media instanceof HTMLVideoElement)) {
			setGrabber(null);
			return;
		}
		const next = new FrameGrabber(media);
		setGrabber(next);
		return () => next.dispose();
	}, [media]);
	const session = useTimelineMarks({
		app,
		file: tab.path,
		rev: revisionOf(tab),
		mediaKind: kind,
		duration: length.duration,
		...(grabber === null ? {} : { grabFrame: (at: number) => grabber.grab(at) }),
	});
	const { marks, addMark, addSpan, focusMark, setActiveId } = session;

	// Only the tab on screen plays. Coming back does not resume: the human pressed pause by leaving.
	useEffect(() => {
		if (!active) media?.pause();
	}, [active, media]);

	// Which frame is showing and how long one is, learned from frames reaching the screen. Costs nothing while hidden.
	const frames = useRef<FrameClock | null>(null);
	useEffect(() => {
		if (!(media instanceof HTMLVideoElement) || !live) return;
		const clock = new FrameClock(media);
		frames.current = clock;
		return () => {
			clock.dispose();
			frames.current = null;
		};
	}, [media, live]);

	// ── the waveform: sound only, on the screen, and only for a file whose cost the viewer can count ───────
	const fileId = `${tab.key}\u0000${tab.size}:${tab.mtimeMs}`;
	const [peaks, setPeaks] = useState<{ readonly id: string; readonly values: Float32Array } | null>(null);
	const eligible = kind === "audio" && media !== null && tab.size <= WAVEFORM_MAX_BYTES;
	useEffect(() => {
		if (!eligible || !live || peaks?.id === fileId) return;
		const controller = new AbortController();
		void (async () => {
			try {
				// The document cache the pane already filled: the bytes are in memory, not read again.
				const { bytes } = await loadDocumentBytes(app, tab, { signal: controller.signal });
				// Only an uncompressed WAV whose header the viewer has checked is decoded; every other file has a plain track.
				if (!waveformAllowed(bytes)) return;
				const values = await decodePeaks(bytes, controller.signal);
				if (values !== null && !controller.signal.aborted) setPeaks({ id: fileId, values });
			} catch {
				// A codec this engine cannot decode, or a pane that went away: a plain track is the answer.
			}
		})();
		return () => controller.abort();
	}, [app, tab, fileId, eligible, live, peaks?.id]);
	const waveform = peaks?.id === fileId ? peaks.values : undefined;

	// ── marking ─────────────────────────────────────────────────────────────────
	const [inPoint, setInPoint] = useState<number | null>(null);
	const [hint, setHint] = useState<string | null>(null);
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
		else if (already !== undefined) say(`Mark ${[...marks].findIndex(mark => mark.id === already.id) + 1} is already here.`);
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

	const selectMark = useCallback(
		(id: number) => {
			const mark = marks.find(entry => entry.id === id);
			if (mark !== undefined) seekTo(mark.at);
			setActiveId(id);
			focusMark(id);
		},
		[marks, seekTo, setActiveId, focusMark],
	);

	const stepFrame = useCallback(
		(direction: 1 | -1) => {
			if (!(media instanceof HTMLVideoElement)) return;
			media.pause();
			const clock = frames.current;
			const target = frameStepTarget(clock?.showing ?? media.currentTime, clock?.frameSeconds ?? 1 / 30, direction);
			media.currentTime = seekTarget(target, readLength(media));
		},
		[media],
	);

	// ── the keyboard ────────────────────────────────────────────────────────────
	useEffect(() => {
		if (!active || media === null) return;
		const onKey = (event: KeyboardEvent): void => {
			// Something already answered it (the scrubber's own arrows), or it is a chord.
			if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
			// Whose key it is comes first: text being typed, a button's Space, a slider's or tab bar's arrows and Home and End are theirs.
			const action = decideKey({
				key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
				shift: event.shiftKey,
				position: media.currentTime,
				length: readLength(media),
				kind,
				marking,
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
				case "leave-mode":
					onMode(null);
					break;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active, media, kind, marking, inPoint, onMode, markHere, stretch, stepFrame, say]);

	// ── what is drawn ──────────────────────────────────────────────────────────
	const items = useMemo<PanelItem[]>(
		() => marks.map(mark => ({ id: mark.id, heading: formatMarkTime(mark), headingStyle: "code", note: mark.note })),
		[marks],
	);
	const transportMarking = useMemo<TransportMarking | null>(
		() =>
			marking
				? {
						full: marks.length >= MAX_TIMELINE_MARKS,
						inPoint,
						hint,
						onMark: markHere,
						onStretch: stretch,
						onCancelStretch: () => setInPoint(null),
						onSpan: makeSpan,
					}
				: null,
		[marking, marks.length, inPoint, hint, markHere, stretch, makeSpan],
	);

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
							{...(waveform === undefined ? {} : { waveform })}
							marking={transportMarking}
						/>,
						dock,
					)}
			{marking ? (
				<Column frame={frame}>
					<AnnotationPanel
						title="Marks"
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
								<button type="button" className="dam-tl-go" onClick={() => seekTo(mark.at)} aria-label={`Go to ${formatTimecode(mark.at)}`} title={`Move the playhead to ${formatTimecode(mark.at)}`}>
									Go to
								</button>
							);
						}}
						emptyHint={
							<>
								<strong>Mark this {kind === "video" ? "video" : "recording"}</strong>
								<span>
									Press <kbd>M</kbd> where something should change, or drag across the bar to mark a stretch. <kbd>I</kbd> and <kbd>O</kbd> set a stretch from the keyboard.
								</span>
							</>
						}
					/>
				</Column>
			) : null}
		</>
	);
}
