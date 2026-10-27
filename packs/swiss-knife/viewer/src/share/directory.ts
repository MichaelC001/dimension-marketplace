import { randomBytes } from "node:crypto";
import type { HostDiscovery, SharePolicy } from "@dimension/sdk/artifact-share";
import { errorMessage } from "../../../src/library/errors";
import { HostClient, type HostClientOptions, HostRequestError } from "./host-api";
import {
	additionRefusal,
	CLOUD_HOST_ID,
	cloudAllowed,
	DEFAULT_RELAY_URL,
	HostConfigError,
	type HostKind,
	type HostsFile,
	HostStore,
	normalizeBaseUrl,
	p2pAllowed,
	P2P_HOST_ID,
	parsePairingLink,
	relayUrlOf,
	type StoredHost,
	visibleHosts,
} from "./hosts";

export type HostStatus = "ok" | "unreachable" | "unauthorized";

export interface PublicHost {
	readonly id: string;
	readonly kind: "p2p" | HostKind;
	readonly name: string;
	readonly baseUrl: string;
	readonly status: HostStatus;
	readonly policy?: SharePolicy;
	readonly oidc: boolean;
	readonly managed: boolean;
}

export interface HostListing {
	readonly hosts: readonly PublicHost[];
	readonly p2pAllowed: boolean;
}

export type HostAddition = { readonly pairing: string; readonly kind: "self" | "company" } | { readonly url: string; readonly token?: string; readonly kind: "self" | "company" };

export interface ResolvedHost {
	readonly host: StoredHost;
	readonly client: HostClient;
	readonly discovery: HostDiscovery;
}

interface Probe {
	readonly status: HostStatus;
	readonly discovery?: HostDiscovery;
}

const PROBE_TTL_MS = 30_000;
const P2P_NAME = "From this computer";
const CLOUD_NAME = "Dimension cloud";

function cloudHost(file: HostsFile, discovery: HostDiscovery): StoredHost {
	const baseUrl = relayUrlOf(file);
	return { id: CLOUD_HOST_ID, kind: "dimension", name: baseUrl === DEFAULT_RELAY_URL ? CLOUD_NAME : discovery.name, baseUrl };
}

export interface DirectoryOptions extends HostClientOptions {
	readonly now?: () => number;
}

export class HostDirectory {
	readonly store: HostStore;
	readonly #options: DirectoryOptions;
	readonly #probes = new Map<string, { readonly at: number; readonly result: Promise<Probe> }>();

	constructor(store: HostStore, options: DirectoryOptions = {}) {
		this.store = store;
		this.#options = options;
	}

	#client(baseUrl: string): HostClient {
		return new HostClient(baseUrl, this.#options);
	}

	#probe(key: string, run: () => Promise<Probe>): Promise<Probe> {
		const now = (this.#options.now ?? Date.now)();
		const cached = this.#probes.get(key);
		if (cached !== undefined && now - cached.at < PROBE_TTL_MS) return cached.result;
		const result = run();
		this.#probes.set(key, { at: now, result });
		return result;
	}

