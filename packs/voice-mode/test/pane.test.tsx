/** WHAT BREAKS FOR THE USER IF THIS GOES RED: the Voice pane renders blank or throws when the Store gives it nothing
 *  (an engine with no speech runtime, a host with no store lane), or it never updates when the engine finishes
 *  loading or a key gets connected: the pane would keep saying "needs an API key" until Settings is reopened.
 *  Mounted with react-dom against a fake root-fenced store; the pane imports nothing but `react`. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import VoicePane, { type PaneStore } from "../src/index";

const GLOBALS = ["window", "document", "Element", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
const prior = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
let host: HTMLElement;

beforeEach(() => {
	const { window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const name of GLOBALS) {
		prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
	}
	host = window.document.getElementById("root") as unknown as HTMLElement;
});

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	for (const name of GLOBALS) {
		const descriptor = prior.get(name);
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	prior.clear();
});

/** A root store whose facts the test can change, firing the subscribers the way the host's fenced view does. */
function fakeStore(initial: Record<string, unknown>) {
	const facts = new Map(Object.entries(initial));
	const listeners = new Map<string, Set<() => void>>();
	const store: PaneStore = {
		watch: <T,>(key: string) => ({
			getSnapshot: () => facts.get(key) as T | undefined,
			subscribe: (listener: () => void) => {
				const set = listeners.get(key) ?? new Set<() => void>();
				set.add(listener);
				listeners.set(key, set);
				return () => set.delete(listener);
			},
		}),
	};
	return {
		store,
		set(key: string, value: unknown) {
			facts.set(key, value);
			for (const listener of listeners.get(key) ?? []) listener();
		},
	};
}

const profilesFact = (elevenReady: boolean) => ({
	profiles: [
		{
			name: "aether",
			layer: "pack",
			speak: [
				{ provider: "elevenlabs", model: "eleven_v4_turbo", voice: "EXAVITQu4vr4xnSDxMaL" },
				{ provider: "local", model: "kokoro", voice: "af_heart" },
			],
		},
	],
	providers: [
		{ id: "elevenlabs", label: "ElevenLabs", speak: elevenReady ? { ready: true } : { ready: false, reason: "needs-key" } },
		{ id: "local", label: "On this machine", speak: { ready: true }, listen: { ready: true } },
	],
	default: { name: "aether", source: "default", why: "your voice.default" },
});

const mount = (props: { store?: PaneStore }) => {
	root = createRoot(host);
	act(() => root?.render(createElement(VoicePane, props)));
};

describe("the Voice pane", () => {
	test("with no store at all it says there is no speech runtime instead of throwing or going blank", () => {
		mount({});
		expect(host.textContent).toContain("no speech runtime");
		expect(host.querySelector('[data-slot="voice-pane"]')).not.toBeNull();
	});

	test("an engine that publishes no speech/profiles is the same honest state, and the pane still explains how to change a voice", () => {
		mount({ store: fakeStore({ "agents/list": [], models: [] }).store });
		expect(host.textContent).toContain("no speech runtime");
		expect(host.textContent).toContain("voice-profiles");
	});

	test("it follows the engine: a key getting connected flips 'falls back' to 'speaks with ElevenLabs' without a reopen", () => {
		const fake = fakeStore({ "speech/profiles": profilesFact(false), "agents/list": [], models: [] });
		mount({ store: fake.store });
		expect(host.textContent).toContain("Needs an API key");
		expect(host.textContent).toContain("speaks with On this machine");

		act(() => fake.set("speech/profiles", profilesFact(true)));
		expect(host.textContent).not.toContain("Needs an API key");
		expect(host.textContent).toContain("speaks with ElevenLabs");
	});

	test("agents show the voice they ship with, or the default one, from the public agent list", () => {
		const fake = fakeStore({
			"speech/profiles": profilesFact(true),
			"agents/list": [
				{ name: "aether", title: "Aether", enabled: true, voice: "aether" },
				{ name: "coding", enabled: true },
			],
			models: [],
		});
		mount({ store: fake.store });
		const rows = [...host.querySelectorAll("li.vm-row")].map(row => row.textContent ?? "");
		expect(rows.some(row => row.startsWith("Aether") && row.includes("aether"))).toBe(true);
		expect(rows.some(row => row.startsWith("coding") && row.includes("aether (default)"))).toBe(true);
	});

	test("the classifier disclosure is on screen as its own line when the engine says it, and absent on an engine that does not", () => {
		const classify = [{ providerId: "typesafe", modelId: "jev-latest", label: "Jev", available: true, kind: "classify" }];
		const fake = fakeStore({ "speech/profiles": profilesFact(true), "agents/list": [], models: classify });
		mount({ store: fake.store });
		expect(host.textContent).toContain("Jev can judge what is worth saying.");
		expect(host.textContent).not.toContain("last six messages");

		act(() =>
			fake.set("speech/profiles", {
				...profilesFact(true),
				classifier: { provider: "typesafe", model: "jev-latest", leavesDevice: true, host: "api.typesafe.ai" },
			}),
		);
		const notice = host.querySelector(".vm-notice");
		expect(notice?.textContent).toContain("api.typesafe.ai");
		expect(notice?.textContent).toContain("last six messages");
		expect(notice?.textContent).toContain("With voice mode off, nothing is sent.");
		expect(host.textContent).not.toContain("Jev can judge what is worth saying.");

		act(() => fake.set("speech/profiles", { ...profilesFact(true), classifier: null }));
		expect(host.querySelector(".vm-notice")).toBeNull();
		expect(host.textContent).toContain("No classifier is connected: a plain rule decides, and nothing is sent.");
	});
});

