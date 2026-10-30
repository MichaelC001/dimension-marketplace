import { ASP_MAX_PEN_POINTS, ASP_MAX_QUOTE, ASP_MAX_QUOTE_CONTEXT, type Audience, parseAudience } from "@dimension/sdk/artifact-share";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage } from "../../../src/library/errors";
import { APP_ONLY, failure } from "../tool-support";
import { StoredFileError } from "./fs-json";
import { HostRequestError } from "./host-api";
import { HostConfigError } from "./hosts";
import type { ShareRuntime } from "./runtime";
import { ShareError } from "./shares";

const MAX_IDS = 200;

const audienceSchema = z
	.object({
		kind: z.enum(["link", "signin"]),
		emails: z.array(z.string().max(320)).max(500).optional(),
		domains: z.array(z.string().max(320)).max(50).optional(),
	})
	.transform((value, context): Audience => {
		const audience = parseAudience(value);
		if (audience === undefined) {
			context.addIssue({ code: "custom", message: "that audience is not valid" });
			return z.NEVER;
		}
		return audience;
	});

const unit = z.number().min(0).max(1);
const point = z.object({ x: unit, y: unit });
const shapeSchema = z.union([
	z.object({ kind: z.literal("pin"), at: point }),
	z.object({ kind: z.enum(["box", "ellipse", "arrow"]), from: point, to: point }),
	z.object({ kind: z.literal("pen"), points: z.array(point).min(2).max(ASP_MAX_PEN_POINTS) }),
]);
const quoteSchema = z.object({
	quote: z.string().min(1).max(ASP_MAX_QUOTE),
	prefix: z.string().max(ASP_MAX_QUOTE_CONTEXT),
	suffix: z.string().max(ASP_MAX_QUOTE_CONTEXT),
});
const millis = z.number().int().min(0);
const anchorSchema = z
	.object({
		startMs: millis.optional(),
		endMs: millis.optional(),
		page: z.number().int().min(1).optional(),
		shape: shapeSchema.optional(),
		text: quoteSchema.optional(),
	})
	.refine(anchor => anchor.endMs === undefined || (anchor.startMs !== undefined && anchor.endMs >= anchor.startMs), "endMs needs a startMs at or before it")
	.refine(anchor => anchor.startMs !== undefined || anchor.page !== undefined || anchor.shape !== undefined || anchor.text !== undefined, "an anchor needs a time, a page, a shape or a passage");

const expiresInDays = z.number().int().min(1).max(3650);
const shareId = z.string().min(1).max(128);
const artifactId = z.string().min(1).max(128);

const options = (title: string, extra: { readonly destructive?: boolean; readonly readOnly?: boolean } = {}) => ({
	title,
	annotations: {
		readOnlyHint: extra.readOnly ?? false,
		destructiveHint: extra.destructive ?? false,
		idempotentHint: extra.readOnly ?? false,
		openWorldHint: true,
	},
	_meta: APP_ONLY,
});

function success(text: string, structuredContent: Record<string, unknown>): CallToolResult {
	return { content: [{ type: "text", text }], structuredContent };
}

async function guarded(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ShareError || error instanceof HostConfigError || error instanceof HostRequestError || error instanceof StoredFileError) {
			return failure(error.message);
		}
		const detail = errorMessage(error);
		console.error(`share: ${detail}`);
		return failure(`sharing failed: ${detail}`);
	}
}

