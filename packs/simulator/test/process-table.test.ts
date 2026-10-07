/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack kills a process that
 *  is not the emulator it started. A pid is only a name until its start time
 *  agrees (Windows reuses them fast), the emulator is a process TREE (the
 *  launcher idles, the qemu child holds the console port and the CPU), and the
 *  pack once stopped the SERIAL emulator-5554 which was the person's own. These
 *  are the questions that decide "is that pid ours", "how busy is our tree" and
 *  "which console port is ours", plus the parsers that feed them.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import {
  isSignalablePid,
  type Listener,
  nodeProcessTable,
  parseCpuTime,
  parseLsof,
  parseNetstat,
  parsePsProcesses,
  parseSs,
  parseWindowsProcesses,
  type ProcessRow,
  type ProcessTable,
  processTree,
  processVerdict,
  START_TOLERANCE_MS,
  treePorts,
  treeUsage,
  verifiedKillPlan,
  windowsToolPath,
} from "../src/android/process-table";

function row(pid: number, ppid: number, startedAtMs: number, cpuSeconds = 0, rssBytes = 0): ProcessRow {
  return { pid, ppid, startedAtMs, cpuSeconds, rssBytes };
}

const T0 = 1_800_000_000_000;

describe("processTree", () => {
  test("is the root and everything below it, however deep, and nothing beside it", () => {
    const rows = [row(10, 1, T0), row(11, 10, T0 + 5), row(12, 11, T0 + 9), row(20, 1, T0), row(21, 20, T0 + 1)];
    expect(processTree(rows, 10).map(item => item.pid)).toEqual([10, 11, 12]);
  });

  test("is empty when the root is not running", () => {
    expect(processTree([row(20, 1, T0)], 10)).toEqual([]);
  });

  test("a row that names the root as parent but started BEFORE it is a reused parent id, not a child", () => {
    // Windows never rewrites a dead parent's id: this process only claims pid 10 because pid 10 was reused.
    const rows = [row(10, 1, T0 + 1_000), row(11, 10, T0 + 2_000), row(12, 10, T0 - 60_000)];
    expect(processTree(rows, 10).map(item => item.pid)).toEqual([10, 11]);
  });

  test("terminates on a cycle of parent ids", () => {
    const rows = [row(10, 11, T0), row(11, 10, T0 + 1)];
    expect(processTree(rows, 10).map(item => item.pid)).toEqual([10, 11]);
  });
});

describe("verifiedKillPlan: what a Windows kill may end", () => {
  const verifiedRows = [row(4242, 1, T0)];

  test("is the tree the fresh table shows, children before their parents and the root last, and nobody else", () => {
    const fresh = [
      row(4242, 1, T0),
      row(4243, 4242, T0 + 5),
      row(4244, 4243, T0 + 9),
      row(4245, 4242, T0 + 6),
      row(5000, 4242, T0 - 60_000),
      row(5001, 4243, T0 + 2),
      row(6000, 1, T0 + 1),
    ];
    const plan = verifiedKillPlan(fresh, verifiedRows, 4242);
    expect(plan.kill.map(item => item.pid)).toEqual([4244, 4245, 4243, 4242]);
    expect(plan.skipped).toEqual([]);
  });

  test("is nothing when the root has already gone", () => {
    expect(verifiedKillPlan([row(6000, 1, T0)], verifiedRows, 4242)).toEqual({ kill: [], skipped: [] });
  });

  test("refuses the whole tree when the pid now belongs to a process that started at another time than the one verified", () => {
    const plan = verifiedKillPlan([row(4242, 1, T0 + 60_000), row(4243, 4242, T0 + 60_005)], verifiedRows, 4242);
    expect(plan.kill).toEqual([]);
    expect(plan.skipped.map(item => item.pid)).toEqual([4242]);
  });

  test("refuses the whole tree when the table it was verified in does not show the root", () => {
    const plan = verifiedKillPlan([row(4242, 1, T0), row(4243, 4242, T0 + 5)], [row(9, 1, T0)], 4242);
    expect(plan.kill).toEqual([]);
    expect(plan.skipped.map(item => item.pid)).toEqual([4242]);
  });

  test("leaves out a member that is the pack itself and still ends the rest", () => {
    const plan = verifiedKillPlan([row(4242, 1, T0), row(process.pid, 4242, T0 + 5), row(4243, 4242, T0 + 6)], verifiedRows, 4242);
    expect(plan.kill.map(item => item.pid)).toEqual([4243, 4242]);
    expect(plan.skipped.map(item => item.pid)).toEqual([process.pid]);
  });
});

