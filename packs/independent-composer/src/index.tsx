// An INDEPENDENT composer, assembled from published parts and the store.
//
// Parts from @fraym/ui: Composer (the field assembly — editor, mention pills,
// attachments, slash menu, chips, voice mic + dictation, send/stop row),
// ComposerTips, GoalComposerSurface + UsageLimitComposerSurface (top surfaces),
// and the slim-channel completion adapters (useSlashCommands /
// useFileCompletions / useArgumentCompletions — capabilities in, never a
// driver). Imports from our section implementations: NOTHING.
//
// THE STORE ANSWER: send -> actions.sendMessage (the ONE behavior path — the
// host executor resolves the live provider registry first, so this composer
// gets the same optimistic echo, queue awareness and steer-ghost as the
// shipped one). stop -> actions.interruptRunForQueuedMessage. state ->
// useObservable(session), the folded facts (isStreaming, goal). No driver.
//
// What is OURS here is the SECTION wiring — draft persistence, the send
// mapping, the surfaces' placement — exactly the part a marketplace author
// owns. The field, the tips, the surfaces and the voice subsystem are the
// published parts the reference also composes, so parity is structural.
import {
	Composer,
	GoalComposerSurface,
	useArgumentCompletions,
	useFileCompletions,
	useObservable,
	useSlashCommands,
	UsageLimitComposerSurface,
} from "@fraym/ui";
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

/** Per-session draft persistence — the same BEHAVIOR as the reference's
 *  session-scoped drafts: switch away mid-sentence, come back, the words are
 *  still here. Module-level on purpose: it outlives the component, scoped by
 *  `workspaceId\0sessionId`, and never leaves the page. */
const drafts = new Map<string, string>();

export default function IndependentComposer(props: ComposerSectionProps) {
	const { sessionRef, placeholder, actions, session, disabled, opening, continuation, leftSlot, rightSlot } = props;
	const draftKey = sessionRef ? `${sessionRef.workspaceId}\0${sessionRef.sessionId}` : "";
	const [draft, setDraft] = useState(() => drafts.get(draftKey) ?? "");
	const facts = (useObservable(session ?? { subscribe: () => () => {}, getSnapshot: () => null }) ?? null) as {
		readonly isStreaming?: boolean;
		readonly turnPhase?: "streaming" | "settled";
		readonly goal?: unknown;
	} | null;
	const slashCommands = useSlashCommands(draft);
	const fileCompletionSource = useFileCompletions();
	const argumentCompletionSource = useArgumentCompletions();

	const setDraftPersisted = (text: string) => {
		setDraft(text);
		if (draftKey) {
			if (text) drafts.set(draftKey, text);
			else drafts.delete(draftKey);
		}
	};

	const blocked = disabled || !sessionRef || !actions || continuation.continued;
	const running = Boolean(facts?.isStreaming) || facts?.turnPhase === "streaming";
	const goal = (facts?.goal ?? null) as { readonly objective?: string } | null | undefined;

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
		<Composer
			value={draft}
			onChange={setDraftPersisted}
			onSubmit={text => {
				setDraftPersisted("");
				send(text);
			}}
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
			topSlot={
				<>
					<UsageLimitComposerSurface />
					{goal?.objective ? (
						<GoalComposerSurface
							goal={goal as never}
							disabled={blocked}
							onEditGoal={objective => send(`/goal set ${objective}`)}
							onPauseGoal={() => send("/goal pause")}
							onResumeGoal={() => send("/goal resume")}
							onClearGoal={() => send("/goal drop")}
						/>
					) : null}
				</>
			}
		/>
	);
}
