// The faces an agent can wear, and the one it shows. The roster is the host's
// (`@fraym/config` `AVATAR_IDS`, the allowlist a persisted avatar is checked
// against), so a vibr added to the kit is wearable here with no edit to this
// pack. The fallback is the host's too (`features/presence/agent-avatar.ts`):
// an agent that declares no face, or one this frame cannot paint (a contributed
// `plugin:` face lives in the host's window, not this one), wears the kit's
// neutral agent face; a skin or accent passes only when it is on Mochi's
// allowlists — exactly what the rail and the dock paint for it.
import { AVATAR_IDS, MOCHI_ACCENT_IDS, MOCHI_SKIN_IDS } from "@fraym/config";
import { AGENT_NEUTRAL_AVATAR, type PresenceAvatarId, type PresenceSurfaceProps } from "@fraym/ui/features/presence";
import { MOCHI_ACCENT_OPTIONS } from "@fraym/vibr";
import type { AgentDraft } from "../../src/agent-md";
import { heldAvatar } from "./roster";

/** Every face an agent may wear — the roster minus `none`, which is the user's
 *  Vibr switch and never an agent's to pick. */
export const WEARABLE: readonly PresenceAvatarId[] = AVATAR_IDS.filter(id => id !== "none");

export function isWearable(id: string): id is PresenceAvatarId {
	return (WEARABLE as readonly string[]).includes(id);
}

/** What one agent paints: a face, and Mochi's two colour axes when it pinned them. */
export interface FaceSpec {
	readonly avatar: PresenceAvatarId;
	readonly skin?: PresenceSurfaceProps["skin"];
	readonly accent?: PresenceSurfaceProps["accent"];
}

/** The face the agent shows: its own when this frame can paint it (a plain id,
 *  or the `avatar:` Everything else carries with a skin), else the neutral face. */
export function faceOf(draft: Pick<AgentDraft, "vibr" | "extra">): FaceSpec {
	if (isWearable(draft.vibr)) return { avatar: draft.vibr };
	const held = draft.vibr === "" ? heldAvatar(draft.extra) : null;
	if (held === null || !isWearable(held.id)) return { avatar: AGENT_NEUTRAL_AVATAR };
	const skin = (MOCHI_SKIN_IDS as readonly string[]).includes(held.skin ?? "") ? (held.skin as PresenceSurfaceProps["skin"]) : undefined;
	const accent = (MOCHI_ACCENT_IDS as readonly string[]).includes(held.accent ?? "") ? (held.accent as PresenceSurfaceProps["accent"]) : undefined;
	return { avatar: held.id, ...(skin !== undefined ? { skin } : {}), ...(accent !== undefined ? { accent } : {}) };
}

/** The colour the agent's face carries when it pinned one (Mochi's accent), for
 *  the faint wash behind it; `undefined` (a neutral wash) otherwise. `theme` is
 *  no colour of its own: it follows the app accent, so it washes neutral too. */
export function faceHue(face: FaceSpec): string | undefined {
	return MOCHI_ACCENT_OPTIONS.find(option => option.id === face.accent)?.hex ?? undefined;
}

/** A face's name, as the picker prints it. */
export function faceLabel(id: string): string {
	return id.charAt(0).toUpperCase() + id.slice(1);
}
