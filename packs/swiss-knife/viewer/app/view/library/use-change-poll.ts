import { useEffect, useRef } from "react";

export function useChangePoll(read: (signal: AbortSignal) => Promise<string>, intervalMs: number, onChange: () => void): void {
	const changed = useRef(onChange);
	changed.current = onChange;
	useEffect(() => {
		const controller = new AbortController();
		let timer: number | undefined;
		let inFlight = false;
		let last: string | undefined;
		const tick = (): void => {
			window.clearTimeout(timer);
			if (controller.signal.aborted || inFlight) return;
			if (document.visibilityState === "hidden") {
				timer = window.setTimeout(tick, intervalMs);
				return;
			}
			inFlight = true;
			read(controller.signal)
				.then(
					next => {
						if (controller.signal.aborted) return;
						const moved = last !== undefined && next !== last;
						last = next;
						if (moved) changed.current();
					},
					() => undefined,
				)
				.finally(() => {
					inFlight = false;
					if (!controller.signal.aborted) timer = window.setTimeout(tick, intervalMs);
				});
		};
		document.addEventListener("visibilitychange", tick);
		tick();
		return () => {
			controller.abort();
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", tick);
		};
	}, [read, intervalMs]);
}
