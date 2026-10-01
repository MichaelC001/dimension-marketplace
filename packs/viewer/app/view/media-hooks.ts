// What the timeline pane keeps about a recording that must not restart or re-render more often than the recording
// itself changes: how long it says it is, whether it has failed, and the picture of its loudness. Their own file so they
// can be driven with a stand-in element and a stand-in decoder; the pane (`pane-extras-timeline.tsx`) only seats them.
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useEffectEvent, useState } from "react";
import { loadDocumentBytes } from "./document-bytes";
import { type LengthSource, readLength } from "./media-length";
import { decodePeaks, WAVEFORM_MAX_BYTES, waveformAllowed } from "./media-waveform";
import type { DocTab } from "./tabs";

/** What says a recording's `duration` is now something else: the engine learning it, a new source, or no source at all. */
const DURATION_EVENTS = ["durationchange", "loadedmetadata", "emptied"] as const;

/**
 * How long the recording says it is, for the marks: `Infinity` when it does not say, 0 until it is known and while there
 * is no element to ask. Only that, and a plain number on purpose: React itself leaves the pane alone while it is the
 * same. How far an UNBOUNDED recording has been played so far moves with the playhead, four times a second, and nothing
 * the pane draws depends on it (the transport reads its own); keeping it here re-rendered the whole list with it.
 */
export function useDuration(media: (LengthSource & EventTarget) | null): number {
	const [duration, setDuration] = useState(0);
	useEffect(() => {
		if (media === null) {
			setDuration(0);
			return;
		}
		const read = (): void => setDuration(readLength(media).duration);
		for (const type of DURATION_EVENTS) media.addEventListener(type, read);
		read();
		return () => {
			for (const type of DURATION_EVENTS) media.removeEventListener(type, read);
		};
	}, [media]);
	return duration;
}

/** What says a player's `error` is now something else: it failed, or a new source started and cleared it. */
const FAILURE_EVENTS = ["error", "emptied", "loadstart"] as const;

/**
 * Whether the player has failed on its recording - a decode that went wrong partway, after the recording opened. One that
 * cannot be played has nothing to mark, so the pane stops offering marks on it (a recording that never opened is the
 * pane's own error card, and never gets here).
 */
export function useFailed(media: (EventTarget & { readonly error: MediaError | null }) | null): boolean {
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (media === null) {
			setFailed(false);
			return;
		}
		const read = (): void => setFailed(media.error !== null);
		for (const type of FAILURE_EVENTS) media.addEventListener(type, read);
		read();
		return () => {
			for (const type of FAILURE_EVENTS) media.removeEventListener(type, read);
		};
	}, [media]);
	return failed;
}

/** Reads a recording's file and makes its loudness, or `null` for a plain track. Aborting `signal` ends it early. */
export type PeaksLoader = (app: App, tab: DocTab, signal: AbortSignal) => Promise<Float32Array | null>;

/** The loudness of a recording's file, or `null` for a plain track: every other container, and any decode this engine cannot make. */
export const loadPeaks: PeaksLoader = async (app, tab, signal) => {
	// The document cache the pane already filled: the bytes are in memory, not read again.
	const { bytes } = await loadDocumentBytes(app, tab, { signal });
	// Only an uncompressed WAV whose header the viewer has checked is decoded.
	return waveformAllowed(bytes) ? decodePeaks(bytes, signal) : null;
};

/**
 * The picture of a sound's loudness under the scrubber, made once per FILE.
 *
 * A decode cannot be cancelled (`decodeAudioData` runs on to the end), so every restart is another copy of the file and
 * another decode beside the one left behind. So what restarts it is only what changes the file: its identity, which is
 * its key, size and modification time - not the tab object (a new one is made whenever Annotate is asked again for an
 * open tab), and not whether the tab is showing. `startable` (the sound is on screen) gates only the START: a decode
 * that has begun finishes when the human looks away, and one that failed is not tried again for the same file.
 */
export function useWaveform(app: App, tab: DocTab, startable: boolean, load: PeaksLoader = loadPeaks): Float32Array | undefined {
	const fileId = `${tab.key}\u0000${tab.size}:${tab.mtimeMs}`;
	const affordable = tab.size <= WAVEFORM_MAX_BYTES;
	// A decode starts from the app, tab and loader as they are when it starts; none of them is a reason to start another.
	const decode = useEffectEvent((signal: AbortSignal) => load(app, tab, signal));
	// The file this pane has set a decode going for: held until the file changes, whatever the tab does.
	const [asked, setAsked] = useState<string | null>(null);
	const [peaks, setPeaks] = useState<{ readonly id: string; readonly values: Float32Array } | null>(null);
	useEffect(() => {
		if (startable && affordable) setAsked(fileId);
	}, [startable, affordable, fileId]);
	useEffect(() => {
		if (asked !== fileId) return;
		const controller = new AbortController();
		void decode(controller.signal).then(
			values => {
				if (values !== null) setPeaks({ id: fileId, values });
			},
			// A codec this engine cannot decode, or a pane that went away: a plain track is the answer.
			() => undefined,
		);
		return () => controller.abort();
	}, [asked, fileId]);
	// A late answer for a file that is no longer showing is kept but not drawn.
	return peaks?.id === fileId ? peaks.values : undefined;
}
