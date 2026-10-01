// What a key does on a recording, decided apart from the window it was pressed in.
//
// The pane listens on the window, so a key pressed in a text box, on a button or inside a widget that
// has its own use for it (a slider's arrows, a tab bar's Home and End, Space on a button) arrives here
// too. Those keys are THEIRS: this module says what a recording does with a key only after it has
// checked whose key it is. The decision is a pure function of the key, where the playhead is, the
// length, and whether marking is on and a stretch is half set, so each rule can be held to a test.
import { keySeek, type MediaLength } from "./media-length";
import type { MediaTag } from "./media-messages";

/** What the focused element takes for itself. */
export interface KeyOwner {
	/** The human is typing: every key is theirs. */
	readonly typing: boolean;
	/** A button or link: Space and Enter press it, and Home and End are not a place to jump from it. */
	readonly presses: boolean;
	/** A widget that moves with the arrow keys and Home and End (a slider, a tab bar, a list, a menu). */
	readonly navigates: boolean;
}

export const NOBODY: KeyOwner = { typing: false, presses: false, navigates: false };

const TEXT_FIELDS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const PRESSES = "button, a[href], summary, [role='button'], [role='tab'], [role='switch'], [role='checkbox'], [role='menuitem'], [role='option']";
const NAVIGATES =
	"[role='slider'], [role='spinbutton'], [role='scrollbar'], [role='tab'], [role='tablist'], [role='listbox'], [role='option'], [role='menu'], [role='menubar'], [role='menuitem'], [role='radiogroup'], [role='radio'], [role='tree'], [role='treeitem'], [role='grid'], [role='gridcell'], [role='combobox'], [role='toolbar']";

/** Whose key is a key pressed on `target`. */
export function keyOwner(target: EventTarget | null): KeyOwner {
	if (!(target instanceof HTMLElement)) return NOBODY;
	const typing = TEXT_FIELDS.has(target.tagName) || target.isContentEditable;
	return { typing, presses: target.closest(PRESSES) !== null, navigates: target.closest(NAVIGATES) !== null };
}

export type KeyAction =
	| { readonly do: "toggle" }
	| { readonly do: "seek"; readonly to: number }
	| { readonly do: "step"; readonly direction: 1 | -1 }
	| { readonly do: "mark" }
	| { readonly do: "set-in" }
	/** `O` with a start already set: end the stretch here. */
	| { readonly do: "end-stretch" }
	/** `O` with no start set: say how a stretch is made. */
	| { readonly do: "needs-start" }
	| { readonly do: "cancel-stretch" }
	| { readonly do: "leave-mode" };

export interface KeyInput {
	/** `event.key`, with a letter in lower case. */
	readonly key: string;
	readonly shift: boolean;
	/** Where the playhead is, in seconds. */
	readonly position: number;
	readonly length: MediaLength;
	readonly kind: MediaTag;
	/** Timeline mode is on: the marking keys work. */
	readonly marking: boolean;
	/** Where a stretch set from the keyboard began, or `null` when none is half set. */
	readonly inPoint: number | null;
	readonly owner: KeyOwner;
}

/** What the recording does with the key, or `null` when the key is not the recording's to answer. */
export function decideKey({ key, shift, position, length, kind, marking, inPoint, owner }: KeyInput): KeyAction | null {
	if (owner.typing) return null;
	if (key === " ") return owner.presses ? null : { do: "toggle" };
	if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
		// A slider or a tab bar moves with these; a button is no place to jump from with Home or End.
		if (owner.navigates || ((key === "Home" || key === "End") && owner.presses)) return null;
		const to = keySeek(key, shift, position, length);
		return to === null ? null : { do: "seek", to };
	}
	if (kind === "video" && (key === "," || key === ".")) return { do: "step", direction: key === "," ? -1 : 1 };
	if (key === "Escape") {
		// A stretch half set is taken back first, as a half-dragged one is; a second Escape leaves the mode.
		if (inPoint !== null) return { do: "cancel-stretch" };
		return marking ? { do: "leave-mode" } : null;
	}
	if (!marking) return null;
	if (key === "m") return { do: "mark" };
	if (key === "i") return { do: "set-in" };
	if (key === "o") return inPoint === null ? { do: "needs-start" } : { do: "end-stretch" };
	return null;
}
