import type { PresentedKind } from "@dimension/sdk/presentation";
import type { IconName } from "@fraym/ui/icons";

export interface KindLook {
	readonly label: string;
	readonly plural: string;
	readonly icon: IconName;
	readonly poster: boolean;
}

export const KIND_LOOK: Record<PresentedKind, KindLook> = {
	image: { label: "Image", plural: "Images", icon: "image", poster: false },
	video: { label: "Video", plural: "Videos", icon: "play", poster: true },
	audio: { label: "Audio", plural: "Audio", icon: "waveform", poster: false },
	pdf: { label: "PDF", plural: "PDFs", icon: "file", poster: true },
	pptx: { label: "PowerPoint", plural: "Decks", icon: "canvas", poster: false },
	docx: { label: "Word", plural: "Documents", icon: "type", poster: false },
	xlsx: { label: "Excel", plural: "Spreadsheets", icon: "table", poster: false },
	markdown: { label: "Markdown", plural: "Markdown", icon: "book", poster: false },
	html: { label: "HTML", plural: "Pages", icon: "globe", poster: false },
	text: { label: "Text", plural: "Text", icon: "list", poster: false },
	code: { label: "Code", plural: "Code", icon: "code", poster: false },
	archive: { label: "Archive", plural: "Archives", icon: "archive", poster: false },
	binary: { label: "File", plural: "Other files", icon: "file", poster: false },
};

export const KIND_ORDER = Object.keys(KIND_LOOK) as readonly PresentedKind[];

export function folderName(path: string): string {
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

const DAY_MS = 86_400_000;

export function relativeAge(at: number, now: number): string {
	const elapsed = Math.max(0, now - at);
	if (elapsed < 60_000) return "just now";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
	if (elapsed < DAY_MS) return `${Math.floor(elapsed / 3_600_000)} h ago`;
	if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} d ago`;
	return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fullDate(at: number): string {
	return new Date(at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
