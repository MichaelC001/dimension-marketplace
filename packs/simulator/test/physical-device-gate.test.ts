/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent asked to use an
 *  EMULATOR drives the owner's real phone. In a live run it did exactly that:
 *  the only adb device was the owner's USB phone (QGL78HORAISCWGVS, IV2201),
 *  the serial may be left out, and nothing asked who the device was. These tests
 *  call the real MCP tools through a real MCP client against an in-memory
 *  device world, and assert on what the devices were asked to DO.
 *
 *  The contract: a physical device is never auto-selected; every tool that
 *  reads or drives a device refuses a physical one unless the call passes
 *  allowPhysical: true AND the user's simulator.allowPhysical setting is on; and
 *  the refusal names both.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { DeviceInfo } from "../src/contracts";
import { emulatorDevice, FakeBackend, node, PHONE_SERIAL, phoneDevice, snapshot } from "./fake-backend";
import { type Answer, connectServer, type McpSession, type ServerFolder, serverFolder } from "./mcp-session";

let folder: ServerFolder;
const open: McpSession[] = [];

beforeAll(() => {
  folder = serverFolder();
});

afterAll(() => {
  folder.dispose();
});

afterEach(async () => {
  for (const session of open.splice(0)) await session.close();
});

async function connect(backend: FakeBackend, allowPhysical: boolean): Promise<McpSession> {
  const session = await connectServer(folder, backend, { allowPhysical });
  open.push(session);
  return session;
}

function world(...devices: DeviceInfo[]): FakeBackend {
  const backend = new FakeBackend();
  backend.devices = devices;
  backend.screens = [snapshot([node({ index: 1, text: "Save", clickable: true, cls: "android.widget.Button", bounds: { left: 100, top: 1000, right: 980, bottom: 1160 } })])];
  return backend;
}

/** The tools that read or drive a device, with arguments that would work on one. `acted` is what the backend sees when the call goes through. */
const DRIVING: { name: string; tool: string; args: Record<string, unknown>; acted: RegExp }[] = [
  { name: "screenshot", tool: "device_screenshot", args: {}, acted: /^screenshot / },
  { name: "tap at a point", tool: "device_tap", args: { x: 10, y: 20 }, acted: /^tap / },
  { name: "tap by label", tool: "device_tap", args: { label: "Save" }, acted: /^tap / },
  { name: "swipe", tool: "device_swipe", args: { x1: 1, y1: 2, x2: 3, y2: 4 }, acted: /^swipe / },
  { name: "type", tool: "device_type", args: { text: "hello" }, acted: /^text / },
  { name: "key", tool: "device_key", args: { key: "home" }, acted: /^key / },
  { name: "open url", tool: "device_open_url", args: { url: "https://example.com/" }, acted: /^openUrl / },
  { name: "install", tool: "device_install", args: { apk: "/tmp/app.apk" }, acted: /^install / },
  { name: "launch", tool: "device_launch", args: { package: "com.example.app" }, acted: /^launch / },
  { name: "ui tree", tool: "device_ui_tree", args: {}, acted: /^uiTree / },
];

/** Tools that also name a device but never drive one through a successful call here. */
const OTHER: { name: string; tool: string }[] = [
  { name: "stop", tool: "device_stop" },
  { name: "open the pane", tool: "device_open" },
  { name: "mint a stream", tool: "device_stream" },
];

function expectRefusalNamesBothKeys(answer: Answer): void {
  expect(answer.isError).toBe(true);
  expect(answer.text).toContain(PHONE_SERIAL);
  expect(answer.text).toContain("allowPhysical: true");
  expect(answer.text).toContain("simulator.allowPhysical");
}

