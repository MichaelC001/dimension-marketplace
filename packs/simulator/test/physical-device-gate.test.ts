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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceInfo } from "../src/contracts";
import { deviceLine } from "../src/server";
import { emulatorDevice, FakeBackend, node, PHONE_SERIAL, phoneDevice, snapshot } from "./fake-backend";
import { type Answer, connectServer, type McpSession, type ServerFolder, serverFolder } from "./mcp-session";

let folder: ServerFolder;
const open: McpSession[] = [];

let sdk: string;

beforeAll(() => {
  folder = serverFolder();
  sdk = mkdtempSync(join(tmpdir(), "sim-sdk-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const [dir, name] of [["platform-tools", "adb"], ["emulator", "emulator"]] as const) {
    mkdirSync(join(sdk, dir), { recursive: true });
    writeFileSync(join(sdk, dir, `${name}${suffix}`), "");
  }
});

afterAll(() => {
  folder.dispose();
  rmSync(sdk, { recursive: true, force: true });
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

describe("deviceLine", () => {
  test("a phone's serial is masked to its last four characters unless it is revealed, and an emulator's never is", () => {
    const masked = deviceLine(phoneDevice());
    expect(masked).toContain(`****${PHONE_SERIAL.slice(-4)}`);
    expect(masked).not.toContain(PHONE_SERIAL);
    expect(deviceLine(phoneDevice(), true)).toContain(PHONE_SERIAL);
    expect(deviceLine(emulatorDevice("emulator-5554", "Pixel_8"))).toContain("emulator-5554");
  });

  test("a phone adb gave no model for is named by its masked serial, not the full one", () => {
    const line = deviceLine(phoneDevice({ name: PHONE_SERIAL }));
    expect(line).not.toContain(PHONE_SERIAL);
    expect(line).toContain(`****${PHONE_SERIAL.slice(-4)}`);
  });
});

describe("what the pack shows of, and does to, a phone while a key is missing", () => {
  async function connectListing(backend: FakeBackend, allowPhysical: boolean): Promise<McpSession> {
    const session = await connectServer(folder, backend, { allowPhysical, sdkPath: sdk });
    open.push(session);
    return session;
  }

  const combos: { name: string; setting: boolean; call: boolean | undefined; unlocked: boolean }[] = [
    { name: "both keys off", setting: false, call: undefined, unlocked: false },
    { name: "the call asks and the setting is off", setting: false, call: true, unlocked: false },
    { name: "the setting is on and the call does not ask", setting: true, call: undefined, unlocked: false },
    { name: "both keys on", setting: true, call: true, unlocked: true },
  ];
  for (const combo of combos) {
    for (const tool of ["device_list", "device_open"]) {
      test(`${tool}, ${combo.name}: ${combo.unlocked ? "the phone's full serial is shown and the phone is read" : "the serial is masked and the phone is not read"}`, async () => {
        const backend = world(phoneDevice());
        const session = await connectListing(backend, combo.setting);
        const answer = await session.call(tool, combo.call === undefined ? {} : { allowPhysical: combo.call });
        expect(answer.isError).toBe(false);
        expect(answer.text.includes(PHONE_SERIAL)).toBe(combo.unlocked);
        expect(answer.text.includes(`****${PHONE_SERIAL.slice(-4)}`)).toBe(!combo.unlocked);
        expect(backend.probed).toEqual(combo.unlocked ? [`list ${PHONE_SERIAL}`] : []);
        expect(answer.structured).toBeUndefined();
      });
    }
  }

  const naming: { name: string; setting: boolean; call: boolean; probed: boolean }[] = [
    { name: "the call asks and the setting is off", setting: false, call: true, probed: false },
    { name: "the setting is on and the call does not ask", setting: true, call: false, probed: false },
    { name: "both keys on", setting: true, call: true, probed: true },
  ];
  for (const row of naming) {
    test(`a call that names the phone, ${row.name}: ${row.probed ? "its properties are read, and the call goes through" : "refused, and nothing is run on it to find out what it is"}`, async () => {
      const backend = world(phoneDevice());
      const session = await connectListing(backend, row.setting);
      const answer = await session.call("device_key", { serial: PHONE_SERIAL, key: "home", allowPhysical: row.call });
      expect(answer.isError).toBe(!row.probed);
      expect(backend.probed).toEqual(row.probed ? [`kindOf ${PHONE_SERIAL}`] : []);
    });
  }
});
