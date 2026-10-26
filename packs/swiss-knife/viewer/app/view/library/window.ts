export interface GridLayout {
	readonly minCellWidth: number;
	readonly rowHeight: number;
	readonly gap: number;
	readonly padding: number;
}

export interface GridGeometry {
	readonly columns: number;
	readonly cellWidth: number;
	readonly rowHeight: number;
	readonly rowCount: number;
	readonly totalHeight: number;
	readonly padding: number;
	readonly gap: number;
}

export interface RowRange {
	readonly first: number;
	readonly end: number;
}

export const GRID_LAYOUT: GridLayout = { minCellWidth: 168, rowHeight: 196, gap: 12, padding: 12 };
export const LIST_LAYOUT: GridLayout = { minCellWidth: Number.POSITIVE_INFINITY, rowHeight: 48, gap: 0, padding: 4 };
export const OVERSCAN_ROWS = 3;

export function gridGeometry(width: number, count: number, layout: GridLayout): GridGeometry {
	const inner = Math.max(0, width - layout.padding * 2);
	const columns = Number.isFinite(layout.minCellWidth) ? Math.max(1, Math.floor((inner + layout.gap) / (layout.minCellWidth + layout.gap))) : 1;
	const cellWidth = Math.max(0, (inner - layout.gap * (columns - 1)) / columns);
	const rowCount = Math.ceil(count / columns);
	const totalHeight = rowCount === 0 ? 0 : layout.padding * 2 + rowCount * layout.rowHeight + (rowCount - 1) * layout.gap;
	return { columns, cellWidth, rowHeight: layout.rowHeight, rowCount, totalHeight, padding: layout.padding, gap: layout.gap };
}

export function rowTop(row: number, geometry: GridGeometry): number {
	return geometry.padding + row * (geometry.rowHeight + geometry.gap);
}

export function visibleRows(scrollTop: number, viewportHeight: number, geometry: GridGeometry, overscan: number = OVERSCAN_ROWS): RowRange {
	if (geometry.rowCount === 0) return { first: 0, end: 0 };
	const stride = geometry.rowHeight + geometry.gap;
	const top = Math.max(0, scrollTop - geometry.padding);
	const bottom = Math.max(top, scrollTop + Math.max(0, viewportHeight) - geometry.padding);
	const firstSeen = Math.min(geometry.rowCount - 1, Math.floor(top / stride));
	const lastSeen = Math.min(geometry.rowCount - 1, Math.max(firstSeen, Math.ceil(bottom / stride) - 1));
	return { first: Math.max(0, firstSeen - overscan), end: Math.min(geometry.rowCount, lastSeen + 1 + overscan) };
}

export function itemRange(rows: RowRange, geometry: GridGeometry, count: number): RowRange {
	return { first: Math.min(count, rows.first * geometry.columns), end: Math.min(count, rows.end * geometry.columns) };
}

export function sameRange(a: RowRange, b: RowRange): boolean {
	return a.first === b.first && a.end === b.end;
}

export function revealScrollTop(index: number, scrollTop: number, viewportHeight: number, geometry: GridGeometry): number | null {
	const row = Math.floor(index / geometry.columns);
	const top = rowTop(row, geometry);
	const bottom = top + geometry.rowHeight;
	if (top - geometry.padding < scrollTop) return Math.max(0, top - geometry.padding);
	if (bottom + geometry.padding > scrollTop + viewportHeight) return Math.max(0, bottom + geometry.padding - viewportHeight);
	return null;
}

export type MoveKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";

export function moveSelection(index: number, key: MoveKey, columns: number, count: number, pageRows: number): number {
	if (count === 0) return -1;
	if (index < 0) return 0;
	const step: Record<MoveKey, number> = {
		ArrowLeft: -1,
		ArrowRight: 1,
		ArrowUp: -columns,
		ArrowDown: columns,
		Home: -index,
		End: count - 1 - index,
		PageUp: -columns * Math.max(1, pageRows),
		PageDown: columns * Math.max(1, pageRows),
	};
	return Math.min(count - 1, Math.max(0, index + step[key]));
}

export function wantsNextPage(end: number, loaded: number, hasNext: boolean, lookahead: number): boolean {
	return hasNext && end + lookahead >= loaded;
}
