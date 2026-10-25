import { Button } from "@fraym/ui/elements/button";
import { Input } from "@fraym/ui/elements/input";
import { Modal } from "@fraym/ui/elements/popover";
import { type FormEvent, useState } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import { errorText, type LibraryTools } from "./library-tools";

export interface AddFileDialogProps {
	readonly tools: LibraryTools;
	readonly onClose: () => void;
	readonly onAdded: (item: LibraryItem) => void;
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export function unquotePath(text: string): string {
	const trimmed = text.trim();
	const quoted = /^(["'])(.*)\1$/.exec(trimmed);
	return quoted?.[2] ?? trimmed;
}

export function AddFileDialog({ tools, onClose, onAdded }: AddFileDialogProps) {
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const clean = unquotePath(path);
	const absolute = ABSOLUTE_PATH.test(clean);

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (!absolute || busy) return;
		setBusy(true);
		setError(null);
		tools.stamp(clean).then(onAdded, cause => {
			setBusy(false);
			setError(errorText(cause));
		});
	};

	return (
		<Modal aria-label="Add a file to the library" onClose={busy ? () => undefined : onClose} trapFocus className="w-[min(520px,calc(100vw-32px))]">
			<form data-slot="library-add" onSubmit={submit} className="p-5">
				<div className="text-fr-lg font-semibold text-fr-text">Add a file</div>
				<p className="mt-1 text-fr-sm leading-5 text-fr-text-3">Paste the file’s full path. The library links to it where it is; nothing is copied.</p>
				<Input
					autoFocus
					className="mt-4 font-mono"
					placeholder={"C:\\Users\\you\\Videos\\demo.mp4  or  /Users/you/report.pdf"}
					value={path}
					onChange={event => setPath(event.target.value)}
					aria-invalid={path !== "" && !absolute}
					spellCheck={false}
				/>
				{path !== "" && !absolute ? <p className="mt-2 text-fr-xs text-fr-text-3">That is not a full path; it should start with a drive letter or a slash.</p> : null}
				{error === null ? null : (
					<p role="alert" className="mt-2 text-fr-sm text-fr-del">
						{error}
					</p>
				)}
				<div className="mt-5 flex justify-end gap-2">
					<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button type="submit" loading={busy} disabled={!absolute}>
						Add to library
					</Button>
				</div>
			</form>
		</Modal>
	);
}
