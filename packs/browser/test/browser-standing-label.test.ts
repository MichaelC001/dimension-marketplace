import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { BrowserStanding } from "../src/code/contracts";
import { RuntimeCodeBrowsers, type CodeSeam, type CodeSeamEntry } from "../src/code/host/runtime-port";
import type { CmuxBrowsers } from "../src/code/kinds/cmux/cmux-browsers";
import { createBrowserServer } from "../src/server";
import { newRig, type Rig } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, type Fixture, startFixture, teardown } from "./fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const q = JSON.stringify;

interface Who {
  caller: "model" | "app";
  session: string;
}
const PERSON_IN_A: Who = { caller: "app", session: "chat-a" };
const CHAT_A: Who = { caller: "model", session: "chat-a" };
const CHAT_B: Who = { caller: "model", session: "chat-b" };

const Answer = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string().optional() }).passthrough()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
type Answer = z.infer<typeof Answer>;

interface Wired extends Rig {
  fixture: Fixture;
  call(name: string, args: Record<string, unknown>, who: Who): Promise<Answer>;
}

const rigs: Rig[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const rig of rigs.splice(0)) await rig.host.dispose();
  await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function wire(o: Parameters<typeof newRig>[1] = {}): Promise<Wired> {
  const rootDir = await createRoot();
  const rig = newRig(rootDir, o);
  rigs.push(rig);
  const viewDir = join(rootDir, "view");
  await mkdir(viewDir, { recursive: true });
  await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const server = await createBrowserServer({ runtime: rig.runtime, codeHost: rig.host, viewDir, presets: [], modelTools: "code" });
  const client = new Client({ name: "browser-standing-label-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return {
    ...rig,
    fixture: startFixture(),
    call: async (name, args, who) => Answer.parse(await client.callTool({ name, arguments: args, _meta: { [CALLER]: who.caller, [SESSION]: { sessionId: who.session } } })),
  };
}

const textOf = (answer: Answer): string => answer.content.map(block => block.text ?? "").join("\n");

const browserIdOf = (answer: Answer): string => {
  const browserId = answer.structuredContent?.browserId;
  if (answer.isError || typeof browserId !== "string") throw new Error(`expected a browser, got: ${textOf(answer)}`);
  return browserId;
};

const TAB_LINE = /^(Opened|Reused) tab /;

const told = async (wired: Wired, who: Who, code: string): Promise<string> => {
  const answer = await wired.call("browser_run", { code }, who);
  if (answer.isError) throw new Error(`the cell failed: ${textOf(answer)}`);
  const line = textOf(answer).split("\n").find(candidate => TAB_LINE.test(candidate));
  if (line === undefined) throw new Error(`the cell told nothing of a tab: ${textOf(answer)}`);
  return line;
};

const refused = async (wired: Wired, who: Who, code: string): Promise<string> => {
  const answer = await wired.call("browser_run", { code }, who);
  if (!answer.isError) throw new Error(`the cell was expected to fail, it said: ${textOf(answer)}`);
  return textOf(answer);
};

const throwawayOf = async (wired: Wired, session: string): Promise<string> => {
  const held = await wired.runtime.openBrowsers(session);
  const only = held[0];
  if (held.length !== 1 || only === undefined) throw new Error(`expected one throwaway for ${session}, found ${held.length}`);
  return only.browserId;
};

const PANEL = 'the Browser panel the person is watching (profile "default")';
const OFF_SCREEN = (profile: string): string => `a saved-profile browser that is not on screen (profile ${q(profile)}; browser_view shows it in the Browser panel)`;

describeWithChrome("a cell is told whether the person can see the browser it opened", () => {
  test("a chat whose person watches the saved profile in the Browser panel is told its tab is on that panel, when it opens and when it reuses the tab", async () => {
    const wired = await wire();
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));
    wired.runtime.viewing(panel);

    expect(await told(wired, CHAT_A, `await browser.open({ url: ${q(wired.fixture.url("/page2"))} }); 0`)).toBe(`Opened tab "main" on ${PANEL}`);
    expect(await told(wired, CHAT_A, `await browser.open({ name: "main" }); 0`)).toBe(`Reused tab "main" on ${PANEL}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("the words follow the panel: closed, the next reuse says the profile is not on screen, and watched again it says the panel once more", async () => {
    const wired = await wire();
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));
    const leave = wired.runtime.viewing(panel);
    expect(await told(wired, CHAT_A, `await browser.open({ url: ${q(wired.fixture.url("/page2"))} }); 0`)).toBe(`Opened tab "main" on ${PANEL}`);

    leave();
    expect(await told(wired, CHAT_A, `await browser.open({ name: "main" }); 0`)).toBe(`Reused tab "main" on ${OFF_SCREEN("default")}`);

    wired.runtime.viewing(panel);
    expect(await told(wired, CHAT_A, `await browser.open({ name: "main" }); 0`)).toBe(`Reused tab "main" on ${PANEL}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a saved profile the person opened but nobody has joined a View to is not called hidden", async () => {
    const wired = await wire();
    await wired.call("browser_open", { profile: "default" }, PERSON_IN_A);

    expect(await told(wired, CHAT_A, `await browser.open({ url: ${q(wired.fixture.url("/page2"))} }); 0`)).toBe(`Opened tab "main" on ${OFF_SCREEN("default")}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a saved profile the chat names itself is not on screen even while the person watches another profile in the same chat", async () => {
    const wired = await wire();
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));
    wired.runtime.viewing(panel);

    expect(await told(wired, CHAT_A, `await browser.open({ url: ${q(wired.fixture.url("/page2"))} }); 0`)).toBe(`Opened tab "main" on ${PANEL}`);
    expect(await told(wired, CHAT_A, `await browser.open({ name: "w", profile: "work", url: ${q(wired.fixture.url("/signup"))} }); 0`)).toBe(`Opened tab "w" on ${OFF_SCREEN("work")}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a throwaway the cell made is hidden until a View joins it, and then it is the panel the person is watching, a private browser", async () => {
    const wired = await wire();
    expect(await told(wired, CHAT_A, `await browser.open({ url: ${q(wired.fixture.url("/page2"))} }); 0`)).toBe('Opened tab "main" on headless browser (hidden)');
    expect(await told(wired, CHAT_A, `await browser.open({ name: "main" }); 0`)).toBe('Reused tab "main" on headless browser (hidden)');

    const leave = wired.runtime.viewing(await throwawayOf(wired, "chat-a"));
    expect(await told(wired, CHAT_A, `await browser.open({ name: "main" }); 0`)).toBe('Reused tab "main" on the Browser panel the person is watching (private browser)');
    expect(await told(wired, CHAT_A, `await browser.open({ name: "second", url: ${q(wired.fixture.url("/signup"))} }); 0`)).toBe('Opened tab "second" on the Browser panel the person is watching (private browser)');

    leave();
    expect(await told(wired, CHAT_A, `await browser.open({ name: "main" }); 0`)).toBe('Reused tab "main" on headless browser (hidden)');
  }, BROWSER_TEST_TIMEOUT_MS);

  test("another chat's cell is not told it is on the panel this chat's person watches: it has a throwaway of its own that nobody sees", async () => {
    const wired = await wire();
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));
    wired.runtime.viewing(panel);

    expect(await told(wired, CHAT_B, `await browser.open({ url: ${q(wired.fixture.url("/page2"))} }); 0`)).toBe('Opened tab "main" on headless browser (hidden)');
  }, BROWSER_TEST_TIMEOUT_MS);

  test("the refusal for a tab that is bound to a different browser names that browser the way the open did, as it stands when the cell asks", async () => {
    const wired = await wire({ host: { env: { ...process.env, DIMENSION_BROWSER_CODE_ALLOW_ATTACH: "1" } } });
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));
    const leave = wired.runtime.viewing(panel);
    await told(wired, CHAT_A, `await browser.open({ url: ${q(wired.fixture.url("/page2"))} }); 0`);
    const elsewhere = `await browser.open({ name: "main", app: { cdp_url: "http://127.0.0.1:9" } })`;

    expect(await refused(wired, CHAT_A, elsewhere)).toContain(`Tab "main" is bound to a different browser, ${PANEL}. Close it first.`);

    leave();
    expect(await refused(wired, CHAT_A, elsewhere)).toContain(`Tab "main" is bound to a different browser, ${OFF_SCREEN("default")}. Close it first.`);
  }, BROWSER_TEST_TIMEOUT_MS);
});

