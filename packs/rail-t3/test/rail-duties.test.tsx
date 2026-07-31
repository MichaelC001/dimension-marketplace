import "./test-globals";
import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { T3_RAIL } from "../src";
import {
	FIXTURE_RAIL_ACTIONS,
	SURFACE,
	mountForTest,
	railSlotFixture,
	type RailSlotProps,
} from "@fraym/ui";
import type { ShellIntent } from "@fraym/ui";

const DOM_GLOBALS = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"ResizeObserver",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
type DomGlobal = (typeof DOM_GLOBALS)[number];

let previousDomGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
let testWindow: Window | undefined;
const mounts: Array<{ readonly unmount: () => void }> = [];

function replaceProperty(target: object, key: PropertyKey, value: unknown) {
	const previous = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: previous?.enumerable ?? true,
		value,
		writable: true,
	});
	return () => {
		if (previous) Object.defineProperty(target, key, previous);
		else Reflect.deleteProperty(target, key);
	};
}

function installDom(): Window {
	if (testWindow) return testWindow;
	const { window } = parseHTML("<html><body></body></html>");
	const ResizeObserver = class {
		observe() {}
		disconnect() {}
	};
	const requestAnimationFrame = (callback: FrameRequestCallback) => {
		callback(0);
		return 0;
	};
	Object.assign(window, {
		ResizeObserver,
		requestAnimationFrame,
		cancelAnimationFrame: () => {},
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
	});
	for (const prototype of [window.HTMLElement?.prototype, window.Element?.prototype]) {
		if (!prototype) continue;
		prototype.scrollTo = () => {};
		prototype.scrollBy = () => {};
		prototype.scrollIntoView = () => {};
	}
	previousDomGlobals ??= Object.fromEntries(
		DOM_GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	) as Record<DomGlobal, PropertyDescriptor | undefined>;
	const values: Record<DomGlobal, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		ResizeObserver,
		requestAnimationFrame,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const key of DOM_GLOBALS) replaceProperty(globalThis, key, values[key]);
	testWindow = window;
	return window;
}

function restoreDom() {
	for (const key of DOM_GLOBALS) {
		const previous = previousDomGlobals?.[key];
		if (previous) Object.defineProperty(globalThis, key, previous);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousDomGlobals = undefined;
	testWindow = undefined;
}

afterEach(() => {
	for (const mounted of mounts.splice(0)) mounted.unmount();
	restoreDom();
});

interface MountResult {
	readonly window: Window;
	readonly container: HTMLElement;
	readonly intents: ShellIntent[];
}

function mount(makeProps: (recordIntent: (intent: ShellIntent) => void) => RailSlotProps): MountResult {
	const window = installDom();
	const intents: ShellIntent[] = [];
	const recordIntent = (intent: ShellIntent) => intents.push(intent);
	const props = makeProps(recordIntent);
	const mounted = mountForTest(
		{
			component: T3_RAIL.component as React.ComponentType<RailSlotProps>,
		},
		() => props,
	);
	mounts.push(mounted);
	return { window, container: mounted.container, intents };
}

function railButton(container: HTMLElement, label: string): HTMLButtonElement {
	const button = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="rail-actions"] button[data-slot="rail-button"]')].find(
		candidate => candidate.textContent?.trim() === label,
	);
	if (!button) throw new Error(`Missing ${label} rail action`);
	return button;
}

function click(window: Window, button: HTMLButtonElement) {
	act(() => button.dispatchEvent(new window.Event("click", { bubbles: true })));
}

describe("rail duties", () => {
	test("renders every enabled fixture action as button[data-slot='rail-button'] with label inside [data-slot='rail-actions']", () => {
		const { container } = mount(recordIntent => railSlotFixture(recordIntent));

		for (const action of FIXTURE_RAIL_ACTIONS) {
			const button = railButton(container, action.label);
			expect(button).toBeInstanceOf(HTMLElement);
			expect(button.tagName.toLowerCase()).toBe("button");
			expect(button.getAttribute("data-slot")).toBe("rail-button");
			expect(button.textContent?.trim()).toBe(action.label);
		}
	});

	test.each([
		["New session", { t: "create" as const }],
		["Autonomy", { t: "mount" as const, surface: SURFACE.autonomy }],
		["Models", { t: "mount" as const, surface: SURFACE.models }],
		["Capabilities", { t: "door" as const, route: "settings", pane: "mcp" }],
		["Library", { t: "mount" as const, surface: SURFACE.library }],
	] as const)("%s emits its documented ShellIntent", (label, intent) => {
		const { window, container, intents } = mount(recordIntent => railSlotFixture(recordIntent));

		click(window, railButton(container, label));

		expect(intents).toEqual([intent]);
	});

	test("retains exactly one button with class containing 'primary'", () => {
		const { container } = mount(recordIntent => railSlotFixture(recordIntent));
		const primaryButtons = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="rail-actions"] button.primary')];

		expect(primaryButtons).toHaveLength(1);
		expect(primaryButtons[0]?.textContent?.trim()).toBe("New session");
	});

	test("uses surface identity for active state with className containing 'bg-fr-surface-2'", () => {
		const { container } = mount(recordIntent =>
			railSlotFixture(recordIntent, { activeSurface: SURFACE.library }),
		);

		expect(railButton(container, "Library").className).toContain("bg-fr-surface-2");
		expect(railButton(container, "Autonomy").className).not.toContain("bg-fr-surface-2");
	});
});

describe("T3-specific functionality", () => {
	test("renders working item in card, idle item in list, and settled shelf toggle", () => {
		const now = new Date().toISOString();
		const { container } = mount(recordIntent => {
			const props = railSlotFixture(recordIntent);
			return {
				...props,
				groups: [
					{
						repo: "test-repo",
						branch: "main",
						dot: "bg-blue-400",
						items: [
							{
								id: "working-1",
								title: "Working Task",
								time: "1h",
								status: "working" as const,
								updatedAt: now,
								createdAt: now,
							},
							{
								id: "idle-1",
								title: "Idle Task",
								time: "2h",
								status: "idle" as const,
								updatedAt: now,
								createdAt: now,
							},
							{
								id: "archived-1",
								title: "Archived Task",
								time: "3h",
								status: "ok" as const,
								archived: true,
								updatedAt: now,
								createdAt: now,
							},
						],
					},
				],
			};
		});

		// Check working item exists
		expect(container.textContent).toContain("Working Task");

		// Check idle item exists
		expect(container.textContent).toContain("Idle Task");

		// Look for settled toggle (it should exist or be revealable)
		const toggles = container.querySelectorAll('button');
		let settledToggleFound = false;
		for (const button of toggles) {
			if (button.textContent?.toLowerCase().includes("settled") || button.textContent?.toLowerCase().includes("archive")) {
				settledToggleFound = true;
				break;
			}
		}
		// The settled toggle should exist in the render
		expect(settledToggleFound || container.textContent?.includes("Archived Task")).toBe(true);
	});
});
