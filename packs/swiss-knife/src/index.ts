import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { registerArtifactsTool } from "./artifacts";
import { stampPresented } from "./library/present-stamp";
import { sharedLibrary } from "./library/shared";
import type { Library } from "./library/types";
import { type PresentDetails, presentPaths } from "./present";

export interface SwissKnifeDeps {
	readonly library: () => Promise<Library>;
}

export default function swissKnife(pi: ExtensionAPI, deps: SwissKnifeDeps = { library: sharedLibrary }): void {
	const z = pi.zod;

	pi.registerTool({
		name: "present",
		label: "Present",
		approval: "read",
		description:
			"Show the user one or more files (images, PDFs, documents, decks, sheets) as cards they can open and annotate.",
		parameters: z.object({
			path: z
				.union([z.string(), z.array(z.string())])
				.describe("Absolute file path, or an array of up to 12 paths."),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<PresentDetails>> {
			const { text, details } = await presentPaths(params.path, { cwd: ctx.cwd, signal });
			try {
				await stampPresented(await deps.library(), details, { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
			} catch (error) {
				console.error(`library: presented files were not indexed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { content: [{ type: "text", text }], details };
		},
	});

	registerArtifactsTool(pi, deps.library);
}
