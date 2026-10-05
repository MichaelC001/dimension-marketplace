// What a key does on a recording - and whose key it is first. The pane listens on the window, so
// every key pressed anywhere in the View arrives; a text box, a button, a slider and a tab bar
// each have their own use for some of them. Escape has two jobs that must come in order: the
// first takes back a stretch half set, the second puts the drawing tool down. And a key held with
// Ctrl or Cmd belongs to the browser, bar undo and redo on a video that can be drawn on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decideKey, type KeyAction, type KeyInput, keyOwner, NOBODY } from "../app/view/media-keys";
import type { MediaLength } from "../app/view/media-length";
import { installDom, type TestDom } from "./dom";

const BOUNDED: MediaLength = { duration: 90, reach: 90, unbounded: false };
const UNBOUNDED: MediaLength = { duration: Number.POSITIVE_INFINITY, reach: 40, unbounded: true };

const press = (key: string, over: Partial<KeyInput> = {}): KeyAction | null =>
	decideKey({ key, shift: false, modifier: false, repeat: false, position: 10, length: BOUNDED, kind: "video", marking: true, drawing: false, armed: false, inPoint: null, owner: NOBODY, ...over });

describe("whose key it is comes first", () => {
	test("while the human types, nothing is the recording's: not Space, not the arrows, not M, not a tool number, not undo", () => {
		const typing = { typing: true, presses: false, navigates: false };
		for (const key of [" ", "ArrowLeft", "ArrowRight", "Home", "End", "m", "i", "o", ",", "Escape", "1", "5"]) {
			expect(press(key, { owner: typing, drawing: true, armed: true }), key).toBeNull();
		}
		for (const [key, shift] of [["z", false], ["z", true], ["y", false]] as const) {
			expect(press(key, { owner: typing, modifier: true, shift, drawing: true }), `${key} shift=${shift}`).toBeNull();
		}
	});

	test("Space on a button presses the button; anywhere else it is play and pause", () => {
		expect(press(" ")).toEqual({ do: "toggle" });
		expect(press(" ", { owner: { typing: false, presses: true, navigates: false } })).toBeNull();
	});

	test("a slider or a tab bar keeps its arrows and its Home and End", () => {
		const widget = { typing: false, presses: false, navigates: true };
		for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) expect(press(key, { owner: widget }), key).toBeNull();
		const tab = { typing: false, presses: true, navigates: true };
		for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) expect(press(key, { owner: tab }), key).toBeNull();
	});

	test("a plain button is no place to jump from with Home or End, but the arrows still seek from it", () => {
		const button = { typing: false, presses: true, navigates: false };
		expect(press("Home", { owner: button })).toBeNull();
		expect(press("End", { owner: button })).toBeNull();
		expect(press("ArrowRight", { owner: button })).toEqual({ do: "seek", to: 15 });
	});
});

describe("seeking", () => {
	test("arrows move five seconds, Shift one; Home and End go to the ends", () => {
		expect(press("ArrowRight")).toEqual({ do: "seek", to: 15 });
		expect(press("ArrowLeft", { shift: true })).toEqual({ do: "seek", to: 9 });
		expect(press("Home")).toEqual({ do: "seek", to: 0 });
		expect(press("End")).toEqual({ do: "seek", to: 90 });
	});

	test("in a recording with no end the arrows are not stopped at 0:00, and End goes as far as it plays", () => {
		expect(press("ArrowRight", { length: UNBOUNDED, position: 300 })).toEqual({ do: "seek", to: 305 });
		expect(press("End", { length: UNBOUNDED, position: 300 })).toEqual({ do: "seek", to: 40 });
	});

	test("frames step with , and . on a video, and a sound has no frames", () => {
		expect(press(",")).toEqual({ do: "step", direction: -1 });
		expect(press(".")).toEqual({ do: "step", direction: 1 });
		expect(press(",", { kind: "audio" })).toBeNull();
		expect(press(".", { kind: "audio" })).toBeNull();
	});
});

