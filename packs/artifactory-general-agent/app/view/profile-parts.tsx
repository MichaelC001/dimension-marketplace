// The profile's building blocks: a titled section card, one fact row in it
// (label on the left, the value or its editor on the right, stacked when the
// card is narrow), the "only you can change this" mark on a key that grants,
// and a chip picker for the capability lists.

import { Badge } from "@fraym/ui/elements/badge";
import { Input } from "@fraym/ui/elements/input";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";

/** One titled section of the profile: a bordered card holding a list of facts. */
export function Panel({
	title,
	lede,
	wide = false,
	aside,
	children,
}: {
	readonly title: string;
	readonly lede?: string;
	/** Spans both columns of the profile's grid. */
	readonly wide?: boolean;
	readonly aside?: ReactNode;
	readonly children: ReactNode;
}) {
	const id = useId();
	return (
		<section
			aria-labelledby={id}
			data-slot="profile-panel"
			className={cn("@container/panel flex min-w-0 flex-col rounded-xl border border-fr-border-soft bg-fr-surface/85", wide && "@4xl:col-span-2")}
		>
			<header className="flex items-start justify-between gap-4 px-5 pt-4.5 pb-1">
				<div className="flex min-w-0 flex-col gap-0.5">
					<h2 id={id} className="m-0 text-fr-md font-semibold text-fr-text">
						{title}
					</h2>
					{lede ? <p className="m-0 text-fr-xs leading-relaxed text-pretty text-fr-text-2">{lede}</p> : null}
				</div>
				{aside}
			</header>
			<dl className="m-0 flex flex-col px-5 pt-1 pb-2">{children}</dl>
		</section>
	);
}

/** One fact: its label (and, for a key that grants, who may change it) beside
 *  its value. `proposed` marks a value the Machinist's pending proposal set.
 *  `tall` is for a value whose control has no text baseline of its own (the
 *  vibr picker leads with a face): its label sits on the control's centre line. */
export function Fact({
	label,
	hint,
	grant = false,
	proposed = false,
	tall = false,
	children,
}: {
	readonly label: string;
	readonly hint?: ReactNode;
	readonly grant?: boolean;
	readonly proposed?: boolean;
	readonly tall?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<div
			data-slot="profile-fact"
			data-proposed={proposed || undefined}
			className={cn(
				// Label and value share a first baseline, whatever the value is — text,
				// an input, a select, a row of chips — so no row needs its own nudge.
				"grid min-w-0 gap-2 border-t border-fr-border-soft py-3.5 first:border-t-0 @lg/panel:grid-cols-[10rem_minmax(0,1fr)] @lg/panel:items-baseline @lg/panel:gap-5",
				proposed && "-mx-3 rounded-lg border-transparent bg-fr-accent-dim px-3 [&+*]:border-t-transparent",
			)}
		>
			<dt className={cn("flex min-w-0 flex-col gap-1", tall && "@lg/panel:self-start @lg/panel:pt-3.5")}>
				<span className="flex items-center gap-2 text-fr-sm font-medium text-fr-text">
					{label}
					{proposed ? (
						<Badge tone="accent" variant="soft">
							Proposed
						</Badge>
					) : null}
				</span>
				{grant ? <GrantMark /> : null}
			</dt>
			<dd className="m-0 flex min-w-0 flex-col gap-1.5">
				{children}
				{hint ? <span className="text-fr-xs leading-relaxed text-pretty text-fr-text-2">{hint}</span> : null}
			</dd>
		</div>
	);
}

/** A key that GRANTS the agent something (doc 58 §3): only a person changes it,
 *  here, never the Machinist by proposal. */
export function GrantMark() {
	return (
		<span data-slot="grant-mark" className="inline-flex items-center gap-1 text-fr-2xs text-fr-text-3">
			<Icon name="lock" size={11} strokeWidth={2} aria-hidden="true" />
			Only you can change this
		</span>
	);
}

/** A read-only value that says where it is set instead. */
export function HeldValue({ children }: { readonly children: ReactNode }) {
	return (
		<span className="text-fr-sm text-fr-text">
			{children} <span className="text-fr-xs text-fr-text-2">· set in Everything else, under Advanced</span>
		</span>
	);
}