interface Held {
  profile: string | null;
  viewers: number;
}

function portOver(held: Record<string, Held>, shown: Record<string, string>, cmux?: CmuxBrowsers): RuntimeCodeBrowsers {
  const entry = (browserId: string | undefined): CodeSeamEntry | undefined => {
    const found = browserId === undefined ? undefined : held[browserId];
    return browserId === undefined || found === undefined ? undefined : ({ browserId, profile: found.profile, viewers: found.viewers } as unknown as CodeSeamEntry);
  };
  const seam = {
    peek: (browserId: string) => entry(browserId),
    shownTo: (session: string) => entry(shown[session]),
  } as unknown as CodeSeam;
  return new RuntimeCodeBrowsers(seam, cmux === undefined ? {} : { cmux });
}

test("standing: a browser is on the panel only while a View is joined to it and it is the browser this session is shown", () => {
  const held: Record<string, Held> = {
    saved: { profile: "default", viewers: 1 },
    unwatched: { profile: "default", viewers: 0 },
    throwaway: { profile: null, viewers: 2 },
    elsewhere: { profile: "work", viewers: 1 },
  };
  const cases: Array<{ name: string; session: string; browserId: string; shown: Record<string, string>; standing: BrowserStanding | undefined }> = [
    { name: "a saved profile shown to the session and watched", session: "chat-a", browserId: "saved", shown: { "chat-a": "saved" }, standing: { profile: "default", onPanel: true } },
    { name: "a throwaway shown to the session and watched", session: "chat-a", browserId: "throwaway", shown: { "chat-a": "throwaway" }, standing: { profile: null, onPanel: true } },
    { name: "shown to the session but no View is joined", session: "chat-a", browserId: "unwatched", shown: { "chat-a": "unwatched" }, standing: { profile: "default", onPanel: false } },
    { name: "watched, but shown to another session only", session: "chat-b", browserId: "saved", shown: { "chat-a": "saved" }, standing: { profile: "default", onPanel: false } },
    { name: "watched, but the session is shown a different browser", session: "chat-a", browserId: "elsewhere", shown: { "chat-a": "saved" }, standing: { profile: "work", onPanel: false } },
    { name: "watched, but the session is shown nothing", session: "chat-a", browserId: "saved", shown: {}, standing: { profile: "default", onPanel: false } },
    { name: "a browser that is gone", session: "chat-a", browserId: "closed", shown: { "chat-a": "saved" }, standing: undefined },
  ];

  for (const { name, session, browserId, shown, standing } of cases) expect(portOver(held, shown).standing(session, browserId), name).toEqual(standing);
});

test("standing: a cmux surface has none, even when a runtime entry carries its id and is watched", () => {
  const cmux = { owns: (browserId: string) => browserId === "surface", onEnd: () => () => undefined } as unknown as CmuxBrowsers;
  const port = portOver({ surface: { profile: "default", viewers: 1 } }, { "chat-a": "surface" }, cmux);

  expect(port.standing("chat-a", "surface")).toBeUndefined();
});
