import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readGenerativeUi, UI_LIMITS, UI_NODE_TYPES } from "@dimension/sdk/generative-ui";
import { loadTools, type RegisteredTool, rejection } from "./fixtures";

const SOURCE = join(import.meta.dir, "..", "src", "index.ts");

async function tool(): Promise<RegisteredTool> {
	const [registered, ...rest] = await loadTools(SOURCE);
	if (!registered || rest.length > 0) throw new Error("the pack registers exactly one tool");
	return registered;
}

const LISBON = {
	title: "Lisbon in three days",
	blocks: [
		{ type: "callout", tone: "info", text: "Book the **Belem** tickets ahead." },
		{
			type: "tabs",
			tabs: [
				{
					label: "Day 1",
					children: [
						{
							type: "timeline",
							items: [
								{ time: "09:00", title: "Pasteis de Belem", tag: "food" },
								{ time: "11:00", title: "Jeronimos Monastery", detail: "Allow 90 minutes" },
							],
						},
					],
				},
			],
		},
		{ type: "checklist", title: "Pack", items: ["Passport", { text: "Charger", checked: true }], submit: "Send my list" },
		{ type: "button", label: "Plan day 2", message: "Plan day 2 in more detail" },
	],
};

describe("the tool", () => {
	test("is one read-tier tool: showing a screen to the user never prompts", async () => {
		const registered = await tool();
		expect(registered.name).toBe("render_ui");
		expect(registered.approval).toBe("read");
	});

	test("its description is generated from the palette, so it can never name a block the renderer cannot draw", async () => {
		const { description } = await tool();
		for (const type of UI_NODE_TYPES) expect(description).toContain(`${type}{`);
		expect(description).toContain(`${UI_LIMITS.maxNodes} blocks`);
	});

	test("a valid interface comes back as a one-paragraph receipt for the model and the spec in details", async () => {
		const result = await (await tool()).execute("call-1", LISBON);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.text).toContain("Shown to the user");
		expect(result.content[0]?.text).toContain("Lisbon in three days");
		expect(result.content[0]?.text.length).toBeLessThan(600);
		expect(readGenerativeUi(result.details)?.blocks).toHaveLength(4);
	});

	test("the receipt stays small however large the interface is: the spec never rides back as model context", async () => {
		const rows = Array.from({ length: 150 }, (_, index) => [`Row ${index}`, "x".repeat(60), index]);
		const result = await (await tool()).execute("call-2", {
			blocks: [{ type: "table", columns: ["Name", "Note", "N"], rows }],
		});
		expect(JSON.stringify(result.details).length).toBeGreaterThan(10_000);
		expect(result.content[0]?.text.length).toBeLessThan(600);
	});

	test("what it stores survives a JSON round trip and is read back identical: a reopened session redraws the same interface", async () => {
		const result = await (await tool()).execute("call-3", LISBON);
		const stored: unknown = JSON.parse(JSON.stringify(result.details));
		expect(readGenerativeUi(stored)).toEqual(readGenerativeUi(result.details));
		expect(readGenerativeUi(stored)).not.toBeNull();
	});

	test("warnings about ignored properties reach the model without failing the call", async () => {
		const result = await (await tool()).execute("call-4", {
			blocks: [{ type: "grid", colums: 3, children: [{ type: "divider" }] }],
		});
		expect(result.content[0]?.text).toContain("Ignored");
		expect(result.content[0]?.text).toContain("columns");
	});
});

describe("a bad interface is refused and the model is told exactly what to fix", () => {
	test("an unknown block type names the right one and the path", async () => {
		const message = await rejection((await tool()).execute("e1", { blocks: [{ type: "kpi", items: [] }] }));
		expect(message).toContain("NOT shown");
		expect(message).toContain("blocks[0]");
		expect(message).toContain('use "stats"');
	});

	test("a missing required prop, a wrong type and a wide table row are all reported in one answer", async () => {
		const message = await rejection(
			(await tool()).execute("e2", {
				blocks: [
					{ type: "callout" },
					{ type: "grid", columns: "wide", children: [{ type: "divider" }] },
					{ type: "table", columns: ["a"], rows: [["x", "y"]] },
				],
			}),
		);
		expect(message).toContain("blocks[0].text");
		expect(message).toContain("blocks[1].columns");
		expect(message).toContain("blocks[2].rows[0]");
	});

	test("script and HTML in any string are refused, not rendered, not stripped", async () => {
		const message = await rejection(
			(await tool()).execute("e3", { blocks: [{ type: "text", text: "hi <script>alert(1)</script>" }] }),
		);
		expect(message).toContain("HTML or script-like markup");
	});

	test("an oversized interface is refused before it is walked, with the limit named", async () => {
		const big = "y".repeat(UI_LIMITS.maxText);
		const blocks = Array.from({ length: 30 }, () => ({ type: "text", text: big }));
		const message = await rejection((await tool()).execute("e4", { blocks }));
		expect(message).toContain("KiB");
	});

	test("nesting past the depth limit is refused", async () => {
		let node: unknown = { type: "divider" };
		for (let i = 0; i < UI_LIMITS.maxDepth + 1; i++) node = { type: "stack", children: [node] };
		const message = await rejection((await tool()).execute("e5", { blocks: [node] }));
		expect(message).toContain("levels deep");
	});

	test("a link or image that is not https is refused", async () => {
		const message = await rejection(
			(await tool()).execute("e6", {
				blocks: [
					{ type: "link", label: "x", url: "javascript:alert(1)" },
					{ type: "image", url: "http://example.com/a.png", alt: "x" },
				],
			}),
		);
		expect(message).toContain("blocks[0].url");
		expect(message).toContain("blocks[1].url");
	});

	test("the argument schema itself accepts the documented envelope and refuses a missing page", async () => {
		const { parameters } = await tool();
		expect(parameters.safeParse({ title: "t", blocks: [] }).success).toBe(true);
		expect(parameters.safeParse({ title: "t" }).success).toBe(false);
	});
});