describe("Escape: the first takes back a stretch half set, the second puts the drawing tool down", () => {
	test("with a tool in hand and no stretch half set, Escape puts the tool down - marking layer up or not", () => {
		expect(press("Escape", { armed: true })).toEqual({ do: "disarm" });
		expect(press("Escape", { armed: true, marking: false })).toEqual({ do: "disarm" });
	});

	test("with nothing in hand and no stretch half set, Escape is not the recording's - it is left to the View", () => {
		expect(press("Escape", { marking: true })).toBeNull();
		expect(press("Escape", { marking: false })).toBeNull();
	});

	test("pressed in a row with a stretch half set and a tool in hand it does both, the stretch first", () => {
		let inPoint: number | null = 4.2;
		let armed = true;
		const done: string[] = [];
		for (let presses = 0; presses < 3; presses += 1) {
			const action = press("Escape", { inPoint, armed });
			if (action?.do === "cancel-stretch") inPoint = null;
			if (action?.do === "disarm") armed = false;
			done.push(action?.do ?? "nothing");
		}
		expect(done).toEqual(["cancel-stretch", "disarm", "nothing"]);
	});

	test("a stretch left half set is taken back even outside the marking layer, tool in hand or not", () => {
		expect(press("Escape", { marking: false, inPoint: 2 })).toEqual({ do: "cancel-stretch" });
		expect(press("Escape", { marking: false, inPoint: 2, armed: true })).toEqual({ do: "cancel-stretch" });
	});
});

describe("the marking keys work only while marking", () => {
	test("M marks, I starts a stretch, O ends it - and says how, when none was started", () => {
		expect(press("m")).toEqual({ do: "mark" });
		expect(press("i")).toEqual({ do: "set-in" });
		expect(press("o", { inPoint: 3 })).toEqual({ do: "end-stretch" });
		expect(press("o", { inPoint: null })).toEqual({ do: "needs-start" });
	});

	test("outside the mode they are not the recording's keys", () => {
		for (const key of ["m", "i", "o"]) expect(press(key, { marking: false }), key).toBeNull();
	});

	test("any other key is left alone, drawing or not", () => {
		for (const drawing of [false, true]) {
			for (const key of ["a", "Enter", "Tab", "ArrowUp", "ArrowDown", "PageDown", "Shift", "0", "6", "9"]) expect(press(key, { drawing }), `${key} drawing=${drawing}`).toBeNull();
		}
	});
});

describe("the drawing keys: the number keys pick a tool", () => {
	const TOOLS = [
		["1", "pin"],
		["2", "box"],
		["3", "ellipse"],
		["4", "arrow"],
		["5", "pen"],
	] as const;

	test("1 to 5 pick the pin, box, ellipse, arrow and pen, whether or not a tool is already in hand", () => {
		for (const armed of [false, true]) {
			for (const [key, tool] of TOOLS) expect(press(key, { drawing: true, armed }), `${key} armed=${armed}`).toEqual({ do: "tool", tool });
		}
	});

	test("they pick nothing while the marking layer is down", () => {
		for (const [key] of TOOLS) expect(press(key, { drawing: true, marking: false }), key).toBeNull();
	});

	test("they pick nothing on a recording that cannot be drawn on, a sound among them", () => {
		for (const [key] of TOOLS) {
			expect(press(key, { drawing: false }), key).toBeNull();
			expect(press(key, { drawing: false, kind: "audio" }), `${key} audio`).toBeNull();
		}
	});

	test("the letter tool keys are not the recording's: C, R, A and P do nothing, and O is still the end of a stretch", () => {
		for (const key of ["c", "r", "a", "p"]) expect(press(key, { drawing: true, armed: true }), key).toBeNull();
		expect(press("o", { drawing: true, inPoint: null })).toEqual({ do: "needs-start" });
		expect(press("o", { drawing: true, inPoint: 3 })).toEqual({ do: "end-stretch" });
	});

	test("a focused button or slider does not take the marking and number keys from the picture", () => {
		const button = { typing: false, presses: true, navigates: false };
		const slider = { typing: false, presses: false, navigates: true };
		for (const owner of [button, slider]) {
			expect(press("m", { drawing: true, owner }), "m").toEqual({ do: "mark" });
			expect(press("i", { drawing: true, owner }), "i").toEqual({ do: "set-in" });
			expect(press("3", { drawing: true, owner }), "3").toEqual({ do: "tool", tool: "ellipse" });
		}
	});
});

