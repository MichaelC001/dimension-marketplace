import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { MAX_CHUNK_BYTES, TAB_META_KEY, fileChunkSchema, mediaSourceSchema, renewedMediaSchema, viewedFileSchema } from "../src/contract";
import { createFence } from "../src/fence";
import { LEASE_TTL_MS, MAX_LEASES } from "../src/media-server";
import { createViewerServer } from "../src/server";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("viewer server contract", () => {
	let base: string;
	let root: string;
	let client: Client;
	const large = randomBytes(MAX_CHUNK_BYTES + 1234);

	beforeAll(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), "viewer-server-")));
		root = join(base, "root");
		const view = join(base, "dist");
		await mkdir(root);
		await mkdir(join(view, "assets"), { recursive: true });
		await writeFile(join(view, "index.html"), "<!doctype html><title>viewer</title>");
		await writeFile(join(view, "assets", "chunk.js"), "export default 1");
		await writeFile(join(root, "pixel.png"), PNG);
		await writeFile(join(root, "notes.md"), "# hello");
		await writeFile(join(root, "large.bin"), large);
		await writeFile(join(root, ".env"), "TOKEN=SECRET_VALUE_123");
		const server = await createViewerServer({ viewDir: view, fence: createFence({ home: base, env: { VIEWER_ROOTS: root } }) });
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		client = new Client({ name: "test", version: "0" });
		await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	});
	afterAll(async () => {
		await client.close();
		await rm(base, { recursive: true, force: true });
	});

	test("view_file is model-visible and mounts the View; recording leases and chunk reads are app-only", async () => {
		const { tools } = await client.listTools();
		const toolMeta = z.object({ ui: z.object({ resourceUri: z.string().optional(), visibility: z.array(z.string()).optional() }) });
		const meta = (name: string) => toolMeta.parse(tools.find(tool => tool.name === name)?._meta);
		expect(meta("view_file").ui.resourceUri).toBe("ui://viewer/index.html");
		expect(meta("view_file").ui.visibility).toBeUndefined();
		for (const name of ["read_file_chunk", "open_media", "close_media", "renew_media"]) expect(meta(name).ui.visibility).toEqual(["app"]);
	});

	test("view_file names the real path, the kind and the size, and keys the tab by the real path", async () => {
		const result = await client.callTool({ name: "view_file", arguments: { path: join(root, "pixel.png") } });
		expect(result.isError).toBeFalsy();
		const file = viewedFileSchema.parse(result.structuredContent);
		expect(file).toMatchObject({ path: join(root, "pixel.png"), filename: "pixel.png", kind: "image", size: PNG.length });
		expect(result._meta?.[TAB_META_KEY]).toEqual({ key: join(root, "pixel.png") });
	});

	test("a display name overrides the file name and decides the kind of a misnamed file", async () => {
		const result = await client.callTool({ name: "view_file", arguments: { path: join(root, "notes.md"), filename: "renamed.txt" } });
		expect(viewedFileSchema.parse(result.structuredContent)).toMatchObject({ filename: "renamed.txt", kind: "text" });
	});

	test("chunks reassemble to bytes with the same sha-256, across more than one call", async () => {
		const parts: Buffer[] = [];
		let offset = 0;
		let calls = 0;
		for (;;) {
			const result = await client.callTool({ name: "read_file_chunk", arguments: { path: join(root, "large.bin"), offset, length: MAX_CHUNK_BYTES } });
			expect(result.isError).toBeFalsy();
			const chunk = fileChunkSchema.parse(result.structuredContent);
			// The base64 payload must ride in structuredContent only, never doubled into the text block.
			expect(JSON.stringify(result.content)).not.toContain(chunk.base64.slice(0, 64));
			parts.push(Buffer.from(chunk.base64, "base64"));
			offset += chunk.length;
			calls++;
			if (chunk.eof) break;
		}
		expect(calls).toBe(2);
		expect(sha256(Buffer.concat(parts))).toBe(sha256(large));
	});

	test("secrets, outside paths and traversal are refused with a reason and never leak content", async () => {
		const refusals = [join(root, ".env"), join(root, "..", "dist", "index.html"), "relative/path.png"];
		for (const path of refusals) {
			for (const name of ["view_file", "read_file_chunk", "open_media"]) {
				const arguments_ = name === "view_file" ? { path } : name === "open_media" ? { path, size: 0, mtimeMs: 0, token: "a".repeat(48) } : { path, offset: 0, length: 10 };
				const result = await client.callTool({ name, arguments: arguments_ });
				expect(result.isError).toBe(true);
				const text = JSON.stringify(result.content);
				expect(text.length).toBeGreaterThan(20);
				expect(text).not.toContain("SECRET_VALUE_123");
			}
		}
	});

	test("a missing file and a directory are errors, not crashes", async () => {
		expect((await client.callTool({ name: "view_file", arguments: { path: join(root, "gone.png") } })).isError).toBe(true);
		expect((await client.callTool({ name: "view_file", arguments: { path: root } })).isError).toBe(true);
	});

	test("the schema, not the handler, rejects a chunk longer than the cap", async () => {
		const result = await client.callTool({ name: "read_file_chunk", arguments: { path: join(root, "pixel.png"), offset: 0, length: MAX_CHUNK_BYTES + 1 } });
		expect(result.isError).toBe(true);
	});

	test("the View and every asset it names are readable as resources", async () => {
		const html = await client.readResource({ uri: "ui://viewer/index.html" });
		expect(html.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
		const chunk = await client.readResource({ uri: "ui://viewer/assets/chunk.js" });
		expect(chunk.contents[0]).toMatchObject({ mimeType: "text/javascript", text: "export default 1" });
	});

	test("a pane that vanished without closing is reclaimed once the table is full and its lease went unrenewed, while a renewing pane keeps its recording", async () => {
		const header = Buffer.from([0, 0, 0, 32, ...Buffer.from("ftypisom"), ...new Uint8Array(52)]);
		const recording = join(root, "take.mp4");
		await writeFile(recording, header);
		const { size, mtimeMs } = await stat(recording);
		const open = async () => {
			const token = randomBytes(24).toString("hex");
			const result = await client.callTool({ name: "open_media", arguments: { path: recording, size, mtimeMs, token } });
			return { token, result };
		};
		const renewed = async (token: string) => renewedMediaSchema.parse((await client.callTool({ name: "renew_media", arguments: { token } })).structuredContent).alive;
		const range = async (url: string) => (await fetch(url, { headers: { Range: "bytes=0-11" } })).status;
		const urls: string[] = [];
		const tokens: string[] = [];
		for (let opened = 0; opened < MAX_LEASES; opened++) {
			const { token, result } = await open();
			expect(result.isError).toBeFalsy();
			tokens.push(token);
			urls.push(mediaSourceSchema.parse(result.structuredContent).url);
		}
		try {
			expect((await open()).result.isError).toBe(true);
			setSystemTime(new Date(Date.now() + LEASE_TTL_MS - 1000));
			expect(await renewed(tokens[0]!)).toBe(true);
			setSystemTime(new Date(Date.now() + 2000));
			const next = await open();
			expect(next.result.isError).toBeFalsy();
			expect(await range(mediaSourceSchema.parse(next.result.structuredContent).url)).toBe(206);
			expect(await range(urls[0]!)).toBe(206);
			expect(await range(urls[1]!)).toBe(404);
			expect(await renewed(tokens[0]!)).toBe(true);
			expect(await renewed(tokens[1]!)).toBe(false);
		} finally {
			setSystemTime();
		}
	});
});
