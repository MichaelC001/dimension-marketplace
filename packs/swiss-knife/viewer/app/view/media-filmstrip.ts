// The pictures of a video's film lane: one small frame for each cell, taken when the lane is on screen and not
// before. What the lane draws is the kit's (`film-lane.tsx`, which knows nothing of a viewer); what is HERE is the
// cost of its pictures, which is a seek and an encode each, on a second decoder:
//   * lazy: nothing is taken until the pane is ready, on screen, and has a length (`enabled`);
//   * serial: one after another, through the grabber's own line - two seeks at once is a wrong frame;
//   * abortable: leaving, resizing the lane to other cells, or a different video stops the one in progress and
//     drops the rest, at once;
//   * progressive: each picture is shown the moment it exists, not after all of them;
//   * cached per FILE (path, size and modified time): the pane re-mounts its renderer on a theme change, and a
//     filmstrip already taken is not taken again; the cache is bounded in files and in pictures per file, so
//     opening many videos, or dragging the lane's width, cannot grow it without end;
//   * bounded: at most `MAX_FILM_SLOTS` cells, so at most that many pictures per width;
//   * given up on, once: a video that will not give a picture (no picture at all, a seek that never lands) costs
//     one wait, not one per cell and one more per run - the FILE is remembered as unfilmable, in the same bounded
//     cache as the pictures, the run stops, and the lane is told so it draws its empty cells calm. A video whose
//     picture is too big to decode a second time for a decoration (`MAX_STRIP_PIXELS`) is never asked at all;
//   * let go of: when a run is over the second decoder goes with it, not four seconds later.
// A picture that cannot be taken never fails the pane.
import { type FilmFrame, filmSlotTimes, MAX_FILM_SLOTS } from "@dimension/mcp-app-kit/annotate";
import { useEffect, useMemo, useState } from "react";
import type { Thumbnail } from "./media-frame";

/**
 * The largest picture, in pixels, the strip opens a second decoder for: 3840 x 2160, 8.3 Mpx. A decoder holds a pool
 * of frames at the stream's own size, and the strip is a decoration: a hostile or enormous stream (16384 x 16384
 * declared) must not be decoded twice, or three times with a send, to draw sixteen 160 px pictures.
 */
export const MAX_STRIP_PIXELS = 3840 * 2160;

/** Whether a picture `width` x `height` px is one the strip takes frames of: it has a size, and a size within {@link MAX_STRIP_PIXELS}. */
export function filmable(width: number, height: number): boolean {
	return width > 0 && height > 0 && width * height <= MAX_STRIP_PIXELS;
}

/** What the filmstrip needs of a grabber: a small picture at a time, abortable; the size of the video it takes them from; and letting go. */
export interface ThumbnailSource {
	thumbnail(at: number, signal?: AbortSignal): Promise<Thumbnail>;
	/** The size in pixels of the picture the video draws; 0 x 0 for a video that has none. */
	readonly size: { readonly width: number; readonly height: number };
	/** Let go of the decoder behind the pictures; a later `thumbnail` opens it again. */
	release(): void;
}

/** Files whose filmstrips are kept. */
export const FILMSTRIP_FILES = 4;
/** Pictures kept per file: three widths' worth, so resizing back and forth finds them again. */
export const FILMSTRIP_FRAMES_PER_FILE = 3 * MAX_FILM_SLOTS;

const millis = (seconds: number): number => Math.round(seconds * 1000);

interface Kept {
	readonly frames: Map<number, string>;
	/** The video would not give pictures: do not ask it again. */
	unfilmable: boolean;
}

/**
 * What is known of each file, by key: its pictures by the millisecond they show, and whether it is unfilmable. Least
 * recently used file goes first, then oldest picture; a failure is held in the file's entry, so it is bounded with it.
 */
export class FilmstripCache {
	readonly #files = new Map<string, Kept>();
	readonly #maxFiles: number;
	readonly #maxFrames: number;

	constructor(maxFiles: number = FILMSTRIP_FILES, maxFramesPerFile: number = FILMSTRIP_FRAMES_PER_FILE) {
		this.#maxFiles = maxFiles;
		this.#maxFrames = maxFramesPerFile;
	}

