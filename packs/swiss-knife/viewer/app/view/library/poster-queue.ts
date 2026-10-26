export type PosterRun<T> = (item: T, signal: AbortSignal) => Promise<void>;

export class PosterQueue<T extends { readonly id: string }> {
	readonly #run: PosterRun<T>;
	#wanted: readonly T[] = [];
	readonly #settled: Record<string, true> = {};
	#current: { readonly id: string; readonly controller: AbortController } | null = null;
	#disposed = false;

	constructor(run: PosterRun<T>) {
		this.#run = run;
	}

	get running(): string | null {
		return this.#current?.id ?? null;
	}

	want(items: readonly T[]): void {
		if (this.#disposed) return;
		this.#wanted = items;
		const current = this.#current;
		if (current !== null && !items.some(item => item.id === current.id)) current.controller.abort();
		this.#pump();
	}

	dispose(): void {
		this.#disposed = true;
		this.#wanted = [];
		this.#current?.controller.abort();
	}

	#pump(): void {
		if (this.#disposed || this.#current !== null) return;
		const next = this.#wanted.find(item => this.#settled[item.id] === undefined);
		if (next === undefined) return;
		const controller = new AbortController();
		const current = { id: next.id, controller };
		this.#current = current;
		const finish = (): void => {
			if (!controller.signal.aborted) this.#settled[next.id] = true;
			if (this.#current === current) this.#current = null;
			this.#pump();
		};
		let started: Promise<void>;
		try {
			started = this.#run(next, controller.signal);
		} catch {
			finish();
			return;
		}
		void started.then(finish, finish);
	}
}