describe("treeUsage", () => {
  test("sums the whole tree: the idle launcher plus the qemu child that burns the CPU", () => {
    const rows = [row(10, 1, T0, 0.4, 20_000_000), row(11, 10, T0 + 5, 12.5, 900_000_000), row(99, 1, T0, 1_000, 1_000_000_000)];
    expect(treeUsage(rows, 10)).toEqual({ pids: [10, 11], cpuSeconds: 12.9, rssBytes: 920_000_000 });
  });

  test("is null when the root is gone", () => {
    expect(treeUsage([row(99, 1, T0)], 10)).toBeNull();
  });
});

describe("treePorts", () => {
  const rows = [row(10, 1, T0), row(11, 10, T0 + 5), row(50, 1, T0)];
  const listeners: Listener[] = [
    { pid: 11, port: 5556 },
    { pid: 11, port: 5557 },
    { pid: 11, port: 5556 },
    // The person's own emulator, in another tree.
    { pid: 50, port: 5554 },
  ];

  test("is the ports the tree listens on, once each, and never another tree's", () => {
    expect(treePorts(rows, listeners, 10)).toEqual([5556, 5557]);
  });

  test("is null when the host cannot list listeners: 'unknown' is not 'none'", () => {
    expect(treePorts(rows, null, 10)).toBeNull();
  });

  test("is empty when the tree is gone", () => {
    expect(treePorts(rows, listeners, 777)).toEqual([]);
  });
});

describe("processVerdict: may this remembered pid be killed", () => {
  const remembered = { pid: 4242, startedAt: T0 };

  test("ours: running and started when the pack spawned it", () => {
    expect(processVerdict([row(4242, 1, T0 + 300)], remembered)).toBe("ours");
  });

  test("ours across the two clocks' disagreement, to the tolerance and not a millisecond past it", () => {
    expect(processVerdict([row(4242, 1, T0 + START_TOLERANCE_MS)], remembered)).toBe("ours");
    expect(processVerdict([row(4242, 1, T0 - START_TOLERANCE_MS)], remembered)).toBe("ours");
    expect(processVerdict([row(4242, 1, T0 + START_TOLERANCE_MS + 1)], remembered)).toBe("reused");
  });

  test("reused: the pid is running, but it started hours later: it is somebody else's process now", () => {
    expect(processVerdict([row(4242, 1, T0 + 3 * 3_600_000)], remembered)).toBe("reused");
  });

  test("gone: no such pid", () => {
    expect(processVerdict([row(1, 0, T0)], remembered)).toBe("gone");
  });

  test("unknown when the table could not be read: nothing can be shown, so nothing is done", () => {
    expect(processVerdict(null, remembered)).toBe("unknown");
  });

  test("a caller's tolerance replaces the default", () => {
    expect(processVerdict([row(4242, 1, T0 + 100)], remembered, 10)).toBe("reused");
  });
});

