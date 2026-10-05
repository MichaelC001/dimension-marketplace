/** WHAT BREAKS FOR THE USER IF THIS GOES RED: the Voice pane crashes (and takes the whole Settings screen's pane with
 *  it) on a fact shape the engine sends that this bundle was not built against, or it tells the user the wrong thing
 *  about what will actually speak: "speaks with ElevenLabs" when the key is missing, or "cannot speak" when the
 *  on-device voice would. The facts are an untrusted boundary: they come from an engine newer or older than the pane. */
import { describe, expect, test } from "bun:test";
import { engineView, headline, liveDisclosure, liveHeadline, modelRows, profileViews, readAgents, readModelsFact, readProfilesFact } from "../src/model";

const ELEVEN = { provider: "elevenlabs", model: "eleven_v4_turbo", voice: "EXAVITQu4vr4xnSDxMaL" };
const KOKORO = { provider: "local", model: "kokoro", voice: "af_heart" };

function fact(over: { elevenlabs?: unknown; local?: unknown; profiles?: unknown; default?: unknown } = {}) {
	return {
		profiles: over.profiles ?? [
			{ name: "aether", layer: "pack", description: "Warm", speak: [ELEVEN, KOKORO] },
			{ name: "local", layer: "builtin", speak: [KOKORO] },
		],
		providers: [
			{ id: "elevenlabs", label: "ElevenLabs", speak: over.elevenlabs ?? { ready: true } },
			{ id: "local", label: "On this machine", speak: over.local ?? { ready: true }, listen: { ready: true } },
		],
		default: over.default ?? { name: "aether", source: "default", why: "your voice.default" },
	};
}

const viewOf = (raw: unknown) => {
	const view = readProfilesFact(raw);
	if (!view) throw new Error("fact did not parse");
	return view;
};

describe("reading the speech/profiles fact", () => {
	test("an absent or non-object fact is 'no speech runtime', not an error", () => {
		expect(readProfilesFact(undefined)).toBeNull();
		expect(readProfilesFact("nope")).toBeNull();
		expect(readProfilesFact([])).toBeNull();
		expect(headline(null).tone).toBe("off");
	});

	test("a malformed row is dropped alone: the rest of the pane still renders", () => {
		const view = viewOf(
			fact({
				profiles: [
					{ name: "good", layer: "user", speak: [ELEVEN, { provider: "local" }, "junk", { model: "x" }] },
					{ name: "no-layer", speak: [ELEVEN] },
					{ name: "weird-layer", layer: "galaxy", speak: [ELEVEN] },
					null,
					42,
				],
			}),
		);
		expect(view.profiles.map(profile => profile.name)).toEqual(["good"]);
		expect(view.profiles[0]?.speak).toEqual([ELEVEN]);
	});

	test("a layer name that is a prototype property is not a layer", () => {
		const view = viewOf(fact({ profiles: [{ name: "p", layer: "toString", speak: [ELEVEN] }] }));
		expect(view.profiles).toEqual([]);
	});
});

