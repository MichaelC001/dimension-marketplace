// Rendering for the media tests: linkedom and the real react-dom under `act`, the way the kit's React tests do it.
// linkedom has no layout and no frames of its own, so animation frames are a queue the test runs by hand.
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { installDom, type TestDom } from "./dom";

export interface ReactEnv {
	readonly document: Document;
	/** React's `act`: wrap whatever the test does that React should flush before the next line. */
	readonly act: typeof act;
	/** Render `element` into a fresh container and wait for it to settle. */
	readonly mount: (element: ReactElement) => Promise<{ readonly container: HTMLElement; readonly render: (next: ReactElement) => Promise<void>; readonly unmount: () => Promise<void> }>;
	/** Run the animation frames asked for so far, once (a frame that asks for the next is run by the next call). */
	readonly runFrames: () => Promise<void>;
	/** How many animation frames are waiting to run. */
	readonly pendingFrames: () => number;
	/** Unmount everything mounted. */
	readonly cleanup: () => Promise<void>;
	/** Put the globals back the way they were. */
	readonly restore: () => void;
}

export async function installReact(): Promise<ReactEnv> {
	const dom: TestDom = installDom();
	const target = globalThis as unknown as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const put = (name: string, value: unknown): void => {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	};
	put("IS_REACT_ACT_ENVIRONMENT", true);
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 1;
	put("requestAnimationFrame", (callback: FrameRequestCallback): number => {
		frames.set(nextFrame, callback);
		return nextFrame++;
	});
	put("cancelAnimationFrame", (handle: number): void => void frames.delete(handle));
	// Not a static import: react-dom decides once, when it loads, whether there is a DOM, so it loads after the globals above.
	const { createRoot } = await import("react-dom/client");
	const roots: Root[] = [];
	return {
		document: dom.document,
		act,
		async mount(element) {
			const container = dom.document.createElement("div");
			dom.document.body.append(container);
			const root = createRoot(container);
			roots.push(root);
			await act(async () => root.render(element));
			return {
				container,
				render: next => act(async () => root.render(next)),
				unmount: async () => {
					roots.splice(roots.indexOf(root), 1);
					await act(async () => root.unmount());
				},
			};
		},
		async runFrames() {
			await act(async () => {
				for (const [handle, callback] of [...frames]) {
					frames.delete(handle);
					callback(0);
				}
			});
		},
		pendingFrames: () => frames.size,
		async cleanup() {
			await act(async () => {
				while (roots.length > 0) roots.pop()?.unmount();
			});
			frames.clear();
			dom.document.body.replaceChildren();
		},
		restore() {
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete target[name];
			}
			dom.restore();
		},
	};
}
