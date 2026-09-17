// Everything in this instrument that WRITES: the two composers, the row menu
// and the link dialog. Each one hands its caller a plain value; the `act`
// intents themselves live where the review is known.

import { Button, Icon, Input, Textarea } from "@fraym/ui";
import { useMemo, useState } from "react";
import { parseLinkInput, type ReviewRef } from "./model";

/** Reply into a line thread, or flip its resolution. One field, one send;
 *  the settle re-reads the threads so the reply appears where it landed. */
export function ThreadWrite({
	resolved,
	onReply,
	onResolve,
}: {
	readonly resolved: boolean;
	readonly onReply: (body: string) => void;
	readonly onResolve: () => void;
}) {
	const [body, setBody] = useState("");
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-1.5 pl-1" data-slot="pr-viewer-thread-write">
			{open ? (
				<Textarea
					autoFocus
					value={body}
					rows={2}
					placeholder="Reply…"
					onChange={event => setBody(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Escape") setOpen(false);
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && body.trim()) {
							onReply(body.trim());
							setBody("");
							setOpen(false);
						}
					}}
				/>
			) : null}
			<span className="flex items-center gap-1.5">
				{open ? (
					<Button
						size="sm"
						disabled={!body.trim()}
						onClick={() => {
							onReply(body.trim());
							setBody("");
							setOpen(false);
						}}
					>
						Reply
					</Button>
				) : (
					<Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
						Reply
					</Button>
				)}
				<Button size="sm" variant="ghost" onClick={onResolve}>
					{resolved ? "Unresolve" : "Resolve"}
				</Button>
			</span>
		</div>
	);
}

/** The review's own composer: a comment, or a verdict with an optional body.
 *  Approve / Request changes confirm nothing — they are the reviewer's word,
 *  reversible on the host; Merge and Close stay behind the dialog. */
export function ReviewWrite({
	verdicts,
	onComment,
	onReview,
}: {
	readonly verdicts: boolean;
	readonly onComment: (body: string) => void;
	readonly onReview: (verdict: "approve" | "request-changes", body?: string) => void;
}) {
	const [body, setBody] = useState("");
	const send = (fn: () => void) => {
		fn();
		setBody("");
	};
	return (
		<div className="flex flex-col gap-2 border-fr-border border-t p-3" data-slot="pr-viewer-review-write">
			<Textarea
				value={body}
				rows={3}
				placeholder="Comment, or say why you approve or want changes…"
				onChange={event => setBody(event.target.value)}
				onKeyDown={event => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && body.trim()) send(() => onComment(body.trim()));
				}}
			/>
			<span className="flex flex-wrap items-center gap-1.5">
				<Button size="sm" variant="outline" disabled={!body.trim()} onClick={() => send(() => onComment(body.trim()))}>
					Comment
				</Button>
				{verdicts ? (
					<>
						<span className="flex-1" />
						<Button size="sm" variant="outline" disabled={!body.trim()} onClick={() => send(() => onReview("request-changes", body.trim()))}>
							Request changes
						</Button>
						<Button size="sm" onClick={() => send(() => onReview("approve", body.trim() || undefined))}>
							Approve
						</Button>
					</>
				) : null}
			</span>
		</div>
	);
}

export function RowMenu({ actions }: { readonly actions: readonly { readonly label: string; readonly onClick: () => void }[] }) {
	const [open, setOpen] = useState(false);
	return (
		<span className="relative">
			<Button size="icon" variant="ghost" aria-label="Row actions" onClick={() => setOpen(v => !v)}>
				<Icon name="dots" size={13} />
			</Button>
			{open ? (
				<span className="absolute right-0 z-10 mt-1 flex min-w-36 flex-col rounded-md border border-fr-border bg-fr-surface p-1 shadow-fr">
					{actions.map(action => (
						<button
							key={action.label}
							type="button"
							className="rounded-sm px-2 py-1 text-left text-fr-sm text-fr-text hover:bg-fr-surface-2"
							onClick={() => {
								setOpen(false);
								action.onClick();
							}}
						>
							{action.label}
						</button>
					))}
				</span>
			) : null}
		</span>
	);
}

export function LinkDialog({
	own,
	onSubmit,
	onClose,
}: {
	readonly own: { readonly provider: string; readonly host: string; readonly repository: string } | null;
	readonly onSubmit: (ref: ReviewRef, url: string) => void;
	readonly onClose: () => void;
}) {
	const [text, setText] = useState("");
	const parsed = useMemo(() => parseLinkInput(text, own), [text, own]);
	const reason =
		text.trim() === ""
			? null
			: parsed
				? null
				: /^#?\d+$/.test(text.trim())
					? "This checkout has no review host; paste a full URL."
					: "Paste a review URL, or #123 for this repository.";
	return (
		<div className="flex flex-col gap-2 border-fr-border border-b p-2">
			<Input
				autoFocus
				value={text}
				placeholder="https://… or #123"
				onChange={event => setText(event.target.value)}
				onKeyDown={event => {
					if (event.key === "Escape") onClose();
					if (event.key === "Enter" && parsed) onSubmit(parsed.ref, parsed.url);
				}}
			/>
			{reason ? <span className="text-fr-2xs text-fr-warn">{reason}</span> : null}
			<div className="flex justify-end gap-1">
				<Button size="sm" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button size="sm" disabled={!parsed} onClick={() => parsed && onSubmit(parsed.ref, parsed.url)}>
					Link to this session
				</Button>
			</div>
		</div>
	);
}
