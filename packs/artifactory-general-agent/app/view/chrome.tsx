// The page's shared vocabulary — the column, a section heading, a label, an
// agent's live face and the Machinist's dock button — spoken the way the
// Autonomy page speaks it (`packages/autonomy/app/view/chrome.tsx`, `dock.tsx`),
// so two whole pages side by side in the Code rail read as one product.
// Token-only (`--fr-*` through the kit's utilities).

import type { ViewDockState } from "@dimension/sdk/artifactory";
import { Button } from "@fraym/ui/elements/button";
import { type PresenceAvatarId, PresenceSurface, type PresenceSurfaceProps } from "@fraym/ui/features/presence";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type ReactNode, useSyncExternalStore } from "react";
import type { ForgeDock } from "./forge-client";

/** A label: the kit's eyebrow size and weight in the secondary face, sentence
 *  case (DESIGN.md: no uppercase eyebrows), text-2 for contrast on surfaces. */
export const LABEL = "font-secondary text-fr-2xs font-semibold tracking-fr-label text-fr-text-2";

/** A label on the lit hero band: text at 80%, which text-2 would take under AA. */
export const HERO_LABEL = "font-secondary text-fr-2xs font-semibold tracking-fr-label text-fr-text/80";

/** One scrolling column — the home and the profile. Container queries, not the
 *  viewport: the dock opening beside the page reflows it. */
export function ViewColumn({ slot, children }: { readonly slot: string; readonly children: ReactNode }) {
	return (
		<div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
			<div data-slot={slot} className="@container mx-auto flex w-full max-w-295 flex-col gap-7 px-5 pt-5 pb-12">
				{children}
			</div>
		</div>
	);
}

/** Section chrome: a real heading with a quiet count and an optional aside. */
export function Section({
	title,
	count,
	aside,
	children,
	className,
}: {
	readonly title: string;
	readonly count?: number;
	readonly aside?: ReactNode;
	readonly children: ReactNode;
	readonly className?: string;
}) {
	return (
		<section className={cn("flex flex-col gap-2.5", className)}>
			<div className="flex min-h-5 items-center justify-between gap-3">
				<h2 className="flex items-baseline gap-2 text-fr-md font-semibold text-fr-text">
					{title}
					{count !== undefined ? (
						<span className="font-secondary text-fr-sm font-normal text-fr-text-2 tabular-nums">{count}</span>
					) : null}
				</h2>
				{aside}
			</div>
			{children}
		</section>
	);
}

/**
 * An agent's live face, painted by the kit's own presence seam — the one the
 * rail and the chat use, so the motion budget, reduced motion, the occlusion
 * gate and the orb's shared GL pool all apply. `live` false holds one pose
 * (`still`): a wall of cards moves only where the pointer is.
 */
export function AgentFace({
	avatar,
	size,
	live,
	skin,
	accent,
	working = false,
}: {
	readonly avatar: PresenceAvatarId;
	readonly size: PresenceSurfaceProps["size"];
	readonly live: boolean;
	readonly skin?: PresenceSurfaceProps["skin"];
	readonly accent?: PresenceSurfaceProps["accent"];
	readonly working?: boolean;
}) {
	return (
		<PresenceSurface
			avatar={avatar}
			size={size}
			state={working ? "thinking" : "idle"}
			mode=""
			energy={working ? 0.85 : 0.35}
			{...(live ? {} : { motion: "still" as const })}
			{...(skin !== undefined ? { skin } : {})}
			{...(accent !== undefined ? { accent } : {})}
		/>
	);
}

/**
 * The Machinist, who lives in the dock beside this page, as an icon button in
 * the page's own header. Which agent it is comes off the host — the View names
 * none — and the button exists only while the host lends a dock station, which
 * it does only to a pack that declared `dock:open`. Pressed = the dock is open.
 */
export function DockAgentButton({ dock, onError }: { readonly dock: ForgeDock; readonly onError: (message: string) => void }) {
	const state = useSyncExternalStore(dock.subscribe, dock.state);
	if (!dock.offered() || state === null) return null;
	const name = state.label.charAt(0).toUpperCase() + state.label.slice(1);
	const label = state.open ? `Close ${name} chat` : `Ask ${name}`;
	return (
		<Button
			size="icon"
			variant="ghost"
			data-slot="dock-agent-button"
			aria-label={label}
			title={label}
			aria-pressed={state.open}
			className={cn("size-8", state.open && "bg-fr-accent-dim text-fr-text ring-1 ring-fr-accent-line")}
			onClick={() => {
				dock.open({ agent: state.agent, open: !state.open }).catch((cause: unknown) => onError(errorText(cause)));
			}}
		>
			<DockFace state={state} />
		</Button>
	);
}

/** The docked agent's face as the host lends it; a face this frame cannot
 *  paint (Vibr off, a contributed mark) is the chat glyph, never an empty button. */
function DockFace({ state }: { readonly state: ViewDockState }) {
	const { avatar } = state;
	if (avatar === undefined || avatar === "none" || avatar.startsWith("plugin:")) return <Icon name="chat" size={15} strokeWidth={1.7} />;
	return (
		<span data-slot="dock-agent-face" className="flex" aria-hidden>
			<AgentFace
				// Cast reason: the host lends the id, skin and accent its own binding
				// admitted (the kit's allowlists); this frame only paints.
				avatar={avatar as PresenceAvatarId}
				size={28}
				live
				working={state.working === true}
				{...(state.skin !== undefined ? { skin: state.skin as PresenceSurfaceProps["skin"] } : {})}
				{...(state.accent !== undefined ? { accent: state.accent as PresenceSurfaceProps["accent"] } : {})}
			/>
		</span>
	);
}

/** An error as a person reads it. */
export function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