	/** The entry for `key`, made if need be and re-inserted last: this file was used most recently. */
	#use(key: string): Kept {
		const kept = this.#files.get(key) ?? { frames: new Map<number, string>(), unfilmable: false };
		this.#files.delete(key);
		this.#files.set(key, kept);
		for (const oldest of this.#files.keys()) {
			if (this.#files.size <= this.#maxFiles) break;
			this.#files.delete(oldest);
		}
		return kept;
	}

	has(key: string, at: number): boolean {
		return this.#files.get(key)?.frames.has(millis(at)) ?? false;
	}

	set(key: string, at: number, src: string): void {
		const { frames } = this.#use(key);
		frames.delete(millis(at));
		frames.set(millis(at), src);
		for (const oldest of frames.keys()) {
			if (frames.size <= this.#maxFrames) break;
			frames.delete(oldest);
		}
	}

	/** Remember that this file will not give pictures. */
	fail(key: string): void {
		this.#use(key).unfilmable = true;
	}

	/** Whether this file was found unfilmable. */
	unfilmable(key: string): boolean {
		return this.#files.get(key)?.unfilmable ?? false;
	}

	/** Every picture kept for `key`, in time order. */
	frames(key: string): FilmFrame[] {
		return [...(this.#files.get(key)?.frames ?? [])].map(([at, src]) => ({ at: at / 1000, src })).sort((a, b) => a.at - b.at);
	}
}

/** The cache every pane shares: a file's filmstrip outlives the pane's renderer being mounted again. */
const SHARED = new FilmstripCache();

export interface FilmstripOptions {
	/** Where the pictures come from; `null` before there is a video to take them from. */
	readonly source: ThumbnailSource | null;
	/** Names the FILE as it is now: its path, size and modified time. A different one is a different filmstrip. */
	readonly key: string;
	/** Seconds; 0 until known. */
	readonly duration: number;
	/** How many cells the lane draws (it reports what its width holds). */
	readonly slots: number;
	/** The pane is ready, on screen, and the video plays: only then is a picture worth a seek. */
	readonly enabled: boolean;
	readonly cache?: FilmstripCache;
}

export interface Filmstrip {
	/** The pictures taken so far. */
	readonly frames: readonly FilmFrame[];
	/** This video will not give the rest: the cells still empty are not waiting for anything. */
	readonly failed: boolean;
}

/** The pictures taken so far for this video, filling in as they are taken. */
export function useFilmstrip({ source, key, duration, slots, enabled, cache = SHARED }: FilmstripOptions): Filmstrip {
	// A picture arrived, or the file was given up on: the cache is not React state, so this is what says the lane should draw again.
	const [changed, setChanged] = useState(0);
	useEffect(() => {
		if (!enabled || source === null || cache.unfilmable(key)) return;
		const wanted = filmSlotTimes(duration, slots).filter(at => !cache.has(key, at));
		if (wanted.length === 0) return;
		// Asked before a decoder is opened: the size is the player's own, already decoded, so reading it costs nothing.
		if (!filmable(source.size.width, source.size.height)) {
			cache.fail(key);
			setChanged(count => count + 1);
			return;
		}
		const abort = new AbortController();
		void (async () => {
			try {
				for (const at of wanted) {
					const picture = await source.thumbnail(at, abort.signal);
					if (abort.signal.aborted) return;
					cache.set(key, at, picture.src);
					setChanged(count => count + 1);
				}
			} catch {
				// Aborted: whoever stopped it has the next run in hand, or the pane is going. Otherwise the video refused
				// (no picture, a seek that never landed): the same would happen to every cell after this one.
				if (abort.signal.aborted) return;
				cache.fail(key);
				setChanged(count => count + 1);
			}
			// The run is over, whole or given up: its decoder goes now. A stopped one is the next run's to reuse or the pane's to drop.
			source.release();
		})();
		return () => abort.abort();
	}, [source, key, duration, slots, enabled, cache]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `changed` is the signal that the cache changed.
	return useMemo(() => ({ frames: cache.frames(key), failed: cache.unfilmable(key) }), [cache, key, changed]);
}
