import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialStore, SlackSignInError, TOKEN_ENDPOINT } from "../credential";

const NOW = 1_800_000_000_000;
const TWELVE_HOURS_MS = 43_200_000;

let dir: string;
let path: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "slack-user-credential-"));
	path = join(dir, "token.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function save(credential: object): Promise<void> {
	await writeFile(path, JSON.stringify(credential));
}

async function saved(): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf-8"));
}

function tokenEndpoint(answer: (form: URLSearchParams, call: number) => object) {
	const calls: URLSearchParams[] = [];
	const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		expect(String(input)).toBe(TOKEN_ENDPOINT);
		const form = new URLSearchParams(String(init?.body));
		calls.push(form);
		return Response.json(answer(form, calls.length));
	}) as typeof fetch;
	return { fetcher, calls };
}

const renewed = (access: string, refresh: string, expiresIn = 43_200) => ({
	ok: true,
	access_token: access,
	refresh_token: refresh,
	expires_in: expiresIn,
});

test("a token with no refresh token is used as is even when its stored expiry has passed", async () => {
	await save({ access: "xoxp-forever", refresh: "", expires: NOW - 1, clientId: "1.2" });
	const { fetcher, calls } = tokenEndpoint(() => ({ ok: false, error: "never_called" }));
	const store = createCredentialStore({ path, fetch: fetcher, now: () => NOW });

	expect(await store.accessToken()).toBe("xoxp-forever");
	expect(calls).toHaveLength(0);
});

test("a token far from expiry is returned without asking Slack", async () => {
	await save({ access: "xoxe.fresh", refresh: "xoxe-1-r", expires: NOW + TWELVE_HOURS_MS, clientId: "1.2" });
	const { fetcher, calls } = tokenEndpoint(() => ({ ok: false, error: "never_called" }));
	const store = createCredentialStore({ path, fetch: fetcher, now: () => NOW });

	expect(await store.accessToken()).toBe("xoxe.fresh");
	expect(calls).toHaveLength(0);
});

test("a token inside the refresh window is renewed and the rotated refresh token is saved with the rest of the credential", async () => {
	await save({
		provider: "slack",
		access: "xoxe.old",
		refresh: "xoxe-1-old",
		expires: NOW + 30_000,
		clientId: "1.2",
		scopes: ["chat:write"],
	});
	const { fetcher, calls } = tokenEndpoint(() => renewed("xoxe.new", "xoxe-1-new"));
	const store = createCredentialStore({ path, fetch: fetcher, now: () => NOW });

	expect(await store.accessToken()).toBe("xoxe.new");
	expect(Object.fromEntries(calls[0] ?? [])).toEqual({
		grant_type: "refresh_token",
		refresh_token: "xoxe-1-old",
		client_id: "1.2",
	});
	expect(await saved()).toEqual({
		provider: "slack",
		access: "xoxe.new",
		refresh: "xoxe-1-new",
		expires: NOW + TWELVE_HOURS_MS,
		clientId: "1.2",
		scopes: ["chat:write"],
	});
	expect(await readdir(dir)).toEqual(["token.json"]);
});

test("a client secret saved at connect time is sent on renewal", async () => {
	await save({ access: "a", refresh: "r", expires: NOW, clientId: "1.2", clientSecret: "s3cret" });
	const { fetcher, calls } = tokenEndpoint(() => renewed("b", "r2"));

	await createCredentialStore({ path, fetch: fetcher, now: () => NOW }).accessToken();

	expect(calls[0]?.get("client_secret")).toBe("s3cret");
});

test("callers racing an expiring token cause exactly one renewal", async () => {
	await save({ access: "xoxe.old", refresh: "r1", expires: NOW, clientId: "1.2" });
	const { fetcher, calls } = tokenEndpoint(() => renewed("xoxe.new", "r2"));
	const store = createCredentialStore({ path, fetch: fetcher, now: () => NOW });

	const tokens = await Promise.all([store.accessToken(), store.accessToken(), store.accessToken()]);

	expect(tokens).toEqual(["xoxe.new", "xoxe.new", "xoxe.new"]);
	expect(calls).toHaveLength(1);
});

test("the next renewal presents the refresh token the previous one returned", async () => {
	await save({ access: "a0", refresh: "r0", expires: NOW, clientId: "1.2" });
	let clock = NOW;
	const { fetcher, calls } = tokenEndpoint((_form, call) => renewed(`a${call}`, `r${call}`, 100));
	const store = createCredentialStore({ path, fetch: fetcher, now: () => clock });

	expect(await store.accessToken()).toBe("a1");
	clock += 100_000;
	expect(await store.accessToken()).toBe("a2");

	expect(calls.map(form => form.get("refresh_token"))).toEqual(["r0", "r1"]);
});

test("Slack answering 200 with ok false for a dead refresh token tells the user to reconnect and keeps the saved credential", async () => {
	const credential = { access: "a", refresh: "dead", expires: NOW, clientId: "1.2" };
	await save(credential);
	const { fetcher } = tokenEndpoint(() => ({ ok: false, error: "invalid_refresh_token" }));
	const store = createCredentialStore({ path, fetch: fetcher, now: () => NOW });

	await expect(store.accessToken()).rejects.toBeInstanceOf(SlackSignInError);
	await expect(store.accessToken()).rejects.toThrow("Reconnect Slack (as you)");
	expect(await saved()).toEqual(credential);
});

test("a rejected token that another process already replaced is swapped for the replacement without calling Slack", async () => {
	await save({ access: "xoxe.replacement", refresh: "r", expires: NOW + TWELVE_HOURS_MS, clientId: "1.2" });
	const { fetcher, calls } = tokenEndpoint(() => ({ ok: false, error: "never_called" }));
	const store = createCredentialStore({ path, fetch: fetcher, now: () => NOW });

	expect(await store.renewRejected("xoxe.stale")).toBe("xoxe.replacement");
	expect(calls).toHaveLength(0);
});

test("a rejected token that cannot renew itself says to reconnect", async () => {
	await save({ access: "xoxp-revoked", refresh: "", clientId: "1.2" });
	const store = createCredentialStore({ path, now: () => NOW });

	await expect(store.renewRejected("xoxp-revoked")).rejects.toThrow("Reconnect Slack (as you)");
});

test("a missing credential reports that Slack is not connected and a corrupt one that it is unreadable", async () => {
	const store = createCredentialStore({ path, now: () => NOW });
	await expect(store.accessToken()).rejects.toThrow("isn't connected yet");

	await writeFile(path, "{not json");
	await expect(store.accessToken()).rejects.toThrow("is unreadable");
	expect(store.peek()).toBeNull();
});
