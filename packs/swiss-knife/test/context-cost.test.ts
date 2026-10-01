import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeTools, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { bucketRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
import { buildRuleFromMarkdown } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { StreamRuleMatcher } from "@oh-my-pi/pi-coding-agent/stream-rules/matcher";
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

	for (const folder of ["skills", "prompts"]) {
		test(`the plugin ships no ${folder}/ folder: a skill or prompt is resident context on every turn`, async () => {
			const exists = await stat(join(PACK, folder)).then(
				() => true,
				() => false,
			);
			expect(exists, `${folder}/ exists in the plugin root (doc 86 section 8 forbids it)`).toBe(false);
		});
	}
});

// The plugin also ships stream rules (`rules/ban-comments*.md`), and a rule is only resident
// context when the engine puts it in the system prompt on every turn: an always-apply body,
// or a rulebook line (any rule that has a `description`). A STREAM rule is neither.
// `bucketRules` (omp/packages/coding-agent/src/capability/rule-buckets.ts) registers a rule
// whose `condition` the stream matcher accepts and moves on, so it reaches no prompt bucket;
// the engine's own context-cost probe lists it as `loadMode: "stream", resident: 0, onUse:
// <body tokens>` (omp/packages/coding-agent/src/context-cost/measure.ts), and
// docs/design/81-stream-rules.md section 1 has the body injected only at the moment the model
// is about to break the rule. So a stream rule costs 0 tokens until it fires.
//
// That holds only while the matcher ACCEPTS the condition. A rejected one (an engine that
// cannot run `except:`, a lookaround) falls through to the next bucket, and these rules carry
// a `description`, so it would become a rulebook line, resident on every turn. The test runs
// the real parser and the real bucketing over the shipped files instead of trusting their
// front matter; plugin.json carries the engine floor (`requires.dimension`) that honours `except:`.
describe("the context cost of the shipped rules", () => {
	test("every rule is a stream rule the engine accepts, so none is resident on any turn", async () => {
		const folder = join(PACK, "rules");
		const files = (await readdir(folder)).filter(file => file.endsWith(".md")).sort();
		expect(files.length, "rules/ holds the plugin's rules; a plugin without any has no use for this test").toBeGreaterThan(0);
		const rules = await Promise.all(
			files.map(async file => {
				const path = join(folder, file);
				const source = { provider: "swiss-knife", providerName: "swiss-knife", path, level: "user" } as const;
				return buildRuleFromMarkdown(basename(file), await readFile(path, "utf8"), path, source);
			}),
		);

		const matcher = new StreamRuleMatcher();
		const { rulebookRules, alwaysApplyRules } = bucketRules(rules, matcher);

		expect(
			[...rulebookRules, ...alwaysApplyRules].map(rule => rule.name),
			"these rules would be resident context on every turn: the stream matcher did not take their condition",
		).toEqual([]);
		expect(matcher.getRules().map(rule => rule.name).sort()).toEqual(rules.map(rule => rule.name).sort());
	});
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