export function registerShareTools(server: McpServer, runtime: ShareRuntime): void {
	const { service, directory } = runtime;

	registerAppTool(server, "share_hosts", { ...options("Share hosts", { readOnly: true }), inputSchema: {} }, () =>
		guarded(async () => success("Share hosts listed.", { ...(await directory.list()) })),
	);

	registerAppTool(
		server,
		"share_host_add",
		{
			...options("Add a share server"),
			inputSchema: {
				pairing: z.string().min(1).max(4096).optional(),
				url: z.string().min(1).max(2048).optional(),
				token: z.string().max(512).optional(),
				kind: z.enum(["self", "company"]).optional(),
			},
		},
		({ pairing, url, token, kind }) =>
			guarded(async () => {
				if (pairing === undefined && url === undefined) throw new ShareError("paste the pairing link, or the server address and its token");
				const host = await directory.add(
					pairing !== undefined
						? { pairing, kind: kind ?? "self" }
						: { url: url as string, kind: kind ?? "self", ...(token === undefined || token.trim() === "" ? {} : { token }) },
				);
				runtime.reconcile();
				return success(`Added ${host.name}.`, { host });
			}),
	);

	registerAppTool(server, "share_host_remove", { ...options("Remove a share server", { destructive: true }), inputSchema: { id: z.string().min(1).max(64) } }, ({ id }) =>
		guarded(async () => {
			await directory.remove(id);
			return success("Server removed.", {});
		}),
	);

	registerAppTool(
		server,
		"share_create",
		{
			...options("Share a file"),
			inputSchema: {
				artifactId,
				host: z.string().min(1).max(64),
				audience: audienceSchema,
				expiresInDays: expiresInDays.optional(),
				allowComments: z.boolean(),
			},
		},
		(input) =>
			guarded(async () => {
				const share = await service.create({
					artifactId: input.artifactId,
					host: input.host,
					audience: input.audience,
					allowComments: input.allowComments,
					...(input.expiresInDays === undefined ? {} : { expiresInDays: input.expiresInDays }),
				});
				return success("Link created.", { share });
			}),
	);

	registerAppTool(server, "share_progress", { ...options("Share progress", { readOnly: true }), inputSchema: { artifactId } }, ({ artifactId: id }) =>
		guarded(async () => success("Progress read.", { ...service.progress(id) })),
	);

	registerAppTool(
		server,
		"share_update",
		{
			...options("Change a share"),
			inputSchema: { shareId, audience: audienceSchema.optional(), expiresInDays: expiresInDays.optional(), allowComments: z.boolean().optional() },
		},
		(input) =>
			guarded(async () => {
				const share = await service.update({
					shareId: input.shareId,
					...(input.audience === undefined ? {} : { audience: input.audience }),
					...(input.expiresInDays === undefined ? {} : { expiresInDays: input.expiresInDays }),
					...(input.allowComments === undefined ? {} : { allowComments: input.allowComments }),
				});
				return success("Share updated.", { share });
			}),
	);

	registerAppTool(server, "share_new_version", { ...options("Publish a new version"), inputSchema: { shareId } }, ({ shareId: id }) =>
		guarded(async () => success("New version published.", { share: await service.newVersion(id) })),
	);

	registerAppTool(server, "share_revoke", { ...options("Revoke a link", { destructive: true }), inputSchema: { shareId } }, ({ shareId: id }) =>
		guarded(async () => success("Link revoked.", { ...(await service.revoke(id)) })),
	);

	registerAppTool(server, "share_link", { ...options("Read a share link", { readOnly: true }), inputSchema: { shareId } }, ({ shareId: id }) =>
		guarded(async () => success("Link read.", { link: service.linkOf(id) })),
	);

	registerAppTool(server, "share_comments", { ...options("Share comments", { readOnly: true }), inputSchema: { artifactId } }, ({ artifactId: id }) =>
		guarded(async () => success("Comments read.", { comments: await service.comments(id) })),
	);

	registerAppTool(
		server,
		"share_reply",
		{ ...options("Reply to comments"), inputSchema: { shareId, body: z.string().min(1).max(8000), anchor: anchorSchema.optional() } },
		({ shareId: id, body, anchor }) =>
			guarded(async () => success("Reply posted.", { comment: await service.reply(id, body, anchor) })),
	);

	registerAppTool(
		server,
		"share_mark_read",
		{ ...options("Mark comments read"), inputSchema: { ids: z.array(z.string().min(1).max(128)).max(MAX_IDS) } },
		({ ids }) =>
			guarded(async () => success("Marked read.", { revision: service.markRead(ids) })),
	);
}
