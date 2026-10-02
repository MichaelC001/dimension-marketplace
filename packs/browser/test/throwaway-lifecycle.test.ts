/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser tool dies for every
 *  chat on an engine, for good. One pack server serves every session; a
 *  throwaway browser (browser_open with no profile) used to be released only by
 *  browser_close, and models routinely end without it — so after the fourth
 *  forgotten one every browser_open in every session failed `too_many_browsers`
 *  until the engine restarted, with a Chrome per forgotten browser left running.
 *  Also the other way: the pool frees a slot by closing a browser that was
 *  working — a running task, a page a person is watching, a saved profile and
 *  its lock — or a refused chat is told nothing about what to close.
 *
 *  Real Chrome, real directories in temp roots. A Chrome is "gone" only when the
 *  operating system says so by pid (chrome-processes.ts), never because the
 *  runtime stopped listing it. The host sends a pack server no session-end
 *  signal, so a session that goes quiet is told apart from a live one by calls
 *  and by what a person is looking at, and by nothing else.
 */
import { existsSync } from "node:fs";
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
import { chromePidsByThrowaway, waitUntilGone } from "./chrome-processes";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, describeWithChrome, newRuntime, startFixture, teardown, waitUntil } from "./fixture";

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

const asSession = (session: string): BrowserOpener => ({ caller: "model", session });

const clients: Client[] = [];
const viewers: Timer[] = [];

