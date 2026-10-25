import { Button } from "@fraym/ui/elements/button";
import { Checkbox } from "@fraym/ui/elements/checkbox";
import { Modal } from "@fraym/ui/elements/popover";
import { Icon } from "@fraym/ui/icons";
import { useEffect, useId, useState } from "react";
import type { DiscardOutcome, LibraryItem } from "../../../../src/library/types";
import { errorText, type LibraryTools } from "./library-tools";
import { liveShares } from "./query";

export const TRASH_NAME = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "Recycle Bin" : "Trash";

export interface DiscardDialogProps {
	readonly tools: LibraryTools;
	readonly item: LibraryItem;
	readonly onClose: () => void;
	readonly onDiscarded: (result: DiscardOutcome) => void;
}

export function DiscardDialog({ tools, item, onClose, onDiscarded }: DiscardDialogProps) {
	const [trash, setTrash] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const checkboxId = useId();
	const links = liveShares(item);

	useEffect(() => {
		let live = true;
		tools.discardDefault(item.id).then(
			value => {
				if (live) setTrash(previous => previous ?? value);
			},
			() => {
				if (live) setTrash(previous => previous ?? false);
			},
		);
		return () => {
			live = false;
		};
	}, [tools, item.id]);

	const confirm = (): void => {
		setBusy(true);
		setError(null);
		tools.discard(item.id, trash === true).then(onDiscarded, cause => {
			setBusy(false);
			setError(errorText(cause));
		});
	};

	return (
		<Modal role="alertdialog" aria-label="Discard artifact" onClose={busy ? () => undefined : onClose} trapFocus className="w-[min(460px,calc(100vw-32px))]">
			<div data-slot="library-discard" className="p-5">
				<div className="flex items-start gap-3.5">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-fr-del/35 bg-fr-del-bg text-fr-del">
						<Icon name="trash" size={20} strokeWidth={1.8} />
					</div>
					<div className="min-w-0 flex-1">
						<div className="text-fr-lg font-semibold text-fr-text">Discard “{item.title ?? item.name}”?</div>
						<p className="mt-1 text-fr-sm leading-5 text-fr-text-3">
							It leaves the library{links > 0 ? ` and its ${links === 1 ? "link stops working" : `${links} links stop working`} for everyone` : ""}. Recently discarded keeps it for 30 days so you can restore it.
						</p>
					</div>
				</div>
				<label htmlFor={checkboxId} className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-fr-border-soft bg-fr-surface-2 px-3 py-2.5 text-fr-sm text-fr-text-2">
					<Checkbox id={checkboxId} className="mt-0.5" checked={trash === true} disabled={trash === null || busy} onCheckedChange={value => setTrash(value === true)} />
					<span className="min-w-0">
						Also move the file to the {TRASH_NAME}
						<span className="block truncate text-fr-xs text-fr-text-3" title={item.path}>
							{item.path}
						</span>
					</span>
				</label>
				{error === null ? null : (
					<p role="alert" className="mt-3 text-fr-sm text-fr-del">
						{error}
					</p>
				)}
				<div className="mt-5 flex justify-end gap-2">
					<Button type="button" variant="outline" onClick={onClose} disabled={busy} autoFocus>
						Cancel
					</Button>
					<Button type="button" variant="destructive" onClick={confirm} loading={busy} disabled={trash === null}>
						Discard
					</Button>
				</div>
			</div>
		</Modal>
	);
}
