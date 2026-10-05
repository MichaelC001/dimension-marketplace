/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack kills a process that
 *  is not the emulator it started. A pid is only a name until its start time
 *  agrees (Windows reuses them fast), the emulator is a process TREE (the
 *  launcher idles, the qemu child holds the console port and the CPU), and the
 *  pack once stopped the SERIAL emulator-5554 which was the person's own. These
 *  are the questions that decide "is that pid ours", "how busy is our tree" and
 *  "which console port is ours", plus the parsers that feed them.
 */
import { describe, expect, test } from "bun:test";
import {
  type Listener,
  parseCpuTime,
  parseLsof,
  parseNetstat,
  parsePsProcesses,
  parseSs,
  parseWindowsProcesses,
  type ProcessRow,
  processTree,
  processVerdict,
  START_TOLERANCE_MS,
  treePorts,
  treeUsage,
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
