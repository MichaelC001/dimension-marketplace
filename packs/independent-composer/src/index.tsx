// An INDEPENDENT composer, assembled from published parts and the store.
//
// Imports from @fraym/ui: Composer (the field assembly PART — editor, mention
// pills, attachments, slash menu, chips, send/stop row), ComposerTips, the
// slim-channel completion adapters (useSlashCommands / useFileCompletions /
// useArgumentCompletions — they read the promoted capabilities, never a
// driver). Imports from our section implementations: NOTHING.
//
// THE STORE ANSWER: send -> actions.sendMessage (the ONE behavior path — the
// host executor resolves the live provider registry first, so this composer
// gets the same optimistic echo, queue awareness and steer-ghost as the
// shipped one). stop -> actions.interruptRunForQueuedMessage. state ->
// useObservable(session), the folded facts. No driver anywhere.
//
// What is OURS here is the SECTION wiring — draft state, the send mapping, the
// streaming read — exactly the part a marketplace author is meant to own. The
// field itself is the published part the reference also composes, so field
// parity is structural, not aspirational.
import { Composer, useArgumentCompletions, useFileCompletions, useObservable, useSlashCommands } from "@fraym/ui";
import { useState, type KeyboardEvent, type ReactNode } from "react";

/** The prop shape this composer uses, declared structurally — a marketplace
 *  author has no path into the host's internal contract modules, and none is
 *  needed: the host passes these fields, types are erased at build. */
interface ComposerProps {
	readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string } | null | undefined;
	readonly placeholder: string;
	readonly actions?:
		| {
				readonly sendMessage: (input: unknown) => Promise<void>;
				readonly interruptRunForQueuedMessage: () => Promise<void>;
		  }
		| null;
	readonly session?: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown } | null;
	readonly disabled: boolean;
	readonly opening: boolean;
	readonly continuation: { readonly continued: boolean };
	readonly leftSlot?: ReactNode;
	readonly rightSlot?: ReactNode;
}

type ComposerSectionProps = ComposerProps;

interface ImageAttachment {
	readonly id: string;
	readonly dataUrl: string;
}

export default function IndependentComposer(props: ComposerSectionProps) {
	const { sessionRef, placeholder, actions, session, disabled, opening, continuation, leftSlot, rightSlot } = props;
	const [draft, setDraft] = useState("");
	const facts = (useObservable(session ?? { subscribe: () => () => {}, getSnapshot: () => null }) ?? null) as {
		readonly isStreaming?: boolean;
		readonly turnPhase?: "streaming" | "settled";
	} | null;
	const slashCommands = useSlashCommands(draft);
	const fileCompletionSource = useFileCompletions();
	const argumentCompletionSource = useArgumentCompletions();

	const blocked = disabled || !sessionRef || !actions || continuation.continued;
	const running = Boolean(facts?.isStreaming) || facts?.turnPhase === "streaming";

	const send = (text: string) => {
		if (!actions || blocked || running) return;
		void actions.sendMessage(text);
	};
	const stop = () => {
		if (!actions) return;
		void actions.interruptRunForQueuedMessage();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			send(draft);
		}
	};

	return (
		<div data-slot="composer" className="relative z-[2] flex-none bg-fr-bg px-7 pb-[18px] pt-2">
			{continuation.continued && (
				<div className="mx-auto mb-2 max-w-[780px]">
					<div className="rounded-fr-md border border-fr-warn/40 bg-fr-surface-2/95 px-3 py-1.5 font-secondary text-fr-xs text-fr-text-2">
						This session was continued — open the new session to keep working.
					</div>
				</div>
			)}
			<Composer
				data-slot="independent-composer"
				value={draft}
				onChange={setDraft}
				onSubmit={text => send(text)}
				onStop={stop}
				streaming={Boolean(running)}
				disabled={blocked}
				connecting={opening && !continuation.continued}
				focusWhenEnabled={!continuation.continued}
				placeholder={placeholder}
				showTips
				leftSlot={leftSlot}
				rightSlot={rightSlot}
				onKeyDown={onKeyDown}
				slashCommands={slashCommands}
				fileCompletionSource={fileCompletionSource}
				argumentCompletionSource={argumentCompletionSource}
			/>
		</div>
	);
}
