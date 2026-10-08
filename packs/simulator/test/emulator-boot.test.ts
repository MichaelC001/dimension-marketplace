/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the emulator does not start
 *  (the pack once passed `-qemu -lowram` and the emulator answered
 *  "qemu-system-x86_64.exe: -lowram: invalid option"), or a hung boot is never
 *  noticed (with `-gpu auto` the qemu process sat at 0.6 s of CPU for 80+ s with
 *  no adb device), or the pack mistakes somebody else's emulator for the one it
 *  just started and later stops it.
 */
import { describe, expect, test } from "bun:test";
import { GPU_MODES } from "../src/settings";
import {
  type AdbEntry,
  BAKED_SNAPSHOT,
  type BootSample,
  bootFailureMessage,
  bootStalled,
  buildEmulatorArgs,
  consolePortOf,
  type EmulatorArgsInput,
  emulatorLaunchVerdict,
  freshEmulators,
  lastLines,
  parseAvdName,
  pickSerial,
  STALL_POLICY,
} from "../src/android/emulator-boot";

/** The value that follows `flag`, or undefined when the flag is absent. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

const base: EmulatorArgsInput = { avd: "Pixel_8", headless: false, cold: false, bakedSnapshot: false, gpu: "auto" };

describe("buildEmulatorArgs", () => {
  test("-lowram is the emulator's own flag: never behind -qemu", () => {
    const args = buildEmulatorArgs(base);
    expect(args).toContain("-lowram");
    expect(args).not.toContain("-qemu");
  });

  test("no flag forces a console port, so the pack can never collide with an emulator the person runs", () => {
    const args = buildEmulatorArgs({ ...base, headless: true, cold: true, readOnly: true });
    for (const flag of ["-port", "-ports"]) expect(args).not.toContain(flag);
  });

  test("the AVD is named, and -memory takes an explicit size", () => {
    const args = buildEmulatorArgs({ ...base, avd: "Medium_Phone_API_36", memoryMb: 2048 });
    expect(valueOf(args, "-avd")).toBe("Medium_Phone_API_36");
    expect(valueOf(args, "-memory")).toBe("2048");
  });

  test("headless is -no-window; a windowed boot has no such flag", () => {
    expect(buildEmulatorArgs({ ...base, headless: true })).toContain("-no-window");
    expect(buildEmulatorArgs({ ...base, headless: false })).not.toContain("-no-window");
  });

  test("-read-only appears only when it was asked for", () => {
    expect(buildEmulatorArgs({ ...base, readOnly: true })).toContain("-read-only");
    expect(buildEmulatorArgs({ ...base, readOnly: false })).not.toContain("-read-only");
    expect(buildEmulatorArgs(base)).not.toContain("-read-only");
  });

  test("a cold boot loads no snapshot, even when the AVD has the baked one", () => {
    const args = buildEmulatorArgs({ ...base, cold: true, bakedSnapshot: true });
    expect(args).toContain("-no-snapshot-load");
    expect(args).not.toContain("-snapshot");
  });

  test("a warm boot starts from the baked snapshot when the AVD has one, and from the default otherwise", () => {
    expect(valueOf(buildEmulatorArgs({ ...base, bakedSnapshot: true }), "-snapshot")).toBe(BAKED_SNAPSHOT);
    const plain = buildEmulatorArgs(base);
    expect(plain).not.toContain("-snapshot");
    expect(plain).not.toContain("-no-snapshot-load");
  });

  test("nothing is saved on the way out: stopping an emulator kills it", () => {
    expect(buildEmulatorArgs(base)).toContain("-no-snapshot-save");
  });

  test("every combination carries -gpu with exactly the mode asked for, once, and never -qemu or -port", () => {
    for (const gpu of GPU_MODES) {
      for (const headless of [false, true]) {
        for (const cold of [false, true]) {
          for (const bakedSnapshot of [false, true]) {
            for (const readOnly of [undefined, false, true]) {
              const args = buildEmulatorArgs({ avd: "A", headless, cold, bakedSnapshot, gpu, ...(readOnly === undefined ? {} : { readOnly }) });
              const label = JSON.stringify({ gpu, headless, cold, bakedSnapshot, readOnly });
              expect({ label, gpu: valueOf(args, "-gpu") }).toEqual({ label, gpu });
              expect({ label, gpuFlags: args.filter(arg => arg === "-gpu").length }).toEqual({ label, gpuFlags: 1 });
              expect({ label, qemu: args.includes("-qemu"), port: args.includes("-port") }).toEqual({ label, qemu: false, port: false });
              expect({ label, lowram: args.includes("-lowram") }).toEqual({ label, lowram: true });
            }
          }
        }
      }
    }
  });
});

describe("bootStalled", () => {
  const stalled: BootSample = { elapsedMs: STALL_POLICY.afterMs, alive: true, deviceSeen: false, cpuSeconds: 0.6 };
  const rows: { name: string; sample: BootSample; verdict: boolean }[] = [
    { name: "the incident as measured: 80 s with no device and 0.6 s of CPU is stalled", sample: { elapsedMs: 80_000, alive: true, deviceSeen: false, cpuSeconds: 0.6 }, verdict: true },
    { name: "a healthy boot of the same AVD at 80 s (10 s of CPU, device not yet listed) is not", sample: { elapsedMs: 80_000, alive: true, deviceSeen: false, cpuSeconds: 10 }, verdict: false },
    { name: "stalled at exactly the policy's age and CPU just under its limit", sample: stalled, verdict: true },
    { name: "a hung boot a good deal older", sample: { ...stalled, elapsedMs: 200_000 }, verdict: true },
    { name: "one millisecond before the stall age is still waiting", sample: { ...stalled, elapsedMs: STALL_POLICY.afterMs - 1 }, verdict: false },
    { name: "a busy slow boot (12 s of CPU) is slow, not hung", sample: { ...stalled, cpuSeconds: 12 }, verdict: false },
    { name: "CPU exactly at the limit is not stalled", sample: { ...stalled, cpuSeconds: STALL_POLICY.maxCpuSeconds }, verdict: false },
    { name: "just under the CPU limit is stalled", sample: { ...stalled, cpuSeconds: STALL_POLICY.maxCpuSeconds - 0.001 }, verdict: true },
    { name: "a device has appeared: not stalled however idle it is", sample: { ...stalled, deviceSeen: true }, verdict: false },
    { name: "a process that already exited is not a stall to kill", sample: { ...stalled, alive: false }, verdict: false },
    { name: "a CPU reading that could not be taken is never a reason to kill", sample: { ...stalled, cpuSeconds: null }, verdict: false },
  ];
  for (const row of rows) {
    test(row.name, () => {
      expect(bootStalled(row.sample)).toBe(row.verdict);
    });
  }

  test("a caller's own policy replaces the measured one", () => {
    const sample: BootSample = { elapsedMs: 40, alive: true, deviceSeen: false, cpuSeconds: 0.1 };
    expect(bootStalled(sample)).toBe(false);
    expect(bootStalled(sample, { afterMs: 30, maxCpuSeconds: 1 })).toBe(true);
  });
});

describe("which adb serial is the pack's own", () => {
  const person: AdbEntry = { serial: "emulator-5554", state: "device" };
  const ours: AdbEntry = { serial: "emulator-5556", state: "device" };

  test("the console port is read from emulator-<port> and from nothing else", () => {
    expect(consolePortOf("emulator-5556")).toBe(5556);
    expect(consolePortOf("QGL78HORAISCWGVS")).toBeNull();
    expect(consolePortOf("192.168.1.20:5555")).toBeNull();
    expect(consolePortOf("emulator-")).toBeNull();
    expect(consolePortOf("emulator-5554x")).toBeNull();
  });

  test("the process tree decides: the emulator it listens for is ours, not the person's older one", () => {
    expect(pickSerial({ before: [person], after: [person, ours], treePorts: [5556, 5557] })).toEqual({ serial: "emulator-5556", basis: "process" });
  });

  test("a newcomer the tree does not listen for is not ours, even when it is the only one to appear", () => {
    expect(pickSerial({ before: [], after: [ours], treePorts: [] })).toBeNull();
    expect(pickSerial({ before: [person], after: [person, ours], treePorts: [41234] })).toBeNull();
  });

  test("a phone is never picked, whatever ports the tree holds", () => {
    expect(pickSerial({ before: [], after: [{ serial: "QGL78HORAISCWGVS", state: "device" }], treePorts: [5555] })).toBeNull();
  });

  test("with no listener list, the one emulator that appeared since the spawn is the candidate", () => {
    expect(pickSerial({ before: [person], after: [person, ours], treePorts: null })).toEqual({ serial: "emulator-5556", basis: "diff" });
  });

  test("with no listener list and two newcomers it is not yet: a guess would later stop somebody else's device", () => {
    const other: AdbEntry = { serial: "emulator-5558", state: "device" };
    expect(pickSerial({ before: [person], after: [person, ours, other], treePorts: null })).toBeNull();
  });

  test("a stale offline entry whose port the new emulator took counts as new; an unchanged one does not", () => {
    const stale: AdbEntry = { serial: "emulator-5556", state: "offline" };
    expect(freshEmulators([stale], [{ serial: "emulator-5556", state: "device" }])).toEqual(["emulator-5556"]);
    expect(freshEmulators([stale], [stale])).toEqual([]);
    expect(freshEmulators([person], [person, { serial: "QGL78HORAISCWGVS", state: "device" }])).toEqual([]);
  });
});

describe("the emulator console and the failure report", () => {
  const answers: { name: string; output: string; avd: string | null }[] = [
    { name: "the name, then OK", output: "Pixel_8\r\nOK\r\n", avd: "Pixel_8" },
    { name: "past the console banner", output: "Android Console: Authentication required\nPixel_8\nOK\n", avd: "Pixel_8" },
    { name: "a refused console is not a name", output: "KO: unknown command\r\n", avd: null },
    { name: "an empty answer", output: "OK\r\n", avd: null },
  ];
  for (const row of answers) {
    test(`emu avd name: ${row.name}`, () => {
      expect(parseAvdName(row.output)).toBe(row.avd);
    });
  }

  test("lastLines drops trailing blank lines before it counts", () => {
    expect(lastLines("a\nb\nc\n\n  \n", 2)).toEqual(["b", "c"]);
  });

  test("a failure ends with the emulator's own words, and explains the one case the user can act on", () => {
    const log = "INFO | starting\nERROR | Running multiple emulators with the same AVD is an experimental feature.\nERROR | exiting\n";
    const message = bootFailureMessage("the emulator exited.", { path: "/logs/Pixel_8.log", text: log }, 2);
    expect(message).toContain("the emulator exited.");
    expect(message).toContain("readOnly: true");
    expect(message).toContain("Last 2 lines of the emulator log (/logs/Pixel_8.log):\nERROR | Running multiple emulators");
    expect(message).not.toContain("INFO | starting");
  });

  test("an unreadable log is said to be unreadable, without a hint nobody earned", () => {
    const message = bootFailureMessage("the emulator exited.", { path: "/logs/x.log", text: null });
    expect(message).toContain("empty or could not be read");
    expect(message).not.toContain("readOnly");
  });
});

describe("emulatorLaunchVerdict: is this process the emulator launch of that AVD", () => {
  const AVD = "Pixel_8";
  const rows: { name: string; command: string | undefined; verdict: "launch" | "other" | "unknown" }[] = [
    { name: "a quoted Windows path with spaces", command: '"C:\\Program Files\\Android\\Sdk\\emulator\\emulator.exe" -avd Pixel_8 -no-snapshot', verdict: "launch" },
    { name: "an unquoted unix path with spaces", command: "/home/me/My Android SDK/emulator/emulator -avd Pixel_8 -gpu host", verdict: "launch" },
    { name: "the qemu child by its Windows path", command: "C:\\Sdk\\emulator\\qemu-system-x86_64.exe -avd Pixel_8 -memory 2048", verdict: "launch" },
    { name: "the AVD named as @Pixel_8", command: "/opt/sdk/emulator/emulator @Pixel_8", verdict: "launch" },
    { name: "a launcher by an architecture or headless name, in any case", command: "C:\\Sdk\\emulator\\EMULATOR-HEADLESS.EXE -avd Pixel_8", verdict: "launch" },
    { name: "another AVD whose name merely starts with this one", command: "/opt/sdk/emulator/emulator -avd Pixel_8_Pro", verdict: "other" },
    { name: "another AVD named with @, whose name merely starts with this one", command: "/opt/sdk/emulator/emulator @Pixel_8_Pro", verdict: "other" },
    { name: "this AVD's name as the value of some other flag", command: "/opt/sdk/emulator/emulator -avd Other -timezone Pixel_8", verdict: "other" },
    { name: "-avd with no value", command: "/opt/sdk/emulator/emulator -avd", verdict: "other" },
    { name: "emulator-manager, which is not an emulator", command: "C:\\Sdk\\emulator\\emulator-manager.exe -avd Pixel_8", verdict: "other" },
    { name: "a shell whose arguments happen to spell the emulator's command line", command: "bash -c emulator -avd Pixel_8", verdict: "other" },
    { name: "another program handed the emulator's flags", command: "C:\\Windows\\notepad.exe -avd Pixel_8", verdict: "other" },
    { name: "no command line at all", command: undefined, verdict: "unknown" },
  ];
  for (const row of rows) {
    test(`${row.name}: ${row.verdict}`, () => {
      const process = { pid: 4242, ppid: 1, startedAtMs: 0, cpuSeconds: 0, rssBytes: 0, ...(row.command === undefined ? {} : { command: row.command }) };
      expect(emulatorLaunchVerdict(process, AVD)).toBe(row.verdict);
    });
  }
});
