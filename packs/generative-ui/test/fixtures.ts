import { pathToFileURL } from "node:url";
import { z } from "zod";

export interface ToolResult {
	readonly content: readonly { readonly type: string; readonly text: string }[];
	readonly details: Record<string, unknown>;
}

export interface RegisteredTool {
	readonly name: string;
	readonly description: string;
	readonly approval?: string;
	readonly parameters: { safeParse(value: unknown): { success: boolean } };
	execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		"execute" in value &&
		typeof value.execute === "function" &&
		"parameters" in value
	);
}

export async function loadTools(entry: string): Promise<readonly RegisteredTool[]> {
	const mod: unknown = await import(pathToFileURL(entry).href);
	if (typeof mod !== "object" || mod === null || !("default" in mod) || typeof mod.default !== "function") {
		throw new Error(`${entry} has no default-exported extension factory`);
	}
	const factory = mod.default as (pi: { zod: typeof z; registerTool: (definition: unknown) => void }) => void;
	const raw: unknown[] = [];
	factory({ zod: z, registerTool: definition => raw.push(definition) });
	return raw.filter(isRegisteredTool);
}

export async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the call to be refused");
}
