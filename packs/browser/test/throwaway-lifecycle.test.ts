/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser tool dies for every
 *  chat on an engine, for good. One pack server serves every session; a
 *  throwaway browser (browser_open with no profile) used to be released only by
 *  browser_close, and models routinely end without it — so after the fourth
 *  forgotten one every browser_open in every session failed `too_many_browsers`
 *  until the engine restarted, with a Chrome per forgotten browser left running.
 *  Also the other way: the pool frees a slot by closing a browser that was
 *  working — a running task, a page a person is watching, the Private browser a
 *  person opened, a saved profile and its lock — or by letting one open tear
 *  down every other chat's browser, or it keeps a slot for ever because a Chrome
 *  would not shut down, or a refused chat is told nothing about what to close.
 *
 *  Real Chrome, real directories in temp roots. A Chrome is "gone" only when the
 *  operating system says so by pid (chrome-processes.ts), never because the
 *  runtime stopped listing it. The host sends a pack server no session-end
 *  signal, so a session that goes quiet is told apart from a live one by calls,
 *  by what a person is looking at, and by nothing else.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { BrowserOpener } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { BrowserRuntimeError } from "../src/store";
import { LiveChannel } from "../src/stream";
import { chromePidsByThrowaway, isAlive, suspendProcess, waitUntilGone } from "./chrome-processes";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, describeWithChrome, newRuntime, startFixture, teardown, waitUntil, within } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const FAKE_WORKER = fileURLToPath(new URL("./fake-worker/", import.meta.url));
const VENV_PYTHON = fileURLToPath(new URL(`../python/.venv/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`, import.meta.url));
/** The task tests' interpreter: the pack's venv when it is built, else DIM_BROWSER_PYTHON or a python on the PATH that can import `websockets` (the fake worker's one import). */
function workingPython(): string | undefined {
	for (const candidate of [VENV_PYTHON, process.env.DIM_BROWSER_PYTHON, Bun.which("python3"), Bun.which("python")]) {
		if (candidate === undefined || candidate === null) continue;
		try {
			if (Bun.spawnSync([candidate, "-c", "import websockets"]).exitCode === 0) return candidate;
		} catch {
			// Not runnable here: try the next.
		}
	}
	return undefined;
}

const PYTHON = workingPython();
const describeTasks = chromePath === undefined || PYTHON === undefined ? describe.skip : describe;

const asSession = (session: string, caller: "model" | "app" = "model"): BrowserOpener => ({ caller, session });

const clients: Client[] = [];
const channels: LiveChannel[] = [];
const leases: Array<() => void> = [];
const streams: AbortController[] = [];

afterEach(async () => {
	for (const stream of streams.splice(0)) stream.abort();
	for (const release of leases.splice(0)) release();
	for (const channel of channels.splice(0)) await channel.close().catch(() => undefined);
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

const entries = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [])).sort();

/** The refusal `work` raised; a call that resolves fails the test. */
async function refusal(work: () => Promise<unknown>): Promise<BrowserRuntimeError> {
	try {
		await work();
	} catch (error) {
		if (error instanceof BrowserRuntimeError) return error;
		throw error;
	}
	throw new Error("expected the call to be refused, but it resolved");
}

interface Throwaway {
	browserId: string;
	/** Its directory's name under `ephemeral/`, which is also what its Chrome's command line carries. */
	dir: string;
}

/** A throwaway browser's Chrome as the operating system sees it. */
interface RunningChrome {
	main: number;
	all: number[];
}

/** Open a throwaway for `session` and learn which directory under `ephemeral/` it runs in (opens here are one at a time). */
async function openThrowaway(runtime: BrowserRuntime, rootDir: string, session: string, caller: "model" | "app" = "model"): Promise<Throwaway> {
	const before = await entries(join(rootDir, "ephemeral"));
	const { browserId } = await runtime.open({ viewport: VIEWPORT }, asSession(session, caller));
	const dir = (await entries(join(rootDir, "ephemeral"))).find((name) => !before.includes(name));
	if (dir === undefined) throw new Error("the throwaway browser made no directory");
	return { browserId, dir };
}

async function chromeOf(rootDir: string, throwaway: Throwaway): Promise<RunningChrome> {
	const found = (await chromePidsByThrowaway(rootDir)).get(throwaway.dir);
	if (found === undefined || found.main === undefined) throw new Error("no Chrome is running for this throwaway browser");
	return { main: found.main, all: found.all };
}