const liveProfilesFact = (codexReady: boolean) => ({
	profiles: [
		{
			name: "eleven-turbo",
			layer: "user",
			speak: [{ provider: "elevenlabs", model: "eleven_v4_turbo", voice: "v1" }],
			converse: [
				{ provider: "codex-live", voice: "sol" },
				{ provider: "elevenlabs", model: "eleven_v4_turbo", voice: "v1" },
			],
		},
	],
	providers: [
		{ id: "codex-live", label: "Live Voice (Codex)", converse: codexReady ? { ready: true } : { ready: false, reason: "needs-key" } },
		{ id: "elevenlabs", label: "ElevenLabs", speak: { ready: true }, converse: { ready: true } },
		{ id: "local", label: "On this machine", speak: { ready: true }, listen: { ready: true } },
	],
	default: { name: "eleven-turbo", source: "default", why: "your voice.default" },
});

describe("the Voice pane and Live", () => {
	test("says which live voice Talk live opens, lists each profile's live choices, and states where the microphone goes", () => {
		mount({ store: fakeStore({ "speech/profiles": liveProfilesFact(true), "agents/list": [], models: [] }).store });
		expect(host.textContent).toContain("Talk live uses Live Voice (Codex) for the default voice, eleven-turbo.");
		expect(host.textContent).toContain("Talk live · uses Live Voice (Codex)");
		expect(host.textContent).toContain("Talking live sends your microphone audio off this machine to Live Voice (Codex) for as long as a call is open.");
		// The Live-only provider is described as such, not as a voice that "Does not speak".
		expect(host.textContent).toContain("Talks live only");
		expect(host.textContent).not.toContain("Does not speak");
	});

	test("it follows the engine: Codex becoming ready flips 'falls back' to 'uses' without a reopen", () => {
		const fake = fakeStore({ "speech/profiles": liveProfilesFact(false), "agents/list": [], models: [] });
		mount({ store: fake.store });
		expect(host.textContent).toContain("Talk live uses ElevenLabs for the default voice, eleven-turbo: Live Voice (Codex) is not ready.");

		act(() => fake.set("speech/profiles", liveProfilesFact(true)));
		expect(host.textContent).toContain("Talk live uses Live Voice (Codex) for the default voice, eleven-turbo.");
		expect(host.textContent).not.toContain("is not ready");
	});

	test("an engine that does not talk live gets no Live words at all: nothing is claimed about a feature that is not there", () => {
		mount({ store: fakeStore({ "speech/profiles": profilesFact(true), "agents/list": [], models: [] }).store });
		expect(host.textContent).not.toContain("Talk live");
		expect(host.textContent).not.toContain("microphone audio off this machine");
	});
});
