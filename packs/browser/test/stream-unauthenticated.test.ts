/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: anyone who can reach the View's loopback listener can hold its sockets for as long as they like without ever holding a token. The listener turns off Node's request
 *  timeout (a View's stream is long-lived), so a request that is answered 404 but whose body the client never finishes sending is kept open for as long as the client trickles bytes in: a page that guessed the
 *  port, or a local process, opens sockets one after another and the pack's one listener runs out of them. A request that is refused ends its connection with the refusal.
 *
 *  The listener runs on Node, the runtime the pack ships on: Bun's `node:http` does not end a connection on `Connection: close` while a body is unread, so this test bundles the listener (esbuild, as the relay's tests do)
 *  and runs it under `node`, and talks to it from here over a raw socket.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { z } from "zod";

const PACK = resolve(import.meta.dirname, "..");
const Listening = z.object({ origin: z.string(), token: z.string() });

/** The listener and nothing else: a browser that exists and does nothing, and one real token minted, which opens the listener. The process lives as long as the listener does. */
const HOST = `
import { LiveChannel } from "../src/stream";
const channel = new LiveChannel({
	watchFrames: () => () => undefined,
	liveState: async (browserId) => ({ browserId }),
	viewing: () => () => undefined,
	previewHolding: () => () => undefined,
	input: async () => undefined,
});
console.log(JSON.stringify(await channel.mint("b1")));
`;

let dir = "";
let child: ChildProcess | undefined;
let port = 0;
let token = "";

beforeAll(async () => {
	dir = await mkdtemp(join(PACK, ".stream-host-"));
	const file = join(dir, "stream-host.mjs");
	await build({ stdin: { contents: HOST, resolveDir: join(PACK, "test"), loader: "ts" }, outfile: file, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: false, logLevel: "silent" });
	child = spawn("node", [file], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
	const line = Promise.withResolvers<string>();
	child.stdout?.once("data", (chunk) => line.resolve(String(chunk)));
	child.once("exit", () => line.reject(new Error("the listener host ended before it was listening")));
	const listening = Listening.parse(JSON.parse(await line.promise));
	port = Number(new URL(listening.origin).port);
	token = listening.token;
}, 30_000);

afterAll(async () => {
	if (child !== undefined && child.exitCode === null) {
		const exited = Promise.withResolvers<void>();
		child.once("exit", () => exited.resolve());
		child.kill();
		await exited.promise;
	}
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** How long a refused client is watched for the server ending its connection. A server that ends it does so in the same breath as the answer; one that keeps the socket never will, and the absence of an event cannot be awaited. */
const WATCH_MS = 1_500;

interface Refusal {
	status: string;
	/** The server ended the connection while the client was still sending. */
	ended: boolean;
}

/** A request answered while its client goes on sending a body it never finishes: the status line it got, and whether the server ended the connection. */
async function refusedWhileSending(request: string): Promise<Refusal> {
	const result = Promise.withResolvers<Refusal>();
	const socket = net.connect({ host: "127.0.0.1", port });
	let seen = "";
	const status = (): string => seen.split("\r\n")[0] ?? "";
	let trickle: NodeJS.Timeout | undefined;
	const giveUp = setTimeout(() => result.resolve({ status: status(), ended: false }), WATCH_MS);
	socket.on("connect", () => {
		socket.write(request);
		// A slow client is the thing under test and has no deterministic clock: it trickles one byte of its never-finished body every 20 ms, which keeps any idle timeout of the server's from ending the connection for it.
		trickle = setInterval(() => socket.write("x"), 20);
	});
	socket.on("data", (chunk) => {
		seen += chunk.toString("latin1");
	});
	socket.on("error", () => undefined);
	socket.on("close", () => result.resolve({ status: status(), ended: true }));
	try {
		return await result.promise;
	} finally {
		clearTimeout(giveUp);
		clearInterval(trickle);
		socket.destroy();
	}
}

describe("the View's listener refuses a request and ends its connection", () => {
	test("a bad token, with a body that is never finished", async () => {
		expect(await refusedWhileSending(`POST /i/not-a-token HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 1000000\r\nContent-Type: application/json\r\n\r\n`)).toEqual({ status: "HTTP/1.1 404 Not Found", ended: true });
	});

	test("a Host that is not the listener's own, even with a live token", async () => {
		expect(await refusedWhileSending(`POST /i/${token} HTTP/1.1\r\nHost: evil.test:${port}\r\nContent-Length: 1000000\r\nContent-Type: application/json\r\n\r\n`)).toEqual({ status: "HTTP/1.1 404 Not Found", ended: true });
	});
});
