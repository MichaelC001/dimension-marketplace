/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: profiles stop being profiles.
 *  Either a named profile forgets the login the human established in it (a
 *  cookie that did not survive reopening), or one profile can SEE another's
 *  session, or two sessions drive the same on-disk Chrome profile at once —
 *  which corrupts it — or a lock survives a clean close and the profile is
 *  bricked until someone deletes a file by hand. Nothing upstream can catch
 *  any of these: they are properties of real Chrome writing a real user-data
 *  directory, so these tests use both.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { BrowserState } from "../src/contracts";
import { BrowserRuntimeError } from "../src/store";
import {
	approve,
	BROWSER_TEST_TIMEOUT_MS,
	createRoot,
	createRuntime,
	describeWithChrome,
	failureCode,
	newRuntime,
	startFixture,
	teardown,
} from "./fixture";

const VIEWPORT = { width: 640, height: 480 };

// Closing a real Chrome and deleting its profile on Windows takes longer than
// bun's default hook budget; a leaked browser poisons every later test.
afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("profiles", () => {
	test(
		"a cookie survives reopening the same profile and is invisible to another profile",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();

			const first = await runtime.open({ profile: "signed-in", viewport: VIEWPORT });
			await approve(runtime, first.browserId, "nav-1", { kind: "navigate", url: fixture.url("/set-cookie") });
			await runtime.close(first.browserId);

			const reopened = await runtime.open({ profile: "signed-in", viewport: VIEWPORT });
			expect(reopened.browserId).not.toBe(first.browserId);
			await approve(runtime, reopened.browserId, "nav-2", { kind: "navigate", url: fixture.url("/show-cookie") });
			const persisted = await runtime.snapshot(reopened.browserId);
			expect(persisted.text).toContain(`COOKIE:${fixture.cookieValue}`);

			const other = await runtime.open({ profile: "other", viewport: VIEWPORT });
			await approve(runtime, other.browserId, "nav-3", { kind: "navigate", url: fixture.url("/show-cookie") });
			const isolated = await runtime.snapshot(other.browserId);
			expect(isolated.text).toContain("COOKIE:none");
			expect(isolated.text).not.toContain(fixture.cookieValue);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a second open of a live profile is refused instead of handing out its capability",
		async () => {
			const { runtime } = await createRuntime();

			// One engine serves many sessions: the second caller must never receive
			// the first caller's browserId, and must never get a second Chrome on
			// the same user-data dir.
			const settled = await Promise.allSettled([
				runtime.open({ profile: "shared", viewport: VIEWPORT }),
				runtime.open({ profile: "shared", viewport: VIEWPORT }),
			]);
			const opened = settled.filter((r): r is PromiseFulfilledResult<BrowserState> => r.status === "fulfilled");
			const refused = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
			expect(opened).toHaveLength(1);
			expect(refused).toHaveLength(1);
			expect(refused[0]?.reason).toBeInstanceOf(BrowserRuntimeError);
			expect((refused[0]?.reason as BrowserRuntimeError).code).toBe("profile_in_use");

			const live = opened[0]?.value as BrowserState;
			expect((await runtime.state(live.browserId)).profile).toBe("shared");
			// Sequentially, too: the refusal is not a race artifact.
			expect(await failureCode(() => runtime.open({ profile: "shared", viewport: VIEWPORT }))).toBe("profile_in_use");
			expect(await runtime.profiles()).toEqual(["shared"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a second runtime cannot steal a held profile, and inherits it after a clean close",
		async () => {
			const { runtime, rootDir } = await createRuntime();
			const holder = await runtime.open({ profile: "exclusive", viewport: VIEWPORT });

			const intruder = newRuntime(rootDir);
			expect(await failureCode(() => intruder.open({ profile: "exclusive", viewport: VIEWPORT }))).toBe(
				"profile_locked",
			);
			// The refusal must not have disturbed the holder's browser.
			expect((await runtime.state(holder.browserId)).browserId).toBe(holder.browserId);

			await runtime.close(holder.browserId);

			const handedOver = await intruder.open({ profile: "exclusive", viewport: VIEWPORT });
			expect(handedOver.profile).toBe("exclusive");
			// A close releases the lock but never destroys what the profile stores.
			expect(existsSync(join(rootDir, "profiles", "exclusive", "chrome"))).toBe(true);
			expect(await intruder.profiles()).toContain("exclusive");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a launch that never started a browser leaves the profile openable",
		async () => {
			const rootDir = await createRoot();
			const broken = newRuntime(rootDir, { executablePath: join(rootDir, "no-such-chrome") });

			// Nothing was launched, so nothing of ours can still be writing this
			// profile. Holding its lock anyway would brick the profile for good:
			// the store never steals a lock, so only a human deleting the file
			// would ever get it back.
			await expect(broken.open({ profile: "recovered", viewport: VIEWPORT })).rejects.toThrow();

			const survivor = newRuntime(rootDir);
			const opened = await survivor.open({ profile: "recovered", viewport: VIEWPORT });
			expect(opened.profile).toBe("recovered");
			expect((await survivor.state(opened.browserId)).browserId).toBe(opened.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the refused abp engine launches nothing and leaves the profile openable by another engine",
		async () => {
			const { runtime, rootDir } = await createRuntime();

			// ABP's control port takes commands from any page it visits, so the
			// driver is refused before it can start a browser holding real logins.
			expect(await failureCode(() => runtime.open({ profile: "declined", engine: "abp", viewport: VIEWPORT }))).toBe(
				"abp_unauthenticated_control_port",
			);
			// The driver stages its user-data dir, session dir and config under
			// this subdirectory before it spawns. Nothing is there, so nothing ran.
			expect(existsSync(join(rootDir, "profiles", "declined", "abp"))).toBe(false);

			// The refusal took the profile lock on the way in. Keeping it would
			// brick the name for every other engine, since a lock is never stolen.
			const opened = await runtime.open({ profile: "declined", engine: "chromium", viewport: VIEWPORT });
			expect((await runtime.state(opened.browserId)).engine).toBe("chromium");
			await runtime.close(opened.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