/** What the Browser View does to a browser it shows: it joins its live stream. Returns what ends the watching. */
function watching(runtime: BrowserRuntime, browserId: string): () => void {
	const release = runtime.viewing(browserId);
	leases.push(release);
	return release;
}

interface ToolAnswer {
	isError?: true;
	text: string;
	structured?: Record<string, unknown>;
}

interface RawToolAnswer {
	isError?: boolean;
	content: Array<{ text?: string }>;
	structuredContent?: Record<string, unknown>;
}

/** The real MCP server over `runtime`, called the way the host calls it: every call stamped with its session. */
async function connect(runtime: BrowserRuntime, rootDir: string): Promise<(session: string, name: string, args: Record<string, unknown>) => Promise<ToolAnswer>> {
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "throwaway-lifecycle-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return async (session, name, args) => {
		const answer = (await client.callTool({
			name,
			arguments: args,
			_meta: { "ai.insodimension/caller": "model", "ai.insodimension/session": { sessionId: session } },
		})) as RawToolAnswer;
		return { ...(answer.isError ? { isError: true } : {}), text: answer.content[0]?.text ?? "", ...(answer.structuredContent === undefined ? {} : { structured: answer.structuredContent }) };
	};
}

/** The slice of a browser's engine driver a test replaces to make a real Chrome's shutdown fail: there is no other way to provoke it. */
interface DriverSeam {
	close(): Promise<void>;
	kill(): Promise<void>;
}

function driverOf(runtime: BrowserRuntime, browserId: string): DriverSeam {
	// Reason: test seam into the runtime's private map (as `driverOf` in publish.test.ts).
	const seam = runtime as unknown as { byId: Map<string, { driver: DriverSeam }> };
	const entry = seam.byId.get(browserId);
	if (entry === undefined) throw new Error("the browser is not listed");
	return entry.driver;
}