describe("a key with Ctrl or Cmd is the browser's, bar undo and redo on a video that can be drawn on", () => {
	test("Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo", () => {
		const rows = [
			{ name: "Ctrl+Z", key: "z", shift: false, want: { do: "undo" } },
			{ name: "Ctrl+Shift+Z", key: "z", shift: true, want: { do: "redo" } },
			{ name: "Ctrl+Shift+Z with the capital a held Shift sends", key: "Z", shift: true, want: { do: "redo" } },
			{ name: "Ctrl+Y", key: "y", shift: false, want: { do: "redo" } },
		] as const;
		for (const { name, key, shift, want } of rows) expect(press(key, { modifier: true, shift, drawing: true }), name).toEqual(want);
	});

	test("where nothing can be drawn on, Ctrl+Z and Ctrl+Y are left to the browser", () => {
		expect(press("z", { modifier: true, drawing: false })).toBeNull();
		expect(press("z", { modifier: true, shift: true, drawing: false })).toBeNull();
		expect(press("y", { modifier: true, drawing: false, kind: "audio" })).toBeNull();
	});

	test("no other key does anything with a modifier down: the arrows do not seek, Space does not play, M and the tool keys are not ours", () => {
		const keys = ["ArrowLeft", "ArrowRight", "Home", "End", " ", ",", ".", "m", "i", "o", "1", "3", "5", "c", "p", "Escape"];
		for (const drawing of [false, true]) {
			for (const key of keys) expect(press(key, { modifier: true, drawing, armed: true, inPoint: 3 }), `${key} drawing=${drawing}`).toBeNull();
		}
	});
});

