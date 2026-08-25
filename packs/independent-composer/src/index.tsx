// An INDEPENDENT composer, built on the marketplace authoring surface.
//
// Imports from @fraym/ui: Button, Textarea, Badge, Icon, cn, useObservable.
// Imports from our implementations: NOTHING. This is the proof that the
// platform's primitives + store channels are sufficient to build a real
// session surface from scratch — the thing the externals contract made
// impossible until it published the bricks.
//
// Behavior channels (the store answer):
//   send    -> actions.sendMessage(text)   the ONE behavior path: the host's
//            executor resolves the live provider registry first, so this gets
//            the same optimistic echo, queue awareness and steer-ghost the
//            shipped composer gets. No driver anywhere.
//   stop    -> actions.interruptRunForQueuedMessage()
//   state   -> useObservable(session)      the folded facts (status, turnPhase)
//   store.watch("session/<id>/verb")       the published cell, watched directly
//
// Styling: the fr-* token classes. theme.css is host-loaded, so the tokens are
import { Badge, ComposerTips, IconButton, Icon, Textarea, cn, useObservable } from "@fraym/ui";
import { useState, type KeyboardEvent, type ReactNode } from "react";

/** The prop shape this composer uses, declared structurally — a marketplace
 *  author has no path into the host's internal contract modules, and none is
 *  needed: the host passes these fields, types are erased at build. */
interface ComposerProps {
	readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string } | null | undefined;
	readonly placeholder: string;
	readonly actions?:
		| {
				readonly sendMessage: (input: string) => Promise<void>;
				readonly interruptRunForQueuedMessage: () => Promise<void>;
		  }
		| null;
	readonly session?: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown } | null;
	readonly disabled: boolean;
	readonly opening: boolean;
	readonly continuation: { readonly continued: boolean };
	/** Host chrome: the permission chip + mode pills (left), the model picker +
	 *  context radial cluster (right). Rendered where the shipped composer puts
	 *  them — the host builds them, the pack only places them. */
	readonly leftSlot?: ReactNode;
	readonly rightSlot?: ReactNode;
}

type ComposerSectionProps = ComposerProps;

export default function IndependentComposer(props: ComposerSectionProps) {
	const { sessionRef, placeholder, actions, session, disabled, opening, continuation, leftSlot, rightSlot } = props;
	const [draft, setDraft] = useState("");
	const facts = useObservable(
		session ?? { subscribe: () => () => {}, getSnapshot: () => null },
	);


	const blocked = disabled || !sessionRef || !actions || continuation.continued;
	const running = facts?.status === "running" || facts?.turnPhase === "streaming";
	const canSend = !blocked && !running && draft.trim().length > 0;

	const send = () => {
		if (!canSend || !actions) return;
		const text = draft;
		setDraft("");
		void actions.sendMessage(text);
	};
	const stop = () => {
		if (!actions) return;
		void actions.interruptRunForQueuedMessage();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			send();
		}
	};

	return (
		<div data-slot="composer" className="relative z-[2] flex-none bg-fr-bg px-7 pb-[18px] pt-2">
			{continuation.continued && (
				<div className="mx-auto mb-2 max-w-[780px]">
					<Badge tone="warn" variant="soft">This session was continued — open the new session to keep working.</Badge>
				</div>
			)}
			<div
				className={cn(
					"relative mx-auto max-w-[780px] rounded-xl border border-fr-border bg-fr-surface",
					"transition-[border-color] duration-[var(--fr-motion-fast)] focus-within:border-fr-accent-line",
				)}
			>
				<Textarea
					data-slot="independent-composer-field"
					value={draft}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={blocked && !sessionRef ? "No session" : placeholder}
					disabled={blocked}
					rows={1}
					resize="none"
					className="max-h-[240px] min-h-[44px] w-full resize-none border-0 bg-transparent px-4 py-3 text-fr-sm text-fr-text focus:outline-none disabled:opacity-50"
				/>
				<ComposerTips className="mx-auto mt-2.5 max-w-[780px] px-2" />
				<div className="flex items-center gap-2 px-2.5 pb-[9px] pt-2">
					{leftSlot}
					<span className="flex-1" />
					{rightSlot}
					{running ? (
						<IconButton variant="accent" aria-label="Stop response" onClick={stop} data-slot="independent-composer-stop">
							<Icon name="square" size={16} strokeWidth={2} />
						</IconButton>
					) : (
						<IconButton
							variant="accent"
							aria-label="Send"
							onClick={send}
							disabled={!canSend}
							data-slot="independent-composer-send"
						>
							<Icon name="send" size={16} strokeWidth={2} />
						</IconButton>
					)}
				</div>
			</div>
		</div>
	);
}