describeWithChrome("throwaway browsers a session leaves behind", () => {
	test(
		"six sessions that never close their browser do not lock out the seventh, and the Chrome of every browser given up is gone",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const opened: Throwaway[] = [];
			for (let n = 1; n <= 6; n += 1) opened.push(await openThrowaway(runtime, rootDir, `session-${n}`));

			const seventh = await openThrowaway(runtime, rootDir, "session-7");
			opened.push(seventh);

			// The pool stays bounded: the three that went unused longest were given up, and each says why — not "unknown", which is what an id that never existed says.
			const generic = (await refusal(() => runtime.state("never-issued"))).message;
			for (const given of opened.slice(0, 3)) {
				const told = await refusal(() => runtime.state(given.browserId));
				expect(told.code).toBe("unknown_browser");
				expect(told.message).not.toBe(generic);
				expect(told.message).toContain("browser_open");
				// The View treats this phrase as "gone for good" and shows its start page; a different wording would leave it reconnecting forever.
				expect(told.message).toStartWith("unknown or already closed browserId");
			}
			for (const kept of opened.slice(3)) expect((await runtime.state(kept.browserId)).browserId).toBe(kept.browserId);

			// By pid: exactly the four kept browsers still have a Chrome, and their directories are the only ones left.
			const running = await chromePidsByThrowaway(rootDir);
			expect([...running.keys()].sort()).toEqual(opened.slice(3).map((kept) => kept.dir).sort());
			expect(await entries(join(rootDir, "ephemeral"))).toEqual(opened.slice(3).map((kept) => kept.dir).sort());
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a full pool gives up the browser used least recently, and its Chrome is already gone when the new one's open returns",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const [a, b, c, d] = [await openThrowaway(runtime, rootDir, "s1"), await openThrowaway(runtime, rootDir, "s2"), await openThrowaway(runtime, rootDir, "s3"), await openThrowaway(runtime, rootDir, "s4")] as const;
			// The oldest is not the least recently used once it is called: b is.
			await runtime.state(a.browserId);
			const victim = await chromeOf(rootDir, b);

			const e = await openThrowaway(runtime, rootDir, "s5");

			// Asked once, with no grace: a close that was only started would still show its browser process.
			expect(isAlive(victim.main)).toBe(false);
			expect(await waitUntilGone(victim.all, 3_000)).toEqual([]);
			expect((await refusal(() => runtime.state(b.browserId))).code).toBe("unknown_browser");
			for (const kept of [a, c, d, e]) expect((await runtime.state(kept.browserId)).browserId).toBe(kept.browserId);
			expect([...(await chromePidsByThrowaway(rootDir)).keys()].sort()).toEqual([a.dir, c.dir, d.dir, e.dir].sort());
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"two sessions opening at once at a full pool both get a browser, the live Chromes never pass the pool, and the two given up are gone when the opens return",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const [a, b, c, d] = [await openThrowaway(runtime, rootDir, "s1"), await openThrowaway(runtime, rootDir, "s2"), await openThrowaway(runtime, rootDir, "s3"), await openThrowaway(runtime, rootDir, "s4")] as const;
			const victims = [await chromeOf(rootDir, a), await chromeOf(rootDir, b)];
			let peak = 0;
			let sampling = true;
			const sampler = (async () => {
				while (sampling) peak = Math.max(peak, [...(await chromePidsByThrowaway(rootDir)).values()].filter((chrome) => chrome.main !== undefined).length);
			})();

			const [fifth, sixth] = await Promise.all([runtime.open({ viewport: VIEWPORT }, asSession("s5")), runtime.open({ viewport: VIEWPORT }, asSession("s6"))]);
			sampling = false;
			await sampler;

			expect(fifth.browserId).not.toBe(sixth.browserId);
			expect(peak).toBeLessThanOrEqual(4);
			for (const victim of victims) expect(isAlive(victim.main)).toBe(false);
			expect(await waitUntilGone(victims.flatMap((victim) => victim.all), 3_000)).toEqual([]);
			for (const kept of [c.browserId, d.browserId, fifth.browserId, sixth.browserId]) expect((await runtime.state(kept)).browserId).toBe(kept);
			for (const given of [a, b]) expect((await refusal(() => runtime.state(given.browserId))).code).toBe("unknown_browser");
			const live = await chromePidsByThrowaway(rootDir);
			expect([...live.values()].filter((chrome) => chrome.main !== undefined)).toHaveLength(4);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"browser_read at a full pool gives up an abandoned browser instead of failing",
		async () => {
			const fixture = startFixture();
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { allowPrivateReadHosts: ["127.0.0.1"] });
			for (let n = 1; n <= 4; n += 1) await openThrowaway(runtime, rootDir, `session-${n}`);

			const read = await runtime.read({ url: fixture.url("/article") });

			expect(read.status).toBe("ok");
			expect(await entries(join(rootDir, "ephemeral"))).toHaveLength(3);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"close ends the Chrome too: by pid, and the directory goes with it",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const one = await openThrowaway(runtime, rootDir, "s1");
			const chrome = await chromeOf(rootDir, one);

			await runtime.close(one.browserId);

			expect(await waitUntilGone(chrome.all, 5_000)).toEqual([]);
			expect(await entries(join(rootDir, "ephemeral"))).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("what a full pool never gives up", () => {
	test(
		"a page a person is watching is kept, and goes the moment nobody is",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const first = await openThrowaway(runtime, rootDir, "s1");
			const second = await openThrowaway(runtime, rootDir, "s2");
			const third = await openThrowaway(runtime, rootDir, "s3");
			const fourth = await openThrowaway(runtime, rootDir, "s4");
			watching(runtime, first.browserId);
			const secondsView = watching(runtime, second.browserId);
			watching(runtime, third.browserId);
			watching(runtime, fourth.browserId);

			expect((await refusal(() => runtime.open({ viewport: VIEWPORT }, asSession("s5")))).code).toBe("too_many_browsers");
			for (const browser of [first, second, third, fourth]) expect((await runtime.state(browser.browserId)).browserId).toBe(browser.browserId);

			// The View on the second one goes away; the others stay watched.
			secondsView();
			await openThrowaway(runtime, rootDir, "s5");

			expect((await refusal(() => runtime.state(second.browserId))).code).toBe("unknown_browser");
			for (const browser of [first, third, fourth]) expect((await runtime.state(browser.browserId)).browserId).toBe(browser.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a View streaming a browser holds it for as long as the stream is open, however slowly the page answers, and lets go when the stream ends",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const channel = new LiveChannel(runtime, { stateIntervalMs: 100 });
			channels.push(channel);
			const four: Throwaway[] = [];
			const aborts: AbortController[] = [];
			for (let n = 1; n <= 4; n += 1) {
				const browser = await openThrowaway(runtime, rootDir, `s${n}`);
				four.push(browser);
				const { origin, token } = await channel.mint(browser.browserId);
				const abort = new AbortController();
				streams.push(abort);
				aborts.push(abort);
				const response = await fetch(`${origin}/s/${token}?frames=0`, { signal: abort.signal });
				const reader = response.body?.getReader();
				if (reader === undefined) throw new Error("the stream has no body");
				// The first message is the stream's state: the View is joined.
				await reader.read();
			}

			expect((await refusal(() => runtime.open({ viewport: VIEWPORT }, asSession("s5")))).code).toBe("too_many_browsers");

			// The View on the third goes away (the tab was closed): once the pack notices, that browser is the one a new open takes.
			aborts[2]?.abort();
			await waitUntil(
				"the pack to notice the View is gone and give its browser up",
				() => runtime.open({ viewport: VIEWPORT }, asSession("s5")).then(() => "opened", (error: unknown) => (error instanceof BrowserRuntimeError ? error.code : String(error))),
				(outcome) => outcome === "opened",
				15_000,
			);
			expect((await refusal(() => runtime.state((four[2] as Throwaway).browserId))).code).toBe("unknown_browser");
			for (const kept of [four[0], four[1], four[3]] as Throwaway[]) expect((await runtime.state(kept.browserId)).browserId).toBe(kept.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a saved profile's browser and its lock are never given up for a throwaway",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const saved: string[] = [];
			for (let n = 1; n <= 3; n += 1) saved.push((await runtime.open({ profile: `keep-${n}`, viewport: VIEWPORT }, asSession(`s${n}`))).browserId);
			const throwaway = await openThrowaway(runtime, rootDir, "s4");

			// The saved ones were opened first, so they are the least recently used; only a throwaway may be given up, whatever the order.
			await runtime.state(throwaway.browserId);
			const newcomer = await openThrowaway(runtime, rootDir, "s5");

			expect((await refusal(() => runtime.state(throwaway.browserId))).code).toBe("unknown_browser");
			expect((await runtime.state(newcomer.browserId)).browserId).toBe(newcomer.browserId);
			for (const browserId of saved) expect((await runtime.state(browserId)).profile).toMatch(/^keep-/);
			// The lock is intact: another chat still cannot take a profile that is open.
			expect((await refusal(() => runtime.open({ profile: "keep-1", viewport: VIEWPORT }, asSession("s9")))).code).toBe("profile_held");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the Private browser a person opened is given up last, and never while its View is joined",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			// Opened first and never called again: by recency alone it would go first.
			const private_ = await openThrowaway(runtime, rootDir, "human", "app");
			const m1 = await openThrowaway(runtime, rootDir, "s2");
			const m2 = await openThrowaway(runtime, rootDir, "s3");
			const m3 = await openThrowaway(runtime, rootDir, "s4");

			// A chat's browser goes before the person's, though the person's is older.
			const n1 = await openThrowaway(runtime, rootDir, "s5");
			expect((await refusal(() => runtime.state(m1.browserId))).code).toBe("unknown_browser");
			expect((await runtime.state(private_.browserId)).browserId).toBe(private_.browserId);

			// Every browser is held by a View: nothing can be given up.
			const privateView = watching(runtime, private_.browserId);
			for (const browser of [m2, m3, n1]) watching(runtime, browser.browserId);
			expect((await refusal(() => runtime.open({ viewport: VIEWPORT }, asSession("s6")))).code).toBe("too_many_browsers");
			expect((await runtime.state(private_.browserId)).browserId).toBe(private_.browserId);

			// Its View goes away; with no chat browser to give up, the person's is the one.
			privateView();
			const n2 = await openThrowaway(runtime, rootDir, "s6");
			expect((await refusal(() => runtime.state(private_.browserId))).code).toBe("unknown_browser");
			for (const kept of [m2, m3, n1, n2]) expect((await runtime.state(kept.browserId)).browserId).toBe(kept.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	describeTasks("while it works", () => {
		const saved: Partial<Record<"DIM_BROWSER_PYTHON" | "PYTHONPATH" | "PYTHONDONTWRITEBYTECODE", string>> = {};
		beforeAll(() => {
			for (const key of ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"] as const) saved[key] = process.env[key];
			if (PYTHON !== undefined) process.env.DIM_BROWSER_PYTHON = PYTHON;
			process.env.PYTHONPATH = FAKE_WORKER;
			process.env.PYTHONDONTWRITEBYTECODE = "1";
		});
		afterAll(() => {
			for (const key of ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"] as const) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		});

		test(
			"a browser running a task is kept by a full pool, though it is the least recently used",
			async () => {
				const rootDir = await createRoot();
				const runtime = newRuntime(rootDir);
				const working = await openThrowaway(runtime, rootDir, "s1");
				await runtime.startTask(working.browserId, { agent: "jev", task: JSON.stringify({ steps: [{ action: "thinking", url: "" }], hold: true }) });
				const second = await openThrowaway(runtime, rootDir, "s2");
				const third = await openThrowaway(runtime, rootDir, "s3");
				const fourth = await openThrowaway(runtime, rootDir, "s4");
				// Every call is on the others, so the task's browser is the one used longest ago, and `second` the next.
				for (const other of [second, third, fourth]) await runtime.state(other.browserId);

				await openThrowaway(runtime, rootDir, "s5");

				expect((await refusal(() => runtime.state(second.browserId))).code).toBe("unknown_browser");
				expect((await runtime.state(working.browserId)).task?.status).toBe("running");
				await runtime.cancelTask(working.browserId);
			},
			BROWSER_TEST_TIMEOUT_MS,
		);

		test(
			"a browser running a task is not closed for being quiet",
			async () => {
				const rootDir = await createRoot();
				const runtime = newRuntime(rootDir, { throwawayIdleMs: 1_500 });
				const working = await openThrowaway(runtime, rootDir, "s1");
				await runtime.startTask(working.browserId, { agent: "jev", task: JSON.stringify({ steps: [{ action: "thinking", url: "" }], hold: true }) });

				// Quiet for several idle timeouts, and still working. A real wait: the idle clock is real time over a live Chrome, which no fake timer advances.
				await Bun.sleep(5_000);

				expect((await runtime.state(working.browserId)).task?.status).toBe("running");
				await runtime.cancelTask(working.browserId);
			},
			BROWSER_TEST_TIMEOUT_MS,
		);
	});

	test(
		"when nothing can be given up, the refusal names the browsers the asking chat holds, and only those",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const call = await connect(runtime, rootDir);
			const open = async (session: string, profile: string): Promise<string> => {
				const answer = await call(session, "browser_open", { profile });
				expect(answer.isError).toBeUndefined();
				return String(answer.structured?.browserId);
			};
			const mine = [await open("chat-a", "alpha"), await open("chat-a", "beta")];
			const theirs = [await open("chat-b", "gamma"), await open("chat-b", "delta")];

			const asked = await call("chat-a", "browser_open", { profile: "epsilon" });
			const other = await call("chat-b", "browser_open", { profile: "zeta" });
			const stranger = await call("chat-c", "browser_open", {});

			for (const answer of [asked, other, stranger]) expect(answer.isError).toBe(true);
			// Told what to close: the browsers it holds.
			for (const answer of [asked, other]) expect(answer.text).toContain("browser_close");
			for (const id of mine) expect(asked.text).toContain(id);
			for (const id of theirs) expect(asked.text).not.toContain(id);
			for (const id of theirs) expect(other.text).toContain(id);
			for (const id of mine) expect(other.text).not.toContain(id);
			// A chat that holds nothing is told so, and is shown nobody's capability.
			for (const id of [...mine, ...theirs]) expect(stranger.text).not.toContain(id);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"when every browser has a call in progress the refusal says so, so the chat knows to wait rather than to close",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const four: Throwaway[] = [];
			for (let n = 1; n <= 4; n += 1) four.push(await openThrowaway(runtime, rootDir, `s${n}`));
			const inFlight = four.map((browser) => runtime.wait(browser.browserId, { text: "__never_on_this_page__", timeoutMs: 4_000 }));

			const refused = await refusal(() => runtime.open({ viewport: VIEWPORT }, asSession("s5")));

			expect(refused.code).toBe("too_many_browsers");
			expect(refused.message).toMatch(/call in progress/i);
			expect((await Promise.all(inFlight)).map((outcome) => outcome.status)).toEqual(["timeout", "timeout", "timeout", "timeout"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"when the browser chosen to make room will not close, the open is refused and no other chat's browser is touched, and the refusal says a browser is still shutting down",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const [a, b, c, d] = [await openThrowaway(runtime, rootDir, "s1"), await openThrowaway(runtime, rootDir, "s2"), await openThrowaway(runtime, rootDir, "s3"), await openThrowaway(runtime, rootDir, "s4")] as const;
			const driver = driverOf(runtime, a.browserId);
			const { close, kill } = driver;
			// A Chrome nothing can stop: the polite close fails, and so does the kill.
			driver.close = async () => {
				throw new Error("the browser did not shut down");
			};
			driver.kill = async () => {
				throw new Error("the process could not be killed");
			};
			try {
				const refused = await refusal(() => runtime.open({ viewport: VIEWPORT }, asSession("s5")));

				expect(refused.code).toBe("too_many_browsers");
				expect(refused.message).toMatch(/shutting down|shut down/i);
				// One open took at most one victim and then stopped: the others were never closed.
				for (const untouched of [b, c, d]) expect((await runtime.state(untouched.browserId)).browserId).toBe(untouched.browserId);
				const live = await chromePidsByThrowaway(rootDir);
				expect([...live.keys()].sort()).toEqual([a.dir, b.dir, c.dir, d.dir].sort());
			} finally {
				driver.close = close;
				driver.kill = kill;
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("a throwaway nobody calls", () => {
	test(
		"is closed after the idle timeout: its Chrome is gone by pid, its directory is gone, its owner is told, and close afterwards is not an error",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { throwawayIdleMs: 4_000 });
			const one = await openThrowaway(runtime, rootDir, "s1");
			const chrome = await chromeOf(rootDir, one);

			expect(await waitUntilGone(chrome.all, 20_000)).toEqual([]);

			// The directory is deleted right behind the process; nobody awaits an idle close, so it is watched for.
			await waitUntil("the idle browser's directory to be deleted", () => entries(join(rootDir, "ephemeral")), (left) => left.length === 0, 10_000);
			const told = await refusal(() => runtime.state(one.browserId));
			expect(told.code).toBe("unknown_browser");
			expect(told.message).toContain("browser_open");
			await runtime.close(one.browserId);
			// The slot is free again: nothing stands between this chat and a new browser.
			expect((await runtime.open({ viewport: VIEWPORT }, asSession("s1"))).profile).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is kept by calls, by a call still in flight and by a person watching it; silence alone ends it",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { throwawayIdleMs: 4_000 });
			// Each keeper's activity starts the moment it is open, so no keeper is ever quiet while the others are being opened.
			const called = await openThrowaway(runtime, rootDir, "s1");
			const calling = (async () => {
				for (let n = 0; n < 20; n += 1) {
					await runtime.state(called.browserId);
					// Real time: what is under test is a clock over live Chromes, not a function of an injected one.
					await Bun.sleep(400);
				}
			})();
			const waiting = await openThrowaway(runtime, rootDir, "s2");
			const wait = runtime.wait(waiting.browserId, { text: "__never_on_this_page__", timeoutMs: 8_000 });
			const shown = await openThrowaway(runtime, rootDir, "s3");
			watching(runtime, shown.browserId);
			const silent = await openThrowaway(runtime, rootDir, "s4");
			const silentChrome = await chromeOf(rootDir, silent);

			// Both the 8 s call and the 8 s of calls outlast two idle timeouts.
			await calling;
			expect((await wait).status).toBe("timeout");

			for (const browser of [called, waiting, shown]) expect((await runtime.state(browser.browserId)).browserId).toBe(browser.browserId);
			expect(await waitUntilGone(silentChrome.all, 10_000)).toEqual([]);
			expect((await refusal(() => runtime.state(silent.browserId))).code).toBe("unknown_browser");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the Private browser a person opened is never closed for being quiet, while a chat's browser opened beside it is",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { throwawayIdleMs: 2_000 });
			const private_ = await openThrowaway(runtime, rootDir, "human", "app");
			const chats = await openThrowaway(runtime, rootDir, "s2");
			const chatsChrome = await chromeOf(rootDir, chats);

			// The control first: the chat's browser really is closed by the same clock.
			expect(await waitUntilGone(chatsChrome.all, 15_000)).toEqual([]);
			// A real wait: the person's browser must outlast several idle timeouts, and no signal says "still there".
			await Bun.sleep(5_000);

			expect((await runtime.state(private_.browserId)).browserId).toBe(private_.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is not the case for a saved profile: its browser and lock stay until it is closed",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { throwawayIdleMs: 500 });
			const { browserId } = await runtime.open({ profile: "stays", viewport: VIEWPORT }, asSession("s1"));

			// A negative over real time (nothing may happen in six idle timeouts); no signal exists to await.
			await Bun.sleep(3_000);

			expect((await runtime.state(browserId)).profile).toBe("stays");
			expect((await refusal(() => runtime.open({ profile: "stays", viewport: VIEWPORT }, asSession("s2")))).code).toBe("profile_held");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an idle close that cannot finish is tried again until the Chrome is dead, so a stuck browser never keeps a slot for good",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { throwawayIdleMs: 3_000 });
			const one = await openThrowaway(runtime, rootDir, "s1");
			const driver = driverOf(runtime, one.browserId);
			const kill = driver.kill;
			// Installed before anything slow, so the fault is in place when the idle timeout first fires. The polite close always fails;
			// the first kill fails too, so the first attempt ends unconfirmed and only a retry can finish it.
			driver.close = async () => {
				throw new Error("the browser did not shut down");
			};
			driver.kill = async () => {
				driver.kill = kill;
				throw new Error("the process could not be killed yet");
			};
			const chrome = await chromeOf(rootDir, one);

			expect(await waitUntilGone(chrome.all, 25_000)).toEqual([]);

			await waitUntil("the retried browser's directory to be deleted", () => entries(join(rootDir, "ephemeral")), (left) => left.length === 0, 10_000);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("a Chrome that will not shut down", () => {
	test(
		"a browser_close on a Chrome that never answers ends it by force: it returns, the process tree is gone by pid, and the directory is deleted",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const one = await openThrowaway(runtime, rootDir, "s1");
			const chrome = await chromeOf(rootDir, one);
			// A frozen browser process answers no one: the polite close can only hang.
			const thaw = suspendProcess(chrome.main);
			try {
				await within(60_000, "close of a Chrome that does not answer", runtime.close(one.browserId));

				expect(await waitUntilGone(chrome.all, 5_000)).toEqual([]);
				await waitUntil("the hung browser's directory to be deleted", () => entries(join(rootDir, "ephemeral")), (left) => left.length === 0, 10_000);
				expect((await refusal(() => runtime.state(one.browserId))).code).toBe("unknown_browser");
			} finally {
				thaw();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a browser_close that hangs and then fails to kill is tried again by the runtime, so a model that does not retry still does not lose the slot",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { throwawayIdleMs: 3_000 });
			const one = await openThrowaway(runtime, rootDir, "s1");
			const driver = driverOf(runtime, one.browserId);
			const kill = driver.kill;
			// The first kill fails without touching the process: only a retry by the runtime itself can end this Chrome.
			driver.kill = async () => {
				driver.kill = kill;
				throw new Error("the process could not be killed yet");
			};
			const chrome = await chromeOf(rootDir, one);
			// A frozen browser process answers no one: the polite close does not fail, it hangs past its bound.
			const thaw = suspendProcess(chrome.main);
			try {
				await expect(within(60_000, "close of a Chrome that does not answer", runtime.close(one.browserId))).rejects.toThrow(/could not be killed/);
				// The close call is over and nothing has killed the Chrome yet.
				expect(isAlive(chrome.main)).toBe(true);

				expect(await waitUntilGone(chrome.all, 25_000)).toEqual([]);
				await waitUntil("the retried browser's directory to be deleted", () => entries(join(rootDir, "ephemeral")), (left) => left.length === 0, 10_000);
			} finally {
				thaw();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describe("the idle timeout is a number a timer can hold", () => {
	test("a value above what setTimeout takes (it would become a 1 ms loop) or that is not a positive number is refused, and the largest the timer holds is accepted", async () => {
		const rootDir = await createRoot();
		for (const bad of [2_147_483_648, 3_000_000_000, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => newRuntime(rootDir, { throwawayIdleMs: bad })).toThrow(RangeError);
		}
		expect(() => newRuntime(rootDir, { throwawayIdleMs: 2_147_483_647 })).not.toThrow();
	});
});
