import type { Library } from "../../../src/library/types";
import type { Fence } from "../fence";
import { CommentSync } from "./comments";
import { HostDirectory } from "./directory";
import { HostStore, p2pAllowed, relayUrlOf } from "./hosts";
import { P2pRuntime } from "./p2p";
import { P2pStore } from "./p2p-store";
import { ShareService } from "./shares";
import type { RetryOptions } from "./retry";
import type { TunnelClientOptions } from "./tunnel";

export const RECONCILE_INTERVAL_MS = 30_000;

export interface ShareRuntimeDeps {
	readonly library: Library;
	readonly fence: Fence;
	readonly home: string;
	readonly fetch?: typeof fetch;
	readonly retry?: RetryOptions;
	readonly createSocket?: TunnelClientOptions["createSocket"];
	readonly reconnect?: TunnelClientOptions["reconnect"];
	readonly reconcileIntervalMs?: number;
	readonly log?: (message: string) => void;
}

export interface ShareRuntime {
	readonly service: ShareService;
	readonly directory: HostDirectory;
	readonly p2p: P2pRuntime;
	readonly sync: CommentSync;
	reconcile(): void;
	close(): Promise<void>;
}

export function startShareRuntime(deps: ShareRuntimeDeps): ShareRuntime {
	const log = deps.log ?? ((message: string) => console.error(`share: ${message}`));
	const store = new HostStore(deps.home);
	const directory = new HostDirectory(store, { ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }), ...(deps.retry === undefined ? {} : { retry: deps.retry }) });
	const p2p = new P2pRuntime({
		library: deps.library,
		fence: deps.fence,
		store: new P2pStore(deps.home),
		relay: async () => {
			const file = await store.read();
			return { baseUrl: relayUrlOf(file), allowed: p2pAllowed(file) };
		},
		log,
		...(deps.createSocket === undefined ? {} : { createSocket: deps.createSocket }),
		...(deps.reconnect === undefined ? {} : { reconnect: deps.reconnect }),
	});
	const sync: CommentSync = new CommentSync({
		library: deps.library,
		log,
		onShareEnded: () => reconcile(),
		...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
	});
	const service = new ShareService({
		library: deps.library,
		fence: deps.fence,
		directory,
		p2p,
		sync,
		onSharesChanged: () => reconcile(),
		displayName: async () => (await store.read()).displayName,
	});

	function reconcile(): void {
		const now = Date.now();
		sync.reconcile(deps.library.shares.live().filter(row => row.expiresAt === undefined || row.expiresAt > now));
		void p2p.reconcile();
	}

	const timer = setInterval(reconcile, deps.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
	timer.unref();
	reconcile();

	return {
		service,
		directory,
		p2p,
		sync,
		reconcile,
		async close() {
			clearInterval(timer);
			service.close();
			await sync.close();
			await p2p.close();
		},
	};
}
