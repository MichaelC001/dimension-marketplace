// What a key does on a recording - and whose key it is first. The pane listens on the window, so
// every key pressed anywhere in the View arrives; a text box, a button, a slider and a tab bar
// each have their own use for some of them. And Escape has two jobs that must come in order:
// the first takes back a stretch half set, the second leaves the marking mode.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decideKey, type KeyAction, type KeyInput, keyOwner, NOBODY } from "../app/view/media-keys";
import type { MediaLength } from "../app/view/media-length";
import { installDom, type TestDom } from "./dom";

const BOUNDED: MediaLength = { duration: 90, reach: 90, unbounded: false };
const UNBOUNDED: MediaLength = { duration: Number.POSITIVE_INFINITY, reach: 40, unbounded: true };

const press = (key: string, over: Partial<KeyInput> = {}): KeyAction | null =>
	decideKey({ key, shift: false, position: 10, length: BOUNDED, kind: "video", marking: true, inPoint: null, owner: NOBODY, ...over });

describe("whose key it is comes first", () => {
	test("while the human types, nothing is the recording's: not Space, not the arrows, not M", () => {
		for (const key of [" ", "ArrowLeft", "ArrowRight", "Home", "End", "m", "i", "o", ",", "Escape"]) {
			expect(press(key, { owner: { typing: true, presses: false, navigates: false } }), key).toBeNull();
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

describe("Escape: the first takes back a stretch half set, the second leaves the mode", () => {
	test("with a stretch started, Escape cancels the stretch and does NOT leave the mode", () => {
		expect(press("Escape", { inPoint: 4.2 })).toEqual({ do: "cancel-stretch" });
	});

	test("with no stretch half set, Escape leaves the mode", () => {
		expect(press("Escape", { inPoint: null })).toEqual({ do: "leave-mode" });
	});

	test("pressed twice in a row it does both, in that order", () => {
		let inPoint: number | null = 4.2;
		let marking = true;
		const done: string[] = [];
		for (let presses = 0; presses < 3; presses += 1) {
			const action = press("Escape", { inPoint, marking });
			if (action?.do === "cancel-stretch") inPoint = null;
			if (action?.do === "leave-mode") marking = false;
			done.push(action?.do ?? "nothing");
		}
		expect(done).toEqual(["cancel-stretch", "leave-mode", "nothing"]);
	});

	test("outside the mode there is nothing to leave; a stretch left half set is still taken back", () => {
		expect(press("Escape", { marking: false })).toBeNull();
		expect(press("Escape", { marking: false, inPoint: 2 })).toEqual({ do: "cancel-stretch" });
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

	test("any other key is left alone", () => {
		for (const key of ["a", "Enter", "Tab", "ArrowUp", "ArrowDown", "PageDown", "Shift"]) expect(press(key), key).toBeNull();
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
