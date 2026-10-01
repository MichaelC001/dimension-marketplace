// `view_file` and `read_file_chunk` as a host drives them over MCP: the lent file
// rides the call's `_meta`, and `annotate` rides back on the result's `_meta`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACTORY_GRANT_META_KEY } from "@dimension/sdk/artifactory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ANNOTATE_META_KEY, fileChunkSchema, TAB_META_KEY, viewedFileSchema } from "../src/contract";
import { createFence } from "../src/fence";
import { createViewerServer } from "../src/server";

const lend = (...files: string[]) => ({ [ARTIFACTORY_GRANT_META_KEY]: { read: files } });

describe("the viewer server honours a host-lent file", () => {
	let base: string;
	let client: Client;
	let granted: string;
	let sibling: string;
	let secret: string;

	beforeAll(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), "viewer-lent-")));
		const root = join(base, "root");
		const project = join(base, "project");
		const view = join(base, "dist");
		await mkdir(root);
		await mkdir(project);
		await mkdir(view);
		await writeFile(join(view, "index.html"), "<!doctype html><title>viewer</title>");
		granted = join(project, "notes.md");
		sibling = join(project, "other.md");
		secret = join(project, ".env");
		await writeFile(granted, "# LENT_CONTENT");
		await writeFile(sibling, "# SIBLING_CONTENT");
		await writeFile(secret, "TOKEN=SECRET_VALUE_123");
		const server = await createViewerServer({ viewDir: view, fence: createFence({ home: base, env: { VIEWER_ROOTS: root } }) });
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		client = new Client({ name: "test", version: "0" });
		await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	});
	afterAll(async () => {
		await client.close();
		await rm(base, { recursive: true, force: true });
	});

	const view = (path: string, meta?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
		client.callTool({ name: "view_file", arguments: { path, ...extra }, ...(meta ? { _meta: meta } : {}) });
	const chunk = (path: string, meta?: Record<string, unknown>) =>
		client.callTool({ name: "read_file_chunk", arguments: { path, offset: 0, length: 1024 }, ...(meta ? { _meta: meta } : {}) });

	test("view_file opens a file outside the roots only with its grant, and names its real path", async () => {
		const refused = await view(granted);
		expect(refused.isError).toBe(true);
		const opened = await view(granted, lend(granted));
		expect(opened.isError).toBeFalsy();
		expect(viewedFileSchema.parse(opened.structuredContent)).toMatchObject({ path: granted, filename: "notes.md", kind: "markdown" });
		expect(opened._meta?.[TAB_META_KEY]).toEqual({ key: granted });
	});

	test("read_file_chunk, the call the View makes for the same file, honours the same grant", async () => {
		expect((await chunk(granted)).isError).toBe(true);
		const read = await chunk(granted, lend(granted));
		expect(read.isError).toBeFalsy();
		const bytes = Buffer.from(fileChunkSchema.parse(read.structuredContent).base64, "base64").toString();
		expect(bytes).toBe("# LENT_CONTENT");
	});

	test("a grant lends one file: a sibling, the folder and a secret are refused on both tools, never leaking content", async () => {
		for (const path of [sibling, join(granted, ".."), secret]) {
			for (const call of [view, chunk]) {
				const result = await call(path, lend(granted, secret));
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result)).not.toMatch(/SIBLING_CONTENT|SECRET_VALUE_123|LENT_CONTENT/);
			}
		}
	});

	test("only `_meta` lends: the same grant in the tool's arguments is ignored", async () => {
		expect((await view(granted, undefined, { [ARTIFACTORY_GRANT_META_KEY]: { read: [granted] }, grant: { read: [granted] } })).isError).toBe(true);
	});

	test("annotate: true comes back on the result's _meta for the View, and only when asked", async () => {
		const asked = await view(granted, lend(granted), { annotate: true });
		expect(asked._meta?.[ANNOTATE_META_KEY]).toBe(true);
		expect(asked._meta?.[TAB_META_KEY]).toEqual({ key: granted }); // the document's identity is unchanged by it
		for (const extra of [{}, { annotate: false }]) {
			const plain = await view(granted, lend(granted), extra);
			expect(plain.isError).toBeFalsy();
			expect(plain._meta).not.toHaveProperty([ANNOTATE_META_KEY]);
		}
	});

	test("annotate must be a boolean: the schema, not the handler, refuses anything else", async () => {
		expect((await view(granted, lend(granted), { annotate: "yes" })).isError).toBe(true);
	});
});
