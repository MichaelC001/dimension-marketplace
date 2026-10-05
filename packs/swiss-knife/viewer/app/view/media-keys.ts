// What a key does on a recording, decided apart from the window it was pressed in.
//
// The pane listens on the window, so a key pressed in a text box, on a button or inside a widget that
// has its own use for it (a slider's arrows, a tab bar's Home and End, Space on a button) arrives here
// too. Those keys are THEIRS: this module says what a recording does with a key only after it has
// checked whose key it is. The decision is a pure function of the key, where the playhead is, the
// length, and whether marking is on and a stretch is half set, so each rule can be held to a test.
import { type MarkTool, shortcutIntent } from "@dimension/mcp-app-kit/annotate";
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
	/** Escape with a drawing tool in hand: put it down, so the picture can be played, scrolled and read again. */
	| { readonly do: "disarm" }
	/** A number key: pick that drawing tool. */
	| { readonly do: "tool"; readonly tool: MarkTool }
	| { readonly do: "undo" }
	| { readonly do: "redo" };

export interface KeyInput {
	/** `event.key`, with a letter in lower case. */
	readonly key: string;
	readonly shift: boolean;
	/** Ctrl or Cmd is down. */
	readonly modifier: boolean;
	/** The key is held down and the system is repeating it (`KeyboardEvent.repeat`), not pressed anew. */
	readonly repeat: boolean;
	/** Where the playhead is, in seconds. */
	readonly position: number;
	readonly length: MediaLength;
	readonly kind: MediaTag;
	/** The marking layer is up (and the recording has not failed): the marking keys work. */
	readonly marking: boolean;
	/** A video the human can draw on: the drawing keys work. */
	readonly drawing: boolean;
	/** A drawing tool is in hand. */
	readonly armed: boolean;
	/** Where a stretch set from the keyboard began, or `null` when none is half set. */
	readonly inPoint: number | null;
	readonly owner: KeyOwner;
}

/**
 * The drawing keys a video takes: the number keys that pick a tool, and undo and redo. The letter keys the picture
 * also has for tools (R, O, A, P) are NOT taken here: O ends a stretch on a recording, and one key cannot be both.
 */
function drawingKey(key: string, modifier: boolean, shift: boolean): KeyAction | null {
	const intent = shortcutIntent(key, modifier, shift);
	if (intent === null) return null;
	if (intent.kind === "undo" || intent.kind === "redo") return { do: intent.kind };
	return intent.kind === "tool" && /^[1-5]$/.test(key) ? { do: "tool", tool: intent.tool } : null;
}

/** What the recording does with the key, or `null` when the key is not the recording's to answer. */
export function decideKey({ key, shift, modifier, repeat, position, length, kind, marking, drawing, armed, inPoint, owner }: KeyInput): KeyAction | null {
	if (owner.typing) return null;
	if (modifier) return drawing ? drawingKey(key, true, shift) : null;
	if (key === " ") return owner.presses ? null : { do: "toggle" };
	if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
		// A slider or a tab bar moves with these; a button is no place to jump from with Home or End.
		if (owner.navigates || ((key === "Home" || key === "End") && owner.presses)) return null;
		const to = keySeek(key, shift, position, length);
		return to === null ? null : { do: "seek", to };
	}
	if (kind === "video" && (key === "," || key === ".")) return { do: "step", direction: key === "," ? -1 : 1 };
	if (key === "Escape") {
		// A stretch half set is taken back first, as a half-dragged one is; a second Escape puts the drawing tool down.
		if (inPoint !== null) return { do: "cancel-stretch" };
		return armed ? { do: "disarm" } : null;
	}
	if (!marking) return null;
	// A note is made by pressing, not by holding: a held M would stamp a mark at every quarter second of a playing recording,
	// a held I or O would set and reset a stretch, a held number would pick the tool again and again. What a held key
	// repeats on purpose - the seeks, the frame steps, undo and redo - is decided above.
	if (repeat) return null;
	if (key === "m") return { do: "mark" };
	if (key === "i") return { do: "set-in" };
	if (key === "o") return inPoint === null ? { do: "needs-start" } : { do: "end-stretch" };
	return drawing ? drawingKey(key, false, shift) : null;
}
