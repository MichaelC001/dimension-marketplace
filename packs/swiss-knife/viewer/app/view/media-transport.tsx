import { clampTime, type FilmFrame, FULL_SENTENCE, type Playhead, type TimelineMark } from "@dimension/mcp-app-kit/annotate";
import { FilmLane, type NoteCloseReason, Transport, useMediaState, WaveLane } from "@dimension/mcp-app-kit/annotate/react";
import { cn } from "@fraym/ui/lib/cn";
import type { ReactNode } from "react";
import { UNBOUNDED_SENTENCE } from "./media-length";
import { describeMediaError, type MediaTag } from "./media-messages";

export interface TransportMarking {
	readonly full: boolean;
	readonly inPoint: number | null;
	readonly hint: string | null;
	readonly onSpan: (from: number, to: number) => void;
	readonly onComment: (at: number) => void;
}

export interface TransportFilm {
	readonly frames: readonly FilmFrame[];
	readonly failed: boolean;
	readonly slots: number;
	readonly onSlots: (count: number) => void;
}

export interface MediaTransportProps {
	readonly media: HTMLMediaElement;
	readonly kind: MediaTag;
	readonly filename: string;
	readonly playhead: Playhead;
	readonly marks: readonly TimelineMark[];
	readonly activeId: number | null;
	readonly onSelectMark: (id: number) => void;
	readonly onNote: (id: number, note: string) => void;
	readonly openId: number | null;
	readonly onClose: (reason: NoteCloseReason) => void;
	readonly onRemove: (id: number) => void;
	readonly waveform?: ArrayLike<number>;
	readonly film?: TransportFilm;
	readonly marking: TransportMarking | null;
	readonly under?: ReactNode;
}

const NO_FRAMES: readonly FilmFrame[] = [];

export function MediaTransport({ media, kind, filename, playhead, marks, activeId, onSelectMark, onNote, openId, onClose, onRemove, waveform, film, marking, under }: MediaTransportProps): ReactNode {
	const state = useMediaState(media);
	const seek = (seconds: number): void => {
		const to = clampTime(seconds, state.duration);
		media.currentTime = to;
		playhead.set(to);
	};
	const failure = state.failed === null ? null : describeMediaError(kind, undefined, true, state.failed, state.failedDetail);
	const floatingHint = marking?.hint !== null && marking?.hint !== undefined && !(marking.full && marking.hint === FULL_SENTENCE);

	return (
		<Transport media={media} state={state} playhead={playhead} failure={failure}>
			{marking === null ? null : (
				<p role="status" data-slot="viewer-transport-hint" className={cn("pointer-events-none absolute inset-x-3 bottom-full mb-2 flex justify-center", !floatingHint && "sr-only")}>
					{marking.hint === null ? null : (
						<span className="rounded-full border border-fr-border-soft bg-fr-surface px-3 py-1 text-center text-fr-xs text-fr-text-2">{marking.hint}</span>
					)}
				</p>
			)}
			{kind === "video" ? (
				<FilmLane
					playhead={playhead}
					duration={state.duration}
					frames={film?.frames ?? NO_FRAMES}
					failed={film?.failed ?? false}
					slots={film?.slots ?? 1}
					{...(film === undefined ? {} : { onSlots: film.onSlots })}
					marks={marks}
					activeId={activeId}
					onSeek={seek}
					onSelectMark={onSelectMark}
					openId={openId}
					onNote={onNote}
					onClose={onClose}
					onRemove={onRemove}
					{...(marking === null ? {} : { onSpan: marking.onSpan })}
					inPoint={marking?.inPoint ?? null}
					label={`Position in ${filename}`}
				/>
			) : (
				<WaveLane
					playhead={playhead}
					duration={state.duration}
					peaks={waveform ?? null}
					marks={marks}
					activeId={activeId}
					onSeek={seek}
					onSelectMark={onSelectMark}
					openId={openId}
					onNote={onNote}
					onClose={onClose}
					onRemove={onRemove}
					{...(marking === null ? {} : { onSpan: marking.onSpan, onComment: marking.onComment, inPoint: marking.inPoint })}
					label={`Position in ${filename}`}
				/>
			)}
			{under}
			{marking !== null && state.unbounded ? (
				<p data-slot="viewer-transport-note" className="pb-1 text-fr-xs text-fr-text-3">
					{UNBOUNDED_SENTENCE}
				</p>
			) : null}
		</Transport>
	);
}
