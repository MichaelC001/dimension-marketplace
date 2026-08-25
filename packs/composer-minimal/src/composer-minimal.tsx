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

/** Structural subset of the published `session/<id>/isStreaming` fact
 *  (`StreamingFact`, store-types.ts:176-179). It is an OBJECT, not a boolean —
 *  restated from the source, because a restatement invented from memory is a
 *  false claim about the host and every read against it is dead. */
interface StreamingShape {
	readonly isStreaming?: boolean;
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
	readonly placeholder?: string;
	readonly disabled?: boolean;
	readonly opening?: boolean;
	readonly continuation?: ContinuationShape | null;
}

const noop = () => {};
/** Module-stable so the server/hydration arm is not a fresh identity per render. */
const serverSnapshot = (): StreamingShape | undefined => undefined;

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

/** The session's state in one line — honest about what is happening rather than
 *  a decorative hint. Pure derivation, so it lives outside the component. */
function hint(sessionId: string | undefined, opening: boolean, streaming: boolean): string {
	if (!sessionId) return "no session bound";
	if (opening) return "connecting — input is queued";
	if (streaming) return "the agent is working";
	return "Enter sends · Shift+Enter newline";
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
	// Two rules, both load-bearing. (1) `subscribe` is invoked THROUGH the
	// observable, never detached: the published contract is an interface, and a
	// host implementing `watch` with a bound method would throw on a torn-off
	// reference. (2) The closures are MEMOIZED, because React keys its
	// subscription effect on `subscribe` identity alone — a fresh arrow per
	// render unsubscribes and resubscribes on every commit, and this component
	// re-renders on every keystroke. `use-session.ts` does the same thing for
	// the same reason.
	const subscribe = useCallback(
		(listener: () => void) => streamingSource?.subscribe(listener) ?? noop,
		[streamingSource],
	);
	const getSnapshot = useCallback(() => streamingSource?.getSnapshot(), [streamingSource]);
	const streaming = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot)?.isStreaming === true;

	const continued = props.continuation?.continued === true;
	// Name where the conversation went: the successor's title when the live
	// `sessionSwitched` carried one, else its short id — after a reopen the
	// journal divider carries only the id (session-types.ts:160-164). Saying
	// "read-only" without a destination is the half of the duty that strands the
	// user.
	const successor = props.continuation?.toSessionTitle ?? props.continuation?.toSessionId;
	const continuedInto = successor ? `"${successor.slice(0, 40)}"` : null;
	const blocked = props.disabled === true || continued || !sessionId;
	const canSend = !blocked && text.trim().length > 0;

	const send = useCallback(() => {
		const body = text.trim();
		if (!body || !sessionId) return;
		// ONE path out: the published verb. The host's executor resolves the
		// provider's registered action set itself (host-store.ts SESSION_VERBS is
		// `actions ? actions.sendMessage(text) : driver.sendUserMessage(...)`), so a
		// pack that reached for the action directly would duplicate that decision
		// and skip whatever the executor adds later — the traceId it mints today.
		store?.act("sendMessage", { sessionId, workspaceId: props.sessionRef?.workspaceId, text: body });
		setText("");
		areaRef.current?.focus();
	}, [text, sessionId, props.sessionRef?.workspaceId, store]);

	const stop = useCallback(() => {
		if (!sessionId) return;
		store?.act("stopSession", { sessionId, workspaceId: props.sessionRef?.workspaceId });
	}, [sessionId, props.sessionRef?.workspaceId, store]);

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
						? `This session continued${continuedInto ? ` into ${continuedInto}` : ""} — it is read-only.`
						: (props.placeholder ?? "Message the agent…")
				}
				onChange={event => setText(event.target.value)}
				onKeyDown={onKeyDown}
				disabled={blocked}
				aria-label="Message the agent"
			/>
			<div style={row}>
				<span style={badge}>{hint(sessionId, props.opening === true, streaming)}</span>
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
