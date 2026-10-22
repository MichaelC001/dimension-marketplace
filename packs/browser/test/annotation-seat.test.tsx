import { afterEach, describe, expect, mock, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { VIEW_DICTATION_CONTEXT_KEY, VIEW_DICTATION_START_METHOD, VIEW_DICTATION_STOP_METHOD } from "@dimension/sdk/artifactory";
import * as realExtApps from "@modelcontextprotocol/ext-apps/react";
import { act, useState } from "react";
import * as ReactDomClient from "react-dom/client";
import * as realPaint from "../../../../packages/mcp-app-kit/src/annotate/paint";
import type { BrowserFrame } from "../src/contracts";
import { BrowserClient } from "../app/view/browser-client";
import { type Dom, mount, unmountAll } from "./dom-harness";

const NATURAL = { width: 1280, height: 800 };
mock.module("../../../../packages/mcp-app-kit/src/annotate/paint.js", () => ({
	...realPaint,
	measureImage: async () => NATURAL,
	paintMarkup: async (_source: unknown, marks: readonly unknown[]) => ({
		frame: { mimeType: "image/png", data: "AAAA", bytes: 3, width: NATURAL.width, height: NATURAL.height },
		crops: [],
		natural: NATURAL,
		scale: 1,
		marksPainted: marks.length,
		notes: [],
	}),
}));

interface ViewHost {
	app: App | undefined;
	booting: boolean;
	readonly created: WeakSet<App>;
	readonly roots: ReactDomClient.Root[];
}
const viewHost: ViewHost = { app: undefined, booting: false, created: new WeakSet(), roots: [] };
const realCreateRoot = ReactDomClient.createRoot;
mock.module("react-dom/client", () => ({
	...ReactDomClient,
	createRoot: (container: Element, options?: ReactDomClient.RootOptions) => {
		const root = realCreateRoot(container, options);
		if (viewHost.booting) viewHost.roots.push(root);
		return root;
	},
}));
mock.module("@modelcontextprotocol/ext-apps/react", () => ({
	...realExtApps,
	useApp: (options: Parameters<typeof realExtApps.useApp>[0]) => {
		const app = viewHost.app;
		if (app === undefined) return realExtApps.useApp(options);
		if (!viewHost.created.has(app)) {
			viewHost.created.add(app);
			options?.onAppCreated?.(app);
		}
		return { app, isConnected: true, error: null };
	},
	useHostStyles: (...args: Parameters<typeof realExtApps.useHostStyles>) => (viewHost.app === undefined ? realExtApps.useHostStyles(...args) : undefined),
	useDocumentTheme: () => (viewHost.app === undefined ? realExtApps.useDocumentTheme() : "light"),
}));
const { AnnotationSeat } = await import("../app/view/annotation-seat");
const { BrowserApp } = await import("../app/view/browser-app");

afterEach(async () => {
	viewHost.app = undefined;
	for (const root of viewHost.roots.splice(0)) await act(async () => root.unmount());
	await unmountAll();
});

const FRAME: BrowserFrame = {
	frameId: "f1",
	mimeType: "image/png",
	data: "AAAA",
	capturedAt: "2026-10-02T10:00:00.000Z",
	state: {
		browserId: "b1",
		profile: null,
		engine: "chromium",
		app: "chrome",
		url: "https://example.com/pricing",
		title: "Pricing",
		revision: 1,
		viewport: NATURAL,
		task: null,
		tabs: [],
		activeTabId: "",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		publish: null,
		dialogs: [],
	},
};

interface Call {
	readonly name: string;
	readonly args: Record<string, unknown>;
}
interface Update {
	readonly content: readonly { type: string; text?: string }[];
}

const asked = (args: Record<string, unknown>) =>
	Array.isArray(args.regions)
		? args.regions.map(region => ({
				region,
				truncated: false,
				elements: [{ tag: "button", id: "buy", label: "Buy now", box: { x: 412, y: 300, width: 96, height: 32 } }],
			}))
		: [];

interface Dictation {
	readonly offered: boolean;
	readonly available: boolean;
}

function host(over: { capabilities?: object; dictation?: Dictation; annotate?: (call: Call) => CallToolResult; other?: (call: Call) => CallToolResult } = {}) {
	const calls: Call[] = [];
	const updates: Update[] = [];
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const lent = { [VIEW_DICTATION_CONTEXT_KEY]: { available: over.dictation?.available ?? false, phase: "idle", text: "" } };
	const dictationVerbs = over.dictation?.offered === true ? { experimental: { [VIEW_DICTATION_START_METHOD]: {}, [VIEW_DICTATION_STOP_METHOD]: {} } } : {};
	const app = {
		callServerTool: async (request: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> => {
			const call = { name: request.name, args: request.arguments ?? {} };
			calls.push(call);
			if (call.name === "browser_annotation_file") return { content: [], structuredContent: { path: "/tmp/annotation-1.json" } };
			if (call.name !== "browser_annotate") return over.other?.(call) ?? { isError: true, content: [{ type: "text", text: "unexpected" }] };
			return (
				over.annotate?.(call) ?? {
					content: [],
					structuredContent: {
						url: FRAME.state.url,
						title: FRAME.state.title,
						capturedAt: FRAME.capturedAt,
						readAt: "2026-10-02T10:00:01.000Z",
						viewport: NATURAL,
						scroll: { x: 0, y: 1200, width: 1280, height: 4300 },
						regions: asked(call.args),
					},
				}
			);
		},
		getHostCapabilities: () => over.capabilities ?? { updateModelContext: { text: {}, image: {} }, ...dictationVerbs },
		getHostContext: () => lent,
		addEventListener: (name: string, listener: (payload: unknown) => void) => {
			listeners.set(name, (listeners.get(name) ?? new Set()).add(listener));
		},
		removeEventListener: (name: string, listener: (payload: unknown) => void) => {
			listeners.get(name)?.delete(listener);
		},
		updateModelContext: async (update: Update) => {
			updates.push(update);
			return {};
		},
	} as unknown as App;
	const emit = (name: string, payload: unknown) => {
		for (const listener of listeners.get(name) ?? []) listener(payload);
	};
	return { app, calls, updates, emit };
}

const label = (dom: Dom, name: string): Element => {
	const found = dom.find(`[aria-label="${name}"]`)[0];
	if (!found) throw new Error(`no control labelled ${name}`);
	return found;
};

const DRAW_SURFACE = "Draw on the page. Arrow keys move the cursor; Enter or Space places a point.";

async function placePin(dom: Dom): Promise<void> {
	await dom.click(label(dom, "Pin"));
	await dom.key(label(dom, DRAW_SURFACE), "Enter");
}

async function marked(app: App, client = new BrowserClient(app), onDone = () => {}) {
	await client.follow("b1");
	const dom = await mount(<AnnotationSeat app={app} client={client} browserId="b1" frame={FRAME} onDone={onDone} />);
	await placePin(dom);
	return { dom, client };
}

const noteField = (dom: Dom): Element => {
	const found = dom.find('[data-slot="note-popover-field"]')[0];
	if (!found) throw new Error("no note is open");
	return found;
};
const notice = (dom: Dom): string => dom.find(".dam-notice")[0]?.textContent ?? "";

async function until(dom: Dom, done: () => boolean, withinMs = 4000): Promise<void> {
	const deadline = Date.now() + withinMs;
	while (!done() && Date.now() < deadline) await dom.act(() => new Promise<void>(resolve => setTimeout(resolve, 25)));
	if (!done()) throw new Error("what the test waits for never happened");
}

const textOf = (update: Update | undefined): string => update?.content.find(block => block.type === "text")?.text ?? "";

const QUIET_TIMER_FLOOR_MS = 250;

function holdQuietTimers(): { readonly armed: () => number; readonly release: () => void } {
	const real = globalThis.setTimeout;
	let armed = 0;
	globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
		if ((delay ?? 0) < QUIET_TIMER_FLOOR_MS) return real(handler as () => void, delay, ...args);
		armed += 1;
		return real(() => {}, delay);
	}) as unknown as typeof setTimeout;
	return { armed: () => armed, release: () => void (globalThis.setTimeout = real) };
}