describe("what a voice will actually speak with", () => {
	test("the first READY choice speaks, not the first listed", () => {
		const [aether] = profileViews(viewOf(fact({ elevenlabs: { ready: false, reason: "needs-key" } })));
		expect(aether?.steps.map(step => step.state.text)).toEqual(["Needs an API key", "Ready"]);
		expect(aether?.speaksWith).toEqual({ label: "On this machine", fellBack: true, because: "ElevenLabs" });
	});

	test("with every listed choice down, the on-device voice is the last resort and it says so", () => {
		const [aether] = profileViews(
			viewOf(
				fact({
					profiles: [{ name: "aether", layer: "pack", speak: [ELEVEN] }],
					elevenlabs: { ready: false, reason: "needs-key" },
				}),
			),
		);
		expect(aether?.speaksWith).toEqual({ label: "On this machine", fellBack: true, because: "ElevenLabs" });
	});

	test("nothing ready anywhere: it cannot speak, and the headline names the default voice", () => {
		const view = viewOf(
			fact({ elevenlabs: { ready: false, reason: "needs-key" }, local: { ready: false, reason: "needs-download" } }),
		);
		expect(profileViews(view)[0]?.speaksWith).toBeNull();
		expect(headline(view)).toEqual({ tone: "warn", text: "The default voice, aether, has nothing ready to speak with." });
	});

	test("a profile naming a provider that is not installed shows 'Not installed', never a guessed label", () => {
		const [ghost] = profileViews(
			viewOf(fact({ profiles: [{ name: "ghost", layer: "user", speak: [{ provider: "xai", model: "grok-voice", voice: "v" }] }] })),
		);
		expect(ghost?.steps[0]).toMatchObject({ providerLabel: "xai", ready: false, state: { text: "Not installed" } });
	});

	test("the default is marked on exactly one profile", () => {
		const defaults = profileViews(viewOf(fact())).filter(profile => profile.isDefault);
		expect(defaults.map(profile => profile.name)).toEqual(["aether"]);
	});

	test("a healthy default reads as a plain sentence, and a fallback says which choice was not ready", () => {
		expect(headline(viewOf(fact()))).toEqual({ tone: "ok", text: "The default voice, aether, speaks with ElevenLabs." });
		expect(headline(viewOf(fact({ elevenlabs: { ready: false, reason: "needs-key" } }))).text).toBe(
			"The default voice, aether, speaks with On this machine: ElevenLabs is not ready.",
		);
	});
});

describe("agents", () => {
	test("disabled and duplicate agents are dropped, the rest sorted by the name a person sees", () => {
		const rows = readAgents([
			{ name: "coding", enabled: true, voice: "aether" },
			{ name: "aether", title: "Aether", enabled: true },
			{ name: "coding", title: "Dupe", enabled: true },
			{ name: "off", enabled: false },
			{ title: "no name" },
			"junk",
		]);
		expect(rows).toEqual([
			{ name: "aether", title: "Aether", voice: null },
			{ name: "coding", title: "coding", voice: "aether" },
		]);
	});

	test("anything that is not a list is no agents", () => {
		expect(readAgents(undefined)).toEqual([]);
		expect(readAgents({ coding: {} })).toEqual([]);
	});
});

describe("the two model roles", () => {
	const catalog = [
		{ providerId: "anthropic", modelId: "haiku", label: "Haiku", available: true },
		{ providerId: "openai", modelId: "mini", label: "Mini", available: true },
		{ providerId: "openai", modelId: "locked", label: "Locked", available: false },
		{ providerId: "typesafe", modelId: "jev", label: "Jev", available: true, kind: "classify" },
		{ providerId: "typesafe", modelId: "jev", label: "Jev", available: true, kind: "classify" },
	];

	test("classify-only models never count as chat models, and unavailable ones count for nothing", () => {
		expect(readModelsFact(catalog)).toEqual({ chat: 2, classifiers: ["Jev"] });
	});

	test("rows name only what is connected: they never claim a model the Store cannot tell them", () => {
		const [voice, classifier] = modelRows(readModelsFact(catalog));
		expect(voice).toMatchObject({ role: "voice", tone: "ok" });
		expect(voice?.says).toContain("2 chat models");
		expect(classifier).toMatchObject({ role: "classifier", tone: "ok" });
		expect(classifier?.says).toContain("Jev");
	});

	test("no chat model and no classifier: voice mode still works, the rows say they are missing", () => {
		const [voice, classifier] = modelRows(readModelsFact([]));
		expect(voice).toMatchObject({ role: "voice", tone: "warn" });
		expect(classifier).toMatchObject({ role: "classifier", tone: "off" });
	});

	test("an unpublished catalog is 'not known yet', not 'none connected'", () => {
		expect(readModelsFact(undefined)).toBeNull();
		expect(modelRows(null).map(row => row.tone)).toEqual(["off", "off"]);
	});
});

/** The classifier's words leave the machine, so what the pane says about WHERE is the part that must not be wrong:
 *  a false "nothing is sent", a dropped host, or a claim on an engine that said nothing would each mislead the user. */
