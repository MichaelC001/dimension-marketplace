// Minimal Composer — the worked example of the contributed composer SECTION
// lane ("type": "component", "slot": "composer", doc 69 §3.5). A space binds it
// through `workspace.sections.composer` and it replaces COMPOSER_CLASSIC inside
// the session surface.
//
//   THE ENTIRE IMPORT SURFACE: `react`. Nothing else.
//
// Data in, INTENTS OUT (doc 68 §3.3 rules 1+2). This section never touches a
// driver and never writes a Store key: it reads the published
// `session/<id>/isStreaming` cell through React's own `useSyncExternalStore`,
// and every mutation leaves as a published verb — `act("sendMessage")` and
// `act("stopSession")`. That is the whole reason a stranger can write a
// composer at all: the send path is a message, not an API handle.

import { type CSSProperties, type KeyboardEvent, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";

/** The Store's contract shape, restated structurally (doc 68 §3.4). */
interface HostStoreShape {
	watch<T>(key: string): { getSnapshot(): T | undefined; subscribe(listener: () => void): () => void };
	act(intent: string, payload?: unknown): void;
}

/** The registered session action set, structurally — present when the host
 *  mounted a provider. Preferred over the raw verb when both exist: it carries
 *  the optimistic echo and queue awareness the provider owns. */
interface SessionActionsShape {
	readonly sendMessage?: (text: string) => unknown;
	readonly interruptRunForQueuedMessage?: () => unknown;
}

/** Structural subset of the published `session/<id>/isStreaming` fact
 *  (`StreamingFact`, store-types.ts:176-179). It is an OBJECT, not a boolean —
 *  restated from the source, because a restatement invented from memory is a
 *  false claim about the host and every read against it is dead. */
interface StreamingShape {
	readonly isStreaming?: boolean;
	readonly hasRunningTool?: boolean;
}

/** A continued session is terminal — the contract's duty is to BLOCK sends and
 *  say where the conversation went, never to silently swallow input.
 *  Fields from `SessionContinuation` (session-types.ts:156-165). */
interface ContinuationShape {
	readonly continued?: boolean;
	readonly toSessionId?: string;
	readonly toSessionTitle?: string;
}

/** The structural subset of `ComposerSectionProps` this section reads. */
export interface MinimalComposerProps {
	readonly sessionRef?: { readonly sessionId: string; readonly workspaceId?: string } | null;
	readonly store?: HostStoreShape | null;
	readonly actions?: SessionActionsShape | null;
	readonly placeholder?: string;
	readonly disabled?: boolean;
	readonly opening?: boolean;
	readonly continuation?: ContinuationShape | null;
}

const noop = () => {};

const surface: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	margin: "0 12px 12px",
	padding: 10,
	borderRadius: 12,
	border: "1px solid var(--fr-border)",
	background: "var(--fr-surface)",
};

const field: CSSProperties = {
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
	lineHeight: 1.5,
};

const row: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };

const badge: CSSProperties = { fontSize: 11, color: "var(--fr-text-3)" };

function button(tone: "send" | "stop", enabled: boolean): CSSProperties {
	return {
		border: "1px solid var(--fr-border)",
		borderRadius: 8,
		padding: "4px 12px",
		fontSize: 12,
		cursor: enabled ? "pointer" : "not-allowed",
		opacity: enabled ? 1 : 0.45,
		color: tone === "stop" ? "var(--fr-del)" : "var(--fr-text)",
		background: "var(--fr-surface-2)",
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
export function MinimalComposer(props: MinimalComposerProps) {
	const [text, setText] = useState("");
	const areaRef = useRef<HTMLTextAreaElement | null>(null);
	const sessionId = props.sessionRef?.sessionId;
	const store = props.store ?? null;

	// The published streaming cell — the ONE fact this composer needs from the
	// session, read with React's own store hook. No provider, no context.
	const streamingSource = useMemo(() => {
		if (!store || !sessionId) return null;
		return store.watch<StreamingShape>(`session/${sessionId}/isStreaming`);
	}, [store, sessionId]);
	// `subscribe` is invoked THROUGH the observable, never detached: the
	// published contract is an interface, and a host implementing `watch` with a
	// bound method would throw on a torn-off reference (thread-minimal states the
	// same rule — model the pattern, not the accident). The no-source fallback is
	// module-stable so React does not tear down and re-subscribe every render.
	const streaming =
		useSyncExternalStore(
			listener => streamingSource?.subscribe(listener) ?? noop,
			() => streamingSource?.getSnapshot(),
			() => undefined,
		)?.isStreaming === true;

	const continued = props.continuation?.continued === true;
	const blocked = props.disabled === true || continued || !sessionId;
	const canSend = !blocked && text.trim().length > 0;

	const send = useCallback(() => {
		const body = text.trim();
		if (!body || !sessionId) return;
		// The provider's action first (optimistic echo + queue awareness), the
		// published verb as the honest fallback. Both are messages; neither is a
		// driver handle.
		if (props.actions?.sendMessage) props.actions.sendMessage(body);
		else store?.act("sendMessage", { sessionId, workspaceId: props.sessionRef?.workspaceId, text: body });
		setText("");
		areaRef.current?.focus();
	}, [text, sessionId, props.actions, props.sessionRef?.workspaceId, store]);

	const stop = useCallback(() => {
		if (!sessionId) return;
		if (props.actions?.interruptRunForQueuedMessage) props.actions.interruptRunForQueuedMessage();
		else store?.act("stopSession", { sessionId, workspaceId: props.sessionRef?.workspaceId });
	}, [sessionId, props.actions, props.sessionRef?.workspaceId, store]);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key !== "Enter" || event.shiftKey) return;
			event.preventDefault();
			if (canSend) send();
		},
		[canSend, send],
	);

	return (
		<div style={surface} data-slot="composer-minimal">
			<textarea
				ref={areaRef}
				style={field}
				value={text}
				placeholder={
					continued
						? `This session continued${props.continuation?.toSessionTitle ? ` into "${props.continuation.toSessionTitle}"` : ""} — it is read-only.`
						: (props.placeholder ?? "Message the agent…")
				}
				onChange={event => setText(event.target.value)}
				onKeyDown={onKeyDown}
				disabled={blocked}
				aria-label="Message the agent"
			/>
			<div style={row}>
				<span style={badge}>
					{/* Honest about the session's state rather than a decorative hint. */}
					{!sessionId
						? "no session bound"
						: props.opening
							? "connecting — input is queued"
							: streaming
								? "the agent is working"
								: "Enter sends · Shift+Enter newline"}
				</span>
				{streaming ? (
					<button type="button" style={button("stop", true)} onClick={stop}>
						Stop
					</button>
				) : (
					<button type="button" style={button("send", canSend)} onClick={canSend ? send : noop} disabled={!canSend}>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
