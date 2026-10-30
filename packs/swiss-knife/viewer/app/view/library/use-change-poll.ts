import { useCallback, useEffect, useRef } from "react";
import { isOwnWrite, type RevisionSpan } from "../../../../src/library/revision";

export function useChangePoll(read: (signal: AbortSignal) => Promise<string>, intervalMs: number, onChange: () => void, active: boolean): (span: RevisionSpan) => void {
	const changed = useRef(onChange);
	changed.current = onChange;
	const listening = useRef(active);
	listening.current = active;
	const last = useRef<string | undefined>(undefined);
	const wake = useRef<() => void>(() => undefined);
	useEffect(() => {
		const controller = new AbortController();
		let timer: number | undefined;
		let inFlight = false;
		const tick = (): void => {
			window.clearTimeout(timer);
			if (controller.signal.aborted || inFlight) return;
			if (!listening.current || document.visibilityState === "hidden") {
				timer = window.setTimeout(tick, intervalMs);
				return;
			}
			inFlight = true;
			read(controller.signal)
				.then(
					next => {
						if (controller.signal.aborted) return;
						const moved = last.current !== undefined && next !== last.current;
						last.current = next;
						if (moved) changed.current();
					},
					() => undefined,
				)
				.finally(() => {
					inFlight = false;
					if (!controller.signal.aborted) timer = window.setTimeout(tick, intervalMs);
				});
		};
		wake.current = tick;
		document.addEventListener("visibilitychange", tick);
		tick();
		return () => {
			controller.abort();
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", tick);
		};
	}, [read, intervalMs]);

	useEffect(() => {
		if (active) wake.current();
	}, [active]);

	return useCallback((span: RevisionSpan): void => {
		if (isOwnWrite(span, last.current)) last.current = span.after;
	}, []);
}
