/**
 * A chat's saved-profile Allow belongs to the subject the person approved it for.
 *
 * The host re-derives a session's verified Loop principal on every call, and it can lose it (the Loop is untrusted or retired) or change it (the Loop's
 * source is edited and re-trusted, which changes `origin`) while the session lives. An approval given for one subject must not carry over to another:
 * the agent has to ask again. A plain chat has no principal at all, and its approval must keep working across every read that reports none.
 */
import { afterEach, expect, test } from "bun:test";
import type { ArtifactoryLoopPrincipal } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { ProfileStore } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, failureCode, newRuntime, teardown } from "./fixture";

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

const P: ArtifactoryLoopPrincipal = { id: "loop-7", workspaceId: "workspace-a", origin: "source-hash-1", label: "Research Loop" };
const Q: ArtifactoryLoopPrincipal = { ...P, origin: "source-hash-2" };
const SESSION = "loop-node";
const asModel = { caller: "model", session: SESSION } as const;
const subjectOf = (principal: ArtifactoryLoopPrincipal | undefined) =>
	principal === undefined ? undefined : { workspaceId: principal.workspaceId, id: principal.id, origin: principal.origin };

async function runtimeWithSavedProfile(): Promise<BrowserRuntime> {
	const rootDir = await createRoot();
	new ProfileStore(rootDir).ensureProfile("work");
	return newRuntime(rootDir);
}

/** The agent asks for saved profile `work`, then the person in the View allows it for this chat while the host reports `principal` for the session. */
async function personAllowsChat(runtime: BrowserRuntime, principal: ArtifactoryLoopPrincipal | undefined): Promise<void> {
	runtime.setProfilePrincipal(SESSION, principal);
	expect(await failureCode(() => runtime.open({ profile: "work" }, asModel))).toBe("profile_consent_required");
	await runtime.decideProfileConsent("work", "allow", "app", SESSION, "chat", subjectOf(principal));
}

/** The agent gets the saved profile's browser: resolving proves its approval is live. */
async function agentOpensAndLeaves(runtime: BrowserRuntime): Promise<void> {
	const state = await runtime.open({ profile: "work" }, asModel);
	await runtime.close(state.browserId, "app");
}

const agentIsRefused = (runtime: BrowserRuntime) => failureCode(() => runtime.open({ profile: "work" }, asModel));

describeWithChrome("a chat's saved-profile approval stays bound to the subject that was approved", () => {
	test("losing the verified Loop identity drops the approval, and the same identity returning does not bring it back", async () => {
		const runtime = await runtimeWithSavedProfile();
		await personAllowsChat(runtime, P);
		await agentOpensAndLeaves(runtime);

		runtime.setProfilePrincipal(SESSION, undefined);
		expect(await agentIsRefused(runtime)).toBe("profile_consent_required");

		// The Loop is trusted again at the very source it was approved at: the approval was dropped, so the person must give it again.
		runtime.setProfilePrincipal(SESSION, P);
		expect(await agentIsRefused(runtime)).toBe("profile_consent_required");
		await runtime.decideProfileConsent("work", "allow", "app", SESSION, "chat", subjectOf(P));
		await agentOpensAndLeaves(runtime);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a Loop re-trusted at a different source hash does not inherit the approval, and the new subject can be asked afresh", async () => {
		const runtime = await runtimeWithSavedProfile();
		await personAllowsChat(runtime, P);
		await agentOpensAndLeaves(runtime);

		runtime.setProfilePrincipal(SESSION, Q);
		expect(await agentIsRefused(runtime)).toBe("profile_consent_required");
		// The request now on the person's menu is for the new subject, and deciding it for that subject is what opens the profile.
		expect(runtime.profileConsents(SESSION)).toEqual([expect.objectContaining({ name: "work", status: "pending", subject: subjectOf(Q) })]);
		await runtime.decideProfileConsent("work", "allow", "app", SESSION, "chat", subjectOf(Q));
		await agentOpensAndLeaves(runtime);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("an identity lost and regained before the agent asks again is still a new subject, so the approval is gone", async () => {
		const runtime = await runtimeWithSavedProfile();
		await personAllowsChat(runtime, P);
		await agentOpensAndLeaves(runtime);

		// The host reads the session twice (say, for the View's menu) and the agent asks for nothing in between.
		runtime.setProfilePrincipal(SESSION, undefined);
		runtime.setProfilePrincipal(SESSION, P);
		expect(await agentIsRefused(runtime)).toBe("profile_consent_required");
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a renamed Loop is the same subject and keeps its approval", async () => {
		const runtime = await runtimeWithSavedProfile();
		await personAllowsChat(runtime, P);
		runtime.setProfilePrincipal(SESSION, { ...P, label: "Renamed Loop" });
		await agentOpensAndLeaves(runtime);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a profile the agent created is bound to the subject it was created under", async () => {
		const runtime = await runtimeWithSavedProfile();
		runtime.setProfilePrincipal(SESSION, P);
		const created = await runtime.open({ profile: "fresh" }, asModel);
		runtime.requireProfileAccess(created.browserId, "model", SESSION);

		runtime.setProfilePrincipal(SESSION, Q);
		expect(await failureCode(async () => runtime.requireProfileAccess(created.browserId, "model", SESSION))).toBe("profile_consent_required");
		runtime.setProfilePrincipal(SESSION, undefined);
		expect(await failureCode(async () => runtime.requireProfileAccess(created.browserId, "model", SESSION))).toBe("profile_consent_required");
		await runtime.close(created.browserId, "app");
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a plain chat with no Loop keeps its approval, and its created profile, across every read that reports no principal", async () => {
		const runtime = await runtimeWithSavedProfile();
		runtime.setProfilePrincipal(SESSION, undefined);
		const created = await runtime.open({ profile: "fresh" }, asModel);
		await personAllowsChat(runtime, undefined);
		for (let read = 0; read < 3; read++) {
			runtime.setProfilePrincipal(SESSION, undefined);
			runtime.requireProfileAccess(created.browserId, "model", SESSION);
			await agentOpensAndLeaves(runtime);
		}
		await runtime.close(created.browserId, "app");
	}, BROWSER_TEST_TIMEOUT_MS);
});
