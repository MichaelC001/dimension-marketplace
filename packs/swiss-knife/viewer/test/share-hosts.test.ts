import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { HostDirectory } from "../src/share/directory";
import { HostStore, normalizeBaseUrl, parsePairingLink } from "../src/share/hosts";
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
