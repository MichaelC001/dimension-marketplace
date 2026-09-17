import { useEffect, useState } from "react";

/** One request/response read, keyed: detail, threads and the diff are large and
 *  on demand, never a cell (doc 73 §3). A new `key` (a new ref, or a settled
 *  write) re-reads; `read === null` means this host cannot answer at all. */
export function useRead<T>(read: (() => Promise<T>) | null, key: string): { readonly value: T | null; readonly error: string | null; readonly loading: boolean } {
	const [state, setState] = useState<{ key: string; value: T | null; error: string | null; loading: boolean }>({ key, value: null, error: null, loading: read !== null });
	useEffect(() => {
		if (!read) return;
		let live = true;
		setState({ key, value: null, error: null, loading: true });
		read().then(
			value => live && setState({ key, value, error: null, loading: false }),
			error => live && setState({ key, value: null, error: error instanceof Error ? error.message : String(error), loading: false }),
		);
		return () => {
			live = false;
		};
	}, [key, read]);
	return state.key === key ? state : { value: null, error: null, loading: read !== null };
}
