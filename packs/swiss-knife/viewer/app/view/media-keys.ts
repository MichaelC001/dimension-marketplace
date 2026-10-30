import { type MarkTool, shortcutIntent, type TimelineKeyAction, timelineKeyAction } from "@dimension/mcp-app-kit/annotate";
import { decideTransportKey, type KeyOwner, type MediaLength, type TransportAction } from "@dimension/mcp-app-kit/media";
import type { MediaTag } from "./media-messages";

export type KeyAction =
	| TransportAction
	| { readonly do: TimelineKeyAction }
	| { readonly do: "disarm" }
	| { readonly do: "tool"; readonly tool: MarkTool }
	| { readonly do: "undo" }
	| { readonly do: "redo" };

export interface KeyInput {
	readonly key: string;
	readonly shift: boolean;
	readonly modifier: boolean;
	readonly repeat: boolean;
	readonly position: number;
	readonly length: MediaLength;
	readonly kind: MediaTag;
	readonly marking: boolean;
	readonly drawing: boolean;
	readonly armed: boolean;
	readonly inPoint: number | null;
	readonly owner: KeyOwner;
}

function drawingKey(key: string, modifier: boolean, shift: boolean): KeyAction | null {
	const intent = shortcutIntent(key, modifier, shift, false);
	if (intent === null) return null;
	if (intent.kind === "undo" || intent.kind === "redo") return { do: intent.kind };
	return intent.kind === "tool" ? { do: "tool", tool: intent.tool } : null;
}

export function decideKey({ key, shift, modifier, repeat, position, length, kind, marking, drawing, armed, inPoint, owner }: KeyInput): KeyAction | null {
	if (owner.typing) return null;
	if (modifier) return drawing ? drawingKey(key, true, shift) : null;
	const transport = decideTransportKey({ key, shift, position, length, hasFrames: kind === "video", owner });
	if (transport !== null) return transport;
	if (key === "Escape") {
		const cancel = timelineKeyAction(key, inPoint);
		if (cancel !== null) return { do: cancel };
		return armed ? { do: "disarm" } : null;
	}
	if (!marking || repeat) return null;
	const stretch = timelineKeyAction(key, inPoint);
	if (stretch !== null) return { do: stretch };
	return drawing ? drawingKey(key, false, shift) : null;
}
