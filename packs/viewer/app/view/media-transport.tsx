// How a recording is played: play and pause, the scrubber (the kit's `TimelineBar`, so
// playing and marking are one control), elapsed over total, volume, speed. Always shown for
// audio and video, because it is how they are played at all; in timeline mode the same bar
// also carries the marks and the buttons that make them.
//
// Mounted into the renderer's dock (`data-slot="viewer-media-dock"`), driven by the media
// element's events. The element is the truth: nothing here keeps a second clock except the
// playhead's position, which is read from the element once per animation frame WHILE it is
// playing and this document is the one on screen - and not at all otherwise. That position
// lives in a small store the scrubber and the clock listen to, not in the transport's
// state, and not in a prop: the scrubber paints it into its own DOM and the clock redraws
// only when its tenths change, so a frame draws none of the buttons, the volume, the speed,
// the marks or the scrubber itself.
import { clampTime, formatTimecode, MAX_TIMELINE_MARKS, type TimelineMark } from "@dimension/mcp-app-kit/annotate";
import { type TimeRange, TimelineBar } from "@dimension/mcp-app-kit/annotate/react";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { cn } from "@fraym/ui/lib/cn";
import { type CSSProperties, type ReactElement, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { readLength, UNBOUNDED_SENTENCE } from "./media-length";
import { describeMediaError, type MediaTag } from "./media-messages";

/** Speeds the speed button steps through. */
export const RATES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

const MAX_BUFFERED_SHOWN = 32;

export interface MediaState {
	/** How far into the recording the player can go: its length, or - for one that does not say - as far as it is known so far. */
	readonly duration: number;
	/** The recording does not say how long it is. */
	readonly unbounded: boolean;
	readonly playing: boolean;
	readonly rate: number;
	readonly volume: number;
	readonly muted: boolean;
	readonly buffered: readonly TimeRange[];
	/** The element's `MediaError.code`, once playback has failed. */
	readonly failed: number | null;
	/** …and the engine's own words about it. */
	readonly failedDetail: string;
}

function readState(media: HTMLMediaElement): MediaState {
	const buffered: TimeRange[] = [];
	for (let index = 0; index < Math.min(media.buffered.length, MAX_BUFFERED_SHOWN); index += 1) {
		buffered.push({ start: media.buffered.start(index), end: media.buffered.end(index) });
	}
	const length = readLength(media);
	return {
		duration: length.reach,
		unbounded: length.unbounded,
		playing: !media.paused && !media.ended,
		rate: media.playbackRate,
		volume: media.volume,
		muted: media.muted,
		buffered,
		failed: media.error?.code ?? null,
		failedDetail: media.error?.message ?? "",
	};
}

function sameState(a: MediaState, b: MediaState): boolean {
	return (
		a.duration === b.duration &&
		a.unbounded === b.unbounded &&
		a.playing === b.playing &&
		a.rate === b.rate &&
		a.volume === b.volume &&
		a.muted === b.muted &&
		a.failed === b.failed &&
		a.failedDetail === b.failedDetail &&
		a.buffered.length === b.buffered.length &&
		a.buffered.every((range, index) => range.start === b.buffered[index]?.start && range.end === b.buffered[index]?.end)
	);
}

const STATE_EVENTS = [
	"play",
	"pause",
	"ended",
	"playing",
	"ratechange",
	"volumechange",
	"durationchange",
	"loadedmetadata",
	"loadeddata",
	"progress",
	// A recording that does not say how long it is is only as long as it has been played or found so far.
	"timeupdate",
	"seeked",
	"emptied",
	"error",
] as const;

/** What the element says about itself, other than where it is: re-read only when it says something changed. */
export function useMediaState(media: HTMLMediaElement): MediaState {
	const [state, setState] = useState(() => readState(media));
	useEffect(() => {
		const update = (): void =>
			setState(previous => {
				const next = readState(media);
				return sameState(previous, next) ? previous : next;
			});
		for (const type of STATE_EVENTS) media.addEventListener(type, update);
		update();
		return () => {
			for (const type of STATE_EVENTS) media.removeEventListener(type, update);
		};
	}, [media]);
	return state;
}

/**
 * Where the playhead is, held outside React so that only the parts that draw it redraw. Moving it to the same place
 * tells nobody.
 */
export interface Playhead {
	readonly get: () => number;
	readonly set: (seconds: number) => void;
	readonly subscribe: (listener: () => void) => () => void;
}

export function createPlayhead(start: number): Playhead {
	let position = start;
	const listeners = new Set<() => void>();
	return {
		get: () => position,
		set(seconds) {
			if (seconds === position) return;
			position = seconds;
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}

const POSITION_EVENTS = ["timeupdate", "seeking", "seeked", "emptied", "loadedmetadata"] as const;

/**
 * Keeps the playhead where the element is. Events keep it right while paused or seeking; while PLAYING it is read once
 * per animation frame (the element's `timeupdate` is four times a second, a playhead that visibly steps) - and only
 * while `live`, so a recording in a hidden tab costs no frames. The hook itself never re-renders its caller for it.
 */
export function useMediaPosition(media: HTMLMediaElement, playing: boolean, live: boolean): Playhead {
	const [playhead] = useState(() => createPlayhead(media.currentTime));
	useEffect(() => {
		const sync = (): void => playhead.set(media.currentTime);
		for (const type of POSITION_EVENTS) media.addEventListener(type, sync);
		sync();
		return () => {
			for (const type of POSITION_EVENTS) media.removeEventListener(type, sync);
		};
	}, [media, playhead]);
	useEffect(() => {
		if (!playing || !live) return;
		let frame = 0;
		const tick = (): void => {
			playhead.set(media.currentTime);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [media, playing, live, playhead]);
	return playhead;
}

/** The elapsed time. What it watches is the TEXT, so it is drawn again when the tenths change, not on every frame. */
function Elapsed({ playhead }: { readonly playhead: Playhead }): ReactElement {
	const text = useSyncExternalStore(playhead.subscribe, () => formatTimecode(playhead.get()));
	return <span className="text-fr-text">{text}</span>;
}

/** Play when paused, pause when playing. A refused `play()` (no gesture, no source) is not an error to throw at the human. */
export function togglePlayback(media: HTMLMediaElement): void {
	if (media.paused || media.ended) void media.play().catch(() => undefined);
	else media.pause();
}

// ── glyphs ───────────────────────────────────────────────────────────────

type GlyphName = "play" | "pause" | "volume" | "volumeLow" | "muted" | "mark" | "stretch" | "x";

const GLYPHS: Readonly<Record<GlyphName, ReactElement>> = {
	play: <path d="M8 5.2v13.6a.6.6 0 0 0 .92.5l10.6-6.8a.6.6 0 0 0 0-1L8.92 4.7A.6.6 0 0 0 8 5.2Z" fill="currentColor" stroke="none" />,
	pause: (
		<>
			<rect x="6.5" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
			<rect x="13.5" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
		</>
	),
	volume: <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4ZM15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" />,
	volumeLow: <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4ZM15.5 8.5a5 5 0 0 1 0 7" />,
	muted: <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4ZM16 9.5l5 5M21 9.5l-5 5" />,
	mark: <path d="M6 20.5V4M6 5h11l-2.5 3.5L17 12H6" />,
	stretch: <path d="M4 7v10M20 7v10M4 12h16M8 9l-4 3 4 3M16 9l4 3-4 3" />,
	x: <path d="M6 6l12 12M18 6 6 18" />,
};

function Glyph({ name, size = 16 }: { readonly name: GlyphName; readonly size?: number }): ReactElement {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{GLYPHS[name]}
		</svg>
	);
}

const rateLabel = (rate: number): string => `${rate}×`;

/** Said beside the marking buttons while they are off because the marks are all used. */
export const FULL_SENTENCE = `${MAX_TIMELINE_MARKS} marks is the most one message carries.`;

/** The key that does what a button does, printed where the eye already is. Not part of the button's name; `aria-keyshortcuts` carries it. */
function Key({ children }: { readonly children: string }): ReactElement {
	return (
		<kbd aria-hidden="true" className="hidden rounded bg-fr-surface-3 px-1.5 text-fr-2xs leading-4 text-fr-text-2 sm:inline">
			{children}
		</kbd>
	);
}

// ── the transport ────────────────────────────────────────────────────────

/** What the transport adds in timeline mode: the marks, and the ways to make them. */
export interface TransportMarking {
	/** The most marks one message carries are already made. */
	readonly full: boolean;
	/** Where a stretch set from the keyboard began, or `null` when none is being set. */
	readonly inPoint: number | null;
	/** One line of help for the last thing that could not be done; `null` when there is none. */
	readonly hint: string | null;
	readonly onMark: () => void;
	/** Set the start of a stretch, or - when one is set - end it here. */
	readonly onStretch: () => void;
	readonly onCancelStretch: () => void;
	readonly onSpan: (from: number, to: number) => void;
}

export interface MediaTransportProps {
	readonly media: HTMLMediaElement;
	readonly kind: MediaTag;
	readonly filename: string;
	/** This document is the one on screen and the page is visible: only then is the playhead animated. */
	readonly live: boolean;
	readonly marks: readonly TimelineMark[];
	readonly activeId: number | null;
	readonly onSelectMark: (id: number) => void;
	/** Loudness per slice, for a sound; `undefined` draws a plain track. */
	readonly waveform?: ArrayLike<number>;
	/** Present in timeline mode. */
	readonly marking: TransportMarking | null;
}

// One focus ring for every control in the strip, the same solid accent the scrubber's knob and markers wear.
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent";

const ROUND_BUTTON = cn(
	"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-fr-sm font-medium transition-colors duration-[var(--fr-motion-fast)] disabled:pointer-events-none disabled:opacity-40",
	FOCUS,
);

const QUIET_BUTTON = "border-fr-border bg-transparent text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-text active:bg-fr-surface-3";

export function MediaTransport({ media, kind, filename, live, marks, activeId, onSelectMark, waveform, marking }: MediaTransportProps): ReactNode {
	const state = useMediaState(media);
	const playhead = useMediaPosition(media, state.playing, live);
	const seek = (seconds: number): void => {
		const to = clampTime(seconds, state.duration);
		media.currentTime = to;
		// The playhead follows the pointer now, not when the engine finishes seeking.
		playhead.set(to);
	};
	const nextRate = RATES[(RATES.indexOf(state.rate) + 1) % RATES.length] ?? 1;
	const loud = state.muted ? 0 : state.volume;
	// The range shows what the human just did at once, until the player's own `volumechange` has reported it: handed the
	// old level back first, a controlled range puts its thumb back and a key pressed in between loses its step.
	const echo = `${state.volume}/${state.muted}`;
	const [typed, setTyped] = useState<{ readonly level: number; readonly echo: string } | null>(null);
	const shownLevel = typed !== null && typed.echo === echo ? typed.level : loud;
	const failure = state.failed === null ? null : describeMediaError(kind, undefined, true, state.failed, state.failedDetail);
	// A line of help floats over the picture's foot for its few seconds, so the picture never jumps to make room for it;
	// while the marks are all used, the same words sit beside the buttons they explain instead.
	const floatingHint = marking?.hint !== null && marking?.hint !== undefined && !(marking.full && marking.hint === FULL_SENTENCE);

	return (
		<div data-slot="viewer-transport" className="relative border-t border-fr-border-soft bg-fr-surface px-3 pb-3 pt-1">
			{failure === null ? null : (
				<p role="alert" className="pt-1.5 text-fr-xs text-fr-del">
					{failure}
				</p>
			)}
			{marking === null ? null : (
				// Always in the tree, so a screen reader hears a hint when it is put there.
				<p role="status" data-slot="viewer-transport-hint" className={cn("pointer-events-none absolute inset-x-3 bottom-full mb-2 flex justify-center", !floatingHint && "sr-only")}>
					{marking.hint === null ? null : (
						<span className="rounded-full border border-fr-border-soft bg-fr-surface px-3 py-1 text-center text-fr-xs text-fr-text-2">{marking.hint}</span>
					)}
				</p>
			)}
			<TimelineBar
				playhead={playhead}
				duration={state.duration}
				marks={marks}
				activeId={activeId}
				onSeek={seek}
				onSelectMark={onSelectMark}
				{...(marking === null ? {} : { onSpan: marking.onSpan })}
				{...(waveform === undefined ? {} : { waveform })}
				buffered={state.buffered}
				inPoint={marking?.inPoint ?? null}
				disabled={state.failed !== null}
				label={`Position in ${filename}`}
			/>
			{marking !== null && state.unbounded ? (
				<p data-slot="viewer-transport-note" className="pb-1 text-fr-xs text-fr-text-3">
					{UNBOUNDED_SENTENCE}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-2">
				<IconButton
					variant="accent"
					className={cn("size-10 rounded-full", FOCUS, "focus-visible:ring-offset-2 focus-visible:ring-offset-fr-surface")}
					aria-label={state.playing ? "Pause" : "Play"}
					title={state.playing ? "Pause (Space)" : "Play (Space)"}
					disabled={state.failed !== null}
					onClick={() => togglePlayback(media)}
				>
					<Glyph name={state.playing ? "pause" : "play"} size={18} />
				</IconButton>
				<span className="min-w-[8.5ch] whitespace-nowrap text-fr-sm tabular-nums text-fr-text-3" data-slot="viewer-time">
					<Elapsed playhead={playhead} />
					{/* A recording that does not say how long it is has no total to read out. */}
					{state.unbounded ? null : ` / ${formatTimecode(state.duration)}`}
				</span>
				{marking === null ? null : (
					// On a narrow View the marking buttons take a row of their own under play, time, speed and volume.
					<div data-slot="viewer-marking" className="order-last flex basis-full flex-wrap items-center gap-2 sm:order-none sm:basis-auto">
						<button
							type="button"
							className={cn(ROUND_BUTTON, "border-fr-accent-line bg-fr-accent-dim text-fr-accent-text hover:border-fr-accent active:bg-fr-accent-line")}
							title="Mark this moment (M)"
							aria-keyshortcuts="M"
							disabled={marking.full || state.failed !== null}
							onClick={marking.onMark}
						>
							<Glyph name="mark" />
							Mark
							<Key>M</Key>
						</button>
						{marking.full ? (
							// Every mark used: a stretch could not be made either, so its button gives way to the reason both are off.
							<span className="text-fr-xs text-fr-text-3">{FULL_SENTENCE}</span>
						) : (
							<span className="inline-flex items-center">
								<button
									type="button"
									className={cn(ROUND_BUTTON, QUIET_BUTTON, marking.inPoint !== null && "rounded-e-none border-e-0")}
									title={marking.inPoint === null ? "Start a stretch here (I)" : "End the stretch here (O)"}
									aria-keyshortcuts={marking.inPoint === null ? "I" : "O"}
									disabled={state.failed !== null}
									onClick={marking.onStretch}
								>
									<Glyph name="stretch" />
									{marking.inPoint === null ? "Start stretch" : `End stretch · from ${formatTimecode(marking.inPoint)}`}
									<Key>{marking.inPoint === null ? "I" : "O"}</Key>
								</button>
								{marking.inPoint === null ? null : (
									<button
										type="button"
										className={cn(ROUND_BUTTON, QUIET_BUTTON, "rounded-s-none px-2")}
										aria-label="Cancel the stretch"
										title="Cancel the stretch (Esc)"
										onClick={marking.onCancelStretch}
									>
										<Glyph name="x" size={14} />
									</button>
								)}
							</span>
						)}
					</div>
				)}
				<div className="ml-auto flex items-center gap-1">
					<button
						type="button"
						className={cn(
							"h-8 w-12 shrink-0 rounded-md text-center text-fr-sm tabular-nums text-fr-text-2 transition-colors duration-[var(--fr-motion-fast)] hover:bg-fr-surface-2 hover:text-fr-text active:bg-fr-surface-3",
							FOCUS,
						)}
						aria-label={`Speed ${rateLabel(state.rate)}. Change speed`}
						title={`Speed ${rateLabel(state.rate)} - press for ${rateLabel(nextRate)}`}
						onClick={() => {
							media.playbackRate = nextRate;
						}}
					>
						{rateLabel(state.rate)}
					</button>
					<IconButton
						className={cn("size-8 hover:border-transparent hover:bg-fr-surface-2 active:bg-fr-surface-3", FOCUS)}
						aria-label={state.muted || state.volume === 0 ? "Unmute" : "Mute"}
						title={state.muted || state.volume === 0 ? "Unmute" : "Mute"}
						onClick={() => {
							media.muted = !(state.muted || state.volume === 0);
							if (state.volume === 0) media.volume = 0.5;
						}}
					>
						<Glyph name={loud === 0 ? "muted" : loud < 0.5 ? "volumeLow" : "volume"} />
					</IconButton>
					<input
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={shownLevel}
						aria-label="Volume"
						aria-valuetext={`${Math.round(shownLevel * 100)} percent`}
						className="vw-media-volume hidden shrink-0 sm:block"
						style={{ "--vw-level": `${shownLevel * 100}%` } as CSSProperties}
						onChange={event => {
							const volume = Number(event.target.value);
							setTyped({ level: volume, echo });
							media.volume = volume;
							media.muted = volume === 0;
						}}
					/>
				</div>
			</div>
		</div>
	);
}
