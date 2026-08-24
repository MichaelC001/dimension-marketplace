import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/composer-minimal.tsx
var noop = () => {};
var surface = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	margin: "0 12px 12px",
	padding: 10,
	borderRadius: 12,
	border: "1px solid var(--fr-border)",
	background: "var(--fr-surface)"
};
var field = {
	resize: "none",
	width: "100%",
	minHeight: 56,
	maxHeight: 200,
	border: "none",
	outline: "none",
	background: "transparent",
	color: "var(--fr-text)",
	font: "inherit",
	fontSize: 13,
	lineHeight: 1.5
};
var row = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 8
};
var badge = {
	fontSize: 11,
	color: "var(--fr-text-3)"
};
function button(tone, enabled) {
	return {
		border: "1px solid var(--fr-border)",
		borderRadius: 8,
		padding: "4px 12px",
		fontSize: 12,
		cursor: enabled ? "pointer" : "not-allowed",
		opacity: enabled ? 1 : .45,
		color: tone === "stop" ? "var(--fr-del)" : "var(--fr-text)",
		background: "var(--fr-surface-2)"
	};
}
/**
* A composer at the zero-import floor.
*
* Enter sends, Shift+Enter is a newline — the shipped convention, because a
* section that invents its own key contract makes the space feel broken rather
* than different. While the session streams, the same control becomes Stop:
* one affordance, whichever verb the session's own state makes true.
*/
function MinimalComposer(props) {
	const [text, setText] = useState("");
	const areaRef = useRef(null);
	const sessionId = props.sessionRef?.sessionId;
	const store = props.store ?? null;
	const streamingSource = useMemo(() => {
		if (!store || !sessionId) return null;
		return store.watch(`session/${sessionId}/isStreaming`);
	}, [store, sessionId]);
	const streaming = useSyncExternalStore(streamingSource?.subscribe ?? (() => noop), () => streamingSource?.getSnapshot() ?? false, () => false) === true;
	const continued = props.continuation?.canOpen === true;
	const blocked = props.disabled === true || continued || !sessionId;
	const canSend = !blocked && text.trim().length > 0;
	const send = useCallback(() => {
		const body = text.trim();
		if (!body || !sessionId) return;
		if (props.actions?.sendMessage) props.actions.sendMessage(body);
		else store?.act("sendMessage", {
			sessionId,
			workspaceId: props.sessionRef?.workspaceId,
			text: body
		});
		setText("");
		areaRef.current?.focus();
	}, [
		text,
		sessionId,
		props.actions,
		props.sessionRef?.workspaceId,
		store
	]);
	const stop = useCallback(() => {
		if (!sessionId) return;
		if (props.actions?.interruptRunForQueuedMessage) props.actions.interruptRunForQueuedMessage();
		else store?.act("stopSession", {
			sessionId,
			workspaceId: props.sessionRef?.workspaceId
		});
	}, [
		sessionId,
		props.actions,
		props.sessionRef?.workspaceId,
		store
	]);
	const onKeyDown = useCallback((event) => {
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		if (canSend) send();
	}, [canSend, send]);
	return /* @__PURE__ */ jsxs("div", {
		style: surface,
		"data-slot": "composer-minimal",
		children: [/* @__PURE__ */ jsx("textarea", {
			ref: areaRef,
			style: field,
			value: text,
			placeholder: continued ? `This session continued${props.continuation?.targetTitle ? ` into "${props.continuation.targetTitle}"` : ""} — it is read-only.` : props.placeholder ?? "Message the agent…",
			onChange: (event) => setText(event.target.value),
			onKeyDown,
			disabled: blocked,
			"aria-label": "Message the agent"
		}), /* @__PURE__ */ jsxs("div", {
			style: row,
			children: [/* @__PURE__ */ jsx("span", {
				style: badge,
				children: !sessionId ? "no session bound" : props.opening ? "connecting — input is queued" : streaming ? "the agent is working" : "Enter sends · Shift+Enter newline"
			}), streaming ? /* @__PURE__ */ jsx("button", {
				type: "button",
				style: button("stop", true),
				onClick: stop,
				children: "Stop"
			}) : /* @__PURE__ */ jsx("button", {
				type: "button",
				style: button("send", canSend),
				onClick: canSend ? send : noop,
				disabled: !canSend,
				children: "Send"
			})]
		})]
	});
}
//#endregion
export { MinimalComposer, MinimalComposer as default };
