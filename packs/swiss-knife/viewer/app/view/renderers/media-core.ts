// Audio and video: a media element playing one `Blob` of the file's bytes.
//
// The element is the engine and nothing else. It is drawn with NO native controls: the
// transport (play, the scrubber, volume, speed) is the React layer's, so playing and
// marking share one control and look the same in every engine. The renderer's part is
// the element, a calm card for sound (a recording with nothing to look at), and an empty
// DOCK under them that the layer fills; `data-slot="viewer-media"` is how the layer finds
// the element and `viewer-media-dock` where it sits (docs/design/88 section 5).
//
// Honesty: a recording this engine cannot play is said so in one sentence, never a blank
// player. `canPlayType` says whether the CONTAINER is one it knows; the element's own
// `error` says what went wrong when it tried; the sentence uses both (`media-messages`).
//
// Length: a capture whose header never got its length reports `Infinity`. Once it has opened, such a
// recording is asked properly (`resolveLength`: seek past the end, then back to the start) before the layer
// reads its length, so the transport and the marks never see it as zero seconds long.
//
// Cleanup: `destroy()` pauses, drops the source so the decoder is released, revokes the object URL and
// removes the DOM. Nothing here outlives it. A pane that goes away while the recording is still opening
// (`ctx.signal`) gets the same cleanup at once, not when the wait runs out.
import { KIND_HEAD_BYTES, sniffMedia } from "../../../src/kind";
import { resolveLength } from "../media-length";
import { describeMediaError, type MediaTag, OPEN_TIMEOUT_SENTENCE } from "../media-messages";
import type { MountContext, Mounted } from "./types";

/** How long a recording may take to report its length before the pane says it cannot open it. A blob in memory answers at once; this is for an engine that never will. */
const OPEN_TIMEOUT_MS = 20_000;

/** A calm tile for sound: the engine draws nothing for an `<audio>`, and a blank pane would read as broken. */
function soundCard(filename: string): HTMLElement {
	const card = document.createElement("div");
	card.className = "vw-media-card";
	card.dataset.slot = "viewer-media-card";
	const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	mark.setAttribute("viewBox", "0 0 24 24");
	mark.setAttribute("aria-hidden", "true");
	mark.setAttribute("focusable", "false");
	mark.classList.add("vw-media-glyph");
	const bars = document.createElementNS("http://www.w3.org/2000/svg", "path");
	bars.setAttribute("d", "M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4");
	mark.append(bars);
	const title = document.createElement("p");
	title.className = "vw-card-title vw-media-name";
	title.textContent = filename;
	card.append(mark, title);
	return card;
}

export async function mountMedia(el: HTMLElement, bytes: Uint8Array, ctx: MountContext, tag: MediaTag): Promise<Mounted> {
	const { signal } = ctx;
	signal?.throwIfAborted();
	const sniffed = sniffMedia(bytes.subarray(0, KIND_HEAD_BYTES), ctx.filename);
	const mime = sniffed?.mime;
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], mime === undefined ? undefined : { type: mime }));

	const root = document.createElement("div");
	root.className = "vw-media";
	root.dataset.kind = tag;
	const stage = document.createElement("div");
	stage.className = "vw-media-stage";
	const media = document.createElement(tag);
	media.dataset.slot = "viewer-media";
	media.preload = "auto";
	media.controls = false;
	media.setAttribute("aria-label", ctx.filename);
	stage.append(media);
	if (tag === "video") {
		(media as HTMLVideoElement).playsInline = true;
		// A click on the picture plays and pauses it, as it does everywhere video is watched.
		media.addEventListener("click", () => {
			if (media.paused) void media.play().catch(() => undefined);
			else media.pause();
		});
		const note = document.createElement("p");
		note.className = "vw-media-note";
		note.textContent = "There is no picture to show; the sound still plays.";
		stage.append(note);
	} else {
		stage.append(soundCard(ctx.filename));
	}
	const dock = document.createElement("div");
	dock.className = "vw-media-dock";
	dock.dataset.slot = "viewer-media-dock";
	root.append(stage, dock);
	el.append(root);

	const release = (): void => {
		media.pause();
		media.removeAttribute("src");
		// Without this the element keeps its decoder, and the blob its memory, until the garbage collector says otherwise.
		media.load();
		root.remove();
		URL.revokeObjectURL(url);
	};

	try {
		await new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				settle();
				reject(new Error(OPEN_TIMEOUT_SENTENCE));
			}, OPEN_TIMEOUT_MS);
			const settle = (): void => {
				window.clearTimeout(timer);
				media.removeEventListener("loadedmetadata", opened);
				media.removeEventListener("error", failed);
				signal?.removeEventListener("abort", gone);
			};
			const opened = (): void => {
				settle();
				resolve();
			};
			const failed = (): void => {
				settle();
				const known = mime !== undefined && media.canPlayType(mime) !== "";
				reject(new Error(describeMediaError(tag, mime, known, media.error?.code, media.error?.message)));
			};
			// The pane went away while the recording was still opening: stop at once, not when the wait runs out.
			const gone = (): void => {
				settle();
				reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
			};
			media.addEventListener("loadedmetadata", opened);
			media.addEventListener("error", failed);
			signal?.addEventListener("abort", gone, { once: true });
			media.src = url;
		});
		// A capture whose header never got its length reports `Infinity`; ask it properly before anything reads it as 0.
		await resolveLength(media, signal === undefined ? {} : { signal });
	} catch (error) {
		release();
		throw error;
	}

	if (tag === "video") {
		const { videoWidth, videoHeight } = media as HTMLVideoElement;
		// A "video" whose picture this engine cannot show (or that has none) is still a recording that plays.
		if (videoWidth === 0) root.dataset.noPicture = "";
		else {
			// The picture's own size, so the stage never blows a tiny clip up past twice it (viewer.css).
			root.style.setProperty("--vw-video-w", `${videoWidth}px`);
			root.style.setProperty("--vw-video-h", `${videoHeight}px`);
		}
	}

	return { destroy: release };
}