describe("the classifier row says where the classifier's input goes", () => {
	const catalog = [{ providerId: "typesafe", modelId: "jev-latest", label: "Jev", available: true, kind: "classify" }];
	const remote = { provider: "typesafe", model: "jev-latest", leavesDevice: true, host: "api.typesafe.ai" };
	const rowFor = (classifier: unknown, models: unknown = catalog) => {
		const view = viewOf({ ...fact(), ...(classifier === undefined ? {} : { classifier }) });
		return modelRows(readModelsFact(models), view.classifier)[1];
	};

	test("a remote classifier names the model and the host, what is sent, and that voice mode off sends nothing", () => {
		const row = rowFor(remote);
		expect(row?.says).toContain("typesafe/jev-latest");
		expect(row?.hint).toContain("api.typesafe.ai");
		expect(row?.hint).toContain("last six messages");
		expect(row?.hint).toContain("last spoken line");
		expect(row?.hint).toContain("scrubbed of code, paths and secrets");
		expect(row?.hint).toMatch(/each line the voice is about to say/i);
		expect(row?.hint).toContain("agent's reply");
		expect(row?.hint).toContain("scrubbed, up to 700 characters");
		expect(row?.hint).toContain("your last request");
		expect(row?.hint).toContain("While voice mode is on");
		expect(row?.hint).toContain("With voice mode off, nothing is sent.");
		expect(row?.disclosure).toBe(true);
	});

	test("a remote classifier whose host the engine did not name still says it is sent away, never 'on this device'", () => {
		const row = rowFor({ provider: "typesafe", model: "jev-latest", leavesDevice: true });
		expect(row?.hint).toContain("go to typesafe");
		expect(row?.hint).not.toContain("this device");
	});

	test("a classifier on this device says nothing leaves it, and a stray host does not turn it into a remote one", () => {
		const row = rowFor({ provider: "local", model: "kev", leavesDevice: false, host: "api.typesafe.ai" });
		expect(row?.says).toContain("local/kev");
		expect(row?.hint).toContain("runs on this device; nothing leaves it.");
		expect(row?.hint).not.toContain("api.typesafe.ai");
		expect(row?.hint).not.toContain("last six messages");
	});

	test("null is 'no classifier resolves': a plain rule decides and nothing is sent, even with a classify model connected", () => {
		const row = rowFor(null);
		expect(row).toMatchObject({ tone: "off", says: "No classifier is connected: a plain rule decides, and nothing is sent." });
		expect(row?.disclosure).toBeUndefined();
	});

	test("an engine that does not say (no key) keeps today's row: the connected classify models, no claim about where", () => {
		expect("classifier" in viewOf(fact())).toBe(false);
		const row = rowFor(undefined);
		expect(row).toEqual(modelRows(readModelsFact(catalog))[1]);
		expect(row?.says).toBe("Jev can judge what is worth saying.");
		expect(row?.hint).not.toContain("nothing is sent");
		expect(row?.disclosure).toBeUndefined();
	});

	test("the engine's word stands even when the models catalog is not published yet", () => {
		expect(rowFor(remote, null)?.hint).toContain("api.typesafe.ai");
		expect(rowFor(null, null)?.says).toContain("nothing is sent");
	});

	test("a malformed classifier is 'the engine did not say': no throw, and never the reassuring 'nothing is sent'", () => {
		const malformed: unknown[] = [
			false,
			0,
			"",
			"typesafe/jev-latest",
			7,
			[],
			{},
			{ provider: "typesafe", model: "jev-latest" },
			{ provider: "typesafe", model: "jev-latest", leavesDevice: "true" },
			{ provider: "typesafe", model: "jev-latest", leavesDevice: 1 },
			{ provider: "", model: "jev-latest", leavesDevice: true, host: "api.typesafe.ai" },
			{ provider: "typesafe", model: 3, leavesDevice: true },
		];
		for (const value of malformed) {
			const view = viewOf({ ...fact(), classifier: value });
			expect(view.classifier).toBeUndefined();
			expect(view.profiles.map(profile => profile.name)).toEqual(["aether", "local"]);
			expect(modelRows(readModelsFact(catalog), view.classifier)[1]).toEqual(modelRows(readModelsFact(catalog))[1]);
		}
	});
});

// ---- Live (doc 92) ----------------------------------------------------------------------------------------------

