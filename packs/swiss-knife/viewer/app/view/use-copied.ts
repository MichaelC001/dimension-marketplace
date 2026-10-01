// Copy a string on demand and say so for a moment ("Path copied"). A copy that did not happen says nothing: the human
// is never told a path is on the clipboard when it is not.
import { useEffect, useRef, useState } from "react";
import { copyText } from "./copy";

export interface Copied {
	/** True for `holdMs` after a copy that worked. */
	readonly copied: boolean;
	readonly copy: () => void;
}

export function useCopied(text: string, holdMs = 1800): Copied {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const copy = (): void => {
		void copyText(text).then(ok => {
			if (!ok) return;
			setCopied(true);
			window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), holdMs);
		});
	};
	return { copied, copy };
}
