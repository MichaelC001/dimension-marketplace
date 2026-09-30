// The profile's building blocks: a titled section panel, one fact row in it
// (label on the left, the value or its editor on the right, stacked when the
// panel is narrow), the lock on a key only the user may change, and a chip
// picker for the capability lists.

import { Badge } from "@fraym/ui/elements/badge";
import { Input } from "@fraym/ui/elements/input";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { PANEL } from "./chrome";

/** The one width every single-line control in a panel shares (inputs, selects,
 *  the face picker, a chip picker's search). A text area takes the full width. */
export const FIELD = "w-full max-w-md";

/** One titled section of the profile: a panel holding a list of facts. Its
 *  title is the scale's heading-lg, two steps over a card's name. */
export function Panel({
	title,
	lede,
	wide = false,
	children,
}: {
	readonly title: string;
	readonly lede?: string;
	/** Spans both columns of the profile's grid. */
	readonly wide?: boolean;
	readonly children: ReactNode;
}) {
	const id = useId();
	return (
		<section aria-labelledby={id} data-slot="profile-panel" className={cn("@container/panel flex min-w-0 flex-col", PANEL, wide && "@4xl:col-span-2")}>
			<header className="flex min-w-0 flex-col gap-1 px-5 pt-5 pb-1">
				<h2 id={id} className="m-0 text-fr-xl leading-tight font-semibold text-fr-text">
					{title}
				</h2>
				{lede ? <p className="m-0 text-fr-xs leading-relaxed text-pretty text-fr-text-2">{lede}</p> : null}
			</header>
			<dl className="m-0 flex flex-col px-5 pt-1 pb-2">{children}</dl>
		</section>
	);
}

/** One fact: its label beside its value. `grant` puts the lock on a key only
 *  the user may change (the legend at the top of the profile says what it
 *  means); `proposed` marks a value the Machinist's pending proposal set;
 *  `tall` is for a value whose control has no text baseline of its own (the
 *  face picker leads with a face): its label sits on the control's centre line. */
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
				// Label and value share a first baseline, whatever the value is (text,
				// an input, a select, a row of chips), so no row needs its own nudge.
				"grid min-w-0 gap-2 border-t border-fr-border-soft py-4 first:border-t-0 @lg/panel:grid-cols-[10rem_minmax(0,1fr)] @lg/panel:items-baseline @lg/panel:gap-5",
				proposed && "-mx-3 rounded-lg border-transparent bg-fr-accent-dim px-3 [&+*]:border-t-transparent",
			)}
		>
			<dt className={cn("flex min-w-0 flex-wrap items-center gap-2 text-fr-sm font-medium text-fr-text", tall && "@lg/panel:self-start @lg/panel:pt-3")}>
				{label}
				{grant ? <GrantMark /> : null}
				{proposed ? (
					<Badge tone="accent" variant="soft">
						Proposed
					</Badge>
				) : null}
			</dt>
			<dd className="m-0 flex min-w-0 flex-col gap-2">
				{children}
				{hint ? <span className="text-fr-xs leading-relaxed text-pretty text-fr-text-2">{hint}</span> : null}
			</dd>
		</div>
	);
}

/** The lock: a key that GRANTS the agent something (doc 58 §3), which only the
 *  user changes, here, and the Machinist never proposes. Icon only; its name
 *  is spoken, and the profile's legend says it once in words. */
export function GrantMark() {
	return (
		<span data-slot="grant-mark" role="img" aria-label="Only you can change this" title="Only you can change this" className="inline-flex text-fr-text-3">
			<Icon name="lock" size={12} strokeWidth={2} aria-hidden="true" />
		</span>
	);
}

/** A read-only value whose setting lives in Advanced, and says so. */
export function HeldValue({ children }: { readonly children: ReactNode }) {
	return (
		<span className="text-fr-sm text-fr-text">
			{children} <span className="text-fr-xs text-fr-text-2">· set in Other settings, under Advanced</span>
		</span>
	);
}

/** A chip: an id in the machine face, or a name a person reads in the primary one. */
function chipClass(named: boolean): string {
	return cn(
		"inline-flex items-center gap-1 rounded-full border border-fr-border-soft bg-fr-surface-2 px-3 py-1 text-fr-xs leading-none text-fr-text",
		named ? "font-primary" : "font-secondary",
	);
}