function LeavableSeat({ app, client, onLeft }: { readonly app: App; readonly client: BrowserClient; readonly onLeft: () => void }) {
	const [seated, setSeated] = useState(true);
	if (!seated) return null;
	return (
		<AnnotationSeat
			app={app}
			client={client}
			browserId="b1"
			frame={FRAME}
			onDone={() => {
				onLeft();
				setSeated(false);
			}}
		/>
	);
}

describe("the annotation seat", () => {
	test("a mark opens its note beside it, and the seat has no side panel, no overall message and no Request edits", async () => {
		const { app } = host();
		const { dom } = await marked(app);

		expect(dom.find('[data-slot="note-popover"]')).toHaveLength(1);
		expect(dom.find('[data-slot="mark-badge"]')).toHaveLength(1);
		expect(
			dom.find('[data-slot="annotate-panel"], .dam-panel, .dam-foot, .dam-row, button.dam-send, textarea[aria-label="Overall message for the agent"]'),
		).toHaveLength(0);
		expect(dom.text()).not.toContain("Request edits");
		expect(dom.text()).not.toContain("Anything else for the agent?");
	});

	test("a note typed at the mark is staged by itself as the page's own facts: where it is, what is under the mark, and where to read the rest", async () => {
		const { app, calls, updates } = host();
		const { dom } = await marked(app);

		await dom.type(noteField(dom), "make this bigger");
		await until(dom, () => updates.length === 1);

		expect(updates[0]?.content.map(block => block.type)).toEqual(["image", "text"]);
		const text = textOf(updates[0]);
		expect(text).toContain('Annotations from the human on "https://example.com/pricing"');
		expect(text).toContain("make this bigger");
		expect(text).toContain("About the picture: Words from the page");
		expect(text).toContain("Live web page");
		expect(text).toContain("y=1200");
		expect(text).toContain('Facts: Under it: "button#buy" "Buy now"');
		expect(text).toContain("/tmp/annotation-1.json");

		const lookups = calls.filter(call => call.name === "browser_annotate");
		expect(lookups).toHaveLength(1);
		expect(lookups[0]?.args).toMatchObject({ browserId: "b1", frameId: "f1" });
		expect(lookups[0]?.args.regions).toEqual([expect.objectContaining({ width: 24, height: 24 })]);
		const filed = calls.find(call => call.name === "browser_annotation_file");
		expect(String(filed?.args.json)).toContain("dimension.annotation-detail/");
	});

	test("what was staged can be taken back when the View moves to another browser", async () => {
		const { app, updates } = host();
		const { dom, client } = await marked(app);
		await until(dom, () => updates.length === 1);

		await client.follow("b2");

		expect(updates).toHaveLength(2);
		expect(updates[1]?.content).toEqual([]);
	});

	test("deleting the only mark from its note takes back what was staged", async () => {
		const { app, updates } = host();
		const { dom } = await marked(app);
		await until(dom, () => updates.length === 1);

		const remove = dom.find('[data-slot="note-popover-delete"]')[0];
		if (!remove) throw new Error("the open note has no delete");
		await dom.click(remove);
		await until(dom, () => updates.length === 2);

		expect(updates[1]?.content).toEqual([]);
		expect(dom.find('[data-slot="mark-badge"]')).toHaveLength(0);
	});

	test("a host with no door for context refuses in writing and nothing is looked up or staged", async () => {
		const { app, calls, updates } = host({ capabilities: {} });
		const { dom } = await marked(app);

		await until(dom, () => notice(dom) !== "");

		expect(notice(dom)).toContain("cannot attach annotations");
		expect(updates).toEqual([]);
		expect(calls).toEqual([]);
		expect(dom.find('[data-slot="mark-badge"]')).toHaveLength(1);
	});

	test("a page that moved on loses the elements but not the marks: the picture goes, and the human is told why", async () => {
		const { app, updates } = host({
			annotate: () => ({
				isError: true,
				content: [{ type: "text", text: "frame f1 was captured at revision 1; the page is now at revision 2. Capture a new frame." }],
			}),
		});
		const { dom } = await marked(app);

		await until(dom, () => updates.length === 1 && notice(dom) !== "");

		const text = textOf(updates[0]);
		expect(text).toContain('on "https://example.com/pricing"');
		expect(text).not.toContain("Facts:");
		expect(notice(dom)).toContain("could not be read");
		expect(notice(dom)).toContain("revision 2");
	});

	test("Done leaves the seat and does not touch what was staged: the request stays in the next message, it is the human's to send or leave", async () => {
		let done = 0;
		const { app, updates } = host();
		const { dom } = await marked(app, undefined, () => {
			done += 1;
		});
		await until(dom, () => updates.length === 1);

		await dom.click(label(dom, "Done"));

		expect(done).toBe(1);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.content.length).toBeGreaterThan(0);
	});

	for (const leave of [
		{ name: "Done", press: (dom: Dom) => dom.click(label(dom, "Done")) },
		{ name: "Esc", press: (dom: Dom) => dom.key(dom.find('[data-slot="annotation-seat"]')[0] as Element, "Escape") },
	]) {
		test(`${leave.name} pressed straight after typing, inside the quiet interval, still hands the host the note once before the seat is gone`, async () => {
			let left = 0;
			const { app, updates } = host();
			const client = new BrowserClient(app);
			await client.follow("b1");
			const dom = await mount(<LeavableSeat app={app} client={client} onLeft={() => void (left += 1)} />);
			const quiet = holdQuietTimers();
			try {
				await placePin(dom);
				await dom.type(noteField(dom), "make this bigger");
			} finally {
				quiet.release();
			}
			expect(quiet.armed()).toBeGreaterThan(0);
			expect(updates).toEqual([]);

			await leave.press(dom);
			await until(dom, () => updates.length === 1);
			await dom.settle();

			expect(left).toBe(1);
			expect(dom.find('[data-slot="annotation-seat"]')).toHaveLength(0);
			expect(updates).toHaveLength(1);
			expect(textOf(updates[0])).toContain("make this bigger");
		});
	}

	test("Done with nothing marked leaves without asking the page anything or staging anything", async () => {
		let left = 0;
		const { app, calls, updates } = host();
		const client = new BrowserClient(app);
		await client.follow("b1");
		const dom = await mount(<LeavableSeat app={app} client={client} onLeft={() => void (left += 1)} />);

		await dom.click(label(dom, "Done"));
		await dom.settle();

		expect(left).toBe(1);
		expect(calls).toEqual([]);
		expect(updates).toEqual([]);
	});
});