describe("a key held down: what repeats on purpose repeats, what makes a note is pressed once", () => {
	type Row = [name: string, key: string, over: Partial<KeyInput>, want: KeyAction];

	const NOTES: Row[] = [
		["m", "m", {}, { do: "mark" }],
		["i", "i", {}, { do: "set-in" }],
		["o with no start set", "o", { inPoint: null }, { do: "needs-start" }],
		["o with a start set", "o", { inPoint: 3 }, { do: "end-stretch" }],
		["1", "1", { drawing: true }, { do: "tool", tool: "pin" }],
		["2", "2", { drawing: true }, { do: "tool", tool: "box" }],
		["3", "3", { drawing: true }, { do: "tool", tool: "ellipse" }],
		["4", "4", { drawing: true }, { do: "tool", tool: "arrow" }],
		["5", "5", { drawing: true }, { do: "tool", tool: "pen" }],
	];

	test.each(NOTES)("%s: pressed anew it answers its action; held, and repeated by the system, it answers nothing", (_name, key, over, want) => {
		expect(press(key, { ...over, repeat: false })).toEqual(want);
		expect(press(key, { ...over, repeat: true })).toBeNull();
	});

	const HELD: Row[] = [
		["ArrowLeft", "ArrowLeft", {}, { do: "seek", to: 5 }],
		["ArrowRight", "ArrowRight", {}, { do: "seek", to: 15 }],
		["Shift+ArrowLeft", "ArrowLeft", { shift: true }, { do: "seek", to: 9 }],
		["Home", "Home", {}, { do: "seek", to: 0 }],
		["End", "End", {}, { do: "seek", to: 90 }],
		[",", ",", {}, { do: "step", direction: -1 }],
		[".", ".", {}, { do: "step", direction: 1 }],
		["Space", " ", {}, { do: "toggle" }],
		["Ctrl+Z", "z", { modifier: true, drawing: true }, { do: "undo" }],
		["Ctrl+Shift+Z", "z", { modifier: true, shift: true, drawing: true }, { do: "redo" }],
		["Ctrl+Y", "y", { modifier: true, drawing: true }, { do: "redo" }],
		["Escape with a stretch half set", "Escape", { inPoint: 4.2 }, { do: "cancel-stretch" }],
		["Escape with a tool in hand", "Escape", { armed: true }, { do: "disarm" }],
	];

	test.each(HELD)("%s: held, it keeps answering exactly as when pressed anew", (_name, key, over, want) => {
		expect(press(key, { ...over, repeat: false })).toEqual(want);
		expect(press(key, { ...over, repeat: true })).toEqual(want);
	});

	test("a repeat lets through no key that marking being off blocked", () => {
		for (const key of ["m", "i", "o", "1", "5"]) {
			expect(press(key, { marking: false, drawing: true, repeat: false }), `${key} pressed`).toBeNull();
			expect(press(key, { marking: false, drawing: true, repeat: true }), `${key} held`).toBeNull();
		}
	});

	test("a repeat does not take a key from the human who is typing, nor from a widget that has it", () => {
		const typing = { typing: true, presses: false, navigates: false };
		const slider = { typing: false, presses: false, navigates: true };
		for (const key of [" ", "ArrowLeft", "Home", ",", "Escape"]) expect(press(key, { owner: typing, repeat: true, inPoint: 3, armed: true }), `${key} typing`).toBeNull();
		for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) expect(press(key, { owner: slider, repeat: true }), `${key} slider`).toBeNull();
	});
});

describe("keyOwner reads whose key it is from the focused element", () => {
	let dom: TestDom;
	beforeAll(() => {
		dom = installDom();
	});
	afterAll(() => dom.restore());

	const make = (html: string): HTMLElement => {
		const holder = dom.document.createElement("div");
		holder.innerHTML = html;
		dom.document.body.append(holder);
		return holder.firstElementChild as HTMLElement;
	};

	test("a text box, a text area and a select are typing", () => {
		for (const html of ["<input type='text'>", "<textarea></textarea>", "<select><option>a</option></select>"]) {
			expect(keyOwner(make(html)).typing, html).toBe(true);
		}
	});

	test("an editable region is typing, whatever it is made of", () => {
		const editable = make("<div>notes</div>");
		Object.defineProperty(editable, "isContentEditable", { value: true });
		expect(keyOwner(editable).typing).toBe(true);
	});

	test("a button, a link, and anything inside one press; a bare div does not", () => {
		expect(keyOwner(make("<button>Play</button>")).presses).toBe(true);
		expect(keyOwner(make("<a href='https://example.com'>x</a>")).presses).toBe(true);
		const inside = make("<button><span>icon</span></button>").firstElementChild;
		expect(keyOwner(inside).presses).toBe(true);
		expect(keyOwner(make("<a>no target</a>")).presses).toBe(false);
		expect(keyOwner(make("<div>plain</div>"))).toEqual(NOBODY);
	});

	test("a slider, a tab and a list box navigate; so does anything inside a tab bar", () => {
		for (const html of ["<div role='slider'></div>", "<div role='tab'></div>", "<ul role='listbox'><li>a</li></ul>"]) {
			expect(keyOwner(make(html)).navigates, html).toBe(true);
		}
		expect(keyOwner(make("<div role='tablist'><span>inside</span></div>").firstElementChild).navigates).toBe(true);
	});

	test("nothing focused, or something that is not an element, belongs to nobody", () => {
		expect(keyOwner(null)).toEqual(NOBODY);
		expect(keyOwner(new EventTarget())).toEqual(NOBODY);
	});
});
