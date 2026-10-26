import { basename } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readRange } from "./chunk";
import { ANNOTATE_META_KEY, TAB_META_KEY, type ViewedFile } from "./contract";
import type { Fence } from "./fence";
import { detectKind, KIND_HEAD_BYTES } from "./kind";

export const APP_ONLY = { ui: { visibility: ["app"] as ("app" | "model")[] } };

export const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

export function describeError(error: unknown): string {
	if (error instanceof RangeError) return error.message;
	if (!(error instanceof Error)) return String(error);
	const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
	return `${error.message}${code}`;
}

export interface OpenRequest {
	readonly path: string;
	readonly filename?: string | undefined;
	readonly annotate?: boolean | undefined;
}

export async function openViewedFile(fence: Fence, request: OpenRequest, meta: unknown): Promise<CallToolResult> {
	const verdict = await fence.check(request.path, meta);
	if (!verdict.ok) return failure(verdict.reason);
	try {
		const head = await readRange(verdict.real, 0, KIND_HEAD_BYTES);
		const shown = request.filename ?? basename(verdict.real);
		const file: ViewedFile = {
			path: verdict.real,
			filename: shown,
			kind: detectKind(shown, head.bytes, head.size),
			size: head.size,
			mtimeMs: head.mtimeMs,
		};
		return {
			content: [{ type: "text", text: `Opened ${file.filename} (${file.kind}, ${file.size} bytes) in the viewer.` }],
			structuredContent: { ...file },
			_meta: { [TAB_META_KEY]: { key: file.path }, ...(request.annotate === true ? { [ANNOTATE_META_KEY]: true } : {}) },
		};
	} catch (error) {
		return failure(`"${request.path}" cannot be opened: ${describeError(error)}`);
	}
}
