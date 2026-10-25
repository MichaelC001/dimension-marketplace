export class ChunkCache {
	readonly #entries = new Map<string, Uint8Array>();
	readonly #capacityBytes: number;
	#bytes = 0;

	constructor(capacityBytes: number) {
		this.#capacityBytes = capacityBytes;
	}

	get(key: string): Uint8Array | undefined {
		const value = this.#entries.get(key);
		if (value === undefined) return undefined;
		this.#entries.delete(key);
		this.#entries.set(key, value);
		return value;
	}

	put(key: string, value: Uint8Array): void {
		const previous = this.#entries.get(key);
		if (previous !== undefined) this.#bytes -= previous.length;
		this.#entries.delete(key);
		this.#entries.set(key, value);
		this.#bytes += value.length;
		for (const [oldest, bytes] of this.#entries) {
			if (this.#bytes <= this.#capacityBytes || oldest === key) break;
			this.#entries.delete(oldest);
			this.#bytes -= bytes.length;
		}
	}

	dropWithPrefix(prefix: string): void {
		for (const [key, bytes] of this.#entries) {
			if (!key.startsWith(prefix)) continue;
			this.#entries.delete(key);
			this.#bytes -= bytes.length;
		}
	}
}
