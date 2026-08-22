// Minimal Thread — a compact transcript, and the worked example of the
// contributed thread SECTION lane ("type": "component", "slot": "thread",
// doc 69 §3.5): a space binds it through `workspace.sections.thread` and it
// replaces THREAD_CLASSIC inside the session surface — never a layout column.
//
//   THE ENTIRE IMPORT SURFACE: `react`. Nothing else.
//
// A section component's props ARE its contract (`ThreadSectionProps`,
// restated structurally here — doc 68 §3.4): the session ref names the store
// keys, the host's Store arrives on `store`, and React's BUILT-IN
// `useSyncExternalStore` reads the published cells. Facts from the Store
// (`session/<id>/transcript` + `session/<id>/verb` — doc 68 §3.3); pixels the
// author's own, drawn on the host's `--fr-*` custom properties so it sits in
// either theme without importing anything.

import { type CSSProperties, type ReactNode, useMemo, useSyncExternalStore } from "react";

/** The Store's contract shape, restated structurally (doc 68 §3.4). */
interface HostStoreShape {
	watch<T>(key: string): { getSnapshot(): T | undefined; subscribe(listener: () => void): () => void };
	act(intent: string, payload?: unknown): void;
}

/** Structural subset of the published `session/<id>/transcript` rows
 *  (`SessionTranscriptMessage`): identity, role, and the text blocks this
 *  minimal view renders. Everything else on the row is ignored, honestly. */
interface TranscriptRow {
	readonly id: string;
	readonly role: "user" | "agent" | "divider";
	readonly blocks: readonly { readonly type: string; readonly text?: string }[];
	readonly variant?: string;
}

/** Structural subset of the published `session/<id>/verb` fact (`WorkingStatus`). */
interface VerbFact {
	readonly message: string | null;
	readonly visible: boolean;
}

/** The structural subset of `ThreadSectionProps` this section reads. */
export interface MinimalThreadProps {
	readonly sessionRef?: { readonly sessionId: string } | null;
	readonly store?: HostStoreShape | null;
}

const NO_ROWS: readonly TranscriptRow[] = [];
const noop = () => {};

const text = (tone: 1 | 2 | 3): CSSProperties => ({
	color: tone === 1 ? "var(--fr-text)" : `var(--fr-text-${tone})`,
});

/** One transcript row: a quiet role label and the row's text. Tool cards,
 *  reasoning, images — deliberately not rendered; this is the MINIMAL thread. */
function Row({ row }: { readonly row: TranscriptRow }): ReactNode {
	if (row.role === "divider") {
		return (
			<div style={{ padding: "6px 0", fontSize: 11, textAlign: "center", ...text(3) }}>
				— {row.variant ?? "divider"} —
			</div>
		);
	}
	const body = row.blocks
		.filter(block => block.type === "text" && typeof block.text === "string" && block.text.length > 0)
		.map(block => block.text)
		.join("\n");
	if (body.length === 0) return null;
	return (
		<div style={{ padding: "6px 0", borderBottom: "1px solid var(--fr-border-soft)" }}>
			<div
				style={{
					fontSize: 10,
					letterSpacing: "0.08em",
					textTransform: "uppercase",
					marginBottom: 2,
					...(row.role === "user" ? { color: "var(--fr-accent)" } : text(3)),
				}}
			>
				{row.role === "user" ? "You" : "Agent"}
			</div>
			<div style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", ...text(row.role === "user" ? 1 : 2) }}>
				{body}
			</div>
		</div>
	);
}

/**
 * The compact transcript: role + text rows from the Store's published
 * `session/<id>/transcript` cell, the working verb at the tail from
 * `session/<id>/verb`. No wisp, no tool cards — minimal but REAL.
 */
export function MinimalThread({ sessionRef, store }: MinimalThreadProps): ReactNode {
	const sessionId = sessionRef?.sessionId;
	const transcriptObservable = useMemo(
		() => (store && sessionId ? store.watch<readonly TranscriptRow[]>(`session/${sessionId}/transcript`) : null),
		[store, sessionId],
	);
	const verbObservable = useMemo(
		() => (store && sessionId ? store.watch<VerbFact | null>(`session/${sessionId}/verb`) : null),
		[store, sessionId],
	);
	// `subscribe` is invoked THROUGH the observable, never detached: the
	// published contract is an interface, and a host implementing `watch` with
	// a bound method would throw on a detached reference. This pack is the
	// exemplar for the zero-import floor — model the pattern, not the accident.
	const rows = useSyncExternalStore(
		listener => transcriptObservable?.subscribe(listener) ?? noop,
		() => transcriptObservable?.getSnapshot() ?? NO_ROWS,
		() => NO_ROWS,
	);
	const verb = useSyncExternalStore(
		listener => verbObservable?.subscribe(listener) ?? noop,
		() => verbObservable?.getSnapshot() ?? null,
		() => null,
	);
	if (!store || !sessionId) {
		return (
			<div style={{ padding: 16, fontSize: 12, ...text(3) }}>
				This host mounted the thread without a Store and a session — nothing to show, honestly.
			</div>
		);
	}
	return (
		<div
			data-slot="thread-minimal"
			style={{
				height: "100%",
				minHeight: 0,
				flex: 1,
				overflowY: "auto",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<div style={{ width: "100%", maxWidth: 680, margin: "0 auto", padding: "16px 20px 24px" }}>
				{rows.length === 0 ? (
					<div style={{ padding: "24px 8px", fontSize: 12, textAlign: "center", ...text(3) }}>
						No messages yet — the transcript fills as the session works.
					</div>
				) : (
					rows.map(row => <Row key={row.id} row={row} />)
				)}
				{verb?.visible && verb.message && (
					<div style={{ padding: "10px 0 0", fontSize: 11, fontStyle: "italic", color: "var(--fr-accent)" }}>
						{verb.message}…
					</div>
				)}
			</div>
		</div>
	);
}
