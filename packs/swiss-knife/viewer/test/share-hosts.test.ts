import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { HostDirectory } from "../src/share/directory";
import { DEFAULT_RELAY_URL, HostConfigError, HostStore, normalizeBaseUrl, parsePairingLink } from "../src/share/hosts";
import { FakeHost, makeWorld, type World } from "./share-fixtures";

let world: World;
let host: FakeHost;
let relay: FakeHost;
let directory: HostDirectory;

beforeEach(async () => {
	world = await makeWorld();
	host = FakeHost.start({ uploadToken: "secret-token" });
	relay = FakeHost.start({ mode: "relay" });
	directory = new HostDirectory(new HostStore(world.home));
});

afterEach(async () => {
	host.stop();
	relay.stop();
	await world.cleanup();
});

describe("hosts.json managed by IT", () => {
	test("an approved-hosts policy shows only those hosts, hides this computer, and cannot be added to or edited from the UI", async () => {
		await world.writeHosts({
			relay: relay.baseUrl,
			policy: { only: ["corp"], p2p: false },
			hosts: [
				{ id: "corp", kind: "company", name: "Corp share", baseUrl: host.baseUrl, token: "secret-token", managed: true },
				{ id: "mine", kind: "self", name: "My VPS", baseUrl: host.baseUrl },
			],
		});
		const listing = await directory.list();
		expect(listing.p2pAllowed).toBe(false);
		expect(listing.hosts.map(entry => entry.id)).toEqual(["corp"]);
		expect(listing.hosts[0]).toMatchObject({ kind: "company", managed: true, status: "ok", oidc: false });
		expect(JSON.stringify(listing)).not.toContain("secret-token");
		await expect(directory.add({ url: host.baseUrl, token: "secret-token", kind: "self" })).rejects.toThrow("administrator");
		await expect(directory.remove("corp")).rejects.toThrow("managed by your administrator");
		await expect(directory.resolve("mine")).rejects.toThrow("not available");
	});

	test("without a policy this computer comes first and a lone p2p switch only turns it off", async () => {
		await world.writeHosts({ relay: relay.baseUrl, hosts: [{ id: "mine", kind: "self", name: "My VPS", baseUrl: host.baseUrl, token: "secret-token" }] });
		const open = await directory.list();
		expect(open.hosts.map(entry => entry.id)).toEqual(["p2p", "mine"]);
		expect(open.hosts[0]).toMatchObject({ kind: "p2p", status: "ok", oidc: false });
		await world.writeHosts({ relay: relay.baseUrl, policy: { p2p: false }, hosts: [{ id: "mine", kind: "self", name: "My VPS", baseUrl: host.baseUrl, token: "secret-token" }] });
		expect((await directory.list()).hosts.map(entry => entry.id)).toEqual(["mine"]);
	});
});

describe("adding your own server", () => {
	test("a pairing link is verified against the server, saved privately, and the token never leaves hosts.json", async () => {
		const added = await directory.add({ pairing: `${host.baseUrl}/pair#t=secret-token`, kind: "company" });
		expect(added).toMatchObject({ kind: "company", name: "Fake host", status: "ok", managed: false });
		expect(JSON.stringify(await directory.list())).not.toContain("secret-token");
		const path = join(world.home, "artifacts", "hosts.json");
		expect(await readFile(path, "utf8")).toContain("secret-token");
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
		await directory.remove(added.id);
		expect((await directory.list()).hosts.map(entry => entry.id)).not.toContain(added.id);
	});

	test("refuses a wrong token, a relay-only address, a malformed link and plain http", async () => {
		await expect(directory.add({ url: host.baseUrl, token: "wrong", kind: "self" })).rejects.toThrow("did not accept the token");
		await expect(directory.add({ url: host.baseUrl, kind: "self" })).rejects.toThrow("needs an upload token");
		await expect(directory.add({ url: relay.baseUrl, kind: "self" })).rejects.toThrow("relay");
		expect(() => parsePairingLink("https://share.example.com/somewhere")).toThrow("pairing link");
		expect(() => normalizeBaseUrl("http://share.example.com")).toThrow("https");
		expect(normalizeBaseUrl("https://share.example.com/base/")).toBe("https://share.example.com/base");
	});
});

