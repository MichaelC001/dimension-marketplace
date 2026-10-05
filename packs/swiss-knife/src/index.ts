// swiss-knife: small quality-of-life tools, one per capability, none of them
// resident context beyond its own schema. `present` first (doc 86).
//
// Module state: none. The factory binds one tool per session and everything
// below it is a pure function of its arguments, which is what lets the pack
// declare `sharedModule` and skip re-evaluating this graph on every session.
//
// Types come from the OMP host and are erased. The one runtime import from the
// Dimension SDK (`@dimension/sdk/presentation`: `classifyFile`, the item cap) is
// inlined by `scripts/build.mjs` into `dist/index.mjs`, the committed bundle the
// host loads, so an installed copy needs no node_modules.

import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type PresentDetails, presentPaths } from "./present";

export default function swissKnife(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "present",
		label: "Present",
		// It reads a file the agent could already read and shows it to the human:
		// never a prompt, never a write.
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
			return { content: [{ type: "text", text }], details };
		},
	});
}
