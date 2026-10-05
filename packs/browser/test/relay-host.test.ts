/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a web page the person has open can read their open tabs and drive their logged-in Chrome through the relay. DNS rebinding is the way in: a page on
 *  `attacker.example` whose name the attacker re-points at 127.0.0.1 reaches the relay's loopback port with `Host: attacker.example:<port>`, and (browsers send no Origin on a same-site GET) `GET /json/list` answers
 *  with every open tab's URL and title. The relay is a remote control for the person's own browser, so it answers only a request that NAMES it: a Host that is one of its loopback names at the port it is
 *  bound to, on every path and on both websocket upgrades. Everything else, a missing Host included, is refused before the request is looked at.
 *
 *  The relay under test is the pack's own `--relay` command on Node, bundled from the sources (the runtime it ships on; Bun's `node:http` answers some of these requests itself). A request a test forges, a Host no
 *  HTTP client will send, is written to a raw socket. Asking for port 0 is the one case run in this process.
 */
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import { z } from "zod";
import { allowedRelayHost, startRelayServer } from "../src/code/kinds/relay/server";
import { removeRelayBundle, startRelayHost, stopRelayHosts } from "./relay-fixture";

const TAB = { tabId: 7, url: "https://bank.example/account/4417", title: "Secret tab", active: true, windowId: 1, pinned: false, groupId: -1 } as const;
const VersionInfo = z.object({ webSocketDebuggerUrl: z.string() });

interface Reply {
	status: number;
	body: string;
}

/** One raw HTTP exchange, the request bytes exactly as given (a client library will not let a test forge Host), read until the server closes. A Host of `undefined` is a request with none: HTTP/1.0, the only version Node lets through without one. */
async function exchange(port: number, method: string, path: string, host: string | undefined): Promise<Reply> {
	const request = host === undefined ? `${method} ${path} HTTP/1.0\r\n\r\n` : `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
	const done = Promise.withResolvers<Reply>();
	let received = "";
	const socket = connect({ host: "127.0.0.1", port });
	socket.setTimeout(5_000, () => socket.destroy(new Error("the relay never answered")));
	socket.on("connect", () => socket.write(request));
	socket.on("data", (chunk) => {
		received += chunk.toString("latin1");
	});
	socket.on("error", (error) => done.reject(error));
	socket.on("close", () => {
		const boundary = received.indexOf("\r\n\r\n");
		done.resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(received)?.[1] ?? 0), body: boundary === -1 ? "" : received.slice(boundary + 4) });
	});
	return await done.promise;
}

/** The status a websocket upgrade of `path` gets, off a hand-sent request (a refusal is read the same under every runtime; the `ws` client reports none). The socket is dropped as soon as the status line is in. A Host of `undefined` sends none. */
async function upgradeStatus(port: number, path: string, host: string | undefined): Promise<number> {
	const lines = [`GET ${path} HTTP/1.1`, ...(host === undefined ? [] : [`Host: ${host}`]), "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}`];
	const done = Promise.withResolvers<number>();
	const socket = connect({ host: "127.0.0.1", port });
	let seen = "";
	socket.setTimeout(5_000, () => socket.destroy(new Error("the relay never answered the upgrade")));
	socket.on("connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
	socket.on("data", (chunk) => {
		seen += chunk.toString("latin1");
		const status = /^HTTP\/1\.1 (\d{3})/.exec(seen)?.[1];
		if (status !== undefined) {
			socket.destroy();
			done.resolve(Number(status));
		}
	});
	socket.on("error", (error) => done.reject(error));
	socket.on("close", () => done.resolve(0));
	return await done.promise;
}

/** The extension, as its first message announces it, holding one tab the page must never learn of. Resolves once the relay has taken that message in: it answers the ping sent behind it. */
async function connectExtension(port: number): Promise<WebSocket> {
	const settled = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	ws.once("open", () => {
		ws.send(JSON.stringify({ t: "hello", userAgent: "test", browserVersion: "Chrome/151.0.0.0", tabs: [TAB], attachedTabIds: [] }));
		ws.send(JSON.stringify({ t: "ping" }));
	});
	ws.once("message", () => settled.resolve(ws));
	ws.once("error", (error) => settled.reject(error));
	return await settled.promise;
}

/** Hosts a request may carry to a relay at `port`, and the ones it must not. Each is its own test. */
const ALLOWED: ReadonlyArray<[string, (port: number) => string]> = [
	["127.0.0.1 at the bound port", (port) => `127.0.0.1:${port}`],
	["localhost at the bound port", (port) => `localhost:${port}`],
	["the IPv6 loopback at the bound port", (port) => `[::1]:${port}`],
	["a name in capitals (DNS names are case-insensitive)", (port) => `LOCALHOST:${port}`],
];
const REFUSED: ReadonlyArray<[string, (port: number) => string | undefined]> = [
	["a foreign host", (port) => `evil.test:${port}`],
	["a foreign host named like a loopback one", (port) => `localhost.evil.test:${port}`],
	["a foreign host that starts with the loopback address", (port) => `127.0.0.1.evil.test:${port}`],
	["127.0.0.1 at another port", (port) => `127.0.0.1:${port + 1}`],
	["localhost at another port", (port) => `localhost:${port + 1}`],
	["the bound port written with a leading zero", (port) => `127.0.0.1:0${port}`],
	["127.0.0.1 with no port", () => "127.0.0.1"],
	["localhost with no port", () => "localhost"],
	["the IPv6 loopback with no port", () => "[::1]"],
	["localhost with a trailing dot", (port) => `localhost.:${port}`],
	["127.0.0.1 with a trailing dot", (port) => `127.0.0.1.:${port}`],
	["userinfo after the authority", (port) => `127.0.0.1:${port}@evil.test`],
	["userinfo before the authority", (port) => `evil.test@127.0.0.1:${port}`],
	["a path-like suffix", (port) => `127.0.0.1:${port}/x`],
	["a list of hosts", (port) => `127.0.0.1:${port}, evil.test`],
	["the IPv4-mapped IPv6 loopback", (port) => `[::ffff:127.0.0.1]:${port}`],
	["the IPv6 loopback written out in full", (port) => `[0:0:0:0:0:0:0:1]:${port}`],
	["an empty Host", () => ""],
	["no Host at all", () => undefined],
];

