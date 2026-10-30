import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { useEffect, useRef } from "react";
import { FOCUS } from "../focus-ring";

const TOAST_MS = 5000;

/** A short word at the foot of the library or a document tab: dismissed by hand, or by itself after {@link TOAST_MS}. */
export function LibraryToast({ text, onDismiss }: { readonly text: string; readonly onDismiss: () => void }) {
	const dismiss = useRef(onDismiss);
	dismiss.current = onDismiss;
	useEffect(() => {
		const timer = window.setTimeout(() => dismiss.current(), TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [text]);
	return (
		<div role="status" className="absolute inset-x-0 bottom-3 z-40 mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-lg border border-fr-border bg-fr-surface px-3 py-2 text-fr-sm text-fr-text shadow-lg">
			<span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
			<button type="button" aria-label="Dismiss" onClick={onDismiss} className={cn("shrink-0 rounded-sm p-0.5 text-fr-text-3 hover:bg-fr-surface-3", FOCUS)}>
				<Icon name="x" size={12} />
			</button>
		</div>
	);
}
