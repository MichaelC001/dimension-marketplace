/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the normal approval prompt —
 *  the one path that works with Browser View closed — authorized a browser
 *  action the human never affirmatively approved. Either the effect fired
 *  before anyone was asked, a decline/cancel/unchecked-box answer executed
 *  anyway, an answer too malformed for the protocol to deliver was read as
 *  consent, a host that cannot show a prompt at all executed anyway, a
 *  cancelled or shut-down prompt still dispatched when the late answer
 *  arrived, two prompts for one action paid twice, or a consent given for one
 *  page was spent on the page that replaced it while the human was reading.
 *
 *  Every case drives the REAL `browser_confirm_action` tool over a real MCP
 *  client/server pair (so the elicitation round trip is the protocol's, not a
 *  stub's), a real BrowserRuntime, a real Chrome and a local server that
 *  COUNTS the writes it accepts. "Did the effect happen" is answered by that
 *  server, never by the runtime's own story and never by inspecting a mock.
 */
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserAction, PendingAction } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import {
	approve,
	BROWSER_TEST_TIMEOUT_MS,
	createRuntime,
	describeWithChrome,
	failureCode,
	startFixture,
	submissionLanded,
	teardown,
	waitUntil,
} from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const CLICK_SUBMIT: BrowserAction = { kind: "click", selector: "#go" };
/** The pack's own built View; the server refuses to start without one. */
const VIEW_DIR = fileURLToPath(new URL("../app/dist/", import.meta.url));

type Answer = () => ElicitResult | Promise<ElicitResult>;

interface Host {
	client: Client;
	server: McpServer;
	/** How many approval prompts this host was actually shown. */
	prompts(): number;
}

const hosts: Host[] = [];

/**
 * A real MCP client talking to the pack's real server over the SDK's in-memory
 * transport. `answer` plays the human: it is invoked only when a genuine
 * `elicitation/create` request arrives, so a runtime that executed without
 * asking is visible as a prompt that was never shown.
 */
async function connect(
	runtime: BrowserRuntime,
	answer: Answer,
	options: { elicitation?: boolean } = {},
): Promise<Host> {
	const capable = options.elicitation !== false;
	const server = await createBrowserServer({ runtime, viewDir: VIEW_DIR });
	const client = new Client(
		{ name: "browser-confirm-test-host", version: "0.0.0" },
		{ capabilities: capable ? { elicitation: { form: {} } } : {} },
	);
	let prompts = 0;
	if (capable) {
		client.setRequestHandler(ElicitRequestSchema, async () => {
			prompts += 1;
			return await answer();
		});
	}
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const host: Host = { client, server, prompts: () => prompts };
	hosts.push(host);
	return host;
}

async function confirm(host: Host, browserId: string, actionId: string, signal?: AbortSignal): Promise<CallToolResult> {
	const result = await host.client.callTool(
		{ name: "browser_confirm_action", arguments: { browserId, actionId } },
		undefined,
		signal ? { signal } : {},
	);
	// The SDK hands back the value parsed by CallToolResultSchema; that is this
	// exported type, which the schema is derived from.
	return result as CallToolResult;
}

function textOf(result: CallToolResult): string {
	const first = result.content?.[0];
	return first !== undefined && first.type === "text" ? first.text : "";
}

/** The settled receipt the tool returned. A refusal is a test failure here. */
function receipt(result: CallToolResult): PendingAction {
	if (result.isError === true) throw new Error(`browser_confirm_action was refused: ${textOf(result)}`);
	return JSON.parse(textOf(result)) as PendingAction;
}

/**
 * A prompt the test holds open. `asked` settles the moment the human is shown
 * the prompt; `answer` releases it with the response of the test's choosing —
 * so "before the human responded" is a real, observed window rather than a
 * sleep.
 */
function heldPrompt(): { asked: Promise<void>; answer: (result: ElicitResult) => void; respond: Answer } {
	let shown: () => void = () => undefined;
	const asked = new Promise<void>((resolve) => {
		shown = resolve;
	});
	let release: (result: ElicitResult) => void = () => undefined;
	const answered = new Promise<ElicitResult>((resolve) => {
		release = resolve;
	});
	return {
		asked,
		answer: release,
		respond: () => {
			shown();
			return answered;
		},
	};
}

async function statusOf(runtime: BrowserRuntime, browserId: string, actionId: string): Promise<string | undefined> {
	const state = await runtime.state(browserId);
	return state.actions.find((action) => action.id === actionId)?.status;
}

