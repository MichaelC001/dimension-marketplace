/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pane puts the person's own
 *  phone in front of them as a device to drive. The View lists EMULATORS only,
 *  unless the person turned "Show physical devices" on AND the
 *  simulator.allowPhysical setting is on, and even then a phone is shown only
 *  when they picked it: never as "the first device".
 */
import { describe, expect, test } from "bun:test";
import { deriveScreen, type ListState, pickerOptions, type Selection, usableDevices } from "../src/view/view-model";
import { emulatorDevice, PHONE_SERIAL, phoneDevice } from "./fake-backend";

const NOTHING_PICKED: Selection = { serial: null, booting: null, notes: [] };

function list(devices: ListState["devices"], allowPhysical: boolean, avds: ListState["avds"] = []): ListState {
  return { devices, avds, toolchain: { adb: "/sdk/platform-tools/adb", emulator: "/sdk/emulator/emulator", scrcpyServer: "/tools/scrcpy-server", missing: [] }, live: true, allowPhysical };
}

describe("which devices the pane may offer", () => {
  const devices = [phoneDevice(), emulatorDevice("emulator-5554", "Pixel_8")];
  const rows = [
    { showPhysical: false, allowPhysical: false, listed: ["emulator-5554"] },
    { showPhysical: true, allowPhysical: false, listed: ["emulator-5554"] },
    { showPhysical: false, allowPhysical: true, listed: ["emulator-5554"] },
    { showPhysical: true, allowPhysical: true, listed: [PHONE_SERIAL, "emulator-5554"] },
  ];
  for (const row of rows) {
    test(`Show physical devices ${row.showPhysical ? "on" : "off"}, setting ${row.allowPhysical ? "on" : "off"}: ${row.listed.length === 1 ? "emulators only" : "the phone too"}`, () => {
      const usable = usableDevices(list(devices, row.allowPhysical), row.showPhysical);
      expect(usable.map(device => device.serial).sort()).toEqual([...row.listed].sort());
    });
  }

  test("an emulator adb calls offline is one still starting: shown. An offline or unauthorized phone is not", () => {
    const offline = [emulatorDevice("emulator-5554", "Pixel_8", { state: "offline" }), phoneDevice({ state: "offline" }), phoneDevice({ serial: "ZX1", state: "unauthorized" })];
    expect(usableDevices(list(offline, true), true).map(device => device.serial)).toEqual(["emulator-5554"]);
  });
});

describe("which screen the pane shows", () => {
  test("a phone that is the only device is not 'the first device': the pane shows no device and says a phone is attached but not offered", () => {
    const screen = deriveScreen(list([phoneDevice()], false), NOTHING_PICKED, null, false);
    expect(screen).toMatchObject({ kind: "no-device", hiddenPhones: 1, listedPhones: 0 });
  });

  test("with both switches on, a phone is offered in the picker but still not chosen for the person", () => {
    const screen = deriveScreen(list([phoneDevice()], true), NOTHING_PICKED, null, true);
    expect(screen).toMatchObject({ kind: "no-device", hiddenPhones: 0, listedPhones: 1 });
  });

  test("a phone the person picked, with both switches on, is shown", () => {
    const screen = deriveScreen(list([phoneDevice()], true), { ...NOTHING_PICKED, serial: PHONE_SERIAL }, null, true);
    expect(screen).toMatchObject({ kind: "device", device: { serial: PHONE_SERIAL } });
  });

  test("a phone picked earlier is dropped as soon as either switch goes off", () => {
    const picked = { ...NOTHING_PICKED, serial: PHONE_SERIAL };
    expect(deriveScreen(list([phoneDevice()], false), picked, null, true).kind).toBe("no-device");
    expect(deriveScreen(list([phoneDevice()], true), picked, null, false).kind).toBe("no-device");
  });

  test("beside an emulator, the default device is the emulator, even with a phone listed first", () => {
    const screen = deriveScreen(list([phoneDevice(), emulatorDevice("emulator-5554", "Pixel_8")], true), NOTHING_PICKED, null, true);
    expect(screen).toMatchObject({ kind: "device", device: { serial: "emulator-5554" } });
  });

  test("a device that is still starting is a boot, not an empty pane", () => {
    const screen = deriveScreen(list([emulatorDevice("emulator-5554", "Pixel_8", { state: "booting" })], false), NOTHING_PICKED, null, false);
    expect(screen).toMatchObject({ kind: "booting", avd: "Pixel_8" });
  });

  test("a boot the person started from the pane carries what the boot said about itself", () => {
    const screen = deriveScreen(list([], false), { serial: null, booting: "Pixel_8", notes: ["Fell back to software graphics"] }, null, false);
    expect(screen).toEqual({ kind: "booting", avd: "Pixel_8", notes: ["Fell back to software graphics"] });
  });

  test("no adb is its own screen, ahead of everything else", () => {
    const noAdb: ListState = { ...list([emulatorDevice("emulator-5554", "Pixel_8")], false), toolchain: { adb: null, emulator: null, scrcpyServer: null, missing: [{ tool: "adb", needed: "everything", fix: "Install platform-tools." }] } };
    expect(deriveScreen(noAdb, NOTHING_PICKED, null, false)).toMatchObject({ kind: "missing-adb" });
  });
});

describe("the device picker", () => {
  const devices = [emulatorDevice("emulator-5554", "Pixel_8"), phoneDevice()];
  const avds = [
    { name: "Pixel_8", running: true },
    { name: "Pixel_6", running: false },
  ];

  test("with the phone hidden, the picker offers running emulators, then AVDs to boot", () => {
    const options = pickerOptions(list(devices, false, avds), false);
    expect(options.map(option => [option.group, option.value])).toEqual([
      ["running", "serial:emulator-5554"],
      ["boot", "avd:Pixel_6"],
    ]);
  });

  test("with both switches on, the phone is listed between them, marked as a physical device", () => {
    const options = pickerOptions(list(devices, true, avds), true);
    expect(options.map(option => option.group)).toEqual(["running", "physical", "boot"]);
    expect(options[1]?.label).toContain("physical device");
    expect(options[1]?.value).toBe(`serial:${PHONE_SERIAL}`);
  });

  test("no AVD is offered for booting when the emulator binary is missing", () => {
    const noEmulator: ListState = { ...list(devices, false, avds), toolchain: { adb: "/sdk/adb", emulator: null, scrcpyServer: null, missing: [] } };
    expect(pickerOptions(noEmulator, false).map(option => option.group)).toEqual(["running"]);
  });
});
