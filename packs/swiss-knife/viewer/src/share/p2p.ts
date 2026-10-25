import { type AnnouncedShare, TUNNEL_NEVER_EXPIRES } from "@dimension/artifact-host/tunnel-protocol";
import { errorMessage } from "../../../src/library/errors";
import type { Library, ShareRow } from "../../../src/library/types";
import type { Fence } from "../fence";
import { P2P_HOST_ID } from "./hosts";
import { P2pServer } from "./p2p-server";
import type { P2pStore, TunnelCredentials } from "./p2p-store";
import { TunnelClient, type TunnelClientOptions, type TunnelSession } from "./tunnel";

const REGISTER_DEADLINE_MS = 15_000;

export interface RelaySettings {
	readonly baseUrl: string;
	readonly allowed: boolean;
}

export interface P2pRuntimeOptions {
	readonly library: Library;
	readonly fence: Fence;
	readonly store: P2pStore;
	readonly relay: () => Promise<RelaySettings>;
	readonly createSocket?: TunnelClientOptions["createSocket"];
	readonly reconnect?: TunnelClientOptions["reconnect"];
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export class P2pRuntime {
	readonly server: P2pServer;
	readonly #options: P2pRuntimeOptions;
	readonly #now: () => number;
	#tunnel: { readonly relayBase: string; readonly client: TunnelClient } | undefined;
	#credentials: TunnelCredentials | undefined;
	#holds = 0;
	#reconciling: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: P2pRuntimeOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.server = new P2pServer({
			library: options.library,
			fence: options.fence,
			store: options.store,
			now: this.#now,
			onVersionChange: () => this.#tunnel?.client.announce(),
		});
	}

	liveRows(): readonly ShareRow[] {
		return this.#options.library.shares.live().filter(row => row.host === P2P_HOST_ID);
	}

	#announced(): readonly AnnouncedShare[] {
		const baseUrl = this.#credentials?.baseUrl;
		return this.liveRows()
			.filter(row => row.baseUrl === baseUrl)
			.map(row => ({ id: row.id, comments: row.allowComments, expiresAt: row.expiresAt ?? TUNNEL_NEVER_EXPIRES, latest: row.version }));
	}

	async #clientFor(relayBase: string): Promise<TunnelClient> {
		if (this.#tunnel?.relayBase === relayBase) return this.#tunnel.client;
		await this.#tunnel?.client.stop();
		const stored = await this.#options.store.readTunnel();
		this.#credentials = stored?.relay === relayBase ? stored : undefined;
		const client = new TunnelClient({
			relayBase,
			credentials: () => this.#credentials,
			shares: () => this.#announced(),
			handle: request => this.server.handle(request),
			onRegistered: async session => {
				const credentials: TunnelCredentials = { relay: relayBase, tunnelId: session.tunnelId, token: session.token, baseUrl: session.baseUrl };
				if (this.#credentials?.token !== credentials.token || this.#credentials.tunnelId !== credentials.tunnelId) {
					await this.#options.store.writeTunnel(credentials);
				}
				this.#credentials = credentials;
			},
			onRefused: () => this.#voidCredentials(),
			...(this.#options.createSocket === undefined ? {} : { createSocket: this.#options.createSocket }),
			...(this.#options.reconnect === undefined ? {} : { reconnect: this.#options.reconnect }),
			...(this.#options.log === undefined ? {} : { log: this.#options.log }),
		});
		this.#tunnel = { relayBase, client };
		return client;
	}

	async #voidCredentials(): Promise<void> {
		const dead = this.#credentials?.baseUrl;
		this.#credentials = undefined;
		await this.#options.store.clearTunnel();
		const now = this.#now();
		for (const row of this.liveRows()) {
			if (row.baseUrl !== dead) continue;
			this.#options.library.shares.update(row.id, { revokedAt: now });
			await this.server.forget(row.id);
		}
	}

	async withTunnel<T>(work: (session: TunnelSession) => Promise<T>): Promise<T> {
		if (this.#closed) throw new Error("sharing is shutting down");
		const relay = await this.#options.relay();
		if (!relay.allowed) throw new Error("your administrator has turned off sharing from this computer");
		this.#holds++;
		try {
			const client = await this.#clientFor(relay.baseUrl);
			client.start();
			const session = await client.whenReady(AbortSignal.timeout(REGISTER_DEADLINE_MS));
			return await work(session);
		} finally {
			this.#holds--;
			void this.reconcile();
		}
	}

	reconcile(): Promise<void> {
		this.#reconciling = this.#reconciling.then(() => this.#reconcileOnce()).catch(error => this.#options.log?.(`sharing from this computer: ${errorMessage(error)}`));
		return this.#reconciling;
	}

	async #reconcileOnce(): Promise<void> {
		if (this.#closed) return;
		const relay = await this.#options.relay();
		const now = this.#now();
		const rows = this.liveRows();
		const needed = this.#holds > 0 || (relay.allowed && rows.some(row => row.expiresAt === undefined || row.expiresAt > now));
		if (needed) {
			const client = await this.#clientFor(relay.baseUrl);
			client.start();
			client.announce();
		} else {
			await this.#tunnel?.client.stop();
		}
		if (this.#holds > 0) return;
		const known = new Set(rows.map(row => row.id));
		for (const id of await this.#options.store.shareIds()) {
			if (!known.has(id)) await this.server.forget(id);
		}
	}

	announce(): void {
		this.#tunnel?.client.announce();
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.#reconciling;
		await this.#tunnel?.client.stop();
	}
}
