import { PRESENTED_KINDS } from "@dimension/sdk/presentation";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defaultTrash } from "../../src/library/trash";
import { LibraryError } from "../../src/library/errors";
import { MAX_TAGS } from "../../src/library/tags";
import type { Library } from "../../src/library/types";
import { MAX_THUMB_BYTES } from "../../src/thumbnail";
import { TAB_META_KEY, VIEWER_VIEW_URI } from "./contract";
import type { Fence } from "./fence";
import type { MediaServer } from "./media-server";
import { APP_ONLY, describeError, failure, openViewedFile } from "./tool-support";

export const LIBRARY_TAB_KEY = "library";

export interface LibraryToolDeps {
	readonly library: Library;
	readonly fence: Fence;
	readonly media: MediaServer;
}

interface Answer {
	readonly text: string;
	readonly data: Record<string, unknown>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTROYS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const THUMB_BASE64_LIMIT = Math.ceil((MAX_THUMB_BYTES * 4) / 3) + 8;

const id = z.string().min(1).max(64);
const path = z.string().min(1).max(4096);

async function answer(run: () => Promise<Answer> | Answer): Promise<CallToolResult> {
	try {
		const { text, data } = await run();
		return { content: [{ type: "text", text }], structuredContent: data };
	} catch (error) {
		return failure(describeError(error));
	}
}

export function registerLibraryTools(server: McpServer, { library, fence, media }: LibraryToolDeps): void {
	registerAppTool(
		server,
		"open_library",
		{
			title: "Library",
			description: "Open the artifact library beside the conversation: every file shown or made, searchable, with shares and comments.",
			inputSchema: {
				workspace: path.optional().describe("Show only this workspace's artifacts"),
				query: z.string().max(200).optional().describe("Start with this search"),
			},
			annotations: READ_ONLY,
			_meta: { ui: { resourceUri: VIEWER_VIEW_URI } },
		},
		async ({ workspace, query }) => ({
			content: [{ type: "text", text: "Opened the library." }],
			structuredContent: { mode: "library", ...(workspace === undefined ? {} : { workspace }), ...(query === undefined ? {} : { query }) },
			_meta: { [TAB_META_KEY]: { key: LIBRARY_TAB_KEY } },
		}),
	);

	registerAppTool(
		server,
		"library_query",
		{
			title: "Query the library",
			description: "One keyset page of artifacts: filters, sort, search. The View calls this; it is not for the model.",
			inputSchema: {
				q: z.string().max(200).optional(),
				kinds: z.array(z.enum(PRESENTED_KINDS)).max(PRESENTED_KINDS.length).optional(),
				tags: z.array(z.string().max(100)).max(MAX_TAGS).optional(),
				workspace: path.optional(),
				state: z.enum(["live", "discarded"]).optional(),
				starred: z.boolean().optional(),
				shared: z.boolean().optional(),
				sort: z.enum(["recent", "name", "size", "opened", "relevance"]).optional(),
				cursor: z.string().max(512).optional(),
				limit: z.number().int().min(1).max(200).optional(),
			},
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		args =>
			answer(() => {
				const page = library.query(args);
				return { text: `${page.items.length} of ${page.total} artifacts.`, data: { ...page } };
			}),
	);

	registerAppTool(
		server,
		"library_facets",
		{
			title: "Library facets",
			description: "Counts for the Library's filter column.",
			inputSchema: { workspace: path.optional(), state: z.enum(["live", "discarded"]).optional() },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		args => answer(() => ({ text: "Facets.", data: { ...library.facets(args) } })),
	);

	registerAppTool(
		server,
		"library_check",
		{
			title: "Check artifacts on disk",
			description: "Stat the files behind these rows and report which are missing.",
			inputSchema: { ids: z.array(id).min(1).max(200) },
			annotations: WRITES,
			_meta: APP_ONLY,
		},
		({ ids }) => answer(async () => ({ text: "Checked.", data: { items: await library.check(ids) } })),
	);

	registerAppTool(
		server,
		"library_update",
		{
			title: "Edit an artifact",
			description: "Set an artifact's title, note, tags, star, or recording length.",
			inputSchema: {
				id,
				title: z.string().max(400).nullable().optional(),
				note: z.string().max(8000).nullable().optional(),
				tags: z.array(z.string().max(100)).max(48).optional(),
				starred: z.boolean().optional(),
				durationMs: z.number().min(0).optional(),
			},
			annotations: WRITES,
			_meta: APP_ONLY,
		},
		({ id: artifactId, ...patch }) => answer(() => ({ text: "Updated.", data: { item: library.update(artifactId, patch) } })),
	);

	registerAppTool(
		server,
		"library_stamp",
		{
			title: "Add a file to the library",
			description: "A person adds one file by path. Secrets are refused.",
			inputSchema: { path },
			annotations: WRITES,
			_meta: APP_ONLY,
		},
		args => answer(async () => ({ text: "Added.", data: { item: await library.stamp({ path: args.path, source: "human" }) } })),
	);

	registerAppTool(
		server,
		"library_discard",
		{
			title: "Discard an artifact",
			description: "Revoke its shares, drop it from the library and, when asked, move the file to the recycle bin.",
			inputSchema: { id, trash: z.boolean() },
			annotations: DESTROYS,
			_meta: APP_ONLY,
		},
		({ id: artifactId, trash }) => answer(async () => ({ text: "Discarded.", data: { ...(await library.discard(artifactId, { trash })) } })),
	);

	registerAppTool(
		server,
		"library_discard_default",
		{
			title: "Default for Discard's recycle-bin box",
			description: "True unless git tracks the file.",
			inputSchema: { id },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		({ id: artifactId }) =>
			answer(async () => {
				const item = library.get(artifactId);
				if (item === undefined) throw new LibraryError(`no artifact ${artifactId} in the library`);
				return { text: "Default.", data: { trash: await defaultTrash(item.path) } };
			}),
	);

	registerAppTool(
		server,
		"library_restore",
		{
			title: "Restore a discarded artifact",
			description: "Bring a discarded artifact back, within 30 days.",
			inputSchema: { id },
			annotations: WRITES,
			_meta: APP_ONLY,
		},
		({ id: artifactId }) => answer(() => ({ text: "Restored.", data: { item: library.restore(artifactId) } })),
	);

	registerAppTool(
		server,
		"library_open",
		{
			title: "Open an artifact",
			description: "Open an indexed artifact as a document tab: the same answer as view_file.",
			inputSchema: { id },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		async ({ id: artifactId }, extra) => {
			const item = library.get(artifactId);
			if (item === undefined || item.state === "discarded") return failure(`no artifact ${artifactId} in the library`);
			const opened = await openViewedFile(fence, { path: item.path }, extra._meta);
			if (opened.isError !== true) library.markOpened(item.id);
			return opened;
		},
	);

	registerAppTool(
		server,
		"library_thumbs",
		{
			title: "Thumbnail origin",
			description: "The loopback origin and capability under which `<base>/<id>` serves a cached thumbnail.",
			inputSchema: {},
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		() => answer(() => ({ text: "Thumbnail origin.", data: { base: media.thumbBase } })),
	);

	registerAppTool(
		server,
		"library_set_thumb",
		{
			title: "Save a thumbnail",
			description: "The View draws a poster or a first page once and saves it here.",
			inputSchema: { id, data: z.string().min(1).max(THUMB_BASE64_LIMIT), mime: z.enum(["image/webp", "image/png", "image/jpeg"]) },
			annotations: WRITES,
			_meta: APP_ONLY,
		},
		({ id: artifactId, data, mime }) =>
			answer(async () => {
				await library.setThumb(artifactId, Buffer.from(data, "base64"), mime);
				return { text: "Saved.", data: { ok: true } };
			}),
	);
}