describe("host process listings", () => {
  test("Windows (CIM): pid, parent, start time to the millisecond with the offset applied, CPU from 100 ns ticks", () => {
    const text = [
      "4242|1000|2026-10-01T18:48:41.6052390+05:30|12000000|8000000|104857600",
      "77|4242|2026-10-01T13:18:42.0000000Z|5000000|0|2048",
      // The idle process has no creation time.
      "0|0||0|0|8192",
      "not a row",
      "x|1|2026-10-01T13:18:42.0000000Z|1|1|1",
    ].join("\r\n");
    expect(parseWindowsProcesses(text)).toEqual([
      { pid: 4242, ppid: 1000, startedAtMs: Date.UTC(2026, 9, 1, 13, 18, 41, 605), cpuSeconds: 2, rssBytes: 104_857_600 },
      { pid: 77, ppid: 4242, startedAtMs: Date.UTC(2026, 9, 1, 13, 18, 42, 0), cpuSeconds: 0.5, rssBytes: 2048 },
    ]);
  });

  test("ps CPU time in each of its formats", () => {
    expect(parseCpuTime("00:00:01")).toBe(1);
    expect(parseCpuTime("01:02:03")).toBe(3723);
    expect(parseCpuTime("45")).toBe(45);
    expect(parseCpuTime("12:34.56")).toBeCloseTo(754.56, 5);
    expect(parseCpuTime("1-02:03:04")).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
  });

  test("ps: local start time, CPU time, RSS in KiB; headers and junk are skipped", () => {
    const text = ["  PID  PPID  STARTED", "  123     1 Tue Oct  6 00:03:12 2026 00:00:01  12345", " 9001   123 Tue Oct  6 00:03:13 2026 1-02:03:04  2048", "garbage"].join("\n");
    expect(parsePsProcesses(text)).toEqual([
      { pid: 123, ppid: 1, startedAtMs: new Date(2026, 9, 6, 0, 3, 12).getTime(), cpuSeconds: 1, rssBytes: 12_345 * 1024 },
      { pid: 9001, ppid: 123, startedAtMs: new Date(2026, 9, 6, 0, 3, 13).getTime(), cpuSeconds: 93_784, rssBytes: 2048 * 1024 },
    ]);
  });

  test("netstat (Windows): only LISTENING TCP rows, IPv4 and IPv6", () => {
    const text = [
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1132",
      "  TCP    127.0.0.1:5554         0.0.0.0:0              LISTENING       20444",
      "  TCP    127.0.0.1:50234        127.0.0.1:5037         ESTABLISHED     9988",
      "  TCP    [::]:5037              [::]:0                 LISTENING       9988",
      "  UDP    0.0.0.0:5353           *:*                                    1500",
    ].join("\r\n");
    expect(parseNetstat(text)).toEqual([
      { pid: 1132, port: 135 },
      { pid: 20_444, port: 5554 },
      { pid: 9988, port: 5037 },
    ]);
  });

  test("lsof -Fpn: every n line belongs to the p line above it", () => {
    const text = ["p1234", "f14", "n127.0.0.1:5554", "n*:5555", "p77", "n[::1]:5037"].join("\n");
    expect(parseLsof(text)).toEqual([
      { pid: 1234, port: 5554 },
      { pid: 1234, port: 5555 },
      { pid: 77, port: 5037 },
    ]);
  });

  test("ss: one listener per owning pid, and none for a socket whose owner is hidden", () => {
    const text = [
      'LISTEN 0      1          127.0.0.1:5554       0.0.0.0:*    users:(("qemu-system-x86",pid=1234,fd=14))',
      'LISTEN 0      4096       127.0.0.1:5037       0.0.0.0:*    users:(("adb",pid=77,fd=8),("adb",pid=78,fd=9))',
      "LISTEN 0      128          0.0.0.0:22         0.0.0.0:*",
      'ESTAB  0      0          127.0.0.1:5037     127.0.0.1:41000  users:(("adb",pid=77,fd=10))',
    ].join("\n");
    expect(parseSs(text)).toEqual([
      { pid: 1234, port: 5554 },
      { pid: 77, port: 5037 },
      { pid: 78, port: 5037 },
    ]);
  });
});

