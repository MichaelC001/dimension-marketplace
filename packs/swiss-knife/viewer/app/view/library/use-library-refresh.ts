import { type Dispatch, useCallback, useEffect, useRef } from "react";
import type { LibraryTools } from "./library-tools";
import { type LibraryFilter, type ListAction, type ListState, reloadLoaded } from "./query";
import { useChangePoll } from "./use-change-poll";

export const REVISION_POLL_MS = 3000;

export function useLibraryRefresh(tools: LibraryTools, filter: LibraryFilter, list: ListState, dispatch: Dispatch<ListAction>, onMoved: () => void): void {
	const latest = useRef(filter);
	latest.current = filter;
	const running = useRef<AbortController | null>(null);
	const retry = useRef<number | undefined>(undefined);
	const { key, stale, phase, loadingMore, refreshing } = list;
	const loaded = list.items.length;
	const idle = key !== null && phase === "ready" && !loadingMore && !refreshing;

	const moved = useCallback((): void => {
		dispatch({ type: "stale" });
		onMoved();
	}, [dispatch, onMoved]);
	useChangePoll(tools.revision, REVISION_POLL_MS, moved);

	useEffect(
		() => () => {
			running.current?.abort();
			window.clearTimeout(retry.current);
		},
		[key],
	);

	useEffect(() => {
		if (!stale || !idle || key === null) return;
		const controller = new AbortController();
		running.current = controller;
		dispatch({ type: "refresh", key });
		reloadLoaded(args => tools.query(args, controller.signal), latest.current, loaded).then(
			page => dispatch({ type: "refreshed", key, page }),
			() => {
				dispatch({ type: "refreshed", key });
				if (!controller.signal.aborted) retry.current = window.setTimeout(() => dispatch({ type: "stale" }), REVISION_POLL_MS);
			},
		);
	}, [tools, dispatch, stale, idle, key, loaded]);
}