describe("a physical phone, named by serial", () => {
  for (const tool of [...DRIVING, ...OTHER.map(other => ({ ...other, args: {}, acted: /^$/ }))]) {
    test(`${tool.name}: refused when the call allows it but the user's setting is off`, async () => {
      const backend = world(phoneDevice());
      const session = await connect(backend, false);
      const answer = await session.call(tool.tool, { ...tool.args, serial: PHONE_SERIAL, allowPhysical: true });
      expectRefusalNamesBothKeys(answer);
      expect(backend.acts).toEqual([]);
      expect(backend.stops).toEqual([]);
    });

    test(`${tool.name}: refused when the user's setting is on but the call does not allow it`, async () => {
      const backend = world(phoneDevice());
      const session = await connect(backend, true);
      const answer = await session.call(tool.tool, { ...tool.args, serial: PHONE_SERIAL });
      expectRefusalNamesBothKeys(answer);
      expect(backend.acts).toEqual([]);
      expect(backend.stops).toEqual([]);
    });
  }

  for (const tool of DRIVING) {
    test(`${tool.name}: goes through only with both keys, and then acts on that phone`, async () => {
      const backend = world(phoneDevice());
      const session = await connect(backend, true);
      const answer = await session.call(tool.tool, { ...tool.args, serial: PHONE_SERIAL, allowPhysical: true });
      expect(answer.isError).toBe(false);
      const acted = backend.acts.filter(act => tool.acted.test(act));
      expect(acted).toHaveLength(1);
      expect(acted[0]).toContain(PHONE_SERIAL);
    });
  }

  test("stop: even with both keys the pack stops no phone: it did not boot it", async () => {
    const backend = world(phoneDevice());
    const session = await connect(backend, true);
    const answer = await session.call("device_stop", { serial: PHONE_SERIAL, allowPhysical: true });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("was not booted by this pack");
    expect(backend.stops).toEqual([]);
  });

  test("open the pane: with both keys it opens on that phone", async () => {
    const session = await connect(world(phoneDevice()), true);
    const answer = await session.call("device_open", { serial: PHONE_SERIAL, allowPhysical: true });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain(`The simulator pane is open on ${PHONE_SERIAL}.`);
  });

  test("a serial that is not attached is reported as not connected, not driven", async () => {
    const backend = world(emulatorDevice("emulator-5554", "Pixel_8"));
    const session = await connect(backend, true);
    const answer = await session.call("device_tap", { serial: PHONE_SERIAL, x: 1, y: 1, allowPhysical: true });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("not connected");
    expect(backend.acts).toEqual([]);
  });
});

describe("a call that leaves serial out", () => {
  for (const tool of DRIVING) {
    test(`${tool.name}: the owner's phone as the ONLY device is not picked, even with both keys given`, async () => {
      const backend = world(phoneDevice());
      const session = await connect(backend, true);
      const answer = await session.call(tool.tool, { ...tool.args, allowPhysical: true });
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain("no emulator is running");
      expect(answer.text).toContain(`****${PHONE_SERIAL.slice(-4)}`);
      expect(answer.text).not.toContain(PHONE_SERIAL);
      expect(answer.text).toContain("never picked for you");
      expect(backend.acts).toEqual([]);
    });

    test(`${tool.name}: with an emulator beside the phone it is the emulator that is driven, and only it`, async () => {
      const backend = world(phoneDevice(), emulatorDevice("emulator-5554", "Pixel_8"));
      const session = await connect(backend, true);
      const answer = await session.call(tool.tool, { ...tool.args });
      expect(answer.isError).toBe(false);
      expect(backend.acts.length).toBeGreaterThan(0);
      for (const act of backend.acts) {
        expect(act).toContain("emulator-5554");
        expect(act).not.toContain(PHONE_SERIAL);
      }
    });
  }

  test("two emulators and no serial: the model is asked to choose, and nothing is driven", async () => {
    const backend = world(emulatorDevice("emulator-5554", "Pixel_8"), emulatorDevice("emulator-5556", "Pixel_6"));
    const session = await connect(backend, false);
    const answer = await session.call("device_key", { key: "home" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("several emulators are running; pass serial");
    expect(backend.acts).toEqual([]);
  });

  test("the pane does not select the phone either: it opens with no device chosen", async () => {
    const session = await connect(world(phoneDevice()), true);
    const answer = await session.call("device_open", {});
    expect(answer.isError).toBe(false);
    expect(answer.text.startsWith("The simulator pane is open; no device is selected.")).toBe(true);
  });
});
