import { Badge, Button, ComposerTips, Icon, Textarea, cn, useObservable } from "@fraym/ui";
import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/index.tsx
function IndependentComposer(props) {
	const { sessionRef, placeholder, actions, session, disabled, opening, continuation } = props;
	const [draft, setDraft] = useState("");
	const facts = useObservable(session ?? {
		subscribe: () => () => {},
		getSnapshot: () => null
	});
	const blocked = disabled || !sessionRef || !actions || continuation.continued;
	const running = facts?.status === "running" || facts?.turnPhase === "streaming";
	const canSend = !blocked && !running && draft.trim().length > 0;
	const send = () => {
		if (!canSend || !actions) return;
		const text = draft;
		setDraft("");
		actions.sendMessage(text);
	};
	const stop = () => {
		if (!actions) return;
		actions.interruptRunForQueuedMessage();
	};
	const onKeyDown = (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			send();
		}
	};
	return /* @__PURE__ */ jsxs("div", {
		"data-slot": "composer",
		className: "relative z-[2] flex-none bg-fr-bg px-7 pb-[18px] pt-2",
		children: [continuation.continued && /* @__PURE__ */ jsx("div", {
			className: "mx-auto mb-2 max-w-[780px]",
			children: /* @__PURE__ */ jsx(Badge, {
				tone: "warn",
				variant: "soft",
				children: "This session was continued — open the new session to keep working."
			})
		}), /* @__PURE__ */ jsxs("div", {
			className: cn("relative mx-auto max-w-[780px] rounded-xl border border-fr-border bg-fr-surface", "transition-[border-color] duration-[var(--fr-motion-fast)] focus-within:border-fr-accent-line"),
			children: [
				/* @__PURE__ */ jsx(Textarea, {
					"data-slot": "independent-composer-field",
					value: draft,
					onChange: (event) => setDraft(event.target.value),
					onKeyDown,
					placeholder: blocked && !sessionRef ? "No session" : placeholder,
					disabled: blocked,
					rows: 1,
					resize: "none",
					className: "max-h-[240px] min-h-[44px] w-full resize-none border-0 bg-transparent px-4 py-3 text-fr-sm text-fr-text focus:outline-none disabled:opacity-50"
				}),
				/* @__PURE__ */ jsx(ComposerTips, { className: "mx-auto mt-2.5 max-w-[780px] px-2" }),
				/* @__PURE__ */ jsx("div", {
					className: "flex items-center justify-end gap-2 px-3 pb-2.5",
					children: running ? /* @__PURE__ */ jsxs(Button, {
						variant: "secondary",
						size: "sm",
						onClick: stop,
						"data-slot": "independent-composer-stop",
						children: [/* @__PURE__ */ jsx(Icon, {
							name: "square",
							className: "size-3.5"
						}), "Stop"]
					}) : /* @__PURE__ */ jsxs(Button, {
						variant: "primary",
						size: "sm",
						onClick: send,
						disabled: !canSend,
						"data-slot": "independent-composer-send",
						children: [/* @__PURE__ */ jsx(Icon, {
							name: "send",
							className: "size-3.5"
						}), "Send"]
					})
				})
			]
		})]
	});
}
//#endregion
export { IndependentComposer as default };