const answerFrames = (call: Call): CallToolResult => {
	if (call.name === "browser_frame") {
		const png = call.args.format === "png";
		return { content: [], structuredContent: { state: FRAME.state, frameId: "f1", mimeType: png ? "image/png" : "image/jpeg", data: "AAAA", capturedAt: FRAME.capturedAt } };
	}
	return { content: [], structuredContent: FRAME.state };
};

describe("the Browser around the seat", () => {
	test("removing the annotation from the agent while marking leaves the seat and takes back what was staged", async () => {
		const { app, updates } = host({ other: answerFrames });
		const dom = await mount(<BrowserApp app={app} toolState={{ state: FRAME.state, seq: 1 }} />);
		await dom.settle();
		await dom.click(label(dom, "Annotate for the agent (Ctrl+Shift+A)"));
		await dom.settle();
		await placePin(dom);
		await until(dom, () => updates.length === 1);

		await dom.click(label(dom, "More"));
		const remove = dom.find('[role="menuitem"]').find(item => item.textContent?.includes("Remove annotation from agent"));
		await dom.click(remove as Element);
		await dom.settle();

		expect(updates).toHaveLength(2);
		expect(updates[1]?.content).toEqual([]);
		expect(dom.find("[data-slot='annotation-seat']")).toHaveLength(0);
	});
});