/** A quiet list of values (read-only chips). */
export function ChipList({ values, empty }: { readonly values: readonly string[]; readonly empty: string }) {
	if (values.length === 0) return <span className="text-fr-sm text-fr-text-2">{empty}</span>;
	return (
		<ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
			{values.map(value => (
				<li key={value} className="rounded-full border border-fr-border-soft bg-fr-surface-2 px-2.5 py-0.5 font-secondary text-fr-xs text-fr-text">
					{value}
				</li>
			))}
		</ul>
	);
}

export interface ChipOption {
	readonly id: string;
	readonly hint?: string;
}

/**
 * A list of names as chips, with a search to add more. An empty list is its
 * own meaning (`empty`: "Every tool") — the manifest omits the key. Suggestions
 * are the options not yet chosen that match what is typed; Enter adds the first
 * one, or the typed name itself when `free` (a tool no agent uses yet).
 */
export function ChipPicker({
	label,
	value,
	options,
	empty,
	disabled = false,
	free = false,
	onChange,
}: {
	readonly label: string;
	readonly value: readonly string[];
	readonly options: readonly ChipOption[];
	readonly empty: string;
	readonly disabled?: boolean;
	readonly free?: boolean;
	readonly onChange: (next: string[]) => void;
}) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const listId = useId();
	const needle = query.trim().toLowerCase();
	const suggestions = options
		.filter(option => !value.includes(option.id))
		.filter(option => needle === "" || option.id.toLowerCase().includes(needle) || (option.hint ?? "").toLowerCase().includes(needle))
		.slice(0, 8);
	const add = (id: string) => {
		if (id === "" || value.includes(id)) return;
		onChange([...value, id]);
		setQuery("");
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			const first = suggestions[0]?.id;
			if (first !== undefined) add(first);
			else if (free && /^[\w.:/-]+$/.test(query.trim())) add(query.trim());
		} else if (event.key === "Backspace" && query === "" && value.length > 0) {
			onChange(value.slice(0, -1));
		} else if (event.key === "Escape") {
			setOpen(false);
		}
	};
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<ul aria-label={label} className="m-0 flex min-h-7 list-none flex-wrap items-center gap-1.5 p-0">
				{value.length === 0 ? (
					<li className="text-fr-sm text-fr-text-2">{empty}</li>
				) : (
					value.map(id => (
						<li
							key={id}
							className="inline-flex items-center gap-1 rounded-full border border-fr-border-soft bg-fr-surface-2 py-0.5 pr-1 pl-2.5 font-secondary text-fr-xs text-fr-text"
						>
							{id}
							<button
								type="button"
								disabled={disabled}
								aria-label={`Remove ${id}`}
								onClick={() => onChange(value.filter(entry => entry !== id))}
								className="grid size-4.5 place-items-center rounded-full text-fr-text-3 fr-t-colors hover:bg-fr-surface-3 hover:text-fr-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line disabled:hidden"
							>
								<Icon name="x" size={10} strokeWidth={2.4} />
							</button>
						</li>
					))
				)}
			</ul>
			{disabled ? null : (
				<div className="flex min-w-0 flex-col gap-1.5">
					<div className="relative max-w-80">
						<Icon name="search" size={13} strokeWidth={2} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fr-text-3" />
						<Input
							size="sm"
							value={query}
							placeholder={`Add ${label.toLowerCase()}…`}
							aria-label={`Add ${label.toLowerCase()}`}
							aria-controls={listId}
							aria-expanded={open}
							className="pl-7.5"
							onChange={event => {
								setQuery(event.target.value);
								setOpen(true);
							}}
							onFocus={() => setOpen(true)}
							onBlur={() => setOpen(false)}
							onKeyDown={onKeyDown}
						/>
					</div>
					{open && suggestions.length > 0 ? (
						<ul id={listId} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
							{suggestions.map(option => (
								<li key={option.id}>
									<button
										type="button"
										title={option.hint}
										// Chosen on press, before the input's blur closes the list.
										onMouseDown={event => {
											event.preventDefault();
											add(option.id);
										}}
										className="inline-flex items-center gap-1 rounded-full border border-dashed border-fr-border px-2.5 py-0.5 font-secondary text-fr-xs text-fr-text-2 fr-t-colors hover:border-fr-accent-line hover:text-fr-text"
									>
										<Icon name="plus" size={10} strokeWidth={2.4} />
										{option.id}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
			)}
		</div>
	);
}
