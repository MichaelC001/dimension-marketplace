/**
 * Shared fixtures for the browser pack's tests.
 *
 * These tests drive a REAL Chrome against a local HTTP server we own, because
 * every contract worth defending here (nothing moves without approval, a write
 * happens at most once, a credential never lands on disk, a profile's cookies
 * are its own) is a property of the actual browser and the actual bytes on the
 * wire. A mocked page would let all of those break silently.
 *
 * Two hard rules baked in here:
 *  - We never touch the human's Chrome profile. Every runtime gets a fresh
 *    `rootDir` under the OS temp dir and every profile lives inside it.
 *  - If no Chrome is installed we SKIP, loudly. A green run that never started
 *    a browser must never be mistaken for "the real browser behaves".
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "bun:test";
import type { BrowserAction, PendingAction } from "../src/contracts";
import { BrowserRuntime, type BrowserRuntimeOptions } from "../src/runtime";
import { BrowserRuntimeError } from "../src/store";

// ---------------------------------------------------------------------------
// Locating a real Chrome
// ---------------------------------------------------------------------------

function candidates(): string[] {
	const fromEnv = ["BROWSER_TEST_CHROME", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH"]
		.map((key) => process.env[key]?.trim())
		.filter((value): value is string => value !== undefined && value.length > 0);
	if (process.platform === "win32") {
		const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(
			(root): root is string => typeof root === "string" && root.length > 0,
		);
		return [
			...fromEnv,
			...roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
			...roots.map((root) => join(root, "Chromium", "Application", "chrome.exe")),
		];
	}
	if (process.platform === "darwin") {
		return [
			...fromEnv,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		];
	}
	return [
		...fromEnv,
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	];
}

export const chromePath: string | undefined = candidates().find((path) => existsSync(path));

if (chromePath === undefined) {
	console.warn(
		"[browser tests] No Chrome/Chromium found. The real-browser tests are SKIPPED, not passed. " +
			"Set BROWSER_TEST_CHROME=<path to chrome executable> to run them.",
	);
}

/** `describe` that skips the whole group honestly when there is no browser. */
export const describeWithChrome: (label: string, body: () => void) => void =
	chromePath === undefined ? describe.skip : describe;

/** Generous: a cold Chrome launch plus several real navigations. */
export const BROWSER_TEST_TIMEOUT_MS = 120_000;

/** How long a real, already-dispatched effect gets to become observable. */
const EFFECT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Owned runtimes and owned profile roots
// ---------------------------------------------------------------------------

const runtimes: BrowserRuntime[] = [];
const roots: string[] = [];
const servers: Fixture[] = [];

export async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "dimension-browser-test-"));
	roots.push(root);
	return root;
}

/** A runtime bound to `rootDir`. Headless, real Chrome, disposed in teardown. */
export function newRuntime(rootDir: string, options: Omit<BrowserRuntimeOptions, "rootDir"> = {}): BrowserRuntime {
	const runtime = new BrowserRuntime({
		headless: true,
		executablePath: chromePath,
		...options,
		rootDir,
	});
	runtimes.push(runtime);
	return runtime;
}

export async function createRuntime(): Promise<{ runtime: BrowserRuntime; rootDir: string }> {
	const rootDir = await createRoot();
	return { runtime: newRuntime(rootDir), rootDir };
}

/**
 * Tear down ONLY what these tests created: our runtimes (which close only the
 * browsers they launched), our fixture servers, our temp roots.
 */
