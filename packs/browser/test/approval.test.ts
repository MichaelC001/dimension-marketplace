/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the model moved the human's
 *  browser without being told to. Either a requested action fired before anyone
 *  approved it, a denial executed anyway, a retried requestId paid twice, a
 *  requestId got reused for a DIFFERENT payload and both ran, an approval
 *  landed on a page that had already navigated away underneath it — before OR
 *  during the resolution of its target — a typed password leaked into a
 *  receipt or onto disk, or the human approved an action whose exact text they
 *  had no way to see. Every case below drives a real Chrome against a local
 *  server that COUNTS the writes it accepts, so "did the effect happen" is
 *  answered by the server, never by the runtime's own story.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
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
const SECRET = "correct-horse-battery-staple-9f21";

// Closing a real Chrome and deleting its profile on Windows takes longer than
// bun's default hook budget; a leaked browser poisons every later test.
afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("approval gate", () => {
	test(
		"a requested navigation does not reach the site until it is approved",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "gate", viewport: VIEWPORT });

			const pending = await runtime.requestAction(opened.browserId, "nav-1", {
				kind: "navigate",
				url: fixture.url("/page2"),
			});

			expect(pending.status).toBe("pending");
			expect(fixture.hits("/page2")).toBe(0);
			const before = await runtime.state(opened.browserId);
			expect(before.url).not.toContain("/page2");

			const settled = await runtime.resolveAction(opened.browserId, pending.id, true);
			expect(settled.status).toBe("completed");
			expect(fixture.hits("/page2")).toBe(1);
			const after = await runtime.state(opened.browserId);
			expect(after.url).toBe(fixture.url("/page2"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a denied click never submits the form, and the denial cannot be upgraded",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "deny", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const pending = await runtime.requestAction(opened.browserId, "click-1", {
				kind: "click",
				selector: "#go",
			});
			const denied = await runtime.resolveAction(opened.browserId, pending.id, false);

			expect(denied.status).toBe("denied");
			expect(fixture.submissions()).toHaveLength(0);

			// A second look at the same action must not become consent.
			expect(await failureCode(() => runtime.resolveAction(opened.browserId, pending.id, true))).toBe(
				"action_settled",
			);
			expect(fixture.submissions()).toHaveLength(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a retried requestId submits the form exactly once",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "once", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const click = { kind: "click", selector: "#go" } as const;
			const first = await runtime.requestAction(opened.browserId, "submit-1", { ...click });
			const done = await runtime.resolveAction(opened.browserId, first.id, true);
			expect(done.status).toBe("completed");
			// `completed` means the browser dispatched the click; the POST and its
			// response are still in flight. Wait for the page to land on the
			// fixture's own response — that is the server saying it took the write.
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);

			// The model retries the identical request: it must get the SAME settled
			// action back, not a fresh pending one waiting for a second approval.
			const replay = await runtime.requestAction(opened.browserId, "submit-1", { ...click });
			expect(replay.id).toBe(first.id);
			expect(replay.status).toBe("completed");

			expect(await failureCode(() => runtime.resolveAction(opened.browserId, replay.id, true))).toBe(
				"action_settled",
			);
			expect(fixture.submissions()).toHaveLength(1);

			const state = await runtime.state(opened.browserId);
			expect(state.actions.filter((action) => action.requestId === "submit-1")).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a retry long after the action fell out of the visible history still replays the receipt",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "late-retry", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const click = { kind: "click", selector: "#go" } as const;
			const original = await approve(runtime, opened.browserId, "submit-1", { ...click });
			expect(original.status).toBe("completed");
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);

			// Push the completed submission out of the bounded action history.
			for (let i = 0; i < 70; i += 1) {
				const filler = await runtime.requestAction(opened.browserId, `filler-${i}`, {
					kind: "click",
					selector: "#user",
				});
				await runtime.resolveAction(opened.browserId, filler.id, false);
			}
			const evicted = await runtime.state(opened.browserId);
			expect(evicted.actions.some((action) => action.id === original.id)).toBe(false);

			// Forgetting the request id here would turn a retry into a fresh pending
			// action that a human could approve — a second POST for one request.
			const replay = await runtime.requestAction(opened.browserId, "submit-1", { ...click });
			expect(replay.id).toBe(original.id);
			expect(replay.status).toBe("completed");
			expect(await failureCode(() => runtime.resolveAction(opened.browserId, replay.id, true))).toBe(
				"action_settled",
			);
			expect(fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a requestId reused with a different payload is refused, not queued",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "conflict", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const first = await runtime.requestAction(opened.browserId, "submit-1", { kind: "click", selector: "#go" });
			expect(
				await failureCode(() =>
					runtime.requestAction(opened.browserId, "submit-1", { kind: "click", selector: "#user" }),
				),
			).toBe("request_conflict");

			// The refusal must leave nothing behind that a later approval could fire.
			const state = await runtime.state(opened.browserId);
			const mine = state.actions.filter((action) => action.requestId === "submit-1");
			expect(mine).toHaveLength(1);
			expect(mine[0]?.id).toBe(first.id);
			expect(mine[0]?.action.selector).toBe("#go");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an approval for a page that has since navigated away does not click the new page",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "stale", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const clickOnForm = await runtime.requestAction(opened.browserId, "click-1", {
				kind: "click",
				selector: "#go",
			});
			await approve(runtime, opened.browserId, "nav-2", { kind: "navigate", url: fixture.url("/page2") });

			const settled = await runtime.resolveAction(opened.browserId, clickOnForm.id, true);
			expect(settled.status).toBe("failed");
			expect(fixture.submissions()).toHaveLength(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that navigates WHILE the approved target is being resolved does not receive the click",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "toctou", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/leave") });

			// Page A is fully loaded, carries no form control at all, and is parked
			// on one held subresource. The SERVER decides when that request is
			// answered, and the answer is the only thing that navigates the page —
			// so page A is a live, committed execution context and the runtime has
			// seen no navigation.
			await waitUntil(
				"page A to park on its held request",
				() => fixture.hits("/hold"),
				(count) => count >= 1,
			);

			const pending = await runtime.requestAction(opened.browserId, "click-1", {
				kind: "click",
				selector: "#go",
			});
			expect(pending.status).toBe("pending");

			// The approval is taken against page A, where #go does not exist, so
			// preparation parks on a selector that can never resolve there.
			// Answering the held request swaps the document underneath that wait
			// for one where #go SUBMITS. The ordering is structural rather than
			// timed: the freshness check that precedes preparation runs in a
			// microtask of the call below, while the navigation cannot land until
			// the held response reaches page A, a script runs, and a whole further
			// HTTP round trip commits — so the check this exercises is the one
			// AFTER preparation resolved an element on the page that replaced it.
			const settling = runtime.resolveAction(opened.browserId, pending.id, true);
			fixture.releaseHold();
			const settled = await settling;

			// The consent named a document that is gone. Spending it on the
			// replacement is a submission nobody was ever asked about.
			expect(settled.status).toBe("failed");
			expect(fixture.submissions()).toHaveLength(0);
			expect(fixture.hits("/submit")).toBe(0);

			// …and #go on the new document really is a live submission target, so
			// the zero above is the guard's doing and not a dead page's.
			await waitUntil(
				"the browser to land on the page that replaced page A",
				async () => (await runtime.state(opened.browserId)).url,
				(url) => url === fixture.url("/gate"),
			);
			await approve(runtime, opened.browserId, "submit-1", { kind: "click", selector: "#go" });
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a typed password reaches the page but never a receipt, a snapshot or the journal",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const opened = await runtime.open({ profile: "secrets", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const requested = await runtime.requestAction(opened.browserId, "type-1", {
				kind: "type",
				selector: "#pass",
				text: SECRET,
			});
			expect(requested.action.text).toBe("[redacted]");

			const typed = await runtime.resolveAction(opened.browserId, requested.id, true);
			expect(typed.status).toBe("completed");
			expect(typed.action.text).toBe("[redacted]");

			const snapshot = await runtime.snapshot(opened.browserId);
			expect(snapshot.text).not.toContain(SECRET);
			const state = await runtime.state(opened.browserId);
			expect(JSON.stringify(state)).not.toContain(SECRET);

			// The secret must actually have been typed — otherwise "absent from the
			// receipt" would be satisfied by a runtime that types nothing at all.
			await approve(runtime, opened.browserId, "submit-1", { kind: "click", selector: "#go" });
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()[0]?.pass).toBe(SECRET);

			const journal = await readFile(join(rootDir, "profiles", "secrets", "actions.jsonl"), "utf8");
			expect(journal).toContain(requested.id);
			expect(journal).not.toContain(SECRET);
			expect(journal).not.toContain(opened.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a backend failure that quotes the typed text back never republishes it in the receipt, the history or the journal",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const opened = await runtime.open({ profile: "echoed-failure", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/guarded") });

			const entry = { kind: "type", selector: "#pass", text: SECRET } as const;
			// The first entry lands, so the field genuinely holds the secret that
			// the page's own guard is about to quote back at us.
			expect((await approve(runtime, opened.browserId, "type-1", { ...entry })).status).toBe("completed");

			// A retry of the same credential — the ordinary thing to do after a
			// login that did not take. This time the page throws mid-sequence and
			// its message carries the field contents, which is how a third party's
			// error becomes a credential the runtime is holding.
			const retry = await runtime.requestAction(opened.browserId, "type-2", { ...entry });
			const settled = await runtime.resolveAction(opened.browserId, retry.id, true);
			await waitUntil(
				"the page guard to report that it refused the second entry",
				() => fixture.hits("/guard-fired"),
				(count) => count >= 1,
			);

			// The outcome is still told honestly — native input had begun, so the
			// effect is uncertain and the receipt says so rather than going quiet.
			expect(settled.status).toBe("unknown");
			expect(typeof settled.error).toBe("string");
			// …and none of what the model or the disk gets to read is the text.
			expect(JSON.stringify(settled)).not.toContain(SECRET);
			expect(JSON.stringify(await runtime.state(opened.browserId))).not.toContain(SECRET);
			const journal = await readFile(join(rootDir, "profiles", "echoed-failure", "actions.jsonl"), "utf8");
			expect(journal).toContain(retry.id);
			expect(journal).not.toContain(SECRET);

			// The secret really is sitting in that page, so the absences above are
			// the runtime withholding it, not a browser that typed nothing.
			await approve(runtime, opened.browserId, "submit-1", { kind: "click", selector: "#go" });
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()[0]?.pass).toBe(SECRET);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the approver can read the exact text a model proposed, and approval runs that text once",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const opened = await runtime.open({ profile: "preview", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			// browser_request_action is model-callable, so the human approving this
			// need not have authored the text. Approving an id whose payload cannot
			// be read is not consent to what the payload actually does.
			const requested = await runtime.requestAction(opened.browserId, "type-1", {
				kind: "type",
				selector: "#pass",
				text: SECRET,
			});
			expect(requested.action.text).toBe("[redacted]");

			const preview = await runtime.previewAction(opened.browserId, requested.id);
			expect(preview).toEqual({ kind: "type", selector: "#pass", text: SECRET });

			// The disclosure is a copy of the immutable proposal: whatever the
			// surface does with it, approval still executes the original.
			preview.text = "tampered-by-the-surface";
			preview.selector = "#user";
			expect(await runtime.previewAction(opened.browserId, requested.id)).toEqual({
				kind: "type",
				selector: "#pass",
				text: SECRET,
			});

			// Disclosing to the approver must not widen anything the model reads.
			expect(JSON.stringify(await runtime.state(opened.browserId))).not.toContain(SECRET);

			const typed = await runtime.resolveAction(opened.browserId, requested.id, true);
			expect(typed.status).toBe("completed");
			expect(typed.action.text).toBe("[redacted]");

			// What was inspected is what reached the site, exactly once, and into
			// the field that was inspected rather than the one the copy named.
			await approve(runtime, opened.browserId, "submit-1", { kind: "click", selector: "#go" });
			await submissionLanded(runtime, opened.browserId, fixture);
			expect(fixture.submissions()).toHaveLength(1);
			expect(fixture.submissions()[0]?.pass).toBe(SECRET);
			expect(fixture.submissions()[0]?.user).toBe("");

			// A settled action has no live proposal left to hand anybody.
			expect(await failureCode(() => runtime.previewAction(opened.browserId, requested.id))).toBe("action_settled");

			const journal = await readFile(join(rootDir, "profiles", "preview", "actions.jsonl"), "utf8");
			expect(journal).not.toContain(SECRET);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a pending proposal is not readable through another browser's capability",
		async () => {
			const { runtime } = await createRuntime();
			const mine = await runtime.open({ profile: "preview-mine", viewport: VIEWPORT });
			const other = await runtime.open({ profile: "preview-other", viewport: VIEWPORT });

			const pending = await runtime.requestAction(mine.browserId, "type-1", {
				kind: "type",
				selector: "#pass",
				text: SECRET,
			});

			// The browserId is the capability; holding a different one must not turn
			// an action id into a credential reader.
			expect(await failureCode(() => runtime.previewAction(other.browserId, pending.id))).toBe("unknown_action");
			// The refusal is about the capability, not a broken id.
			expect((await runtime.previewAction(mine.browserId, pending.id)).text).toBe(SECRET);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a proposal the page has already invalidated is not offered for inspection",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const opened = await runtime.open({ profile: "preview-stale", viewport: VIEWPORT });
			await approve(runtime, opened.browserId, "nav-1", { kind: "navigate", url: fixture.url("/") });

			const pending = await runtime.requestAction(opened.browserId, "type-1", {
				kind: "type",
				selector: "#pass",
				text: SECRET,
			});
			expect((await runtime.previewAction(opened.browserId, pending.id)).text).toBe(SECRET);

			await approve(runtime, opened.browserId, "nav-2", { kind: "navigate", url: fixture.url("/page2") });

			// Showing this as an inspectable proposal would invite an approval that
			// the runtime is going to refuse anyway — consent for a page that is
			// already gone.
			expect(await failureCode(() => runtime.previewAction(opened.browserId, pending.id))).toBe("stale_action");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
