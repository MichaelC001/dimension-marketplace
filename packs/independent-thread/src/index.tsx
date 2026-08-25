// An INDEPENDENT thread section, assembled from published parts.
//
// Parts from @fraym/ui: `Thread` (THE conversation composition — transcript →
// turns → tool cards, stick-to-bottom viewport, working tail; reads the session
// only through tuned selectors), `SectionSessionScope` (the purity adapter that
// re-publishes the contract's three channels as the session contexts those
// selectors speak — no host provider needed), `PresenceSurface` (the tail's
// avatar), `OpeningThreadSkeleton` (the loading face), `presenceMode`, and
// `useSettings` (the user's vibr-size preference).
//
// Imports from our section implementations: NOTHING. The reference composes
// the identical parts (impls/thread-classic.tsx), so parity is structural —
// what is OURS here is only the section wiring: prop threading and the memo
// boundary, exactly the part a marketplace author owns.
import {
	OpeningThreadSkeleton,
	PresenceSurface,
	presenceMode,
	SectionSessionScope,
	Thread,
	useSettings,
} from "@fraym/ui";
import { memo, type ComponentProps, type ReactNode } from "react";

/** The prop shape this section uses, declared structurally — a marketplace
 *  author has no path into the host's internal contract modules, and none is
 *  needed: the host passes these fields, types are erased at build. */
interface ThreadSectionProps {
	readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string } | null;
	/** The host Store (contract prop declared for completeness; this section
	 *  takes the SectionSessionScope path, exactly like the reference). */
	readonly store?: unknown;
	readonly session?: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown } | null;
	readonly actions?: Record<string, unknown> | null;
	readonly capabilities?: Record<string, unknown> | null;
	readonly avatar: ComponentProps<typeof PresenceSurface>["avatar"];
	readonly bridgedPresences?: readonly unknown[];
	readonly vibrState: ComponentProps<typeof PresenceSurface>["state"];
	readonly vibrMode?: string;
	readonly energy: number;
	readonly emotion?: ComponentProps<typeof PresenceSurface>["emotion"];
	readonly behaviour?: ComponentProps<typeof PresenceSurface>["behaviour"];
	readonly signals?: ComponentProps<typeof PresenceSurface>["signals"];
	readonly verb?: string;
	readonly showPresence: boolean;
	readonly showAvatar: boolean;
	readonly agentMetaFallback: string;
	readonly opening: boolean;
	readonly enterOnMount?: boolean;
	readonly contentClassName?: string;
}

/** Implementation of the thread section assembled ENTIRELY from published
 *  parts — the composition mirrors the shipped classic one-to-one. */
function IndependentThreadSection(props: ThreadSectionProps) {
	// THE USER'S SIZE, read at the surface that shows a Vibr full-size — the
	// same preference the reference honors (granted `useSettings`, brick tier).
	const { config } = useSettings();
	return (
		// PURITY: everything this subtree knows about the session enters through
		// the contract's three channels — the granted `SectionSessionScope`
		// re-publishes them as the session contexts `Thread`'s tuned selector
		// internals already speak. No ambient session context is consulted.
		<SectionSessionScope session={props.session ?? null} actions={props.actions ?? null} capabilities={props.capabilities ?? null}>
			<Thread
				presence={
					<PresenceSurface
						avatar={props.avatar}
						state={props.vibrState}
						mode={presenceMode(props.vibrMode)}
						energy={props.energy}
						emotion={props.emotion}
						behaviour={props.behaviour}
						signals={props.signals}
						bridgedPresences={props.bridgedPresences}
						size={config.vibrSize}
					/>
				}
				verb={props.verb}
				showPresence={props.showPresence}
				showAvatar={props.showAvatar}
				agentMetaFallback={props.agentMetaFallback}
				// The loading face while the transcript is merely UNKNOWN — the
				// same skeleton part the reference renders, so the opening
				// transition is identical.
				emptyState={props.opening ? <OpeningThreadSkeleton /> : undefined}
				enterOnMount={props.enterOnMount}
				contentClassName={props.contentClassName ?? "max-w-[780px] px-7 pt-8 pb-12"}
			/>
		</SectionSessionScope>
	);
}

// memo: the same flush-stopping boundary the reference carries — the host
// mount re-renders per fold flush, but this section's props are identity-stable
// across flushes, so only the section's own selector subscriptions re-render.
export default memo(IndependentThreadSection);
