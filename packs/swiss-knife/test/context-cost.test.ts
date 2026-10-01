import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeTools, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { loadTools } from "./fixtures";

// The resident cost of `present`: its wire entry (name, description, parameters as the
// model is sent them, intent field included) is in context on every turn of every
// session that has the pack, whether or not the tool is ever called.
//
// Measured 2026-10-01 (Bun 1.3.14, o200k strict): 105 tokens. OMP's live
// `probeAcpSessionContext` (isolated home, deferredToolNames: [], o200k_base, same Bun, same
// date) agrees and adds the rest: `present` is eager with resident 111 = 105 wire entry +
// 6 system-prompt marginal (its line in the tool inventory), onUse 0. This assertion stays on
// the 105 wire number.
//
// A later edit that grows the description or the schema must raise BUDGET deliberately, in
// the same change that makes the tool dearer: that is the point of the number.
const BUDGET = 115;

const DIST = join(import.meta.dir, "..", "dist", "index.mjs");
const PACK = join(import.meta.dir, "..");

// `normalizeTools` takes the agent's tool type; the extension's registered definition has the
// same name/description/parameters it reads, and the rest of that type is never touched.
type AgentTools = Parameters<typeof normalizeTools>[0];

async function wireEntry(injectIntent: boolean) {
	const { raw } = await loadTools(DIST);
	const [entry] = normalizeTools(raw as unknown as AgentTools, { injectIntent }) ?? [];
	if (entry === undefined) throw new Error("the shipped bundle registered no tool");
	return entry;
}

describe("the context cost of the shipped `present` tool", () => {
	test("its wire entry stays inside the token budget", async () => {
		const entry = await wireEntry(true);
		const json = JSON.stringify({ name: entry.name, description: entry.description, parameters: entry.parameters });
		const tokens = new Tokenizer(null).countTokens(json, "strict");
		expect(tokens, `present now costs ${tokens} resident tokens; raise BUDGET deliberately if that is intended`).toBeLessThanOrEqual(BUDGET);
		expect(entry.name).toBe("present");
	});

	for (const folder of ["skills", "rules", "prompts"]) {
		test(`the pack ships no ${folder}/ folder: a rule or prompt is resident context on every turn`, async () => {
			const exists = await stat(join(PACK, folder)).then(
				() => true,
				() => false,
			);
			expect(exists, `${folder}/ exists in the pack root (doc 86 section 8 forbids it)`).toBe(false);
		});
	}
});

/** The required and declared field names of a tool's wire schema, read off its JSON (what is sent). */
async function wireFields(injectIntent: boolean): Promise<{ required: string[]; properties: string[]; schema: unknown }> {
	const schema: unknown = JSON.parse(JSON.stringify((await wireEntry(injectIntent)).parameters));
	const required: string[] = [];
	const properties: string[] = [];
	if (typeof schema === "object" && schema !== null) {
		if ("required" in schema && Array.isArray(schema.required)) {
			for (const name of schema.required) if (typeof name === "string") required.push(name);
		}
		if ("properties" in schema && typeof schema.properties === "object" && schema.properties !== null) {
			properties.push(...Object.keys(schema.properties));
		}
	}
	return { required, properties, schema };
}

describe("the parameters of `present`", () => {
	test("the model is asked for a path and nothing else (besides the intent OMP adds itself)", async () => {
		const own = await wireFields(false);
		expect(own.required).toEqual(["path"]);
		expect(own.properties).toEqual(["path"]);
		expect(own.schema).toMatchObject({
			properties: { path: { anyOf: expect.arrayContaining([{ type: "string" }, { type: "array", items: { type: "string" } }]) } },
		});

		// With the intent field injected, the only field beyond `path` is the one OMP adds.
		const sent = await wireFields(true);
		expect(sent.properties).toContain("path");
		expect(sent.properties).toHaveLength(2);
		expect(sent.required.sort()).toEqual([...sent.properties].sort());
	});

	test("the schema accepts one path or a list of them, and rejects anything else", async () => {
		const { tools } = await loadTools(DIST);
		const [tool] = tools;
		const accepts = (value: unknown) => tool?.parameters.safeParse(value).success;
		expect(accepts({ path: "C:\\Work\\a.png" })).toBe(true);
		expect(accepts({ path: ["/a.png", "/b.pdf"] })).toBe(true);
		expect(accepts({})).toBe(false);
		expect(accepts({ path: 3 })).toBe(false);
		expect(accepts({ path: [1] })).toBe(false);
		expect(accepts("a.png")).toBe(false);
	});
});
