/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack resumes (or fails to
 *  resume) the wrong process. On the owner's Windows PC the emulator's qemu
 *  process was SUSPENDED by the system (every thread `Wait, Suspended`, ~0.3 s
 *  of CPU, no adb device); the pack mistook it for a hung GPU, killed it, and the
 *  relaunch froze too. Resuming a process is the one thing here that touches a
 *  process the pack did not just kill, so the questions that decide it are pinned
 *  hard: is every thread stopped (and are there enough threads to say so), which
 *  process under the launcher is the emulating one, and is it STILL the process
 *  that was looked at when the resume is sent. The host's thread listings are
 *  parsed here too. All of it is a pure function of plain rows and text.
 */
import { describe, expect, test } from "bun:test";
import { emulatorProcess, parsePsThreadStates, parseThreadCounts, type ProcessRow, stillInTree, suspendedVerdict } from "../src/android/process-table";

function row(pid: number, ppid: number, startedAtMs: number, rssBytes = 0): ProcessRow {
  return { pid, ppid, startedAtMs, cpuSeconds: 0, rssBytes };
}

const T0 = 1_800_000_000_000;

describe("suspendedVerdict: is this process frozen by the system", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly sample: { total: number; suspended: number } | null; readonly verdict: "suspended" | "running" | "unknown" }> = [
    { name: "every one of the emulator's threads is stopped", sample: { total: 18, suspended: 18 }, verdict: "suspended" },
    { name: "one live thread among many is a process that can still run: not frozen", sample: { total: 18, suspended: 17 }, verdict: "running" },
    { name: "no thread stopped is a running process", sample: { total: 18, suspended: 0 }, verdict: "running" },
    { name: "two threads are enough to say so (the smallest process that can be told from an idle one)", sample: { total: 2, suspended: 2 }, verdict: "suspended" },
    { name: "one thread waiting proves nothing: a tiny idle process looks the same", sample: { total: 1, suspended: 1 }, verdict: "unknown" },
    { name: "no threads at all is no reading", sample: { total: 0, suspended: 0 }, verdict: "unknown" },
    { name: "more stopped threads than threads is a bad reading, never a reason to touch a process", sample: { total: 5, suspended: 7 }, verdict: "unknown" },
    { name: "a host that could not read the threads says nothing", sample: null, verdict: "unknown" },
  ];
  for (const { name, sample, verdict } of cases) {
    test(name, () => {
      expect(suspendedVerdict(sample)).toBe(verdict);
    });
  }
});

describe("emulatorProcess: which process under the launcher does the emulating", () => {
  test("the qemu child that holds the memory, not the launcher that idles", () => {
    const rows = [row(10, 1, T0, 20_000_000), row(11, 10, T0 + 300, 900_000_000)];
    expect(emulatorProcess(rows, 10)?.pid).toBe(11);
  });

  test("the biggest descendant when the launcher has several, however deep", () => {
    const rows = [row(10, 1, T0, 20_000_000), row(11, 10, T0 + 100, 5_000_000), row(12, 10, T0 + 200, 40_000_000), row(13, 12, T0 + 300, 900_000_000)];
    expect(emulatorProcess(rows, 10)?.pid).toBe(13);
  });

  test("the launcher itself when nothing runs under it (yet, or where the launcher became qemu)", () => {
    expect(emulatorProcess([row(10, 1, T0, 20_000_000)], 10)?.pid).toBe(10);
  });

  test("null when the launcher is not running", () => {
    expect(emulatorProcess([row(99, 1, T0, 1_000_000_000)], 10)).toBeNull();
  });

  test("never a bigger process that is not under the launcher: the person's own emulator is not the pack's to resume", () => {
    const rows = [row(10, 1, T0, 20_000_000), row(11, 10, T0 + 300, 900_000_000), row(50, 1, T0 - 3_600_000, 4_000_000_000), row(51, 50, T0 - 3_600_000, 3_000_000_000)];
    expect(emulatorProcess(rows, 10)?.pid).toBe(11);
  });

  test("never a process that merely names the launcher's reused pid as its parent and started BEFORE the launcher", () => {
    const rows = [row(10, 1, T0, 20_000_000), row(11, 10, T0 + 300, 100_000_000), row(12, 10, T0 - 60_000, 900_000_000)];
    expect(emulatorProcess(rows, 10)?.pid).toBe(11);
  });
});

describe("stillInTree: is it the process that was looked at", () => {
  const looked = row(11, 10, T0 + 300, 900_000_000);
  const launcher = row(10, 1, T0);

  test("yes: the same pid, started when it started, under the launcher", () => {
    expect(stillInTree([launcher, looked], 10, looked)).toBe(true);
  });

  test("no: the pid is running but started later: a successor took the number", () => {
    expect(stillInTree([launcher, row(11, 10, T0 + 301, 900_000_000)], 10, looked)).toBe(false);
  });

  test("no: the same pid and start, but no longer under the launcher", () => {
    expect(stillInTree([launcher, row(11, 1, T0 + 300, 900_000_000)], 10, looked)).toBe(false);
  });

  test("no: the process is gone", () => {
    expect(stillInTree([launcher], 10, looked)).toBe(false);
  });

  test("no: the launcher is gone, whatever else runs", () => {
    expect(stillInTree([looked], 10, looked)).toBe(false);
  });
});

describe("the host's thread listings", () => {
  test("Windows: the `total|suspended` line, however the shell wraps it", () => {
    expect(parseThreadCounts("18|18\r\n")).toEqual({ total: 18, suspended: 18 });
    expect(parseThreadCounts("  22|0  \n")).toEqual({ total: 22, suspended: 0 });
  });

  test("Windows: noise before the counts is skipped, and noise that only CONTAINS counts is not a reading", () => {
    expect(parseThreadCounts("WARNING: something\r\n\r\n18|3\r\n")).toEqual({ total: 18, suspended: 3 });
    expect(parseThreadCounts("note: 18|3 threads\n")).toBeNull();
  });

  test("Windows: a script that failed prints no counts, and that is null, not zero", () => {
    expect(parseThreadCounts("Get-Process : Cannot find a process with the process identifier 4242.\r\n")).toBeNull();
    expect(parseThreadCounts("")).toBeNull();
    expect(parseThreadCounts("18|x\n")).toBeNull();
  });

  test("Linux (`ps -L -o stat=`): a thread is stopped when its state begins with T", () => {
    expect(parsePsThreadStates("Tl\nTl\nT\n")).toEqual({ total: 3, suspended: 3 });
    expect(parsePsThreadStates("Sl\nTl\nSl\nRl\n")).toEqual({ total: 4, suspended: 1 });
  });

  test("Linux: a debugger's stop (lowercase t) is not one SIGCONT undoes, so it is not counted as frozen", () => {
    expect(parsePsThreadStates("tl\ntl\n")).toEqual({ total: 2, suspended: 0 });
  });

  test("Linux: blank lines are not threads; no output is no reading", () => {
    expect(parsePsThreadStates("\nSl\n\nSl\n  \n")).toEqual({ total: 2, suspended: 0 });
    expect(parsePsThreadStates("")).toBeNull();
    expect(parsePsThreadStates("\n \n")).toBeNull();
  });

  test("macOS and BSD print ONE line for the whole process: even a stopped one is never called frozen, so nothing is resumed there", () => {
    expect(suspendedVerdict(parsePsThreadStates("T\n"))).toBe("unknown");
  });
});
