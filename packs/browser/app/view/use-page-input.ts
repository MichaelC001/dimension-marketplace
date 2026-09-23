// Direct input onto the page: every mouse, wheel and key event the human
// makes becomes a `browser_act` call, sent strictly in order, one at a time.
// Between calls the queue coalesces what a human produces in bursts, so a
// flick of the wheel is one scroll, a typed word is one insert, and a sweep
// of the mouse is only the hover where it came to rest.
import { useCallback, useEffect, useRef } from "react";
import type { BrowserAction, BrowserState } from "../../src/contracts";
import { type BrowserClient, failureText } from "./browser-client";

/** The runtime's ceiling for one scroll delta and one inserted string. */
const MAX_DELTA = 5000;
const MAX_INSERT = 4096;

export interface PageInput {
	/** Queue one action; coalesced with the pending tail where that is lossless. */
	send(action: BrowserAction): void;
	/** Drop everything not yet sent (a tab switch, a task taking over). */
	reset(): void;
}

export interface PageInputOptions {
	readonly onState: (state: BrowserState, action: BrowserAction) => void;
	readonly onError: (message: string, action: BrowserAction) => void;
}

const clampDelta = (value: number) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, value));

/** Folds `next` into `last` when the pair means the same as one action. */
function merge(last: BrowserAction, next: BrowserAction): BrowserAction | null {
	if (last.kind === "hover" && next.kind === "hover") return next;
	if (last.kind === "scroll" && next.kind === "scroll") {
		return { kind: "scroll", deltaX: clampDelta((last.deltaX ?? 0) + (next.deltaX ?? 0)), deltaY: clampDelta((last.deltaY ?? 0) + (next.deltaY ?? 0)) };
	}
	if (last.kind === "insert" && next.kind === "insert") {
		const text = `${last.text ?? ""}${next.text ?? ""}`;
		return text.length <= MAX_INSERT ? { kind: "insert", text } : null;
	}
	return null;
}

export function usePageInput(client: BrowserClient, browserId: string | null, options: PageInputOptions): PageInput {
	const queueRef = useRef<BrowserAction[]>([]);
	const busyRef = useRef(false);
	const boundRef = useRef(browserId);
	boundRef.current = browserId;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	useEffect(() => {
		queueRef.current = [];
	}, [browserId]);

	const drain = useCallback(async () => {
		if (busyRef.current) return;
		busyRef.current = true;
		try {
			for (let action = queueRef.current.shift(); action !== undefined; action = queueRef.current.shift()) {
				const bound = boundRef.current;
				if (bound === null) break;
				try {
					const next = await client.act(bound, action);
					if (boundRef.current === bound) optionsRef.current.onState(next, action);
				} catch (cause) {
					// A missed hover is invisible and the next one supersedes it.
					if (boundRef.current === bound && action.kind !== "hover") optionsRef.current.onError(failureText(cause), action);
				}
			}
		} finally {
			busyRef.current = false;
		}
	}, [client]);

	const send = useCallback(
		(action: BrowserAction) => {
			const queue = queueRef.current;
			const last = queue[queue.length - 1];
			const merged = last === undefined ? null : merge(last, action);
			if (merged !== null) queue[queue.length - 1] = merged;
			else queue.push(action.kind === "scroll" ? { ...action, deltaX: clampDelta(action.deltaX ?? 0), deltaY: clampDelta(action.deltaY ?? 0) } : action);
			void drain();
		},
		[drain],
	);

	const reset = useCallback(() => {
		queueRef.current = [];
	}, []);

	return { send, reset };
}
