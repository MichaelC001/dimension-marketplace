/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a relaunch after the pack killed
 *  a stalled emulator fails for a reason nobody can see. In the live run the pack
 *  relaunched within a second of the kill; the AVD's lock
 *  (`<avd>.avd/hardware-qemu.ini.lock/pid`) still named the just-killed process,
 *  and the new emulator exited with code 253 and printed nothing. These are the
 *  questions that decide "may the AVD be launched again" (is anything of the
 *  killed tree still running, does the lock name a process that is) and "was
 *  this exit the lost race for that lock, or a failure the emulator explained".
 *  A wrong yes launches into the race; a wrong no waits for a dead pid or
 *  retries a real failure.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { avdLockHolder, isLockRaceExit, LAUNCH_MARKER, LOCK_EXIT_CODE, LOCK_EXIT_WINDOW_MS, lastLaunchOutput, relaunchBlockers } from "../src/android/emulator-boot";
import { type ProcessRow, treeSurvivors } from "../src/android/process-table";

function row(pid: number, ppid: number, startedAtMs: number): ProcessRow {
  return { pid, ppid, startedAtMs, cpuSeconds: 0, rssBytes: 0 };
}

const T0 = 1_800_000_000_000;
const AVD_DIR = join("avd-home", "Pixel_8.avd");
const LOCK_PID_FILE = join(AVD_DIR, "hardware-qemu.ini.lock", "pid");

describe("avdLockHolder: the pid the emulator wrote into the AVD's lock", () => {
  const holding = (text: string | null) => (path: string) => (path === LOCK_PID_FILE ? text : null);

  test("reads hardware-qemu.ini.lock/pid of THIS AVD, as the decimal the emulator wrote", () => {
    expect(avdLockHolder(AVD_DIR, holding("4242"))).toBe(4242);
  });

  test("tolerates the whitespace a file may carry", () => {
    expect(avdLockHolder(AVD_DIR, holding(" 4242\r\n"))).toBe(4242);
  });

  test("null when there is no lock", () => {
    expect(avdLockHolder(AVD_DIR, holding(null))).toBeNull();
  });

  test("null for anything that is not a pid: an empty file, text, zero, a negative, two numbers, a number with a tail", () => {
    for (const text of ["", "\n", "emulator", "0", "-5", "12 34", "4242abc", "4242.5"]) {
      expect(avdLockHolder(AVD_DIR, holding(text))).toBeNull();
    }
  });

  test("a lock in another AVD's folder is not this AVD's", () => {
    expect(avdLockHolder(join("avd-home", "Other.avd"), holding("4242"))).toBeNull();
  });
});

describe("relaunchBlockers: what still stops the AVD being launched again", () => {
  // The killed tree: the launcher and the qemu child under it.
  const killed = [row(10, 1, T0), row(11, 10, T0 + 300)];

  test("nothing: the tree is gone and the lock names nothing", () => {
    expect(relaunchBlockers([row(99, 1, T0 - 5_000)], killed, null)).toEqual([]);
  });

  test("a member of the killed tree that still runs", () => {
    expect(relaunchBlockers([row(11, 1, T0 + 300), row(99, 1, T0 - 5_000)], killed, null)).toEqual([11]);
  });

  test("a pid of the killed tree that a NEW process has taken is somebody else's, not a blocker", () => {
    expect(relaunchBlockers([row(11, 1, T0 + 60_000)], killed, null)).toEqual([]);
  });

  test("the process the lock names, even outside the killed tree, while it runs", () => {
    expect(relaunchBlockers([row(77, 1, T0 - 600_000)], killed, 77)).toEqual([77]);
  });

  test("a lock that names a process that has died blocks nothing: the file outlives its holder", () => {
    expect(relaunchBlockers([row(99, 1, T0 - 5_000)], killed, 11)).toEqual([]);
  });

  test("a lock holder that is also a survivor of the killed tree is listed once", () => {
    expect(relaunchBlockers([row(11, 1, T0 + 300)], killed, 11)).toEqual([11]);
  });

  test("the survivors and a different lock holder are both named", () => {
    expect(relaunchBlockers([row(10, 1, T0), row(77, 1, T0)], killed, 77)).toEqual([10, 77]);
  });
});

describe("treeSurvivors: members of a killed tree that run", () => {
  test("only a pid whose start time is the member's own", () => {
    const killed = [row(10, 1, T0), row(11, 10, T0 + 300), row(12, 11, T0 + 400)];
    const now = [row(10, 1, T0), row(11, 10, T0 + 301), row(99, 1, T0)];
    expect(treeSurvivors(now, killed)).toEqual([10]);
  });
});

describe("isLockRaceExit: the lost race for the AVD's lock, not a failure the emulator explained", () => {
  /** The emulator log as the pack writes it: a marker line per launch, then what that launch printed. */
  const log = (...launches: string[]): string => launches.map(output => `\n--- 2026-10-06T10:00:00.000Z ${LAUNCH_MARKER} emulator -avd Pixel_8\n${output}`).join("");
  const quick = { code: LOCK_EXIT_CODE, elapsedMs: 400 };

  test("code 253 right after the spawn with nothing FATAL in what the launch printed", () => {
    expect(isLockRaceExit(quick, log(""))).toBe(true);
    expect(isLockRaceExit(quick, log("INFO    | starting\nINFO    | Storing crashdata in: C:\\crash\n"))).toBe(true);
  });

  test("the window ends at LOCK_EXIT_WINDOW_MS: just inside is the race, at it is a boot that got further", () => {
    expect(isLockRaceExit({ code: LOCK_EXIT_CODE, elapsedMs: LOCK_EXIT_WINDOW_MS - 1 }, log(""))).toBe(true);
    expect(isLockRaceExit({ code: LOCK_EXIT_CODE, elapsedMs: LOCK_EXIT_WINDOW_MS }, log(""))).toBe(false);
  });

  test("code 253 WITH a FATAL line: the emulator named its reason, which is reported, never retried", () => {
    expect(isLockRaceExit(quick, log("FATAL   | Running multiple emulators with the same AVD is an experimental feature.\n"))).toBe(false);
  });

  test("a FATAL from an EARLIER launch in the appended log is not this launch's", () => {
    expect(isLockRaceExit(quick, log("FATAL   | an older failure\n", ""))).toBe(true);
    expect(isLockRaceExit(quick, log("", "FATAL   | this launch's own\n"))).toBe(false);
  });

  test("a log that cannot be read does not make a 253 a failure of its own", () => {
    expect(isLockRaceExit(quick, null)).toBe(true);
  });

  test("any other exit is not the race: another code, or no code (killed, or never started)", () => {
    expect(isLockRaceExit({ code: 1, elapsedMs: 400 }, log(""))).toBe(false);
    expect(isLockRaceExit({ code: 0, elapsedMs: 400 }, log(""))).toBe(false);
    expect(isLockRaceExit({ code: null, elapsedMs: 400 }, log(""))).toBe(false);
  });
});

describe("lastLaunchOutput", () => {
  test("is what follows the LAST launch marker", () => {
    const text = `old output\n${LAUNCH_MARKER} emulator -avd A\nfirst launch\n${LAUNCH_MARKER} emulator -avd A\nsecond launch\n`;
    expect(lastLaunchOutput(text)).toBe(" emulator -avd A\nsecond launch\n");
  });

  test("is the whole text when the log has no marker (a log from before the pack wrote them)", () => {
    expect(lastLaunchOutput("just output\n")).toBe("just output\n");
  });
});