	async #probeHost(host: StoredHost): Promise<Probe> {
		const client = this.#client(host.baseUrl);
		let discovery: HostDiscovery;
		try {
			discovery = await client.discovery();
		} catch {
			return { status: "unreachable" };
		}
		try {
			await client.ping(host.token);
		} catch (error) {
			if (error instanceof HostRequestError && (error.status === 401 || error.status === 403)) return { status: "unauthorized", discovery };
			return { status: "unreachable", discovery };
		}
		return { status: "ok", discovery };
	}

	async list(): Promise<HostListing> {
		const file = await this.store.read();
		const allowed = p2pAllowed(file);
		const cloud = cloudAllowed(file);
		const relayBase = relayUrlOf(file);
		const stored = visibleHosts(file);
		const [relay, ...probes] = await Promise.all([
			allowed || cloud ? this.#probe(`p2p:${relayBase}`, () => this.#probeRelay(relayBase)) : Promise.resolve<Probe>({ status: "unreachable" }),
			...stored.map(host => this.#probe(`${host.id}:${host.baseUrl}:${host.token ?? ""}`, () => this.#probeHost(host))),
		]);
		const hosts: PublicHost[] = [];
		if (allowed) {
			hosts.push({
				id: P2P_HOST_ID,
				kind: "p2p",
				name: P2P_NAME,
				baseUrl: relayBase,
				status: relay?.status ?? "unreachable",
				...(relay?.discovery === undefined ? {} : { policy: relay.discovery.policy }),
				oidc: false,
				managed: false,
			});
		}
		if (cloud && relay?.discovery?.mode === "host") {
			const host = cloudHost(file, relay.discovery);
			hosts.push({ ...host, status: relay.status, policy: relay.discovery.policy, oidc: relay.discovery.auth.oidc !== undefined, managed: false });
		}
		stored.forEach((host, index) => {
			const probe = probes[index];
			hosts.push({
				id: host.id,
				kind: host.kind,
				name: host.name,
				baseUrl: host.baseUrl,
				status: probe?.status ?? "unreachable",
				...(probe?.discovery === undefined ? {} : { policy: probe.discovery.policy }),
				oidc: probe?.discovery?.auth.oidc !== undefined,
				managed: host.managed === true,
			});
		});
		return { hosts, p2pAllowed: allowed };
	}

	async #probeRelay(relayBase: string): Promise<Probe> {
		try {
			return { status: "ok", discovery: await this.#client(relayBase).discovery() };
		} catch {
			return { status: "unreachable" };
		}
	}

	async resolve(hostId: string): Promise<ResolvedHost> {
		const file = await this.store.read();
		if (hostId === CLOUD_HOST_ID) return this.#resolveCloud(file);
		const host = visibleHosts(file).find(entry => entry.id === hostId);
		if (host === undefined) throw new HostConfigError("that server is not available to you");
		const client = this.#client(host.baseUrl);
		let discovery: HostDiscovery;
		try {
			discovery = await client.discovery();
		} catch (error) {
			throw new HostConfigError(`${host.name} is not reachable right now: ${errorMessage(error)}`);
		}
		return { host, client, discovery };
	}

	async #resolveCloud(file: HostsFile): Promise<ResolvedHost> {
		if (!cloudAllowed(file)) throw new HostConfigError("your administrator limits sharing to approved servers, so Dimension cloud is not available");
		const client = this.#client(relayUrlOf(file));
		let discovery: HostDiscovery;
		try {
			discovery = await client.discovery();
		} catch (error) {
			throw new HostConfigError(`${CLOUD_NAME} is not reachable right now: ${errorMessage(error)}`);
		}
		if (discovery.mode !== "host") throw new HostConfigError(`${CLOUD_NAME} is not available yet`);
		return { host: cloudHost(file, discovery), client, discovery };
	}

	async resolveRelay(): Promise<{ readonly baseUrl: string; readonly client: HostClient; readonly discovery: HostDiscovery }> {
		const file = await this.store.read();
		if (!p2pAllowed(file)) throw new HostConfigError("your administrator has turned off sharing from this computer");
		const baseUrl = relayUrlOf(file);
		const client = this.#client(baseUrl);
		try {
			return { baseUrl, client, discovery: await client.discovery() };
		} catch (error) {
			throw new HostConfigError(`the relay that makes links from this computer reachable is not available right now: ${errorMessage(error)}`);
		}
	}

	async add(input: HostAddition): Promise<PublicHost> {
		const refusal = additionRefusal(await this.store.read());
		if (refusal !== undefined) throw new HostConfigError(refusal);
		const target =
			"pairing" in input
				? { ...parsePairingLink(input.pairing), kind: input.kind }
				: { baseUrl: normalizeBaseUrl(input.url), token: input.token?.trim() || undefined, kind: input.kind };
		const client = this.#client(target.baseUrl);
		const discovery = await client.discovery().catch((error: unknown) => {
			throw new HostConfigError(`${target.baseUrl} is not reachable: ${errorMessage(error)}`);
		});
		if (discovery.mode !== "host") throw new HostConfigError("that address is a relay for sharing from a computer; it does not store shares, so it cannot be used as your server");
		try {
			await client.ping(target.token);
		} catch (error) {
			if (error instanceof HostRequestError && (error.status === 401 || error.status === 403)) {
				throw new HostConfigError(target.token === undefined ? "that server needs an upload token; paste the pairing link or the token" : "that server did not accept the token");
			}
			throw new HostConfigError(`${discovery.name} did not answer the connection check: ${errorMessage(error)}`);
		}
		const stored = await this.store.add({
			id: `h_${randomBytes(5).toString("hex")}`,
			kind: target.kind,
			name: discovery.name,
			baseUrl: target.baseUrl,
			...(target.token === undefined ? {} : { token: target.token }),
		});
		this.#probes.clear();
		return {
			id: stored.id,
			kind: stored.kind,
			name: stored.name,
			baseUrl: stored.baseUrl,
			status: "ok",
			policy: discovery.policy,
			oidc: discovery.auth.oidc !== undefined,
			managed: stored.managed === true,
		};
	}

	async remove(id: string): Promise<void> {
		await this.store.remove(id);
		this.#probes.clear();
	}
}
