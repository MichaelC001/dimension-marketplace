import { Button } from "@fraym/ui/elements/button";
import { Icon } from "@fraym/ui/icons";
import { useCopied } from "../use-copied";

export function CopyField({ text, label }: { readonly text: string; readonly label: string }) {
	const { copied, copy } = useCopied(text);
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-lg border border-fr-border bg-fr-surface-2 py-1 pl-3 pr-1">
			<code className="min-w-0 flex-1 truncate font-mono text-fr-xs text-fr-text" title={label}>
				{text}
			</code>
			<Button type="button" size="sm" variant="outline" onClick={copy} aria-label={copied ? `${label} copied` : `Copy ${label}`}>
				<Icon name={copied ? "check" : "copy"} size={12} />
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}