/** A quiet list of values (read-only chips). `labelOf` names an id the way a
 *  person reads it; the id itself stays in the chip's tooltip. */
export function ChipList({
	values,
	empty,
	labelOf,
}: {
	readonly values: readonly string[];
	readonly empty: string;
	readonly labelOf?: (id: string) => string;
}) {
	if (values.length === 0) return <span className="text-fr-sm text-fr-text-2">{empty}</span>;
	return (
		<ul className="m-0 flex list-none flex-wrap gap-2 p-0">
			{values.map(value => (
				<li key={value} className={chipClass(labelOf !== undefined)} title={labelOf === undefined ? undefined : value}>
					{labelOf?.(value) ?? value}
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
 * own meaning (`empty`: "Every tool"), and the manifest omits the key.
 * Suggestions are the options not yet chosen that match what is typed; Enter
 * adds the first one, or the typed name itself when `free` (a tool no agent
 * uses yet).
 */
export function ChipPicker({
	label,
	noun,
	value,
	options,
	empty,
	labelOf,
	disabled = false,
	free = false,
	onChange,
}: {
	readonly label: string;
	/** What is added, as the search box says it: "tools", "MCP servers". */
	readonly noun: string;
	readonly value: readonly string[];
	readonly options: readonly ChipOption[];
	readonly empty: string;
	/** Names an id the way a person reads it (an agent's display name); the id
	 *  stays in the chip's tooltip. Absent, the chip is the id. */
	readonly labelOf?: (id: string) => string;
	readonly disabled?: boolean;
	readonly free?: boolean;
	readonly onChange: (next: string[]) => void;
}) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const listId = useId();
	const needle = query.trim().toLowerCase();
	const named = labelOf !== undefined;
	const nameOf = (id: string) => labelOf?.(id) ?? id;
	const suggestions = options
		.filter(option => !value.includes(option.id))
		.filter(
			option =>
				needle === "" ||
				option.id.toLowerCase().includes(needle) ||
				nameOf(option.id).toLowerCase().includes(needle) ||
				(option.hint ?? "").toLowerCase().includes(needle),
		)
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
			<ul aria-label={label} className="m-0 flex min-h-7 list-none flex-wrap items-center gap-2 p-0">
				{value.length === 0 ? (
					<li className="text-fr-sm text-fr-text-2">{empty}</li>
				) : (
					value.map(id => (
						<li key={id} className={cn(chipClass(named), !disabled && "pr-1")} title={named ? id : undefined}>
							{nameOf(id)}
							<button
								type="button"
								disabled={disabled}
								aria-label={`Remove ${nameOf(id)}`}
								onClick={() => onChange(value.filter(entry => entry !== id))}
								className="grid size-4 place-items-center rounded-full text-fr-text-3 fr-t-colors hover:bg-fr-surface-3 hover:text-fr-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line disabled:hidden"
							>
								<Icon name="x" size={10} strokeWidth={2.4} />
							</button>
						</li>
					))
				)}
			</ul>
			{disabled ? null : (
				<div className="flex min-w-0 flex-col gap-2">
					<div className={cn("relative", FIELD)}>
						<Icon name="search" size={13} strokeWidth={2} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fr-text-3" />
						<Input
							size="sm"
							value={query}
							placeholder={`Add ${noun}…`}
							aria-label={`Add ${noun}`}
							aria-controls={listId}
							aria-expanded={open}
							className="pl-8"
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
						<ul id={listId} className="m-0 flex list-none flex-wrap gap-2 p-0">
							{suggestions.map(option => (
								<li key={option.id}>
									<button
										type="button"
										title={named ? [option.id, option.hint].filter(Boolean).join(" · ") : option.hint}
										// Chosen on press, before the input's blur closes the list.
										onMouseDown={event => {
											event.preventDefault();
											add(option.id);
										}}
										className={cn(
											"inline-flex items-center gap-1 rounded-full border border-dashed border-fr-border px-3 py-1 text-fr-xs leading-none text-fr-text-2 fr-t-colors hover:border-fr-accent-line hover:text-fr-text",
											named ? "font-primary" : "font-secondary",
										)}
									>
										<Icon name="plus" size={10} strokeWidth={2.4} />
										{nameOf(option.id)}
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