describe("the relay on Node", () => {
	let port = 0;
	let extension: WebSocket;

	beforeAll(async () => {
		port = (await startRelayHost()).port;
		extension = await connectExtension(port);
	}, 30_000);

	afterAll(() => {
		extension.terminate();
	});

	describe("answers a request that names it", () => {
		for (const [name, hostAt] of ALLOWED) {
			test(`${name}: the open tabs, and a debugger URL for the name it was reached by`, async () => {
				const host = hostAt(port);
				const list = await exchange(port, "GET", "/json/list", host);
				expect(list.status).toBe(200);
				expect(list.body).toContain(TAB.url);
				const version = await exchange(port, "GET", "/json/version", host);
				expect(version.status).toBe(200);
				expect(VersionInfo.parse(JSON.parse(version.body)).webSocketDebuggerUrl.toLowerCase()).toBe(`ws://${host.toLowerCase()}/cdp`);
			});
			test(`${name}: both websockets upgrade`, async () => {
				const host = hostAt(port);
				expect(await upgradeStatus(port, "/cdp", host)).toBe(101);
				expect(await upgradeStatus(port, "/ext", host)).toBe(101);
				// A new extension socket replaces the one before it (the relay's own rule): the real one goes back for the tests that follow.
				extension = await connectExtension(port);
			});
		}
	});

	describe("refuses a request that does not", () => {
		for (const [name, hostAt] of REFUSED) {
			test(`${name}: no tab list, no debugger URL`, async () => {
				const host = hostAt(port);
				const list = await exchange(port, "GET", "/json/list", host);
				expect(list.status).toBe(403);
				expect(list.body).not.toContain(TAB.url);
				expect(list.body).not.toContain(TAB.title);
				const version = await exchange(port, "GET", "/json/version", host);
				expect(version.status).toBe(403);
				expect(version.body).not.toContain("webSocketDebuggerUrl");
			});
			test(`${name}: neither websocket upgrades`, async () => {
				const host = hostAt(port);
				expect(await upgradeStatus(port, "/cdp", host)).toBe(403);
				expect(await upgradeStatus(port, "/ext", host)).toBe(403);
			});
		}

		test("no route is looked at first: a foreign Host gets the same refusal from every one, a 404, a 405 and a 426 included", async () => {
			const host = `evil.test:${port}`;
			for (const [method, path] of [
				["GET", "/json"],
				["GET", "/json/list"],
				["GET", "/json/version"],
				["GET", "/cdp"],
				["GET", "/ext"],
				["GET", "/nothing"],
				["POST", "/json/version"],
			] as const) {
				expect(`${method} ${path} ${(await exchange(port, method, path, host)).status}`).toBe(`${method} ${path} 403`);
			}
			expect(await upgradeStatus(port, "/nothing", host)).toBe(403);
		});
	});
});

describe("a request the relay cannot read", () => {
	test("a request target that is not a URL is refused with 400, and the relay, a process that one uncaught error would end, answers the next request", async () => {
		const { port } = await startRelayHost();
		const host = `127.0.0.1:${port}`;
		expect((await exchange(port, "GET", "http://[", host)).status).toBe(400);
		expect(await upgradeStatus(port, "http://[", host)).toBe(400);
		expect((await exchange(port, "GET", "/json/list", host)).status).toBe(200);
	});
});

afterAll(async () => {
	await stopRelayHosts();
	await removeRelayBundle();
});

describe("the port a relay answers for", () => {
	test("asked for port 0 it answers for the port the system gave it, not for 0", async () => {
		const server = await startRelayServer({ port: 0, group: false });
		try {
			expect(server.port).toBeGreaterThan(0);
			expect((await exchange(server.port, "GET", "/json/list", `127.0.0.1:${server.port}`)).status).toBe(200);
			expect((await exchange(server.port, "GET", "/json/list", "127.0.0.1:0")).status).toBe(403);
		} finally {
			await server.stop();
		}
	});

	test("a request leaves out the port only where HTTP does: on port 80", () => {
		expect(allowedRelayHost("127.0.0.1", 80)).toBe("127.0.0.1");
		expect(allowedRelayHost("LOCALHOST", 80)).toBe("localhost");
		expect(allowedRelayHost("127.0.0.1:80", 80)).toBe("127.0.0.1:80");
		expect(allowedRelayHost("127.0.0.1", 9224)).toBeNull();
		expect(allowedRelayHost("evil.test", 80)).toBeNull();
	});
});