const CODEX = { provider: "codex-live", voice: "sol" };
const ELEVEN_LIVE = { provider: "elevenlabs", model: "eleven_v4_turbo", voice: "EXAVITQu4vr4xnSDxMaL" };

/** An engine with Live: Codex realtime (a provider that talks live and nothing else) and ElevenLabs (speaks AND talks live). */
function liveFact(over: { codex?: unknown; elevenLive?: unknown; profiles?: unknown; default?: unknown } = {}) {
	return {
		profiles: over.profiles ?? [
			{ name: "eleven-turbo", layer: "user", speak: [ELEVEN, KOKORO], converse: [CODEX, ELEVEN_LIVE] },
			{ name: "local", layer: "builtin", speak: [KOKORO] },
		],
		providers: [
			{ id: "codex-live", label: "Live Voice (Codex)", converse: over.codex ?? { ready: true } },
			{ id: "elevenlabs", label: "ElevenLabs", speak: { ready: true }, converse: over.elevenLive ?? { ready: true } },
			{ id: "local", label: "On this machine", speak: { ready: true }, listen: { ready: true } },
		],
		default: over.default ?? { name: "eleven-turbo", source: "default", why: "your voice.default" },
	};
}

describe("reading a profile's live choices", () => {
	test("they keep their order, a model or voice is optional, and a garbled choice is dropped alone", () => {
		const view = viewOf(
			liveFact({
				profiles: [{ name: "p", layer: "user", speak: [ELEVEN], converse: [CODEX, { nonsense: true }, "junk", { model: "orphan" }, ELEVEN_LIVE] }],
			}),
		);
		expect(view.profiles[0]?.converse).toEqual([CODEX, ELEVEN_LIVE]);
	});

	test("an engine that predates Live sends none: the profile has no live choices and the pane has nothing to say about it", () => {
		const view = viewOf(fact());
		expect(view.profiles.every(profile => profile.converse.length === 0)).toBe(true);
		expect(view.providers.every(provider => provider.converse === undefined)).toBe(true);
		expect(liveHeadline(view)).toBeNull();
	});
});

describe("what Talk live would open", () => {
	test("the first READY live choice, not the first listed, and it says what it passed over", () => {
		const [turbo] = profileViews(viewOf(liveFact({ codex: { ready: false, reason: "needs-key", detail: "Sign in to Codex" } })));
		expect(turbo?.live.map(step => step.state.text)).toEqual(["Needs an API key", "Ready"]);
		expect(turbo?.live[0]?.detail).toBe("Sign in to Codex");
		expect(turbo?.liveWith).toEqual({ label: "ElevenLabs", fellBack: true, because: "Live Voice (Codex)" });
	});

	test("the first choice ready: it opens it, with no fallback to explain", () => {
		const [turbo] = profileViews(viewOf(liveFact()));
		expect(turbo?.liveWith).toEqual({ label: "Live Voice (Codex)", fellBack: false });
		expect(turbo?.live[0]).toMatchObject({ providerLabel: "Live Voice (Codex)", voice: "sol", ready: true });
	});

	test("there is no on-device fallback for a live call: every choice down means nothing opens, even with the local voice ready", () => {
		const view = viewOf(liveFact({ codex: { ready: false, reason: "unavailable" }, elevenLive: { ready: false, reason: "needs-key" } }));
		const [turbo] = profileViews(view);
		expect(turbo?.liveWith).toBeNull();
		expect(profileViews(view)[0]?.speaksWith).not.toBeNull();
	});

	test("a live choice naming a provider that is not installed, or one that does not talk live, is never ready", () => {
		const [ghost, mute] = profileViews(
			viewOf(
				liveFact({
					profiles: [
						{ name: "ghost", layer: "user", speak: [KOKORO], converse: [{ provider: "xai-live", voice: "v" }] },
						{ name: "mute", layer: "user", speak: [KOKORO], converse: [{ provider: "local" }] },
					],
				}),
			),
		);
		expect(ghost?.live[0]).toMatchObject({ providerLabel: "xai-live", ready: false, state: { text: "Not installed" } });
		expect(mute?.live[0]).toMatchObject({ ready: false, state: { tone: "off", text: "Does not talk live" } });
		expect(ghost?.liveWith).toBeNull();
		expect(mute?.liveWith).toBeNull();
	});

	test("a profile that names no live voice offers no live call", () => {
		const local = profileViews(viewOf(liveFact())).find(profile => profile.name === "local");
		expect(local?.live).toEqual([]);
		expect(local?.liveWith).toBeNull();
	});
});