describe("isSignalablePid: a pid the pack may ever signal", () => {
  const rows: { name: string; pid: number; signalable: boolean }[] = [
    { name: "a pid above 1", pid: 4242, signalable: true },
    { name: "the lowest pid above init", pid: 2, signalable: true },
    { name: "a Windows pid past the signed 32-bit range", pid: 3_000_000_000, signalable: true },
    { name: "zero", pid: 0, signalable: false },
    { name: "init", pid: 1, signalable: false },
    { name: "-1, which signals every process the user may", pid: -1, signalable: false },
    { name: "a negative pid, which names a process group", pid: -4242, signalable: false },
    { name: "a fractional pid", pid: 1.5, signalable: false },
    { name: "NaN", pid: Number.NaN, signalable: false },
    { name: "infinity", pid: Number.POSITIVE_INFINITY, signalable: false },
    { name: "an integer past 2**53, which is not exactly a number", pid: 2 ** 60, signalable: false },
    { name: "the pack's own pid", pid: process.pid, signalable: false },
    { name: "the pack's parent pid", pid: process.ppid, signalable: false },
  ];
  for (const row of rows) {
    test(`${row.name}: ${row.signalable ? "signalable" : "never"}`, () => {
      expect(isSignalablePid(row.pid)).toBe(row.signalable);
    });
  }
});

describe("the command line a listing keeps", () => {
  test("Windows (CIM): the whole command line, a pipe inside it included; a process with none has no command", () => {
    const text = [
      '4242|1000|2026-10-01T13:18:41.0000000Z|0|0|2048|"C:\\Program Files\\Sdk\\emulator\\emulator.exe" -avd Pixel_8 -append a|b',
      "77|4242|2026-10-01T13:18:42.0000000Z|0|0|2048|",
    ].join("\r\n");
    const [first, second] = parseWindowsProcesses(text);
    expect(first?.command).toBe('"C:\\Program Files\\Sdk\\emulator\\emulator.exe" -avd Pixel_8 -append a|b');
    expect(second?.pid).toBe(77);
    expect(second).not.toHaveProperty("command");
  });

  test("Windows (CIM): a command line is cut at 4096 characters", () => {
    const [only] = parseWindowsProcesses(`4242|1|2026-10-01T13:18:41.0000000Z|0|0|0|${"x".repeat(5000)}`);
    expect(only?.command).toHaveLength(4096);
  });

  test("ps -ww: the arguments after the columns, a path with spaces intact; a row with no arguments has no command", () => {
    const text = [
      "  123     1 Tue Oct  6 00:03:12 2026 00:00:01  12345 /home/me/My SDK/emulator/qemu-system-x86_64 -avd Pixel_8 -no-window  ",
      "  124     1 Tue Oct  6 00:03:13 2026 00:00:00      0",
    ].join("\n");
    const [first, second] = parsePsProcesses(text);
    expect(first?.command).toBe("/home/me/My SDK/emulator/qemu-system-x86_64 -avd Pixel_8 -no-window");
    expect(first?.rssBytes).toBe(12_345 * 1024);
    expect(second?.pid).toBe(124);
    expect(second).not.toHaveProperty("command");
  });
});

