import { Composer, useArgumentCompletions, useFileCompletions, useObservable, useSlashCommands } from "@fraym/ui";
import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/index.tsx
function IndependentComposer(props) {
	const { sessionRef, placeholder, actions, session, disabled, opening, continuation, leftSlot, rightSlot } = props;
	const [draft, setDraft] = useState("");
	const facts = useObservable(session ?? {
		subscribe: () => () => {},
		getSnapshot: () => null
	}) ?? null;
	const slashCommands = useSlashCommands(draft);
	const fileCompletionSource = useFileCompletions();
	const argumentCompletionSource = useArgumentCompletions();
	const blocked = disabled || !sessionRef || !actions || continuation.continued;
	const running = Boolean(facts?.isStreaming) || facts?.turnPhase === "streaming";
	const send = (text) => {
		if (!actions || blocked || running) return;
		actions.sendMessage(text);
	};
	const stop = () => {
		if (!actions) return;
		actions.interruptRunForQueuedMessage();
	};
	const onKeyDown = (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			send(draft);
		}
	};
	return /* @__PURE__ */ jsxs("div", {
		"data-slot": "composer",
		className: "relative z-[2] flex-none bg-fr-bg px-7 pb-[18px] pt-2",
		children: [continuation.continued && /* @__PURE__ */ jsx("div", {
			className: "mx-auto mb-2 max-w-[780px]",
			children: /* @__PURE__ */ jsx("div", {
				className: "rounded-fr-md border border-fr-warn/40 bg-fr-surface-2/95 px-3 py-1.5 font-secondary text-fr-xs text-fr-text-2",
				children: "This session was continued — open the new session to keep working."
			})
		}), /* @__PURE__ */ jsx(Composer, {
			"data-slot": "independent-composer",
			value: draft,
			onChange: setDraft,
			onSubmit: (text) => send(text),
			onStop: stop,
			streaming: Boolean(running),
			disabled: blocked,
			connecting: opening && !continuation.continued,
			focusWhenEnabled: !continuation.continued,
			placeholder,
			showTips: true,
			leftSlot,
			rightSlot,
			onKeyDown,
			slashCommands,
			fileCompletionSource,
			argumentCompletionSource
		})]
	});
}
//#endregion
export { IndependentComposer as default };