describe("the Live headline", () => {
	test("names the live voice the default voice would open", () => {
		expect(liveHeadline(viewOf(liveFact()))).toEqual({ tone: "ok", text: "Talk live uses Live Voice (Codex) for the default voice, eleven-turbo." });
	});

	test("says when it fell back, and from what", () => {
		expect(liveHeadline(viewOf(liveFact({ codex: { ready: false, reason: "needs-key" } })))).toEqual({
			tone: "ok",
			text: "Talk live uses ElevenLabs for the default voice, eleven-turbo: Live Voice (Codex) is not ready.",
		});
	});

	test("warns when the default voice names live choices and none is ready", () => {
		const view = viewOf(liveFact({ codex: { ready: false }, elevenLive: { ready: false } }));
		expect(liveHeadline(view)).toEqual({ tone: "warn", text: "Talk live has nothing ready for the default voice, eleven-turbo." });
	});

	test("says Live is not set up when the default voice names none, while Live exists on this engine", () => {
		const view = viewOf(liveFact({ default: { name: "local", source: "default", why: "" } }));
		expect(liveHeadline(view)).toEqual({ tone: "off", text: "Talk live is not set up for the default voice, local: it names no live voice." });
	});

	test("says nothing when there is no default voice to speak about (the main headline already does)", () => {
		expect(liveHeadline(viewOf({ ...liveFact(), default: null }))).toBeNull();
	});
});

describe("where a live call's microphone audio goes", () => {
	test("names the provider the default voice would open, and follows a fallback", () => {
		expect(liveDisclosure(viewOf(liveFact()))).toBe("Talking live sends your microphone audio off this machine to Live Voice (Codex) for as long as a call is open.");
		expect(liveDisclosure(viewOf(liveFact({ codex: { ready: false, reason: "needs-key" } })))).toContain("to ElevenLabs for as long");
	});

	test("still says it when nothing is ready or there is no default voice, without naming a provider it cannot name", () => {
		const generic = "Talking live sends your microphone audio off this machine to the live voice's provider for as long as a call is open.";
		expect(liveDisclosure(viewOf(liveFact({ codex: { ready: false }, elevenLive: { ready: false } })))).toBe(generic);
		expect(liveDisclosure(viewOf({ ...liveFact(), default: null }))).toBe(generic);
	});

	test("says nothing on an engine that does not talk live: no claim about a feature that is not there", () => {
		expect(liveDisclosure(null)).toBeNull();
		expect(liveDisclosure(viewOf(fact()))).toBeNull();
	});
});

describe("a speech engine row", () => {
	test("a provider that only talks live says so, instead of 'Does not speak'", () => {
		const [codex] = viewOf(liveFact()).providers;
		expect(engineView(codex as never)).toEqual({ primary: { tone: "ok", text: "Live: Ready" }, meta: "Talks live only" });
	});

	test("a provider that speaks AND talks live keeps speaking as its state, and Live as a second fact", () => {
		const eleven = viewOf(liveFact({ elevenLive: { ready: false, reason: "needs-key" } })).providers[1];
		const row = engineView(eleven as never);
		expect(row.primary).toEqual({ tone: "ok", text: "Speaking: Ready" });
		expect(row.meta).toBe("Live: Needs an API key");
	});

	test("engines that predate Live read exactly as they did", () => {
		const [eleven, local] = viewOf(fact()).providers;
		expect(engineView(eleven as never)).toEqual({ primary: { tone: "ok", text: "Speaking: Ready" }, meta: "Speaks only" });
		expect(engineView(local as never)).toEqual({ primary: { tone: "ok", text: "Speaking: Ready" }, meta: "Listening: Ready" });
	});
});

