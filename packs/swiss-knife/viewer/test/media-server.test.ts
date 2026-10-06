import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFence, type Fence } from "../src/fence";
import { startMediaServer, type MediaServer } from "../src/media-server";

const HEADER = Buffer.from([0, 0, 0, 32, ...Buffer.from("ftypisom"), ...new Uint8Array(52)]);
const TAIL = Buffer.from("selected tail bytes");
const LARGE_SIZE = 64 * 1024 * 1024 + 4096;
let directory: string;
let path: string;
let server: MediaServer;
let fence: Fence;
let allowed: boolean;

beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "viewer-media-")));
	path = join(directory, "take.mp4");
	const file = await open(path, "w");
	try {
		await file.write(HEADER, 0, HEADER.length, 0);
		await file.truncate(LARGE_SIZE);
		await file.write(TAIL, 0, TAIL.length, LARGE_SIZE - TAIL.length);
	} finally {
		await file.close();
	}
	allowed = true;
	const realFence = createFence({ home: directory, env: {}, roots: [directory] });
	fence = { roots: realFence.roots, check: (requested, meta) => allowed ? realFence.check(requested, meta) : Promise.resolve({ ok: false, reason: "Access withdrawn" }) };
	server = await startMediaServer(fence);
});

afterEach(async () => {
	await server?.close();
	await rm(directory, { recursive: true, force: true });
});

async function lease() {
	const revision = await stat(path);
	return server.acquire(path, revision.size, revision.mtimeMs, undefined);
}

