import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import {
	GRID_LAYOUT,
	type GridGeometry,
	gridGeometry,
	itemRange,
	LIST_LAYOUT,
	type MoveKey,
	moveSelection,
	revealScrollTop,
	type RowRange,
	rowTop,
	sameRange,
	visibleRows,
} from "./window";

export type LibraryLayout = "grid" | "list";

export interface LibraryGridProps {
	readonly items: readonly LibraryItem[];
	readonly layout: LibraryLayout;
	readonly selectedIndex: number;
	readonly label: string;
	readonly footer: ReactNode;
	readonly renderItem: (item: LibraryItem, index: number, selected: boolean) => ReactNode;
	readonly onSelect: (index: number) => void;
	readonly onOpen: (index: number) => void;
	readonly onKey: (key: "s" | "Delete" | "Escape", index: number) => void;
	readonly onRange: (mounted: RowRange, seen: RowRange, geometry: GridGeometry) => void;
}

const MOVE_KEYS: Record<string, MoveKey> = {
	ArrowLeft: "ArrowLeft",
	ArrowRight: "ArrowRight",
	ArrowUp: "ArrowUp",
	ArrowDown: "ArrowDown",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
};

export const OPTION_ID_PREFIX = "library-item-";

export function LibraryGrid({ items, layout, selectedIndex, label, footer, renderItem, onSelect, onOpen, onKey, onRange }: LibraryGridProps) {
	const scroller = useRef<HTMLDivElement>(null);
	const frame = useRef(0);
	const [box, setBox] = useState({ width: 0, height: 0 });
	const [rows, setRows] = useState<RowRange>({ first: 0, end: 0 });
	const geometry = useMemo(() => gridGeometry(box.width, items.length, layout === "grid" ? GRID_LAYOUT : LIST_LAYOUT), [box.width, items.length, layout]);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element === null) return;
		const measure = (): void => {
			setBox(previous => (previous.width === element.clientWidth && previous.height === element.clientHeight ? previous : { width: element.clientWidth, height: element.clientHeight }));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const sync = useCallback((): void => {
		const element = scroller.current;
		if (element === null) return;
		const next = visibleRows(element.scrollTop, box.height, geometry);
		setRows(previous => (sameRange(previous, next) ? previous : next));
	}, [box.height, geometry]);

	useLayoutEffect(sync, [sync]);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);

	const onScroll = (): void => {
		if (frame.current !== 0) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = 0;
			sync();
		});
	};

	const onRangeRef = useRef(onRange);
	onRangeRef.current = onRange;
	useEffect(() => {
		const seenRows = visibleRows(scroller.current?.scrollTop ?? 0, box.height, geometry, 0);
		onRangeRef.current(itemRange(rows, geometry, items.length), itemRange(seenRows, geometry, items.length), geometry);
	}, [rows, geometry, items, box.height]);

	const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;
	const selectedId = selectedItem?.id;
	const reveal = useRef({ geometry, height: box.height, sync, index: selectedIndex });
	reveal.current = { geometry, height: box.height, sync, index: selectedIndex };
	const measured = box.height > 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a reveal follows the selected row and the first measure only; paging, resizes and rows moving under the selection must not pull the scroll back to it.
	useLayoutEffect(() => {
		const element = scroller.current;
		const { geometry: shape, height, sync: resync, index } = reveal.current;
		if (element === null || selectedId === undefined || height === 0) return;
		const top = revealScrollTop(index, element.scrollTop, height, shape);
		if (top !== null) {
			element.scrollTop = top;
			resync();
		}
	}, [selectedId, measured]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
		const move = MOVE_KEYS[event.key];
		if (move !== undefined) {
			event.preventDefault();
			const pageRows = Math.max(1, Math.floor(box.height / (geometry.rowHeight + geometry.gap)));
			const next = moveSelection(selectedIndex, move, geometry.columns, items.length, pageRows);
			if (next >= 0) onSelect(next);
			return;
		}
		if (event.key === "Enter" && selectedIndex >= 0) {
			event.preventDefault();
			onOpen(selectedIndex);
			return;
		}
		if (event.key === "s" || event.key === "Delete" || event.key === "Escape") {
			event.preventDefault();
			onKey(event.key, selectedIndex);
		}
	};

	const cells: ReactNode[] = [];
	const range = itemRange(rows, geometry, items.length);
	for (let index = range.first; index < range.end; index++) {
		const item = items[index];
		if (item === undefined) continue;
		const row = Math.floor(index / geometry.columns);
		const column = index - row * geometry.columns;
		const selected = index === selectedIndex;
		cells.push(
			<div
				key={item.id}
				id={`${OPTION_ID_PREFIX}${item.id}`}
				role="option"
				aria-selected={selected}
				aria-posinset={index + 1}
				aria-setsize={items.length}
				data-index={index}
				className="absolute"
				style={{
					top: rowTop(row, geometry),
					left: geometry.padding + column * (geometry.cellWidth + geometry.gap),
					width: geometry.cellWidth,
					height: geometry.rowHeight,
				}}
				onClick={() => {
					onSelect(index);
					onOpen(index);
				}}
			>
				{renderItem(item, index, selected)}
			</div>,
		);
	}

	return (
		<div
			ref={scroller}
			role="listbox"
			aria-label={label}
			aria-activedescendant={selectedItem !== undefined && selectedIndex >= range.first && selectedIndex < range.end ? `${OPTION_ID_PREFIX}${selectedItem.id}` : undefined}
			tabIndex={0}
			data-slot="library-grid"
			data-layout={layout}
			onScroll={onScroll}
			onKeyDown={onKeyDown}
			className="relative h-full min-h-0 overflow-y-auto overscroll-contain [contain:strict] focus-visible:outline-none"
		>
			<div className="relative w-full" style={{ height: geometry.totalHeight }}>
				{cells}
			</div>
			{footer}
		</div>
	);
}