describe("Dimension cloud, the built-in relay when it also stores shares", () => {
	let cloud: FakeHost;
	const mine = () => ({ id: "mine", kind: "self", name: "My VPS", baseUrl: host.baseUrl, token: "secret-token" });
	const viaDefaultRelay = (target: string) => ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(String(input).replace(DEFAULT_RELAY_URL, target), init)) as typeof fetch;
	const directoryOver = (target: string) => new HostDirectory(new HostStore(world.home), { fetch: viaDefaultRelay(target) });

	beforeEach(() => {
		cloud = FakeHost.start({ mode: "host", policy: { maxBytes: 5 * 2 ** 30 } });
	});

	afterEach(() => {
		cloud.stop();
	});

	test("is offered right after this computer as Dimension cloud, with the relay's limits and no token, however the built-in address is written", async () => {
		const sameServer = { id: "same", kind: "self", name: "Same server", baseUrl: DEFAULT_RELAY_URL, token: "secret-token" };
		for (const [label, relayField] of [
			["relay unset", {}],
			["relay written with a trailing slash", { relay: `${DEFAULT_RELAY_URL}/` }],
		] as const) {
			await world.writeHosts({ ...relayField, hosts: [mine(), sameServer] });
			const over = directoryOver(cloud.baseUrl);
			const listing = await over.list();
			expect(listing.hosts.map(entry => entry.id), label).toEqual(["p2p", "cloud", "mine", "same"]);
			expect(listing.hosts[1], label).toMatchObject({ kind: "dimension", name: "Dimension cloud", baseUrl: DEFAULT_RELAY_URL, status: "ok", managed: false, policy: { maxBytes: 5 * 2 ** 30 } });
			const resolved = await over.resolve("cloud");
			expect(resolved.host, label).toMatchObject({ id: "cloud", kind: "dimension", name: "Dimension cloud", baseUrl: DEFAULT_RELAY_URL });
			expect(resolved.host.token, label).toBeUndefined();
			expect(resolved.client.baseUrl, label).toBe(DEFAULT_RELAY_URL);
			expect(resolved.discovery.mode, label).toBe("host");
			expect((await over.resolve("same")).host.token, label).toBe("secret-token");
		}
	});

	test("is not offered when sharing goes through another relay, even one that stores shares, or through a relay that stores nothing", async () => {
		await world.writeHosts({ relay: cloud.baseUrl, hosts: [mine()] });
		const custom = directoryOver(cloud.baseUrl);
		const customListing = await custom.list();
		expect(customListing.hosts.map(entry => entry.id)).toEqual(["p2p", "mine"]);
		expect(customListing.cloudAllowed).toBe(false);
		await expect(custom.resolve("cloud")).rejects.toThrow("another relay");
		await world.writeHosts({ hosts: [mine()] });
		const relayOnly = directoryOver(relay.baseUrl);
		const relayOnlyListing = await relayOnly.list();
		expect(relayOnlyListing.hosts.map(entry => entry.id)).toEqual(["p2p", "mine"]);
		expect(relayOnlyListing.cloudAllowed).toBe(true);
		await expect(relayOnly.resolve("cloud")).rejects.toThrow("not available yet");
	});

	test("the administrator's policy decides whether cloud is offered, and listing and using it never disagree", async () => {
		const rows: { readonly name: string; readonly policy?: { only?: string[]; p2p?: boolean }; readonly listed: string[]; readonly offered: boolean }[] = [
			{ name: "no policy", listed: ["p2p", "cloud", "mine"], offered: true },
			{ name: "this computer switched on", policy: { p2p: true }, listed: ["p2p", "cloud", "mine"], offered: true },
			{ name: "this computer switched off takes cloud with it", policy: { p2p: false }, listed: ["mine"], offered: false },
			{ name: "approved servers that leave cloud out", policy: { only: ["mine"] }, listed: ["mine"], offered: false },
			{ name: "approved servers that name only cloud", policy: { only: ["cloud"] }, listed: ["cloud"], offered: true },
			{ name: "approved servers naming cloud and a server", policy: { only: ["cloud", "mine"] }, listed: ["cloud", "mine"], offered: true },
			{ name: "approved cloud with this computer switched on", policy: { only: ["cloud"], p2p: true }, listed: ["p2p", "cloud"], offered: true },
			{ name: "approved cloud with this computer switched off", policy: { only: ["cloud"], p2p: false }, listed: [], offered: false },
		];
		for (const row of rows) {
			await world.writeHosts({ ...(row.policy === undefined ? {} : { policy: row.policy }), hosts: [mine()] });
			const over = directoryOver(cloud.baseUrl);
			const listing = await over.list();
			expect(listing.hosts.map(entry => entry.id), row.name).toEqual(row.listed);
			expect(listing.cloudAllowed, row.name).toBe(row.offered);
			if (row.offered) expect((await over.resolve("cloud")).host.id, row.name).toBe("cloud");
			else await expect(over.resolve("cloud"), row.name).rejects.toThrow("administrator");
		}
	});

	test("a host that was down is asked again on the next listing instead of staying down", async () => {
		let reachable = false;
		const flaky = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => (reachable ? viaDefaultRelay(cloud.baseUrl)(input, init) : Promise.reject(new TypeError("connection refused")))) as typeof fetch;
		const over = new HostDirectory(new HostStore(world.home), { fetch: flaky });
		await world.writeHosts({ hosts: [mine()] });
		expect((await over.list()).hosts.map(entry => `${entry.id}:${entry.status}`)).toEqual(["p2p:unreachable", "mine:unreachable"]);
		await expect(over.resolve("cloud")).rejects.toThrow("not reachable");
		reachable = true;
		expect((await over.list()).hosts.map(entry => `${entry.id}:${entry.status}`)).toEqual(["p2p:ok", "cloud:ok", "mine:ok"]);
	});
});

describe("hosts.json ids", () => {
	test("p2p and cloud are reserved for the built-in places and cannot name a stored server", async () => {
		const store = new HostStore(world.home);
		for (const id of ["p2p", "cloud"]) {
			await world.writeHosts({ hosts: [{ id, kind: "self", name: "Imposter", baseUrl: host.baseUrl }] });
			await expect(store.read(), id).rejects.toThrow("reserved");
		}
		await world.writeHosts({ hosts: [{ id: "cloud-2", kind: "self", name: "Fine", baseUrl: host.baseUrl }] });
		expect((await store.read()).hosts.map(entry => entry.id)).toEqual(["cloud-2"]);
	});
});
