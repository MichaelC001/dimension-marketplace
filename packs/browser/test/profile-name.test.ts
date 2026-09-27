/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser dock panel lets a
 *  person start a sign-in on a profile name the server then refuses (the View
 *  never opens and the panel shows no reason), or refuses a name the agent can
 *  open — the three doors that take a profile name have drifted apart.
 *
 *  `profileSlug` (src/profile-name.ts) is the ONE rule. One table drives all
 *  three doors: the rule itself, the runtime's filesystem check
 *  (`validateProfile`), and the real MCP server's `browser_open` input schema,
 *  called over an in-memory transport exactly as the host calls it. The
 *  runtime behind the server is a recording fake: a name the schema refuses
 *  never reaches `open`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserOpenOptions, BrowserRuntimePort, BrowserState } from "../src/contracts";
import { profileSlug } from "../src/profile-name";
import { createBrowserServer } from "../src/server";
import { validateProfile } from "../src/store";
import { createRoot, teardown } from "./fixture";

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
});

/** The runtime the server needs to boot and answer `browser_open`, recording each profile it was asked to open. */
function recordingRuntime(opened: string[]): BrowserRuntimePort {
	const runtime: Pick<BrowserRuntimePort, "open" | "connections" | "onConnectionsChanged" | "dispose"> = {
		open: async ({ profile }: BrowserOpenOptions) => {
			opened.push(profile);
			return { browserId: "b".repeat(32), profile } as unknown as BrowserState;
		},
		connections: async () => ({}),
		onConnectionsChanged: () => () => {},
		dispose: async () => {},
	};
	return runtime as BrowserRuntimePort;
}

/** Each row: what a person might type, and the slug the rule makes of it (null: refused). */
const NAMES: ReadonlyArray<{ readonly raw: string; readonly slug: string | null }> = [
	{ raw: "work", slug: "work" },
	{ raw: "0", slug: "0" },
	{ raw: "traction-x-acme", slug: "traction-x-acme" },
	{ raw: "a_b-9", slug: "a_b-9" },
	{ raw: "a".repeat(48), slug: "a".repeat(48) },
	{ raw: "a".repeat(49), slug: null },
	{ raw: "Work", slug: "work" },
	{ raw: "  Personal  ", slug: "personal" },
	{ raw: "Bad Name!", slug: null },
	{ raw: "", slug: null },
	{ raw: "   ", slug: null },
	{ raw: "-lead", slug: null },
	{ raw: "_lead", slug: null },
	{ raw: "a.b", slug: null },
	{ raw: "..", slug: null },
	{ raw: "a/b", slug: null },
	{ raw: "a\\b", slug: null },
	{ raw: "c:", slug: null },
	{ raw: "a\u0000b", slug: null },
	{ raw: "café", slug: null },
	{ raw: "two words", slug: null },
];

test("profileSlug is the one rule: the runtime's filesystem check and the server's browser_open schema refuse exactly what it refuses", async () => {
	const rootDir = await createRoot();
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const opened: string[] = [];
	const server = await createBrowserServer({ runtime: recordingRuntime(opened), viewDir, presets: [] });
	const client = new Client({ name: "profile-name-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);

	const rows: Array<{ raw: string; slug: string | null; runtime: string | null; server: boolean }> = [];
	for (const { raw } of NAMES) {
		let runtime: string | null;
		try {
			runtime = validateProfile(raw);
		} catch {
			runtime = null;
		}
		// The panel and the store both send the rule's slug; the server sees what the person typed, normalised.
		const sent = raw.trim().toLowerCase();
		const before = opened.length;
		const call = await client.callTool({ name: "browser_open", arguments: { profile: sent } });
		const reachedOpen = opened.length > before;
		expect(Boolean(call.isError)).toBe(!reachedOpen);
		rows.push({ raw, slug: profileSlug(raw), runtime, server: reachedOpen });
	}

	expect(rows).toEqual(NAMES.map(({ raw, slug }) => ({ raw, slug, runtime: slug, server: slug !== null })));
});
