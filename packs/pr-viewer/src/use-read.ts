import { useEffect, useState } from "react";

/** One request/response read, keyed: detail, threads and the diff are large and
 *  on demand, never a cell (doc 73 §3). A new `key` (a new ref, or a settled
 *  write) re-reads; `read === null` means this host cannot answer at all.
 *
 *  Stale-while-revalidate (dimension#902): a re-read over a painted value keeps
 *  the old value with `loading: true` so callers can dim it instead of swapping
 *  it for a spinner. Only a first-ever read (nothing painted yet) reports
 *  `value: null` with `loading: true`. An errored re-read still blanks to `null`
 *  so the error surfaces instead of a quietly stale number. */
export function useRead<T>(read: (() => Promise<T>) | null, key: string): { readonly value: T | null; readonly error: string | null; readonly loading: boolean } {
	const [state, setState] = useState<{ key: string; value: T | null; error: string | null; loading: boolean }>({ key, value: null, error: null, loading: read !== null });
	useEffect(() => {
		if (!read) return;
		let live = true;
		// Keep the painted value; mark loading so the caller dims it.
		setState(prev => ({ key, value: prev.value, error: null, loading: true }));
		read().then(
			value => live && setState({ key, value, error: null, loading: false }),
			error => live && setState({ key, value: null, error: error instanceof Error ? error.message : String(error), loading: false }),
		);
		return () => {
			live = false;
		};
	}, [key, read]);
	// Between the key change and the effect firing, the state still carries the
	// old key — report the stale value as loading rather than blanking it.
	if (state.key !== key) return { value: state.value, error: null, loading: read !== null };
	return state;
}