async function response(url: string, headers: OutgoingHttpHeaders = {}, method = "GET") {
	return new Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
		const req = request(url, { method, headers }, res => {
			const chunks: Buffer[] = [];
			res.on("data", chunk => chunks.push(Buffer.from(chunk)));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("recording range leases", () => {
	test("releasing an opening recording prevents a delayed fence approval from publishing its capability", async () => {
		await server.close();
		let approve!: () => void;
		let entered!: () => void;
		const approval = new Promise<void>(resolve => { approve = resolve; });
		const checking = new Promise<void>(resolve => { entered = resolve; });
		server = await startMediaServer({
			roots: fence.roots,
			async check(requested, meta) {
				entered();
				await approval;
				return fence.check(requested, meta);
			},
		});
		const revision = await stat(path);
		const token = "a".repeat(48);
		const opening = server.acquire(path, revision.size, revision.mtimeMs, undefined, token);
		const outcome = opening.then(
			source => ({ status: "fulfilled" as const, source }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		await checking;
		server.release(token);
		approve();
		const settled = await outcome;
		expect(settled.status).toBe("rejected");
		if (settled.status !== "rejected") throw new Error("Cancelled recording became available.");
		expect(settled.error).toBeInstanceOf(Error);
		expect((settled.error as Error).message).toBe("Recording opening was cancelled.");
		const result = await response(`${server.origin}/media/${token}`, { Range: "bytes=0-7" });
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("pending admissions consume lease capacity and cancellation restores it after they settle", async () => {
		await server.close();
		let approve!: () => void;
		const approval = new Promise<void>(resolve => { approve = resolve; });
		server = await startMediaServer({
			roots: fence.roots,
			async check(requested, meta) {
				await approval;
				return fence.check(requested, meta);
			},
		});
		const revision = await stat(path);
		const tokens = Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(48, "0"));
		const openings = tokens.map(token => server.acquire(path, revision.size, revision.mtimeMs, undefined, token));
		const settled = Promise.allSettled(openings);
		try {
			await expect(server.acquire(path, revision.size, revision.mtimeMs, undefined, "f".repeat(48))).rejects.toThrow("Close an open recording before opening another.");
		} finally {
			for (const token of tokens) server.release(token);
			approve();
			await settled;
		}
		const source = await server.acquire(path, revision.size, revision.mtimeMs, undefined, "f".repeat(48));
		const result = await response(source.url, { Range: "bytes=0-7" });
		expect(result.status).toBe(206);
		expect(result.bytes).toEqual(HEADER.subarray(0, 8));
	});

	test("a recording larger than 64 MiB serves only the selected header bytes", async () => {
		const source = await lease();
		const result = await response(source.url, { Range: `bytes=0-${HEADER.length - 1}` });
		expect(result.status).toBe(206);
		expect(result.headers["content-type"]).toBe("video/mp4");
		expect(result.headers["content-length"]).toBe(String(HEADER.length));
		expect(result.headers["content-range"]).toBe(`bytes 0-${HEADER.length - 1}/${LARGE_SIZE}`);
		expect(result.bytes).toEqual(HEADER);
	});

	test.each([
		["open-ended tail", `bytes=${LARGE_SIZE - TAIL.length}-`],
		["suffix", `bytes=-${TAIL.length}`],
		["end beyond EOF", `bytes=${LARGE_SIZE - TAIL.length}-${LARGE_SIZE + 100}`],
	])("%s returns the exact final bytes", async (_name, range) => {
		const result = await response((await lease()).url, { Range: range });
		expect(result.status).toBe(206);
		expect(result.headers["content-range"]).toBe(`bytes ${LARGE_SIZE - TAIL.length}-${LARGE_SIZE - 1}/${LARGE_SIZE}`);
		expect(result.bytes).toEqual(TAIL);
	});

	test.each(["bytes=9-2", `bytes=${LARGE_SIZE}-`, "bytes=-0", "bytes=0-1,3-4", "bytes=-", "bytes=9007199254740992-"])("rejects invalid range %s without media bytes", async range => {
		const result = await response((await lease()).url, { Range: range });
		expect(result.status).toBe(416);
		expect(result.headers["content-range"]).toBe(`bytes */${LARGE_SIZE}`);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("HEAD preserves range metadata but never sends a body", async () => {
		const result = await response((await lease()).url, { Range: "bytes=0-11", Origin: "null" }, "HEAD");
		expect(result.status).toBe(206);
		expect(result.headers["content-length"]).toBe("12");
		expect(result.headers["content-range"]).toBe(`bytes 0-11/${LARGE_SIZE}`);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("GET without a range returns the entire small recording", async () => {
		await writeFile(path, HEADER);
		const result = await response((await lease()).url);
		expect(result.status).toBe(200);
		expect(result.headers["content-length"]).toBe(String(HEADER.length));
		expect(result.bytes).toEqual(HEADER);
	});

	test("revoking a lease makes its previously usable URL refuse access", async () => {
		const source = await lease();
		expect((await response(source.url, { Range: "bytes=0-11" })).status).toBe(206);
		server.release(source.token);
		const result = await response(source.url, { Range: "bytes=0-11" });
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("withdrawing fence access invalidates an existing lease", async () => {
		const source = await lease();
		allowed = false;
		const result = await response(source.url, { Range: "bytes=0-11" });
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
		await expect(lease()).rejects.toThrow("Access withdrawn");
	});

	test("a changed file cannot be read through its old revision lease", async () => {
		const source = await lease();
		await writeFile(path, HEADER);
		const result = await response(source.url, { Range: "bytes=0-11" });
		expect(result.status).toBe(409);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("a same-size recording with a new mtime cannot use the old lease", async () => {
		const revision = await stat(path);
		const source = await lease();
		const changed = new Date(revision.mtimeMs + 10_000);
		await utimes(path, changed, changed);
		const result = await response(source.url, { Range: "bytes=0-11" });
		expect(result.status).toBe(409);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("an outdated listing cannot grant a lease", async () => {
		const revision = await stat(path);
		await expect(server.acquire(path, revision.size - 1, revision.mtimeMs, undefined)).rejects.toThrow(/changed/i);
	});

	test("releasing a lease restores capacity after the lease limit is reached", async () => {
		const sources = [];
		for (let index = 0; index < 64; index++) sources.push(await lease());
		await expect(lease()).rejects.toThrow(/Close an open recording/);
		server.release(sources[0]!.token);
		const result = await response((await lease()).url, { Range: "bytes=0-11" });
		expect(result.status).toBe(206);
		expect(result.bytes).toEqual(HEADER.subarray(0, 12));
	});

	test.each([
		["foreign origin", { Origin: "https://attacker.example" }],
		["listener origin is not a sandbox origin", { Origin: "http://127.0.0.1" }],
		["foreign host", { Host: "attacker.example" }],
	])("refuses %s even with a valid token", async (_name, headers) => {
		const result = await response((await lease()).url, { ...headers, Range: "bytes=0-11" });
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("a token cannot be extended into an arbitrary-path request", async () => {
		const result = await response(`${(await lease()).url}?path=${encodeURIComponent(path)}`);
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("a valid lease does not permit methods other than GET and HEAD", async () => {
		const result = await response((await lease()).url, {}, "POST");
		expect(result.status).toBe(405);
		expect(result.headers.allow).toBe("GET, HEAD");
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});
});
