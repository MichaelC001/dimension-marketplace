import { FULL_SENTENCE, type TimelineMark } from "@dimension/mcp-app-kit/annotate";
import { FilmLane, type NoteCloseReason, Transport, WaveLane } from "@dimension/mcp-app-kit/annotate/react";
import type { FilmFrame, MediaPlayer } from "@dimension/mcp-app-kit/media";
import { useMediaState } from "@dimension/mcp-app-kit/media/react";
import { cn } from "@fraym/ui/lib/cn";
import type { ReactNode } from "react";
import { describeMediaError, type MediaTag, UNBOUNDED_SENTENCE } from "./media-messages";

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
	readonly player: MediaPlayer;
	readonly kind: MediaTag;
	readonly filename: string;
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

export function MediaTransport({ player, kind, filename, marks, activeId, onSelectMark, onNote, openId, onClose, onRemove, waveform, film, marking, under }: MediaTransportProps): ReactNode {
	const state = useMediaState(player);
	const { playhead } = player;
	const seek = (seconds: number): void => void player.seek(seconds);
	const failure = state.failed === null ? null : describeMediaError(kind, undefined, true, state.failed, state.failedDetail);
	const floatingHint = marking?.hint !== null && marking?.hint !== undefined && !(marking.full && marking.hint === FULL_SENTENCE);

	return (
		<Transport player={player} failure={failure}>
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
					duration={state.reach}
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
					duration={state.reach}
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