export async function teardown(): Promise<void> {
	for (const runtime of runtimes.splice(0)) {
		await runtime.dispose().catch(() => undefined);
	}
	for (const server of servers.splice(0)) {
		await server.stop();
	}
	for (const root of roots.splice(0)) {
		// Chrome can hold profile files for a moment after exit on Windows.
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------
// The local HTTP fixture
// ---------------------------------------------------------------------------

export interface Fixture {
	/** Absolute URL for a fixture path, e.g. `/page2`. */
	url(path: string): string;
	/** How many times the server was asked for `path` (favicon noise excluded). */
	hits(path: string): number;
	/** Every accepted form POST, in order. This is the write count. */
	submissions(): ReadonlyArray<Record<string, string>>;
	/** The value `/set-cookie` persists; `/show-cookie` echoes it back. */
	readonly cookieValue: string;
	/**
	 * Answer the `/hold` request that the `/leave` page is waiting on. That page
	 * is fully loaded with NO navigation in flight, so it stays a live execution
	 * context; answering its held subresource is what makes it navigate to
	 * `/gate`. A test can therefore place a real navigation at a moment it
	 * chose, with no sleep and without ever holding a document half-committed.
	 */
	releaseHold(): void;
	stop(): Promise<void>;
}

const FORM_BODY = `<h1>fixture form</h1>
<form method="POST" action="/submit">
  <input id="user" name="user" type="text" />
  <input id="pass" name="pass" type="password" />
  <button id="go" type="submit">Submit</button>
</form>`;

/**
 * The same form, plus a page-side guard on the password field that FAILS — and
 * quotes the field's contents inside its own diagnostic — when the field is
 * re-selected while it already holds text. Third-party code that echoes the
 * input it choked on is ordinary (validation layers, autofill bridges and
 * error reporters all do it), and it is how a typed secret can reach the
 * runtime inside somebody else's error message. The guard pings `/guard-fired`
 * before throwing, so a test can prove from the SERVER that this path really
 * ran rather than trusting a message it is not allowed to read.
 */
const GUARDED_BODY = `${FORM_BODY}
<script>
  var field = document.getElementById("pass");
  var native = HTMLInputElement.prototype.select;
  Object.defineProperty(field, "select", {
    value: function () {
      if (this.value.length === 0) return native.call(this);
      fetch("/guard-fired");
      throw new Error("autofill bridge rejected the stored entry: " + this.value);
    },
  });
</script>`;

function page(title: string, body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function html(markup: string, headers: Record<string, string> = {}): Response {
	return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

/**
 * A held request is answered at the latest after this, with a status the page
 * deliberately does NOT navigate on: an expired bound must fail the test that
 * forgot to release it, never fire the effect it was holding.
 */
const HELD_REQUEST_MAX_MS = 30_000;

export function startFixture(): Fixture {
	const hits = new Map<string, number>();
	const submissions: Record<string, string>[] = [];
	const cookieValue = randomBytes(8).toString("hex");
	// `/hold` answers nothing until `releaseHold()`. It is a SUBRESOURCE of the
	// already-committed `/leave` document rather than that document's own
	// response, so holding it never leaves Chrome sitting on a provisional
	// navigation that an aborted request would turn into an error page.
	let openHold: (released: boolean) => void = () => undefined;
	const held = new Promise<boolean>((resolve) => {
		openHold = resolve;
	});
	const holdBound = setTimeout(() => openHold(false), HELD_REQUEST_MAX_MS);

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		// A deliberately held request must be released by the test, not killed by
		// the server's own idle timer.
		idleTimeout: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
			if (pathname === "/") return html(page("fixture form", FORM_BODY));
			if (pathname === "/page2") return html(page("second page", "<p>second page</p>"));
			// Page A: carries no form control at all. It finishes loading and then
			// holds one `fetch("/hold")` open. Answering that fetch — and nothing
			// else — sends it to `/gate`, so the navigation lands exactly when the
			// test says so while page A stays a valid, committed execution context
			// for the whole wait.
			if (pathname === "/leave") {
				return html(
					page(
						"leaving",
						'<p id="leaving">leaving</p><script>fetch("/hold").then((res) => { if (res.ok) location.href = "/gate"; });</script>',
					),
				);
			}
			if (pathname === "/hold") {
				return (await held)
					? new Response("released", { headers: { "cache-control": "no-store" } })
					: new Response("hold expired", { status: 503 });
			}
			// Page B: the same form as `/`, so `#go` on the document that replaces
			// page A is a live submission target and a click landing there is a
			// real write the server would count.
			if (pathname === "/gate") return html(page("gated form", FORM_BODY));
			// The same form behind a page script that throws, with the typed text
			// inside the thrown message, on a second entry into the password field.
			if (pathname === "/guarded") return html(page("guarded form", GUARDED_BODY));
			if (pathname === "/guard-fired") return new Response("ok", { headers: { "cache-control": "no-store" } });
			if (pathname === "/submit" && request.method === "POST") {
				const fields: Record<string, string> = {};
				for (const [key, value] of new URLSearchParams(await request.text())) fields[key] = value;
				submissions.push(fields);
				return html(page("submitted", `<p id="count">submissions:${submissions.length}</p>`));
			}
			if (pathname === "/set-cookie") {
				return html(page("cookie set", "<p>cookie set</p>"), {
					"set-cookie": `fixturesid=${cookieValue}; Max-Age=86400; Path=/; SameSite=Lax`,
				});
			}
			if (pathname === "/show-cookie") {
				const found = /(?:^|;\s*)fixturesid=([^;]+)/.exec(request.headers.get("cookie") ?? "");
				return html(page("cookie", `<p id="cookie">COOKIE:${found?.[1] ?? "none"}</p>`));
			}
			return new Response("not found", { status: 404 });
		},
	});

	const fixture: Fixture = {
		url: (path) => `http://127.0.0.1:${server.port}${path}`,
		hits: (path) => hits.get(path) ?? 0,
		submissions: () => submissions,
		cookieValue,
		releaseHold: () => openHold(true),
		stop: async () => {
			// Nothing this fixture holds may outlive the test that held it.
			clearTimeout(holdBound);
			openHold(false);
			await server.stop(true);
		},
	};
	servers.push(fixture);
	return fixture;
}

// ---------------------------------------------------------------------------
// Small test helpers
// ---------------------------------------------------------------------------

/** Request an action and approve it, returning the settled receipt. */
export async function approve(
	runtime: BrowserRuntime,
	browserId: string,
	requestId: string,
	action: BrowserAction,
): Promise<PendingAction> {
	const pending = await runtime.requestAction(browserId, requestId, action);
	return await runtime.resolveAction(browserId, pending.id, true);
}

/**
 * Poll `probe` until `ok` accepts it, or fail at the deadline. The timeout is a
 * FAILURE, never a success: nothing here treats "time passed" as proof that an
 * effect happened. Use it only to wait for an observation the product itself
 * makes — a server hit, a landed navigation — never to let a race settle.
 */
export async function waitUntil<T>(
	what: string,
	probe: () => T | Promise<T>,
	ok: (value: T) => boolean,
	timeoutMs = EFFECT_TIMEOUT_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let seen = await probe();
	while (!ok(seen)) {
		if (Date.now() >= deadline) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last saw ${JSON.stringify(seen)}`);
		}
		await Bun.sleep(25);
		seen = await probe();
	}
	return seen;
}

/**
 * Wait for the form round trip that `resolveAction` deliberately does NOT
 * await. A click reports `completed` once the browser dispatched it; the POST
 * travels to the server and the response comes back to the page afterwards.
 * Landing on the `/submit` response is the observable END of that round trip:
 * the server has accepted the write and the submitting page is gone, so the
 * submission count is settled and "exactly once" can be asserted honestly.
 */
export async function submissionLanded(
	runtime: BrowserRuntime,
	browserId: string,
	fixture: Fixture,
): Promise<void> {
	await waitUntil(
		"the browser to land on the fixture's /submit response",
		async () => (await runtime.state(browserId)).url,
		(url) => url === fixture.url("/submit"),
	);
}

/**
 * Run `work`, expect it to reject with a {@link BrowserRuntimeError}, and yield
 * its code. A call that RESOLVES fails the test — the refusal is the contract.
 */
export async function failureCode(work: () => Promise<unknown>): Promise<string> {
	try {
		await work();
	} catch (err) {
		if (err instanceof BrowserRuntimeError) return err.code;
		throw err;
	}
	throw new Error("expected the call to be refused, but it resolved");
}