describe("windowsToolPath: the Windows helpers are never found by searching the working directory", () => {
  test("is an absolute path under SystemRoot", () => {
    expect(windowsToolPath("powershell", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(windowsToolPath("netstat", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\netstat.exe");
  });

  const fallbacks: { name: string; env: NodeJS.ProcessEnv; root: string }[] = [
    { name: "windir when SystemRoot is not set", env: { windir: "E:\\W" }, root: "E:\\W" },
    { name: "C:\\Windows when neither is set", env: {}, root: "C:\\Windows" },
    { name: "C:\\Windows when SystemRoot is relative, which would be searched from the working directory", env: { SystemRoot: "Windows" }, root: "C:\\Windows" },
    { name: "C:\\Windows when SystemRoot is empty", env: { SystemRoot: "", windir: "" }, root: "C:\\Windows" },
    { name: "windir when SystemRoot is relative", env: { SystemRoot: "..\\x", windir: "E:\\W" }, root: "E:\\W" },
  ];
  for (const fallback of fallbacks) {
    test(`uses ${fallback.name}`, () => {
      expect(windowsToolPath("netstat", fallback.env)).toBe(`${fallback.root}\\System32\\netstat.exe`);
    });
  }
});

const SIGNAL_FREE_PIDS: readonly number[] = [0, 1, -1, -4242, 1.5, Number.NaN, 2 ** 60, process.pid, process.ppid];

interface HostExec {
  readonly file: string;
  readonly args: readonly string[];
}

interface HostSignal {
  readonly pid: number;
  readonly signal: string | number | undefined;
}

function tableOn(platform: NodeJS.Platform, log: (message: string) => void = () => undefined, env?: NodeJS.ProcessEnv): ProcessTable {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return nodeProcessTable(log, env);
  } finally {
    if (real !== undefined) Object.defineProperty(process, "platform", real);
  }
}

describe("the host's table acts only on a pid it may signal", () => {
  const execs: HostExec[] = [];
  const signals: HostSignal[] = [];
  const spies: { mockRestore(): void }[] = [];
  let answer: (file: string, args: readonly string[]) => string | number = () => "";
  let refuseKill: (pid: number) => Error | null = () => null;

  beforeEach(() => {
    execs.length = 0;
    signals.length = 0;
    answer = () => "";
    refuseKill = () => null;
    spies.push(
      spyOn(childProcess, "execFile").mockImplementation(((file: string, args: readonly string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
        execs.push({ file, args });
        const reply = answer(file, args);
        const failed = typeof reply === "number" && reply !== 0;
        done(failed ? Object.assign(new Error(`exit ${reply}`), { code: reply }) : null, typeof reply === "string" ? reply : "");
        return {} as childProcess.ChildProcess;
      }) as never),
      spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        signals.push({ pid, signal });
        const refusal = refuseKill(pid);
        if (refusal !== null) throw refusal;
        return true;
      }) as never),
    );
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  for (const platform of ["win32", "linux"] as const) {
    test(`${platform}: killTree ends nothing for 0, 1, -1, a group, a fraction, NaN, an unsafe integer, the pack's own pid or its parent's`, async () => {
      const table = tableOn(platform);
      for (const pid of SIGNAL_FREE_PIDS) await table.killTree(pid, []);
      expect(execs).toEqual([]);
      expect(signals).toEqual([]);
    });

    test(`${platform}: threadStates reads nothing of such a pid`, async () => {
      const table = tableOn(platform);
      for (const pid of SIGNAL_FREE_PIDS) expect(await table.threadStates(pid)).toBeNull();
      expect(execs).toEqual([]);
      expect(signals).toEqual([]);
    });

    test(`${platform}: resume refuses such a pid, and a start time that is not an integer, and acts on neither`, async () => {
      const table = tableOn(platform);
      for (const pid of SIGNAL_FREE_PIDS) expect(await table.resume(pid, T0)).toBe(false);
      for (const startedAt of [Number.NaN, T0 + 0.5, 2 ** 60]) expect(await table.resume(4242, startedAt)).toBe(false);
      expect(execs).toEqual([]);
      expect(signals).toEqual([]);
    });
  }

  const cim = (rows: readonly ProcessRow[]): string => rows.map(item => `${item.pid}|${item.ppid}|${new Date(item.startedAtMs).toISOString()}|0|0|0|`).join("\r\n");
  const errno = (code: string): Error => Object.assign(new Error(`kill ${code}`), { code });
  const verifiedRows = [row(4242, 1, T0), row(4290, 4242, T0 + 3)];
  const freshRows = [row(4242, 1, T0), row(4243, 4242, T0 + 5), row(5000, 4242, T0 - 60_000), row(5001, 4243, T0 + 2), row(6000, 1, T0 + 1)];

  test("win32: a verified pid is ended with the tree the table shows right before the kill: children first, the root last, each by its pid, nothing else", async () => {
    answer = () => cim(freshRows);
    await tableOn("win32").killTree(4242, verifiedRows);
    expect(signals).toEqual([
      { pid: 4243, signal: "SIGKILL" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
    expect(execs).toHaveLength(1);
    expect(execs[0]?.file).toEndWith("powershell.exe");
  });

  test("win32: a pid that now belongs to a process started at another time than the one verified is not ended, nor is anything under it, and the refusal is reported", async () => {
    const notes: string[] = [];
    answer = () => cim([row(4242, 1, T0 + 60_000), row(4243, 4242, T0 + 60_005)]);
    await tableOn("win32", note => notes.push(note)).killTree(4242, verifiedRows);
    expect(signals).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("4242");
  });

  test("win32: a table that cannot be read again ends nothing and says so", async () => {
    const notes: string[] = [];
    answer = () => 1;
    await tableOn("win32", note => notes.push(note)).killTree(4242, verifiedRows);
    expect(signals).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("4242");
  });

  test("win32: a member that exited while the tree was being ended does not fail the kill, is not reported, and the rest are still ended", async () => {
    const notes: string[] = [];
    answer = () => cim(freshRows);
    refuseKill = pid => (pid === 4243 ? errno("ESRCH") : null);
    await tableOn("win32", note => notes.push(note)).killTree(4242, verifiedRows);
    expect(signals.map(sent => sent.pid)).toEqual([4243, 4242]);
    expect(notes).toEqual([]);
  });

  test("win32: a member the system refuses is reported and the rest are still ended", async () => {
    const notes: string[] = [];
    answer = () => cim(freshRows);
    refuseKill = pid => (pid === 4243 ? errno("EPERM") : null);
    await tableOn("win32", note => notes.push(note)).killTree(4242, verifiedRows);
    expect(signals.map(sent => sent.pid)).toEqual([4243, 4242]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("4243");
  });

  test("win32: every helper the table runs is an absolute path under SystemRoot", async () => {
    answer = () => cim([row(4242, 1, T0)]);
    const table = tableOn("win32", () => undefined, { SystemRoot: "D:\\Win" });
    await table.processes();
    await table.listeners();
    await table.threadStates(4242);
    await table.resume(4242, T0);
    await table.killTree(4242, [row(4242, 1, T0)]);
    const powershell = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(execs.map(run => run.file)).toEqual([powershell, "D:\\Win\\System32\\netstat.exe", powershell, powershell, powershell]);
  });

  test("linux: a verified pid is killed as its process group and with the children listed under it, and a listed child that is init or the pack itself is skipped", async () => {
    const row = (pid: number, ppid: number, startedAtMs: number): ProcessRow => ({ pid, ppid, startedAtMs, cpuSeconds: 0, rssBytes: 0 });
    const rows = [row(4242, 1, T0), row(4243, 4242, T0 + 5), row(1, 4242, T0 + 6), row(process.pid, 4242, T0 + 7)];
    await tableOn("linux").killTree(4242, rows);
    expect(signals.every(sent => sent.signal === "SIGKILL")).toBe(true);
    expect(signals.map(sent => sent.pid).sort((a, b) => a - b)).toEqual([-4242, 4242, 4243]);
    expect(execs).toEqual([]);
  });

  test("win32: a verified pid's threads are read from the host", async () => {
    answer = () => "12|3\r\n";
    expect(await tableOn("win32").threadStates(4242)).toEqual({ total: 12, suspended: 3 });
  });

  test("linux: a verified pid is resumed with SIGCONT", async () => {
    expect(await tableOn("linux").resume(4242, T0)).toBe(true);
    expect(signals).toEqual([{ pid: 4242, signal: "SIGCONT" }]);
  });

  const resumeExits: { name: string; code: number; resumed: boolean; noted: boolean }[] = [
    { name: "exit 0: the system accepted the resume", code: 0, resumed: true, noted: false },
    { name: "exit 1: the system refused it", code: 1, resumed: false, noted: false },
    { name: "exit 2: the process could not be opened", code: 2, resumed: false, noted: false },
    { name: "exit 3: the process there started at another time, so it is somebody else's now", code: 3, resumed: false, noted: true },
  ];
  for (const row of resumeExits) {
    test(`win32 resume, ${row.name}`, async () => {
      const notes: string[] = [];
      answer = () => row.code;
      expect(await tableOn("win32", note => notes.push(note)).resume(4242, T0)).toBe(row.resumed);
      expect(notes).toHaveLength(row.noted ? 1 : 0);
      if (row.noted) expect(notes[0]).toContain("4242");
    });
  }

  test("win32: the script the host runs names the pid and the start time it must find there", async () => {
    await tableOn("win32").resume(4242, T0);
    const script = Buffer.from(execs[0]?.args.at(-1) ?? "", "base64").toString("utf16le");
    expect(script).toContain(`Resume(4242, ${T0},`);
  });
});
