// The surface against a fake voice conversation, mounted for real (linkedom + react-dom, the head still
// "loading" so no WebGL is asked for). Defended here: CONSENT (the microphone opens from the user's click on
// "Tap to talk" and nowhere else, in every phase and after an error), the ways OUT (Back and Esc both end the
// conversation and leave), and that the mic state on screen is the hook's. The pure phase mapping is in
// surface-model.test.ts; the door in surface-door.test.tsx.
import { afterEach, describe, expect, jest, test } from "bun:test";
import { act, useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FaceSurfaceBody } from "../src/surface/face-surface";
import { type HeadState, loadHead } from "../src/surface/head";
import type { Intent } from "../src/surface/surface-model";
import type { FaceLive } from "../src/surface/live";
import type { FaceVoice } from "../src/surface/voice";
import { mountPage, unmountAll, unmountRoots } from "./surface-dom";

afterEach(unmountAll);

function fakeVoice(over: Partial<FaceVoice> = {}) {
	const calls = { start: 0, stop: 0, toggleMute: 0 };
	const voice: FaceVoice = {
		supported: true,
		phase: "idle",
		error: undefined,
		refusal: undefined,
		notice: undefined,
		micLive: false,
		muted: false,
		micDevices: [],
		micDeviceId: undefined,
		micLabel: undefined,
		micSilent: false,
		setMicDevice: () => undefined,
		partial: "",
		words: [],
		turn: 0,
		faceModel: false,
		levels: { getMic: () => 0, getAgent: () => 0, getSilence: () => 0 },
		audioClock: () => 0,
		faceAt: () => null,
		start: async () => void calls.start++,
		stop: async () => void calls.stop++,
		toggleMute: () => void calls.toggleMute++,
		...over,
	};
	return { voice, calls };
}

function fakeLive(over: Partial<FaceLive> = {}) {
	const calls = { start: 0, stop: 0, toggleMute: 0 };
	// The kit shows "muted" over the engine's phase; unless a test says what the engine is doing underneath, it is listening.
	const shown = over.phase ?? "off";
	const live: FaceLive = {
		available: false,
		voice: null,
		phase: "off",
		enginePhase: shown === "muted" ? "listening" : shown,
		transcript: null,
		muted: false,
		seconds: 0,
		error: null,
		getInputLevel: () => 0,
		getOutputLevel: () => 0,
		start: async () => void calls.start++,
		stop: () => void calls.stop++,
		toggleMute: () => void calls.toggleMute++,
		...over,
	};
	return { live, calls };
}

async function mount(over: Partial<FaceVoice> = {}, head: HeadState = { status: "loading" }, liveOver: Partial<FaceLive> = {}) {
	const { voice, calls } = fakeVoice(over);
	const { live, calls: liveCalls } = fakeLive(liveOver);
	const intents: Intent[] = [];
	const page = await mountPage(<FaceSurfaceBody voice={voice} live={live} head={head} onIntent={(i) => intents.push(i)} />);
	return { ...page, calls, liveCalls, intents };
}

const PHASES: Partial<FaceVoice>[] = [
	{ phase: "idle", supported: true },
	{ phase: "idle", supported: false },
	{ phase: "connecting" },
	{ phase: "listening", micLive: true },
	{ phase: "thinking" },
	{ phase: "speaking" },
	{ phase: "error", error: "The microphone was blocked." },
];

