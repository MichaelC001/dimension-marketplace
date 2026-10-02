/**
 * How a THROWAWAY AGENT browser presents itself to the sites it visits.
 *
 * An agent that opens a browser without a profile (or has `browser_read` read
 * a public page) does real work on the real web, and the first bot check it
 * meets decides whether the work happens. A stock puppeteer Chrome fails
 * public headless checks that the same Chrome started by hand passes; this
 * module closes exactly those, once, in the browser itself:
 *
 *  - `navigator.webdriver` (page and iframes; a worker has no such property):
 *    the `AutomationControlled` Blink switch, a launch argument. No page
 *    script is involved.
 *  - a page larger than its own "screen", a window smaller than its page, a
 *    1280x800 desktop page reporting `portrait-primary`: headless Chrome's
 *    virtual screen is 800x600 whatever the viewport. A device-metrics
 *    override and the window bounds, both native CDP commands, made again
 *    whenever the viewport changes (`fitAgentScreen`).
 *  - the driver's own scripts named in the stack of any page API they call,
 *    with the pack's file path in it (`pptr:evaluate;<callsite>`): stripped
 *    from the two commands that carry it (`silenceDriverNames`).
 *  - a software renderer (SwiftShader, llvmpipe) on a host with no GPU: the
 *    one signal that needs a page script, so it exists only for such hosts,
 *    decided once per browser binary (`SOFTWARE_GRAPHICS_MASK`).
 *
 * The User-Agent, its client hints and the workers' view of both are
 * `presentAsHeadful`'s (puppeteer.ts), for the View and for this alike.
 *
 * THE EXCEPTION, and why it is explicit: doc 77 §12 decision 2 refuses the
 * automation-hiding switch so that a person signing in, in the View or a saved
 * profile, is not disguised and Google is not given a reason to challenge a
 * sign-in. That decision stands for the View and every saved profile, which
 * stay the real, honest browser: nothing in this module touches them. It is
 * reversed ONLY for a throwaway browser (no profile; nothing is kept, nobody
 * signs in) and the browser_read reader, whose whole job is to read pages a
 * stock automation browser is turned away from. `EngineOptions.agent` is the
 * one switch; the runtime sets it from `profile === null`, never from tool
 * input.
 */
import type { CDPSession, Connection, Page } from "puppeteer-core";
import type { Viewport } from "../contracts.js";

/** Launch arguments for an agent browser: `navigator.webdriver` is false in every page and iframe, from the browser itself. */
export const AGENT_LAUNCH_ARGS: readonly string[] = ["--disable-blink-features=AutomationControlled"];

/** What a stock Chrome window spends on its tab strip and address bar, in CSS px: `outerHeight - innerHeight`. */
const WINDOW_CHROME_HEIGHT = 88;
/** The smallest desktop display presented; it grows to hold a larger window. */
const MIN_SCREEN: Viewport = { width: 1920, height: 1080 };

/**
 * Give a page `viewport` a screen and a window that agree with it. Call after
 * every `page.setViewport`: puppeteer's override replaces ours, and headless
 * Chrome's own screen is 800x600, its window 780x580 and its orientation
 * portrait whatever the page measures. `cdp` is any session on the page.
 */
export async function fitAgentScreen(cdp: CDPSession, viewport: Viewport, scale: number): Promise<void> {
	const windowHeight = viewport.height + WINDOW_CHROME_HEIGHT;
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: scale,
		mobile: false,
		screenWidth: Math.max(MIN_SCREEN.width, viewport.width),
		screenHeight: Math.max(MIN_SCREEN.height, windowHeight),
		positionX: 0,
		positionY: 0,
		screenOrientation: { angle: 0, type: "landscapePrimary" },
	});
	const { windowId } = await cdp.send("Browser.getWindowForTarget");
	await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: viewport.width, height: windowHeight } });
}

/** What an agent browser's pages are shaped with (`shapeAgentPage`). */
export interface AgentShape {
	/** Give each page a screen and window that fit it. Not in a browser with a real window, which already has both. */
	screen: boolean;
	/** The GPU to report instead of a software renderer, when the binary renders in software here. */
	graphics: MaskedGraphics | undefined;
}

/**
 * Shape one new page of an agent browser before it navigates anywhere: the
 * software-renderer mask in every document it will load, and a screen and
 * window that fit `viewport`. Call after the page's viewport is set.
 */
export async function shapeAgentPage(page: Page, cdp: CDPSession, viewport: Viewport, scale: number, shape: AgentShape): Promise<void> {
	if (shape.graphics) await page.evaluateOnNewDocument(SOFTWARE_GRAPHICS_MASK, shape.graphics.vendor, shape.graphics.renderer, SOFTWARE_RENDERER.source);
	if (shape.screen) await fitAgentScreen(cdp, viewport, scale);
}

