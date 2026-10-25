import { IconButton } from "@fraym/ui/elements/icon-button";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { FOCUS } from "../focus-ring";

const ITEM = '[role="menuitem"]:not(:disabled)';

export function MoreMenu({ label, children, className }: { readonly label: string; readonly children: ReactNode; readonly className?: string }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		root.current?.querySelector<HTMLElement>(`[role="menu"] ${ITEM}`)?.focus();
		const away = (event: PointerEvent): void => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		window.addEventListener("pointerdown", away, true);
		return () => window.removeEventListener("pointerdown", away, true);
	}, [open]);

	const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (!open) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			trigger.current?.focus();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const items = [...(root.current?.querySelectorAll<HTMLElement>(`[role="menu"] ${ITEM}`) ?? [])];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const step = event.key === "ArrowDown" ? 1 : -1;
		items[(at + step + items.length) % items.length]?.focus();
	};

	return (
		<div ref={root} className={cn("relative", className)} onKeyDown={onKey}>
			<IconButton ref={trigger} className={cn("size-7", FOCUS)} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} toggled={open} onClick={() => setOpen(value => !value)}>
				<Icon name="dots" size={16} strokeWidth={2.4} />
			</IconButton>
			{open ? (
				<div
					role="menu"
					aria-label={label}
					data-fr-enter="pop"
					onClick={() => setOpen(false)}
					className="absolute right-0 top-full z-50 mt-1 flex min-w-[208px] flex-col gap-px rounded-xl border border-fr-border bg-fr-surface p-1.5 shadow-[0_18px_60px_rgba(0,0,0,0.5)]"
				>
					{children}
				</div>
			) : null}
		</div>
	);
}

export function MenuSeparator() {
	return <div role="separator" className="mx-1 my-1 h-px bg-fr-border-soft" />;
}