let viewBoots = 0;

async function bootView(app: App, emit: (name: string, payload: unknown) => void): Promise<Dom> {
	const harness = await mount(<div />);
	const harnessRoot = globalThis.document.getElementById("root");
	if (harnessRoot === null) throw new Error("the harness has no root");
	harnessRoot.id = "harness-root";
	const container = globalThis.document.createElement("div");
	container.id = "root";
	globalThis.document.body.appendChild(container);
	viewHost.app = app;
	viewHost.booting = true;
	try {
		await act(async () => {
			await import(`../app/view/main.tsx?boot=${(viewBoots += 1)}`);
		});
	} finally {
		viewHost.booting = false;
	}
	await harness.settle();
	await act(async () => emit("toolresult", { content: [], structuredContent: { state: FRAME.state } }));
	await harness.settle();
	return { ...harness, find: selector => [...container.querySelectorAll(selector)], text: () => container.textContent ?? "" };
}

describe("the Browser's View, as booted, lends a mark's note the host's dictation", () => {
	test.each([
		{ name: "the pack holds the dictation grant and speech-to-text is set up", dictation: { offered: true, available: true }, mics: 1 },
		{ name: "the pack holds the grant but speech-to-text is not set up", dictation: { offered: true, available: false }, mics: 0 },
		{ name: "the pack was not granted dictation, so the host offers no verbs", dictation: { offered: false, available: true }, mics: 0 },
	])("$name: the mics beside the mark's open note are $mics", async ({ dictation, mics }) => {
		const { app, emit } = host({ dictation, other: answerFrames });
		const dom = await bootView(app, emit);
		await dom.click(label(dom, "Annotate for the agent (Ctrl+Shift+A)"));
		await dom.settle();
		await placePin(dom);

		expect(dom.find('[data-slot="note-popover"]')).toHaveLength(1);
		expect(dom.find('[data-slot="note-popover-mic"]')).toHaveLength(mics);
	});
});
