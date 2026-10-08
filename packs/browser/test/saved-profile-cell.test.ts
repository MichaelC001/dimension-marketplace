import { afterEach, expect, test } from "bun:test";
import type { BrowserRuntime } from "../src/runtime";
import { failureOf, newRig, valueOf, type Rig } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, startFixture, teardown } from "./fixture";

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.host.dispose();
  rig = undefined;
  await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function start(): Promise<Rig> {
  rig = newRig(await createRoot());
  return rig;
}

const browserIdOf = async (runtime: BrowserRuntime, asker: string, profile: string): Promise<string> => {
  const id = (await runtime.profileList(asker)).find(listed => listed.name === profile)?.browserId;
  if (id === undefined) throw new Error(`${asker} holds no browser on profile ${profile}`);
  return id;
};

const urlsOf = async (runtime: BrowserRuntime, browserId: string): Promise<string[]> =>
  (await runtime.state(browserId)).tabs.map(tab => tab.url).sort();

const q = JSON.stringify;
const SLOW_CELL = { timeoutMs: 90_000, waitMs: 85_000 } as const;

describeWithChrome("a cell opens a saved profile with no approval", () => {
  test("a login made in a saved profile survives the browser closing and is there for another chat's cell; another profile does not have it", async () => {
    const site = startFixture();
    const { host } = await start();
    await valueOf(host, "chat-1", `
      await browser.open({ name: "a", profile: "work", url: ${q(site.url("/set-cookie"))} });
      await browser.close({ all: true });
      0`, SLOW_CELL);
    const readBack = (session: string, profile: string) => valueOf(host, session, `
      const tab = await browser.open({ name: "a", profile: ${q(profile)}, url: ${q(site.url("/show-cookie"))} });
      await tab.evaluate(() => document.getElementById("cookie").textContent)`);
    expect(await readBack("chat-2", "work")).toBe(`COOKIE:${site.cookieValue}`);
    expect(await readBack("chat-3", "other")).toBe("COOKIE:none");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a profile one chat holds is refused to another chat as profile_held, without handing over the holder's browser, while the holder goes on driving it", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `await browser.open({ name: "a", profile: "work", url: ${q(site.url("/page2"))} }); 0`);
    const holderBrowser = await browserIdOf(runtime, "chat-1", "work");

    const refused = await failureOf(host, "chat-2", `await browser.open({ name: "b", profile: "work", url: ${q(site.url("/show-cookie"))} }); 0`);

    expect(refused.message).toContain("profile_held");
    expect(refused.message).not.toContain(holderBrowser);
    expect(site.hits("/show-cookie")).toBe(0);
    expect(await browserIdOf(runtime, "chat-1", "work")).toBe(holderBrowser);
    expect(await valueOf(host, "chat-1", "browser.tab('a').url()")).toBe(site.url("/page2"));
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a chat that asks again for the profile it holds gets its one browser with a second tab, not a refusal and not a second Chrome", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `await browser.open({ name: "a", profile: "work", url: ${q(site.url("/page2"))} }); 0`);
    const first = await browserIdOf(runtime, "chat-1", "work");

    await valueOf(host, "chat-1", `await browser.open({ name: "b", profile: "work", url: ${q(site.url("/signup"))} }); 0`);

    expect(await browserIdOf(runtime, "chat-1", "work")).toBe(first);
    expect(await urlsOf(runtime, first)).toEqual([site.url("/page2"), site.url("/signup")].sort());
  }, BROWSER_TEST_TIMEOUT_MS);

  test("opens that start together: two for one profile share its browser, and a throwaway opened beside them is a browser of its own", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `
      await Promise.all([
        browser.open({ name: "a", profile: "work", url: ${q(site.url("/page2"))} }),
        browser.open({ name: "b", profile: "work", url: ${q(site.url("/signup"))} }),
        browser.open({ name: "t", url: ${q(site.url("/opener"))} }),
      ]);
      0`);

    const profileBrowser = await browserIdOf(runtime, "chat-1", "work");
    const throwaways = await runtime.openBrowsers("chat-1");
    expect(await urlsOf(runtime, profileBrowser)).toEqual([site.url("/page2"), site.url("/signup")].sort());
    expect(throwaways).toHaveLength(1);
    expect(throwaways[0]?.browserId).not.toBe(profileBrowser);
    expect(await urlsOf(runtime, throwaways[0]?.browserId ?? "")).toEqual([site.url("/opener")]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a profile combined with another browser (app.cdp_url, app.path, app.relay) is refused before any browser opens, and is not mistaken for a missing consent", async () => {
    const { host, runtime } = await start();
    for (const app of ['{ cdp_url: "http://127.0.0.1:9" }', "{ path: process.execPath }", "{ relay: true }"]) {
      const refused = await failureOf(host, "chat-1", `await browser.open({ name: "x", profile: "work", app: ${app} })`);
      expect(refused.message).not.toContain("code_needs_consent");
      expect(await runtime.profileList("chat-1")).toEqual([]);
      expect(await runtime.openBrowsers("chat-1")).toEqual([]);
    }
  }, BROWSER_TEST_TIMEOUT_MS);
});
