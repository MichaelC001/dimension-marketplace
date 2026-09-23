// The frame loop. One sequential walker, never more than one call in
// flight, and it stops dead when it must:
//   • no browserId              → nothing to poll
//   • document hidden           → the seat is not on screen; do not burn frames
//   • paused (annotation armed) → the picture MUST NOT move under a drawing,
//                                 so the loop reads `browser_state` instead —
//                                 task progress stays live, pixels freeze
// While an agent task runs the loop polls faster so the human sees the page move.
// Every result is dropped if the browser it belongs to is no longer the one the
// UI is showing, so a profile switch can never land a stale frame.
import { useEffect, useRef, useState } from "react";
import type { BrowserFrame, BrowserState } from "../../src/contracts";
import { type BrowserClient, BrowserToolError } from "./browser-client";

const FRAME_INTERVAL_MS = 1200;
/** Paused: pixels are frozen, but task progress must not be. */
const STATE_INTERVAL_MS = 1500;
/** A task is running: frames (or paused state reads) at this cadence. */
const TASK_INTERVAL_MS = 700;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 10000;

export interface BrowserPoll {
	/** The newest frame for the CURRENT browserId, or null before the first one. */
	readonly frame: BrowserFrame | null;
	/** The newest state — from a frame, a paused state read, or a caller push. */
	readonly state: BrowserState | null;
	/** The live failure, cleared by the next success. */
	readonly error: string | null;
	/** True until the first frame or state for this browserId lands. */
	readonly loading: boolean;
	/** Fold a state the UI obtained itself (open, action, snapshot) into the loop. */
	push(state: BrowserState): void;
	/** Poll now (after an action), rather than at the next interval. */
	refresh(): void;
}

export function useBrowserPoll(
	client: BrowserClient | null,
	browserId: string | null,
	paused: boolean,
): BrowserPoll {
	const [frame, setFrame] = useState<BrowserFrame | null>(null);
	const [state, setState] = useState<BrowserState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// Read by the running loop without restarting it.
	const pausedRef = useRef(paused);
	pausedRef.current = paused;
	// The browser the UI is showing right now; a result for anything else is
	// discarded rather than rendered.
	const currentRef = useRef<string | null>(browserId);
	currentRef.current = browserId;
	// Set by the running loop; `refresh` pokes it without restarting it.
	const kickRef = useRef<() => void>(() => {});

	useEffect(() => {
		setFrame(null);
		setState(null);
		setError(null);
		if (!client || browserId === null) {
			setLoading(false);
			return;
		}
		setLoading(true);

		let alive = true;
		let timer: number | undefined;
		let backoff = BACKOFF_START_MS;
		let inFlight = false;
		// A refresh asked for while a read was in flight: that read may predate
		// the action, so one more follows it immediately.
		let kicked = false;

		const schedule = (delay: number) => {
			if (!alive) return;
			clearTimeout(timer);
			timer = window.setTimeout(() => {
				void tick();
			}, delay);
		};

		const tick = async (): Promise<void> => {
			if (!alive || inFlight) return;
			if (typeof document !== "undefined" && document.hidden) {
				return;
			}
			inFlight = true;
			kicked = false;
			let running = false;
			try {
				if (pausedRef.current) {
					const next = await client.state(browserId);
					if (!alive || currentRef.current !== browserId) return;
					setState(next);
					running = next.task?.status === "running";
				} else {
					const next = await client.frame(browserId);
					if (!alive || currentRef.current !== browserId) return;
					setFrame(current => pausedRef.current && current?.state.browserId === browserId ? current : next);
					setState(next.state);
					running = next.state.task?.status === "running";
				}
				setError(null);
				setLoading(false);
				backoff = BACKOFF_START_MS;
				schedule(kicked ? 0 : running ? TASK_INTERVAL_MS : pausedRef.current ? STATE_INTERVAL_MS : FRAME_INTERVAL_MS);
			} catch (cause) {
				if (!alive || currentRef.current !== browserId) return;
				setError(cause instanceof BrowserToolError ? `${cause.tool}: ${cause.message}` : String(cause));
				setLoading(false);
				schedule(backoff);
				backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
			} finally {
				inFlight = false;
			}
		};

		// A hidden seat sleeps; becoming visible again polls immediately.
		const onVisibility = () => {
			clearTimeout(timer);
			if (!alive || document.hidden || inFlight) return;
			schedule(0);
		};
		document.addEventListener("visibilitychange", onVisibility);
		kickRef.current = () => {
			if (inFlight) kicked = true;
			else schedule(0);
		};
		void tick();

		return () => {
			alive = false;
			kickRef.current = () => {};
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [client, browserId]);

	const push = (next: BrowserState) => {
		if (currentRef.current !== next.browserId) return;
		setState(next);
		setLoading(false);
	};

	return {
		frame: frame?.state.browserId === browserId ? frame : null,
		state: state?.browserId === browserId ? state : null,
		error, loading, push,
		refresh: () => kickRef.current(),
	};
}
