import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { YAML } from "bun";
import { buildCatalog } from "../src/catalog.js";

const DIR = join(import.meta.dir, "..", "voice-profiles");
const HALVES = ["speak", "listen", "converse"] as const;

interface Choice {
	readonly provider: string;
	readonly model: string;
	readonly voice?: string;
	readonly language?: string;
}

async function loadProfiles(): Promise<Map<string, Record<(typeof HALVES)[number], Choice[]>>> {
	const profiles = new Map<string, Record<(typeof HALVES)[number], Choice[]>>();
	for (const file of await readdir(DIR)) {
		const parsed = YAML.parse(await Bun.file(join(DIR, file)).text()) as Record<string, Choice[] | undefined>;
		profiles.set(file.replace(/\.yml$/, ""), {
			speak: parsed.speak ?? [],
			listen: parsed.listen ?? [],
			converse: parsed.converse ?? [],
		});
	}
	return profiles;
}

describe("the voice profiles this pack ships", () => {
	test("every ElevenLabs choice names a model and voice the pack's own catalog offers for that half", async () => {
		const catalog = buildCatalog([]);
		for (const [name, profile] of await loadProfiles()) {
			for (const half of HALVES) {
				for (const choice of profile[half].filter(entry => entry.provider === "elevenlabs")) {
					const model = catalog[half]?.find(candidate => candidate.id === choice.model);
					expect({ name, half, model: choice.model, offered: model !== undefined }).toEqual({
						name,
						half,
						model: choice.model,
						offered: true,
					});
					if (choice.voice) expect(model?.voices?.map(voice => voice.id)).toContain(choice.voice);
				}
			}
		}
	});

	test("eleven listens and speaks with ElevenLabs and nothing else: no on-device fallback that would download a model unasked", async () => {
		const eleven = (await loadProfiles()).get("eleven");

		expect(eleven).toBeDefined();
		expect(eleven?.listen.map(choice => [choice.provider, choice.model])).toEqual([
			["elevenlabs", "scribe_v2_realtime"],
		]);
		expect(eleven?.speak.map(choice => [choice.provider, choice.model])).toEqual([["elevenlabs", "eleven_v4_turbo"]]);
		expect(eleven?.converse).toEqual([]);
		const named = [...(eleven?.listen ?? []), ...(eleven?.speak ?? [])].map(choice => choice.provider);
		expect(named).not.toContain("local");
	});

	test("live-eleven is still the live profile, next to eleven", async () => {
		const profiles = await loadProfiles();

		expect([...profiles.keys()].sort()).toEqual(["eleven", "live-eleven"]);
		expect(profiles.get("live-eleven")?.converse.map(choice => choice.provider)).toEqual(["elevenlabs"]);
	});
});