/** The comment puppeteer appends to every script it evaluates: `//# sourceURL=pptr:evaluate;<the caller's file and line>`. */
const DRIVER_NAME = /\n\/\/# sourceURL=pptr:\S*\n?/g;

/**
 * The params of a CDP command with the driver's script name taken out. Only
 * the two commands puppeteer evaluates page functions with carry it, and only
 * its own `pptr:` name is removed: a page script's or a model's own
 * `//# sourceURL` stays.
 */
export function withoutDriverNames(method: string, params: unknown): unknown {
	if (params === null || typeof params !== "object") return params;
	const key = method === "Runtime.callFunctionOn" ? "functionDeclaration" : method === "Runtime.evaluate" ? "expression" : undefined;
	if (key === undefined) return params;
	const source = (params as Record<string, unknown>)[key];
	if (typeof source !== "string" || !source.includes("//# sourceURL=pptr:")) return params;
	return { ...params, [key]: source.replace(DRIVER_NAME, "\n") };
}

interface Sender {
	_rawSend?: (this: Connection, ...args: unknown[]) => unknown;
}

/**
 * Strip the driver's script names from everything this connection sends, for
 * every session on it, present and future. Puppeteer exposes no option for
 * this; `Connection._rawSend` is the one place all its sessions send through.
 * Throws if a puppeteer upgrade moves it, rather than silently leaving the
 * pack's file path in every page's stack traces (the agent-browser test goes
 * red the same way).
 */
export function silenceDriverNames(connection: Connection): void {
	const host = connection as unknown as Sender;
	const send = host._rawSend;
	if (typeof send !== "function") throw new Error("puppeteer-core no longer sends through Connection._rawSend; the agent browser would name the driver in page stacks");
	host._rawSend = function (this: Connection, callbacks: unknown, method: unknown, params: unknown, ...rest: unknown[]): unknown {
		return send.call(this, callbacks, method, typeof method === "string" ? withoutDriverNames(method, params) : params, ...rest);
	};
}

/** What a software renderer's strings look like (Chrome's SwiftShader, Mesa's llvmpipe/lavapipe). */
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|lavapipe|software|mesa offscreen|google inc\. \(google\)/i;

/** A GPU a person's machine of this platform commonly has, as `WEBGL_debug_renderer_info` words it. */
export interface MaskedGraphics {
	vendor: string;
	renderer: string;
}

/** The GPU an agent browser on a software renderer reports instead, by the platform it presents (`navigator.userAgentData.platform`). */
export function maskedGraphics(platform: string): MaskedGraphics {
	if (/mac/i.test(platform)) return { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)" };
	if (/win/i.test(platform)) return { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" };
	return { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)" };
}

/**
 * Runs in every new document (`evaluateOnNewDocument`), and only in a browser
 * whose binary was found to render in software. Answers a masked vendor and
 * renderer for the two unmasked-info parameters, from a Proxy over the native
 * `getParameter` (so a wrong receiver still throws Chrome's own error), and
 * makes both it and `Function.prototype.toString` report `[native code]`. It
 * does not reach workers: an OffscreenCanvas there still names the host's
 * renderer. Self-contained: it is serialized into the page.
 */
export const SOFTWARE_GRAPHICS_MASK = (vendor: string, renderer: string, software: string): void => {
	const looksSoftware = new RegExp(software, "i");
	const nativeToString = Function.prototype.toString;
	const names = new WeakMap<object, string>();
	const toString = new Proxy(nativeToString, {
		apply(target, self, args) {
			const name = names.get(self as object);
			return name === undefined ? Reflect.apply(target, self, args) : `function ${name}() { [native code] }`;
		},
	});
	names.set(toString, "toString");
	Object.defineProperty(Function.prototype, "toString", { value: toString, writable: true, configurable: true, enumerable: false });
	const UNMASKED_VENDOR_WEBGL = 0x9245;
	const UNMASKED_RENDERER_WEBGL = 0x9246;
	for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
		if (typeof Context !== "function") continue;
		const original = Context.prototype.getParameter;
		const getParameter = new Proxy(original, {
			apply(target, self, args) {
				const value: unknown = Reflect.apply(target, self, args);
				if (typeof value !== "string" || !looksSoftware.test(value)) return value;
				if (args[0] === UNMASKED_VENDOR_WEBGL) return vendor;
				if (args[0] === UNMASKED_RENDERER_WEBGL) return renderer;
				return value;
			},
		});
		names.set(getParameter, "getParameter");
		Object.defineProperty(Context.prototype, "getParameter", { value: getParameter, writable: true, configurable: true, enumerable: true });
	}
};