afterEach(async () => {
	for (const viewer of viewers.splice(0)) clearInterval(viewer);
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

/** Open a throwaway for `session` and learn which directory under `ephemeral/` it runs in (opens here are one at a time). */
async function openThrowaway(runtime: BrowserRuntime, rootDir: string, session: string): Promise<Throwaway> {
	const before = await entries(join(rootDir, "ephemeral"));
	const { browserId } = await runtime.open({ viewport: VIEWPORT }, asSession(session));
	const dir = (await entries(join(rootDir, "ephemeral"))).find((name) => !before.includes(name));
	if (dir === undefined) throw new Error("the throwaway browser made no directory");
	return { browserId, dir };
}

/** What the Browser View does to a browser it shows: reads its state, over and over (stream.ts does it every 250 ms). The first read is made before this returns. */
async function watching(runtime: BrowserRuntime, browserId: string): Promise<Timer> {
	await runtime.liveState(browserId);
	const viewer = setInterval(() => void runtime.liveState(browserId).catch(() => undefined), 100);
	viewers.push(viewer);
	return viewer;
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

/** The slice of the runtime's private state a test needs to make a real Chrome's close fail once: there is no other way to provoke it. */
interface RuntimeInternals {
	byId: Map<string, { driver: { close(): Promise<void> } }>;
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
		"a full pool gives up the browser used least recently, and its Chrome is gone by the time the new one opens",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const [a, b, c, d] = [await openThrowaway(runtime, rootDir, "s1"), await openThrowaway(runtime, rootDir, "s2"), await openThrowaway(runtime, rootDir, "s3"), await openThrowaway(runtime, rootDir, "s4")] as const;
			// The oldest is not the least recently used once it is called: b is.
			await runtime.state(a.browserId);
			const before = await chromePidsByThrowaway(rootDir);
			const bPids = before.get(b.dir) ?? [];
			expect(bPids.length).toBeGreaterThan(0);

			const e = await openThrowaway(runtime, rootDir, "s5");

			expect(await waitUntilGone(bPids, 5_000)).toEqual([]);
			expect((await refusal(() => runtime.state(b.browserId))).code).toBe("unknown_browser");
			for (const kept of [a, c, d, e]) expect((await runtime.state(kept.browserId)).browserId).toBe(kept.browserId);
			expect([...(await chromePidsByThrowaway(rootDir)).keys()].sort()).toEqual([a.dir, c.dir, d.dir, e.dir].sort());
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
			const pids = (await chromePidsByThrowaway(rootDir)).get(one.dir) ?? [];
			expect(pids.length).toBeGreaterThan(0);

			await runtime.close(one.browserId);

			expect(await waitUntilGone(pids, 5_000)).toEqual([]);
			expect(await entries(join(rootDir, "ephemeral"))).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("what a full pool never gives up", () => {
	test(
		"a page a person is watching is kept; once nobody watches it, it is the one given up",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const first = await openThrowaway(runtime, rootDir, "s1");
			const second = await openThrowaway(runtime, rootDir, "s2");
			const third = await openThrowaway(runtime, rootDir, "s3");
			const fourth = await openThrowaway(runtime, rootDir, "s4");
			await watching(runtime, first.browserId);
			const secondsView = await watching(runtime, second.browserId);
			await watching(runtime, third.browserId);
			await watching(runtime, fourth.browserId);

			expect((await refusal(() => runtime.open({ viewport: VIEWPORT }, asSession("s5")))).code).toBe("too_many_browsers");
			for (const browser of [first, second, third, fourth]) expect((await runtime.state(browser.browserId)).browserId).toBe(browser.browserId);

			// The View on the second one goes away; the others stay watched.
			clearInterval(secondsView);
			await waitUntil(
				"the pool to give up the browser nobody watches",
				() => runtime.open({ viewport: VIEWPORT }, asSession("s5")).then(() => "opened", (error: unknown) => (error instanceof BrowserRuntimeError ? error.code : String(error))),
				(outcome) => outcome === "opened",
				20_000,
			);

			expect((await refusal(() => runtime.state(second.browserId))).code).toBe("unknown_browser");
			for (const browser of [first, third, fourth]) expect((await runtime.state(browser.browserId)).browserId).toBe(browser.browserId);
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
});

describeWithChrome("a throwaway nobody calls", () => {
	test(
		"is closed after the idle timeout: its Chrome is gone by pid, its directory is gone, its owner is told, and close afterwards is not an error",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { throwawayIdleMs: 4_000 });
			const one = await openThrowaway(runtime, rootDir, "s1");
			const pids = (await chromePidsByThrowaway(rootDir)).get(one.dir) ?? [];
			expect(pids.length).toBeGreaterThan(0);

			expect(await waitUntilGone(pids, 20_000)).toEqual([]);

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
			await watching(runtime, shown.browserId);
			const silent = await openThrowaway(runtime, rootDir, "s4");
			const silentPids = (await chromePidsByThrowaway(rootDir)).get(silent.dir) ?? [];
			expect(silentPids.length).toBeGreaterThan(0);

			// Both the 8 s call and the 8 s of calls outlast two idle timeouts.
			await calling;
			expect((await wait).status).toBe("timeout");

			for (const browser of [called, waiting, shown]) expect((await runtime.state(browser.browserId)).browserId).toBe(browser.browserId);
			expect(await waitUntilGone(silentPids, 10_000)).toEqual([]);
			expect((await refusal(() => runtime.state(silent.browserId))).code).toBe("unknown_browser");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is closed again after another idle period when its first close failed, so a failed close never keeps a slot for good",
		async () => {
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir, { throwawayIdleMs: 1_500 });
			const one = await openThrowaway(runtime, rootDir, "s1");
			const pids = (await chromePidsByThrowaway(rootDir)).get(one.dir) ?? [];
			expect(pids.length).toBeGreaterThan(0);
			// Reached into on purpose: a real Chrome that will not close cannot be had any other way. The one close fails; the next is the real one.
			const internals = runtime as unknown as RuntimeInternals;
			const driver = internals.byId.get(one.browserId)?.driver;
			if (driver === undefined) throw new Error("the browser is not listed");
			const realClose = driver.close.bind(driver);
			let failures = 0;
			driver.close = async () => {
				driver.close = realClose;
				failures += 1;
				throw new Error("the browser did not shut down");
			};

			expect(await waitUntilGone(pids, 20_000)).toEqual([]);

			expect(failures).toBe(1);
			await waitUntil("the retried browser's directory to be deleted", () => entries(join(rootDir, "ephemeral")), (left) => left.length === 0, 10_000);
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
});
