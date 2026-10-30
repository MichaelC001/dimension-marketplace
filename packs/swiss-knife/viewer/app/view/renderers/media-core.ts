import { MediaOpenError, openMedia, releaseMedia, resolveLength, togglePlayback } from "@dimension/mcp-app-kit/media";
import { describeOpenError, type MediaTag } from "../media-messages";
import type { MountContext, Mounted } from "./types";

const NO_SOURCE_SENTENCE = "This recording has no source to play from.";

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

export async function mountMedia(el: HTMLElement, ctx: MountContext, tag: MediaTag): Promise<Mounted> {
	const { signal, mediaSource } = ctx;
	if (mediaSource === undefined) throw new Error(NO_SOURCE_SENTENCE);
	signal?.throwIfAborted();
	const { mime } = mediaSource;

	const root = document.createElement("div");
	root.className = "vw-media";
	root.dataset.kind = tag;
	const stage = document.createElement("div");
	stage.className = "vw-media-stage";
	const media = document.createElement(tag);
	media.dataset.slot = "viewer-media";
	media.controls = false;
	media.setAttribute("aria-label", ctx.filename);
	stage.append(media);
	if (tag === "video") {
		(media as HTMLVideoElement).playsInline = true;
		media.addEventListener("click", () => togglePlayback(media));
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
		releaseMedia(media);
		root.remove();
	};

	try {
		const options = signal === undefined ? {} : { signal };
		await openMedia(media, mediaSource, options);
		await resolveLength(media, options);
	} catch (error) {
		release();
		throw error instanceof MediaOpenError ? new Error(describeOpenError(error, tag, mime)) : error;
	}

	if (tag === "video") {
		const { videoWidth, videoHeight } = media as HTMLVideoElement;
		if (videoWidth === 0) root.dataset.noPicture = "";
		else {
			root.style.setProperty("--vw-video-w", `${videoWidth}px`);
			root.style.setProperty("--vw-video-h", `${videoHeight}px`);
		}
	}

	return { destroy: release };
}
