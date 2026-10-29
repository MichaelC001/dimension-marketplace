import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	describeUiPalette,
	encodeUiSpec,
	formatUiIssues,
	GENERATIVE_UI_DETAILS_KEY,
	parseUiSpec,
	summarizeUiSpec,
	UI_LIMITS,
	type UiSpecWire,
} from "@dimension/sdk/generative-ui";

export const TOOL_NAME = "render_ui";

export interface RenderUiDetails {
	readonly generativeUi: UiSpecWire;
}

export function toolDescription(): string {
	return [
		"Show the user a designed interface instead of a wall of text: a trip plan, a comparison, a checklist, a schedule, a summary with numbers. Use it when structure helps the reader; answer ordinary questions in plain chat.",
		"Call it once with the WHOLE page, then reply with at most one short sentence: the interface is already on screen, so never repeat its content.",
		"Input: {title?, blocks:[block,...]}. A block is {type, ...props}; `name?` is optional; `children` are blocks. Strings are plain text that may use **bold**, *italic*, `code` and [label](https://url). No HTML, no scripts, https links only.",
		describeUiPalette(),
		"A button sends its `message` as the user's next message when clicked: word it as the user would say it. A checklist with `submit` sends the ticked and unticked items back the same way.",
		"Good pages: a heading, short blocks, tabs for days or options, a table or comparison for options, stats and a chart for numbers, one callout for the thing to remember.",
		`Limits: ${UI_LIMITS.maxNodes} blocks, ${UI_LIMITS.maxDepth} levels deep, ${UI_LIMITS.maxSpecBytes / 1024} KiB. A bad block is refused with the exact path to fix: correct it and call again.`,
	].join("\n");
}

export default function generativeUi(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: TOOL_NAME,
		label: "Interface",
		approval: "read",
		description: toolDescription(),
		parameters: z.object({
			title: z.string().optional().describe("Heading of the whole interface."),
			blocks: z.array(z.unknown()).describe("The page: blocks from the grammar above, top to bottom."),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<RenderUiDetails>> {
			const result = parseUiSpec(params);
			if (!result.ok) throw new Error(formatUiIssues(result));
			return {
				content: [{ type: "text", text: summarizeUiSpec(result.spec, result.stats, result.warnings) }],
				details: { [GENERATIVE_UI_DETAILS_KEY]: encodeUiSpec(result.spec) },
			};
		},
	});
}