// Closing a real Chrome and deleting its profile on Windows takes longer than
// bun's default hook budget; a leaked browser poisons every later test.
afterEach(async () => {
	for (const host of hosts.splice(0)) {
		await host.client.close().catch(() => undefined);
		await host.server.close().catch(() => undefined);
	}
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("browser_confirm_action", () => {
	test(
		"nothing reaches the site while the prompt is open, and one affirmative submits exactly once",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const prompt = heldPrompt();
			const host = await connect(runtime, prompt.respond);
			const opened = await runtime.open({ profile: "confirm-gate", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const pending = await runtime.requestAction(opened.browserId, "submit-1", { ...CLICK_SUBMIT });
			const call = confirm(host, opened.browserId, pending.id);
			await prompt.asked;

			// The human is still reading the prompt. Anything the site has seen by
			// now happened without consent.
			expect(fixture.submissions()).toHaveLength(0);
			expect(fixture.hits("/submit")).toBe(0);
			expect(await statusOf(runtime, opened.browserId, pending.id)).toBe("pending");

			prompt.answer({ action: "accept", content: { approve: true } });
			const settled = receipt(await call);
			expect(settled.status).toBe("completed");
			expect(settled.id).toBe(pending.id);

			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);
			expect(host.prompts()).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"no answer other than an explicit affirmative ever touches the page",
		async () => {
			// Answers a schema-compliant host can actually give that are NOT
			// consent. Each one must settle the action denied, untouched.
			const rows: ReadonlyArray<{ name: string; response: ElicitResult }> = [
				{ name: "decline", response: { action: "decline" } },
				{ name: "cancel", response: { action: "cancel" } },
				{ name: "accept with the box left unchecked", response: { action: "accept", content: { approve: false } } },
			];

			const fixture = startFixture();
			const { runtime } = await createRuntime();
			let response: ElicitResult = { action: "cancel" };
			const host = await connect(runtime, () => response);
			const opened = await runtime.open({ profile: "confirm-refusals", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const outcomes: Array<{ name: string; status: string; writes: number }> = [];
			for (const [index, row] of rows.entries()) {
				const pending = await runtime.requestAction(opened.browserId, `submit-${index}`, { ...CLICK_SUBMIT });
				response = row.response;
				const settled = receipt(await confirm(host, opened.browserId, pending.id));
				outcomes.push({ name: row.name, status: settled.status, writes: fixture.submissions().length });
			}
			expect(outcomes).toEqual(rows.map((row) => ({ name: row.name, status: "denied", writes: 0 })));

			// An "accept" carrying no answer at all does not satisfy the schema the
			// prompt asked for, so it never arrives as a usable response at all: the
			// protocol rejects it. The dangerous reading is that a malformed accept
			// is still an accept. The tool must fail instead, and — because nobody
			// answered — the action must survive gated so the human can still be
			// asked properly.
			const malformed = await runtime.requestAction(opened.browserId, "submit-malformed", { ...CLICK_SUBMIT });
			response = { action: "accept", content: {} };
			const refused = await confirm(host, opened.browserId, malformed.id);
			expect(refused.isError).toBe(true);
			expect(await statusOf(runtime, opened.browserId, malformed.id)).toBe("pending");

			expect(fixture.submissions()).toHaveLength(0);
			expect(fixture.hits("/submit")).toBe(0);
			expect(host.prompts()).toBe(rows.length + 1);

			// …and #go really is a live submission target on this page, so the zeros
			// above are the gate's doing and not a dead button's.
			await approve(runtime, opened.browserId, "live-1", { ...CLICK_SUBMIT });
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a cancelled confirmation cannot dispatch when the answer arrives afterwards",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const abandoned = heldPrompt();
			let response: Answer = abandoned.respond;
			const host = await connect(runtime, () => response());
			const opened = await runtime.open({ profile: "confirm-cancel", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const pending = await runtime.requestAction(opened.browserId, "submit-1", { ...CLICK_SUBMIT });
			const caller = new AbortController();
			const call = confirm(host, opened.browserId, pending.id, caller.signal);
			await abandoned.asked;
			caller.abort();
			await expect(call).rejects.toThrow();

			// The human says yes to a prompt whose caller is already gone.
			abandoned.answer({ action: "accept", content: { approve: true } });

			// `state` goes through the same per-browser serializer as execution, so
			// it cannot observe a half-finished dispatch: any resolution still in
			// flight has finished by the time it answers.
			expect(await statusOf(runtime, opened.browserId, pending.id)).toBe("pending");
			expect(fixture.submissions()).toHaveLength(0);
			expect(fixture.hits("/submit")).toBe(0);

			// The abandoned approval left the action gated but still usable: one
			// fresh, answered prompt executes it, and the site is written once in
			// total across both attempts.
			response = () => ({ action: "accept", content: { approve: true } });
			expect(receipt(await confirm(host, opened.browserId, pending.id)).status).toBe("completed");
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a server shutting down cancels the outstanding prompt and the late yes has nothing left to click",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const prompt = heldPrompt();
			const host = await connect(runtime, prompt.respond);
			const opened = await runtime.open({ profile: "confirm-shutdown", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const pending = await runtime.requestAction(opened.browserId, "submit-1", { ...CLICK_SUBMIT });
			const call = confirm(host, opened.browserId, pending.id);
			await prompt.asked;

			// Shutdown must not block on a human who will never answer, and must not
			// leave an approval that a late answer could still spend.
			await host.server.close();
			// The confirmation may end as a tool-level refusal or as a dead
			// connection depending on which half of shutdown wins; what it may
			// NEVER end as is a report that the action executed.
			const outcome = await call.then(
				(result) => (result.isError === true ? "refused" : receipt(result).status),
				() => "refused",
			);
			expect(outcome).toBe("refused");

			prompt.answer({ action: "accept", content: { approve: true } });

			// Disposal is what makes the late yes harmless: the capability is dead
			// and the browser it named is gone, so no click can ever be dispatched.
			expect(await failureCode(() => runtime.state(opened.browserId))).toBe("unknown_browser");
			expect(fixture.submissions()).toHaveLength(0);
			expect(fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"two confirmations racing for one action, and a third after it settled, still write once",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			// A host that says yes to everything it is shown: if the action can be
			// prompted twice, it can be executed twice.
			const host = await connect(runtime, () => ({ action: "accept", content: { approve: true } }));
			const opened = await runtime.open({ profile: "confirm-race", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const pending = await runtime.requestAction(opened.browserId, "submit-1", { ...CLICK_SUBMIT });
			const results = await Promise.all([
				confirm(host, opened.browserId, pending.id),
				confirm(host, opened.browserId, pending.id),
			]);

			// Exactly one call may report an execution; the other must be refused.
			const executed = results.filter((result) => result.isError !== true).map((result) => receipt(result).status);
			expect(executed).toEqual(["completed"]);

			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);

			// The settled action is not a second chance for a human who confirms it
			// again later either.
			const again = await confirm(host, opened.browserId, pending.id);
			expect(again.isError).toBe(true);
			expect(fixture.submissions()).toHaveLength(1);
			expect(fixture.hits("/submit")).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that navigates while the human is deciding invalidates the consent",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "confirm-stale", viewport: VIEWPORT });
			let response: Answer = () => ({ action: "cancel" });
			const host = await connect(runtime, () => response());
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/leave") });

			// Page A carries no form control and is parked on one held subresource;
			// answering it — and nothing else — sends it to a page where #go really
			// does submit.
			await waitUntil(
				"page A to park on its held request",
				() => fixture.hits("/hold"),
				(count) => count >= 1,
			);
			const pending = await runtime.requestAction(opened.browserId, "submit-1", { ...CLICK_SUBMIT });

			// The human is shown a prompt describing page A. While they read it, the
			// page underneath becomes a different document. Answering yes now is
			// consent for a page that no longer exists.
			response = async () => {
				fixture.releaseHold();
				await waitUntil(
					"the browser to land on the page that replaced page A",
					async () => (await runtime.state(opened.browserId)).url,
					(url) => url === fixture.url("/gate"),
				);
				return { action: "accept", content: { approve: true } };
			};
			const settled = receipt(await confirm(host, opened.browserId, pending.id));

			expect(settled.status).toBe("failed");
			expect(fixture.submissions()).toHaveLength(0);
			expect(fixture.hits("/submit")).toBe(0);

			// #go on the replacement document is a live submission target, so the
			// zero above is the freshness check and not a dead page.
			await approve(runtime, opened.browserId, "submit-2", { ...CLICK_SUBMIT });
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a host that cannot show an approval prompt is refused, and the action survives still gated",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const host = await connect(
				runtime,
				() => {
					throw new Error("a host without elicitation must never be asked");
				},
				{ elicitation: false },
			);
			const opened = await runtime.open({ profile: "confirm-uncapable", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const pending = await runtime.requestAction(opened.browserId, "submit-1", { ...CLICK_SUBMIT });
			const refused = await confirm(host, opened.browserId, pending.id);

			// Missing approval UI is not consent, and it is not a reason to throw the
			// human's pending action away either.
			expect(refused.isError).toBe(true);
			expect(fixture.submissions()).toHaveLength(0);
			expect(await statusOf(runtime, opened.browserId, pending.id)).toBe("pending");

			// The Browser View path still approves that very action, once.
			expect((await runtime.resolveAction(opened.browserId, pending.id, true)).status).toBe("completed");
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