describe("consent: the microphone opens from the click on Tap to talk, and only there", () => {
	test("mounting the surface never starts a conversation, whatever state the hook is in", async () => {
		for (const state of PHASES) {
			const view = await mount(state);
			expect(view.calls.start).toBe(0);
			await unmountRoots();
		}
	});

	test("Tap to talk is offered when idle, starts exactly once per click, and is gone once a conversation is open", async () => {
		const view = await mount({ phase: "idle", supported: true });
		expect(view.buttonByText("Tap to talk")).toBeDefined();
		await view.press(view.buttonByText("Tap to talk"));
		expect(view.calls.start).toBe(1);

		for (const phase of ["connecting", "listening", "thinking", "speaking"] as const) {
			const open = await mount({ phase });
			expect(open.buttonByText("Tap to talk")).toBeUndefined();
		}
	});

	test("after a failure the engine's words are shown verbatim and only Try again (a click) starts it again", async () => {
		const view = await mount({ phase: "error", error: "ElevenLabs answered 401: invalid API key" });
		expect(view.container.textContent).toContain("ElevenLabs answered 401: invalid API key");
		expect(view.calls.start).toBe(0);
		await view.press(view.buttonByText("Try again"));
		expect(view.calls.start).toBe(1);
	});

	test("an engine with no speech lane offers no mic: quiet during the probe, then an honest 'Voice is not ready'", async () => {
		jest.useFakeTimers();
		try {
			const view = await mount({ phase: "idle", supported: false });
			expect(view.container.textContent).not.toContain("Voice is not ready");
			await act(async () => {
				jest.advanceTimersByTime(2600);
			});
			expect(view.container.textContent).toContain("Voice is not ready");
			expect(view.buttonByText("Tap to talk")).toBeUndefined();
			expect(view.calls.start).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("a face that cannot be drawn does not take the conversation with it", () => {
	// Bun prints a logged Error by source-mapping the whole react-dom dev bundle (seconds); the boundary, not the log, is under test.
	const { error, warn } = console;
	afterEach(() => {
		console.error = error;
		console.warn = warn;
	});

	test("no WebGL2 (linkedom has none): the card says so in the middle of the page, and Tap to talk and Back still work", async () => {
		console.error = () => {};
		console.warn = () => {};
		const bytes = readFileSync(resolve(import.meta.dir, "../assets/head-f01.bin"));
		const asset = await loadHead(`data:application/octet-stream;base64,${bytes.toString("base64")}`);
		const view = await mount({ phase: "idle", supported: true }, { status: "ready", asset });
		expect(view.find(".f2f-center")?.textContent).toContain("The face could not be drawn");
		expect(view.find(".f2f-center")?.textContent).toContain("WebGL2");
		await view.press(view.buttonByText("Tap to talk"));
		expect(view.calls.start).toBe(1);
		await view.press(view.buttonByText("Back to thread"));
		expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
		// React's dev-mode error path builds component stacks through Bun's source-mapper: ~7 s for the first caught render error
	}, 60_000);

	test("a head that failed to decode says it could not be LOADED (not a WebGL hint) and keeps the controls", async () => {
		const view = await mount({ phase: "idle", supported: true }, { status: "failed", message: "not a face head asset" });
		expect(view.find(".f2f-center")?.textContent).toContain("The face could not be loaded");
		expect(view.find(".f2f-center")?.textContent).not.toContain("WebGL2");
		expect(view.buttonByText("Tap to talk")).toBeDefined();
	});
});

describe("leaving", () => {
	test("Back to thread ends the conversation and mounts the session surface, in every phase", async () => {
		for (const state of PHASES) {
			const view = await mount(state);
			await view.press(view.buttonByText("Back to thread"));
			expect(view.calls.stop).toBe(1);
			expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
			await unmountRoots();
		}
	});

	test("Esc does the same as Back", async () => {
		const view = await mount({ phase: "speaking" });
		await view.key("Escape");
		expect(view.calls.stop).toBe(1);
		expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
	});

	test("after the surface unmounts, Esc no longer leaves anything", async () => {
		const view = await mount({ phase: "listening", micLive: true });
		await unmountRoots();
		await view.key("Escape");
		expect(view.calls.stop).toBe(0);
		expect(view.intents).toEqual([]);
	});
});

describe("what the mic controls show", () => {
	test("Mic on with the red dot follows micLive exactly; Mic off otherwise", async () => {
		const live = await mount({ phase: "listening", micLive: true });
		expect(live.find(".f2f-mic")?.getAttribute("data-on")).toBe("true");
		expect(live.find(".f2f-mic")?.textContent).toContain("Mic on");
		const off = await mount({ phase: "idle", micLive: false });
		expect(off.find(".f2f-mic")?.getAttribute("data-on")).toBe("false");
		expect(off.find(".f2f-mic")?.textContent).toContain("Mic off");
	});

	test("Mute exists only in an open conversation, says which way it will flip, and toggles through the hook", async () => {
		expect((await mount({ phase: "idle" })).buttonByText("Mute")).toBeUndefined();
		const listening = await mount({ phase: "listening", micLive: true });
		await listening.press(listening.buttonByText("Mute"));
		expect(listening.calls.toggleMute).toBe(1);
		const muted = await mount({ phase: "listening", micLive: false, muted: true });
		expect(muted.buttonByText("Unmute")).toBeDefined();
		expect(muted.find(".f2f-state")?.textContent).toContain("Muted");
	});

	test("muting while the agent speaks does not silence the face: it is still Speaking", async () => {
		const view = await mount({ phase: "speaking", muted: true });
		expect(view.find(".f2f-state")?.textContent).toContain("Speaking");
		expect(view.find(".f2f-root")?.getAttribute("data-phase")).toBe("speaking");
	});
});

const DEVICES = [
	{ id: "default", label: "Default - Headset Microphone (INZONE H9 II - Chat)" },
	{ id: "usb-id", label: "USB Microphone" },
];
const LISTENING: Partial<FaceVoice> = { phase: "listening", micLive: true, micDevices: DEVICES, micDeviceId: "usb-id", micLabel: "USB Microphone" };
const DEAD: Partial<FaceVoice> = { ...LISTENING, micSilent: true, micDeviceId: "default", micLabel: DEVICES[0]?.label };
// presence as a boolean: a failed expect prints what it received, and a linkedom node is huge
const has = (view: { find: (selector: string) => Element | null }, selector: string) => view.find(selector) !== null;

describe("the microphone picker", () => {
	test("sits with Mute in an open conversation, and is not offered when there is none or it has failed", async () => {
		for (const phase of ["listening", "thinking", "speaking"] as const) {
			const open = await mount({ ...LISTENING, phase });
			expect(has(open, ".f2f-mp")).toBe(true);
			await unmountRoots();
		}
		for (const state of [{ phase: "idle" }, { phase: "error", error: "The microphone was blocked." }] as const) {
			const closed = await mount({ ...LISTENING, ...state, micLive: false });
			expect(has(closed, ".f2f-mp")).toBe(false);
			await unmountRoots();
		}
	});

	test("choosing a microphone goes to the hook and keeps the conversation open", async () => {
		const chosen: (string | undefined)[] = [];
		const view = await mount({ ...LISTENING, setMicDevice: (id) => void chosen.push(id) });
		await view.press(view.find(".f2f-mp-btn"));
		await view.press([...view.container.querySelectorAll('[role="menuitemradio"]')][0]);
		expect(chosen).toEqual(["default"]);
		expect(view.calls.stop).toBe(0);
		expect(view.calls.start).toBe(0);
		expect(view.intents).toEqual([]);
	});

	test("Esc inside the open menu closes the menu and stays in the conversation; Esc with it closed leaves", async () => {
		const view = await mount(LISTENING);
		await view.press(view.find(".f2f-mp-btn"));
		await view.keyOn(view.find('[role="menuitemradio"]'), "Escape");
		expect(has(view, '[role="menu"]')).toBe(false);
		expect(view.calls.stop).toBe(0);
		expect(view.intents).toEqual([]);

		await view.keyOn(view.find(".f2f-mp-btn"), "Escape");
		expect(view.calls.stop).toBe(1);
		expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
	});
});

describe("a microphone that hears nothing", () => {
	test("the label says No sound (not Listening), the note names the device and asks for another, and the picker is flagged", async () => {
		const view = await mount(DEAD);
		expect(view.find(".f2f-label")?.textContent).toBe("No sound");
		expect(view.find(".f2f-state")?.textContent).not.toContain("Listening");
		expect(view.find(".f2f-note")?.textContent).toBe("No sound from INZONE H9 II. Pick another microphone.");
		expect(view.find(".f2f-note")?.getAttribute("data-warn")).toBe("true");
		expect(view.find(".f2f-mp-btn")?.getAttribute("data-warn")).toBe("true");
	});

	test("a working microphone is Listening, and an ordinary engine notice is not dressed as a warning", async () => {
		const quiet = await mount(LISTENING);
		expect(quiet.find(".f2f-label")?.textContent).toBe("Listening");
		expect(has(quiet, ".f2f-note")).toBe(false);
		const notice = "Downloading the voice model (42%)…";
		const busy = await mount({ ...LISTENING, notice });
		expect(busy.find(".f2f-note")?.textContent).toBe(notice);
		expect(busy.find(".f2f-note")?.getAttribute("data-warn")).toBe("false");
	});

	test("no warning while muted (silence is the point) or while the agent thinks or speaks", async () => {
		for (const [state, label] of [
			[{ muted: true, micLive: false }, "Muted"],
			[{ phase: "thinking" }, "Thinking"],
			[{ phase: "speaking" }, "Speaking"],
		] as const) {
			const view = await mount({ ...DEAD, ...state });
			expect(view.find(".f2f-label")?.textContent).toBe(label);
			expect(has(view, ".f2f-note")).toBe(false);
			await unmountRoots();
		}
	});
});

describe("the send countdown", () => {
	test("the hairline under the user's words is drawn only while their words are being captured", async () => {
		const WORDS = "book me a table";
		const rows: readonly (readonly [string, Partial<FaceVoice>])[] = [
			["listening, words captured", { ...LISTENING, partial: WORDS }],
			["listening, nothing said", { ...LISTENING, partial: "" }],
			["listening, only blanks heard", { ...LISTENING, partial: "   " }],
			["muted", { ...LISTENING, muted: true, micLive: false, partial: WORDS }],
			["thinking", { phase: "thinking", micLive: true, partial: WORDS }],
			["speaking", { phase: "speaking", micLive: true, partial: WORDS }],
			["idle", { phase: "idle", partial: WORDS }],
		];
		const drawn: Record<string, boolean> = {};
		for (const [name, over] of rows) {
			drawn[name] = has(await mount(over), ".f2f-silence");
			await unmountRoots();
		}

		expect(drawn).toEqual({
			"listening, words captured": true,
			"listening, nothing said": false,
			"listening, only blanks heard": false,
			muted: false,
			thinking: false,
			speaking: false,
			idle: false,
		});
	});
});

describe("words the host could not send", () => {
	const REASON = "Couldn't send that: Session is not connected; nothing was sent.";

	test("the note says so as a warning and the words stay in the caption, with the send hairline at rest", async () => {
		const view = await mount({ ...LISTENING, partial: "book me a table", refusal: REASON });

		expect(view.find(".f2f-note")?.textContent).toBe(REASON);
		expect(view.find(".f2f-note")?.getAttribute("data-warn")).toBe("true");
		expect(view.find(".f2f-usercap")?.textContent).toBe("book me a table");
		expect(view.find(".f2f-label")?.textContent).toBe("Listening");
	});

	test("a send that went fine shows no note", async () => {
		const view = await mount({ ...LISTENING, partial: "", refusal: undefined });

		expect(has(view, ".f2f-note")).toBe(false);
		expect(has(view, ".f2f-usercap")).toBe(false);
	});
});

const LOADING: HeadState = { status: "loading" };
const LIVE_PHASES = ["connecting", "listening", "muted", "working", "speaking", "error"] as const;

describe("Talk live: a second conversation on the same surface, started only by its own click", () => {
	test("mounting never starts a call or the voice, whatever state either is in", async () => {
		for (const phase of ["off", ...LIVE_PHASES] as const) {
			const view = await mount({}, LOADING, { available: true, phase });
			expect(view.liveCalls.start).toBe(0);
			expect(view.calls.start).toBe(0);
			await unmountRoots();
		}
	});

	test("offered beside Tap to talk when Live is available, says where the microphone goes, and starts exactly once per click", async () => {
		const view = await mount({ phase: "idle", supported: true }, LOADING, { available: true, voice: "Sol via codex-live" });
		expect(view.buttonByText("Tap to talk")).toBeDefined();
		expect(view.find(".f2f-live")?.textContent).toContain("Mic → Sol via codex-live");
		await view.press(view.find(".f2f-live"));
		expect(view.liveCalls.start).toBe(1);
		expect(view.calls.start).toBe(0);
	});

	test("not offered where the engine offers no Live, nor while the voice conversation is open", async () => {
		expect(has(await mount({ phase: "idle", supported: true }), ".f2f-live")).toBe(false);
		await unmountRoots();
		for (const phase of ["connecting", "listening", "thinking", "speaking", "error"] as const) {
			const view = await mount({ phase, error: "x" }, LOADING, { available: true });
			expect(has(view, ".f2f-live")).toBe(false);
			await unmountRoots();
		}
	});

	test("still offered when the voice conversation is unavailable, since Live has its own route", async () => {
		jest.useFakeTimers();
		try {
			const view = await mount({ phase: "idle", supported: false }, LOADING, { available: true });
			await act(async () => {
				jest.advanceTimersByTime(2600);
			});
			expect(view.container.textContent).toContain("Voice is not ready");
			expect(has(view, ".f2f-live")).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	test("while a call is up it holds the surface: neither start button is offered, and the label is the call's", async () => {
		for (const phase of ["connecting", "listening", "working", "speaking"] as const) {
			const view = await mount({ phase: "idle", supported: true }, LOADING, { available: true, phase });
			expect(view.buttonByText("Tap to talk")).toBeUndefined();
			expect(has(view, ".f2f-live")).toBe(false);
			expect(view.find(".f2f-root")?.getAttribute("data-mode")).toBe("live");
			await unmountRoots();
		}
		const working = await mount({}, LOADING, { available: true, phase: "working" });
		expect(working.find(".f2f-label")?.textContent).toBe("Working");
	});

	test("the controls act on the CALL: Mute and End call go to Live, never to the voice conversation, and there is no voice mic picker", async () => {
		const view = await mount({ ...LISTENING, phase: "idle", micLive: false }, LOADING, { available: true, phase: "listening" });
		expect(has(view, ".f2f-mp")).toBe(false);
		await view.press(view.buttonByText("Mute"));
		expect(view.liveCalls.toggleMute).toBe(1);
		expect(view.calls.toggleMute).toBe(0);
		await view.press(view.buttonByText("End call"));
		expect(view.liveCalls.stop).toBe(1);
		expect(view.calls.stop).toBe(0);
		expect(view.intents).toEqual([]);
	});

	test("a muted call reads Unmute and Muted, and its mic dot is off", async () => {
		const view = await mount({}, LOADING, { available: true, phase: "listening", muted: true });
		expect(view.buttonByText("Unmute")).toBeDefined();
		expect(view.find(".f2f-state")?.textContent).toContain("Muted");
		expect(view.find(".f2f-mic")?.getAttribute("data-on")).toBe("false");
	});

	test("a person who muted still sees the voice answer: the kit reports 'muted' for the whole call, the face follows what the call is doing", async () => {
		const view = await mount({}, LOADING, { available: true, phase: "muted", enginePhase: "speaking", muted: true });
		expect(view.find(".f2f-root")?.getAttribute("data-phase")).toBe("speaking");
		expect(view.find(".f2f-state")?.textContent).toContain("Speaking");
		expect(view.find(".f2f-state")?.textContent).not.toContain("Muted");
		// the microphone is still off, and the button still says how to turn it on
		expect(view.buttonByText("Unmute")).toBeDefined();
		expect(view.find(".f2f-mic")?.getAttribute("data-on")).toBe("false");
	});

	test("End call exists only for a Live call, not for the voice conversation", async () => {
		expect((await mount({ phase: "listening", micLive: true })).buttonByText("End call")).toBeUndefined();
	});

	test("Back and Esc hang up the call and leave; nothing is left holding the microphone", async () => {
		for (const how of ["Back", "Esc"] as const) {
			const view = await mount({}, LOADING, { available: true, phase: "speaking" });
			if (how === "Back") await view.press(view.buttonByText("Back to thread"));
			else await view.key("Escape");
			expect(view.liveCalls.stop).toBe(1);
			expect(view.calls.stop).toBe(1);
			expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
			await unmountRoots();
		}
	});

	test("a failed call shows the engine's words verbatim and only Try again (a click) starts the CALL again", async () => {
		const view = await mount({}, LOADING, { available: true, phase: "error", error: "Codex answered 401: invalid API key" });
		expect(view.container.textContent).toContain("Codex answered 401: invalid API key");
		expect(view.liveCalls.start).toBe(0);
		await view.press(view.buttonByText("Try again"));
		expect(view.liveCalls.start).toBe(1);
		expect(view.calls.start).toBe(0);
	});

	test("the status names who the microphone is talking to and the call clock", async () => {
		const view = await mount({}, LOADING, { available: true, phase: "listening", voice: "Sol via codex-live", seconds: 65 });
		expect(view.find(".f2f-note")?.textContent).toBe("Live · Sol via codex-live · 1:05");
	});
});

describe("the call's words", () => {
	const line = (over: Partial<NonNullable<FaceLive["transcript"]>> = {}): NonNullable<FaceLive["transcript"]> => ({
		role: "assistant",
		text: "Mars is cold and dusty.",
		turn: 1,
		final: false,
		...over,
	});

	test("the voice's line shows under the face, the person's line in the stage; one at a time", async () => {
		const said = await mount({}, LOADING, { available: true, phase: "speaking", transcript: line() });
		expect(said.find(".f2f-livecap")?.textContent).toBe("Mars is cold and dusty.");
		expect(has(said, ".f2f-usercap")).toBe(false);
		const heard = await mount({}, LOADING, { available: true, phase: "listening", transcript: line({ role: "user", text: "What is Mars like?" }) });
		expect(heard.find(".f2f-usercap")?.textContent).toBe("What is Mars like?");
		expect(has(heard, ".f2f-livecap")).toBe(false);
	});

	test("a box that centres itself with a transform never carries the fade, whose last frame is `transform: none` and would slide it off", async () => {
		const view = await mount({}, LOADING, { available: true, phase: "speaking", transcript: line() });
		const centred = [...view.container.querySelectorAll("[style]")].filter((el) => /translate/.test(el.getAttribute("style") ?? ""));
		expect(centred.length).toBeGreaterThan(0);
		expect(centred.filter((el) => el.classList.contains("f2f-fade")).length).toBe(0);
		expect(view.find(".f2f-livecap")?.textContent).toBe("Mars is cold and dusty.");
	});

	test("a finished line yields the floor to the face after it has lingered, once the voice has stopped", async () => {
		jest.useFakeTimers();
		try {
			const view = await mount({}, LOADING, { available: true, phase: "listening", transcript: line({ final: true }) });
			await act(async () => {
				jest.advanceTimersByTime(7_900);
			});
			expect(has(view, ".f2f-livecap")).toBe(true);
			await act(async () => {
				jest.advanceTimersByTime(200);
			});
			expect(has(view, ".f2f-livecap")).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a finished line stays as long as the voice is still speaking it: text can arrive faster than it is said", async () => {
		jest.useFakeTimers();
		try {
			const view = await mount({}, LOADING, { available: true, phase: "speaking", transcript: line({ final: true }) });
			await act(async () => {
				jest.advanceTimersByTime(60_000);
			});
			expect(has(view, ".f2f-livecap")).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	test("the same hold applies when the person muted: the voice is still speaking the line", async () => {
		jest.useFakeTimers();
		try {
			const view = await mount({}, LOADING, { available: true, phase: "muted", enginePhase: "speaking", muted: true, transcript: line({ final: true }) });
			await act(async () => {
				jest.advanceTimersByTime(60_000);
			});
			expect(has(view, ".f2f-livecap")).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a new call is not muted by the last one: its lines show even when they share a role and turn number with a line that already lingered out", async () => {
		jest.useFakeTimers();
		try {
			const { voice } = fakeVoice({});
			const holder: { set?: (live: FaceLive) => void } = {};
			function Swap() {
				const [live, setLive] = useState<FaceLive>(fakeLive({ available: true, phase: "listening", transcript: line({ final: true, turn: 3 }) }).live);
				holder.set = setLive;
				return <FaceSurfaceBody voice={voice} live={live} head={LOADING} onIntent={() => undefined} />;
			}
			const view = await mountPage(<Swap />);
			await act(async () => {
				jest.advanceTimersByTime(8_100);
			});
			expect(has(view, ".f2f-livecap")).toBe(false);

			// the call ends (the surface stays up), then another begins; turn numbers restart with every call
			await act(async () => holder.set?.(fakeLive({ available: true }).live));
			await act(async () =>
				holder.set?.(fakeLive({ available: true, phase: "speaking", transcript: line({ final: false, turn: 3, text: "Second call, same turn." }) }).live),
			);

			expect(view.find(".f2f-livecap")?.textContent).toBe("Second call, same turn.");
		} finally {
			jest.useRealTimers();
		}
	});

	test("a line still being said stays however long it takes", async () => {
		jest.useFakeTimers();
		try {
			const view = await mount({}, LOADING, { available: true, phase: "speaking", transcript: line({ final: false }) });
			await act(async () => {
				jest.advanceTimersByTime(60_000);
			});
			expect(has(view, ".f2f-livecap")).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});
});
