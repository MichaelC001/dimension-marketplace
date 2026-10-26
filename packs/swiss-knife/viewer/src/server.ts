import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createLibrary, engineHome, type Library } from "../../src/library";
import { readChunk } from "./chunk";
import { MAX_CHUNK_BYTES, mediaTokenSchema, VIEWER_VIEW_URI } from "./contract";
import { createFence, type Fence } from "./fence";
import { registerLibraryTools } from "./library-tools";
import { type MediaServer, startMediaServer } from "./media-server";
import { registerShareTools, type ShareRuntime, startShareRuntime } from "./share";
import { APP_ONLY, describeError, failure, openViewedFile } from "./tool-support";

const MIME: Readonly<Record<string, string>> = {
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".wasm": "application/wasm",
};
const TEXT_MIME: Readonly<Record<string, true>> = { "text/javascript": true, "text/css": true, "application/json": true, "image/svg+xml": true };

export interface ViewerServerOptions {
	readonly viewDir?: string;
	readonly fence?: Fence;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	readonly library?: Library;
}

async function openOwnLibrary(home: string): Promise<Library | undefined> {
	try {
		return await createLibrary({ home });
	} catch (error) {
		console.error(`viewer library: the artifact library is unavailable (${describeError(error)}); documents still open`);
		return undefined;
	}
}

export async function createViewerServer(options: ViewerServerOptions = {}): Promise<McpServer> {
	const env = options.env ?? process.env;
	const userHome = options.home ?? homedir();
	const home = engineHome(env, userHome);
	const ownedLibrary = options.library === undefined ? await openOwnLibrary(home) : undefined;
	const library = options.library ?? ownedLibrary;
	const fence =
		options.fence ??
		createFence({
			home: userHome,
			env,
			...(library === undefined ? {} : { indexed: library }),
			log: detail => console.error(`viewer fence: ${detail}`),
		});
	const viewDir = options.viewDir ?? fileURLToPath(new URL("./dist/", import.meta.url));
	const server = new McpServer({ name: "dimension-community-viewer", version: "0.1.0" });

	let media: MediaServer | undefined;
	let share: ShareRuntime | undefined;
	async function release(): Promise<void> {
		try {
			await Promise.all([media?.close(), share?.close()]);
		} finally {
			ownedLibrary?.close();
		}
	}

	try {
		const html = await readFile(join(viewDir, "index.html"), "utf8");
		media = await startMediaServer(fence, Date.now, library);
		share = library === undefined ? undefined : startShareRuntime({ library, fence, home });
		server.server.onclose = () => {
			void release().catch(error => console.error(error));
		};
		await registerViewer(server, { fence, html, viewDir, media, library });
		if (share !== undefined) registerShareTools(server, share);
	} catch (error) {
		await release();
		throw error;
	}
	return server;
}

interface ViewerParts {
	readonly fence: Fence;
	readonly html: string;
	readonly viewDir: string;
	readonly media: MediaServer;
	readonly library: Library | undefined;
}

async function registerViewer(server: McpServer, { fence, html, viewDir, media, library }: ViewerParts): Promise<void> {
	const metadata = { ui: { prefersBorder: false, permissions: { clipboardWrite: {} }, csp: { resourceDomains: [media.origin] } } };
	registerAppResource(server, "Viewer", VIEWER_VIEW_URI, { _meta: metadata }, async () => ({
		contents: [{ uri: VIEWER_VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: metadata }],
	}));
	for (const entry of await readdir(viewDir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || entry.name === "index.html") continue;
		const mimeType = MIME[extname(entry.name)];
		if (mimeType === undefined) throw new Error(`Unsupported viewer View asset: ${entry.name}`);
		const path = join(entry.parentPath, entry.name);
		const relative = path.slice(viewDir.replace(/[\\/]$/, "").length + 1).replaceAll("\\", "/");
		const uri = `ui://viewer/${relative}`;
		server.registerResource(relative, uri, { mimeType }, async () => {
			const bytes = await readFile(path);
			return {
				contents: [TEXT_MIME[mimeType] ? { uri, mimeType, text: bytes.toString("utf8") } : { uri, mimeType, blob: bytes.toString("base64") }],
			};
		});
	}

	registerAppTool(
		server,
		"view_file",
		{
			title: "View file",
			description:
				"Open a file from the user's computer in the viewer beside the conversation, as a tab. Renders images, PDF, HTML, Markdown, Word (.docx), PowerPoint (.pptx), Excel (.xlsx) and plain text, and plays audio and video; other files show a file card. " +
				"Pass the ABSOLUTE path of a file you created or were pointed at; opening the same file again refreshes its tab. annotate: true opens it ready for the user to mark up (a moment on a recording, an element on a page). " +
				"Only folders the user allowed are readable (their personal vault and the folders in VIEWER_ROOTS); anything else, and secrets such as .env files and keys, is refused with the reason.",
			inputSchema: {
				path: z.string().min(1).max(4096).describe("Absolute path of the file to open"),
				filename: z.string().min(1).max(255).optional().describe("Name to show in the tab; defaults to the file's own name"),
				annotate: z.boolean().optional().describe("Open in annotate mode, so the user can mark the file up"),
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: { ui: { resourceUri: VIEWER_VIEW_URI } },
		},
		({ path, filename, annotate }, extra) => openViewedFile(fence, { path, filename, annotate }, extra._meta),
	);

	registerAppTool(
		server,
		"read_file_chunk",
		{
			title: "Read file chunk",
			description: `Read a byte range of a file the viewer may open, base64-encoded (at most ${MAX_CHUNK_BYTES} bytes per call). The View streams a document through this; it is not for the model.`,
			inputSchema: {
				path: z.string().min(1).max(4096),
				offset: z.number().int().min(0),
				length: z.number().int().min(0).max(MAX_CHUNK_BYTES),
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: APP_ONLY,
		},
		async ({ path, offset, length }, extra) => {
			const verdict = await fence.check(path, extra._meta);
			if (!verdict.ok) return failure(verdict.reason);
			try {
				const chunk = await readChunk(verdict.real, offset, length);
				return {
					content: [{ type: "text", text: `Read ${chunk.length} of ${chunk.size} bytes at offset ${chunk.offset}.` }],
					structuredContent: { ...chunk },
				};
			} catch (error) {
				return failure(`"${path}" cannot be read: ${describeError(error)}`);
			}
		},
	);

	registerAppTool(server, "open_media", {
		inputSchema: { path: z.string().min(1).max(4096), size: z.number().int().nonnegative(), mtimeMs: z.number(), token: mediaTokenSchema },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		_meta: APP_ONLY,
	}, async ({ path, size, mtimeMs, token }, extra) => {
		try {
			const source = await media.acquire(path, size, mtimeMs, extra._meta, token);
			return { content: [{ type: "text", text: "Recording ready for range playback." }], structuredContent: { ...source } };
		} catch (error) {
			return failure(describeError(error));
		}
	});
	registerAppTool(server, "close_media", {
		inputSchema: { token: mediaTokenSchema },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		_meta: APP_ONLY,
	}, async ({ token }) => {
		media.release(token);
		return { content: [{ type: "text", text: "Recording released." }], structuredContent: {} };
	});
	registerAppTool(server, "renew_media", {
		inputSchema: { token: mediaTokenSchema },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		_meta: APP_ONLY,
	}, async ({ token }) => {
		const alive = media.renew(token);
		return { content: [{ type: "text", text: alive ? "Recording still held." : "Recording no longer held." }], structuredContent: { alive } };
	});

	if (library !== undefined) registerLibraryTools(server, { library, fence, media });
}
