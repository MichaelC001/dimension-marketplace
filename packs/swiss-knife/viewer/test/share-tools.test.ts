import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseShareLink } from "@dimension/sdk/artifact-share";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerShareTools, type ShareRuntime, startShareRuntime } from "../src/share";
import { FakeHost, makeWorld, randomFile, type World } from "./share-fixtures";

const SHARE_TOOLS = [
	"share_hosts",
	"share_host_add",
	"share_host_remove",
	"share_create",
	"share_progress",
	"share_update",
	"share_new_version",
	"share_revoke",
	"share_link",
	"share_comments",
	"share_reply",
	"share_mark_read",
];

let world: World;
let host: FakeHost;
let runtime: ShareRuntime;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
	return client.callTool({ name, arguments: args });
}

beforeEach(async () => {
	world = await makeWorld();
	host = FakeHost.start({ uploadToken: "up-token" });
	runtime = startShareRuntime({ library: world.library, fence: world.fence, home: world.home, log: () => undefined });
	const server = new McpServer({ name: "share-test", version: "0" });
	registerShareTools(server, runtime);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "view", version: "0" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
	await client.close();
	await runtime.close();
	host.stop();
	await world.cleanup();
});

const addedSchema = z.object({ host: z.object({ id: z.string() }) });
const createdSchema = z.object({ share: z.object({ id: z.string(), link: z.string() }) });

describe("the share tools the Library View calls", () => {
	test("every tool is listed and reachable only from the View", async () => {
		const { tools } = await client.listTools();
		expect(tools.map(tool => tool.name).sort()).toEqual([...SHARE_TOOLS].sort());
		const visibility = z.object({ ui: z.object({ visibility: z.array(z.string()) }) });
		for (const tool of tools) expect(visibility.parse(tool._meta).ui.visibility).toEqual(["app"]);
	});

	test("pair a server, share a file, read progress and the link, and revoke, never exposing a token", async () => {
		const added = await call("share_host_add", { pairing: `${host.baseUrl}/pair#t=up-token` });
		expect(added.isError).toBeFalsy();
		const hostId = addedSchema.parse(added.structuredContent).host.id;
		const listing = await call("share_hosts", {});
		expect(JSON.stringify(listing.structuredContent)).not.toContain("up-token");
		const item = await world.addFile("notes.bin", randomFile(3000));
		const refused = await call("share_create", { artifactId: item.id, host: hostId, audience: { kind: "signin" }, allowComments: true });
		expect(refused.isError).toBe(true);
		const created = await call("share_create", { artifactId: item.id, host: hostId, audience: { kind: "link" }, allowComments: true, expiresInDays: 14 });
		expect(created.isError).toBeFalsy();
		const share = createdSchema.parse(created.structuredContent).share;
		expect(parseShareLink(share.link)?.base).toBe(host.baseUrl);
		expect(JSON.stringify(created.content)).not.toContain("#k=");
		expect((await call("share_progress", { artifactId: item.id })).structuredContent).toMatchObject({ phase: "done", shareId: share.id });
		expect((await call("share_link", { shareId: share.id })).structuredContent).toEqual({ link: share.link });
		expect((await call("share_comments", { artifactId: item.id })).structuredContent).toEqual({ comments: [] });
		const revoked = await call("share_revoke", { shareId: share.id });
		expect(revoked.isError).toBeFalsy();
		expect((await call("share_link", { shareId: share.id })).isError).toBe(true);
	});
});
