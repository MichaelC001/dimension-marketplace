// The host's process and listener tables, and the pure questions asked of them.
//
// Why the pack needs them: the Android emulator is a process TREE (on Windows
// `emulator.exe` launches `qemu-system-x86_64.exe`; the qemu child is what holds the
// console port and burns the CPU), and a pid is only a name until its START TIME
// agrees. Three decisions rest on that and nothing else:
//
//   which serial is ours   the spawned tree listens on that serial's console port
//   is a boot stalled      the tree's CPU time (the launcher alone idles by design)
//   may this pid be killed it is the process the pack spawned: same pid, same start
//
// Everything with logic is a pure function of rows, so each is proved with plain
// arrays. `nodeProcessTable()` is the only part that touches the host.

import { execFile } from "node:child_process";

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** Epoch ms the OS says the process started. */
  readonly startedAtMs: number;
  /** User + kernel CPU time so far. */
  readonly cpuSeconds: number;
  readonly rssBytes: number;
}

export interface Listener {
  readonly pid: number;
  readonly port: number;
}

export interface ProcessTable {
  /** Every process. Rejects when the host cannot list them (the pack then refuses to act on a pid it cannot verify). */
  processes(): Promise<ProcessRow[]>;
  /** Every TCP listener with its owning pid; null when this host has no way to list them. */
  listeners(): Promise<Listener[] | null>;
  /** Kill `pid` and everything under it. `rows` (the table just read) names the children on hosts that do not kill a tree by themselves. */
  killTree(pid: number, rows: readonly ProcessRow[]): Promise<void>;
}

// ── pure questions ───────────────────────────────────────────────────────────

/** `root` and everything under it. A child cannot start before its parent: that drops rows whose parent id is a dead process's reused pid (Windows never rewrites it). Empty when `root` is not in the table. */
export function processTree(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const top = rows.find(row => row.pid === root);
  if (top === undefined) return [];
  const tree = [top];
  const seen = new Set([top.pid]);
  for (let index = 0; index < tree.length; index++) {
    const parent = tree[index];
    if (parent === undefined) break;
    for (const row of rows) {
      if (row.ppid !== parent.pid || seen.has(row.pid) || row.startedAtMs < parent.startedAtMs) continue;
      seen.add(row.pid);
      tree.push(row);
    }
  }
  return tree;
}

export interface TreeUsage {
  readonly pids: readonly number[];
  readonly cpuSeconds: number;
  readonly rssBytes: number;
}

/** CPU and memory of `root`'s whole tree; null when `root` is not running. */
export function treeUsage(rows: readonly ProcessRow[], root: number): TreeUsage | null {
  const tree = processTree(rows, root);
  if (tree.length === 0) return null;
  return { pids: tree.map(row => row.pid), cpuSeconds: tree.reduce((sum, row) => sum + row.cpuSeconds, 0), rssBytes: tree.reduce((sum, row) => sum + row.rssBytes, 0) };
}

/** The TCP ports `root`'s tree listens on; null when the host's listener list is unavailable. Empty when the tree is gone. */
export function treePorts(rows: readonly ProcessRow[], listeners: readonly Listener[] | null, root: number): number[] | null {
  if (listeners === null) return null;
  const pids = new Set(processTree(rows, root).map(row => row.pid));
  return [...new Set(listeners.filter(listener => pids.has(listener.pid)).map(listener => listener.port))];
}

/** What a pid the pack remembers is now. */
export type ProcessVerdict =
  /** Running, and it started when the pack spawned it. */
  | "ours"
  /** No such process. */
  | "gone"
  /** Running, but it started at another time: the pid now belongs to something else. Never touched. */
  | "reused"
  /** The host's table could not be read. Nothing can be shown, so nothing is done. */
  | "unknown";

/** Two clocks (the pack's wall clock at spawn, the OS's creation time) differ by scheduling and by `ps`'s whole seconds. */
export const START_TOLERANCE_MS = 5_000;

export function processVerdict(rows: readonly ProcessRow[] | null, remembered: { readonly pid: number; readonly startedAt: number }, toleranceMs = START_TOLERANCE_MS): ProcessVerdict {
  if (rows === null) return "unknown";
  const row = rows.find(candidate => candidate.pid === remembered.pid);
  if (row === undefined) return "gone";
  return Math.abs(row.startedAtMs - remembered.startedAt) <= toleranceMs ? "ours" : "reused";
}

// ── parsers (one per host format) ────────────────────────────────────────────

/** PowerShell's `pid|ppid|creation(o)|kernel100ns|user100ns|workingSet` lines. A row with no creation time (the idle process) is dropped. */
export function parseWindowsProcesses(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, created, kernel, user, rss] = line.trim().split("|");
    if (pid === undefined || ppid === undefined || created === undefined || created === "") continue;
    // 2026-10-01T18:48:41.6052390+05:30: engines differ on more than three fractional digits.
    const startedAtMs = Date.parse(created.replace(/(\.\d{3})\d+/, "$1"));
    const ticks = Number(kernel) + Number(user);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(ticks) || !Number.isInteger(Number(pid)) || !Number.isInteger(Number(ppid))) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), startedAtMs, cpuSeconds: ticks / 1e7, rssBytes: Number(rss) || 0 });
  }
  return rows;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** `[d-][[hh:]mm:]ss[.cc]` as `ps` prints CPU time on Linux and macOS. */
export function parseCpuTime(text: string): number {
  const [days, clock] = text.includes("-") ? text.split("-", 2) : [undefined, text];
  const seconds = (clock ?? "").split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return seconds + (days === undefined ? 0 : Number(days) * 86_400);
}

/** `ps -A -o pid=,ppid=,lstart=,cputime=,rss=` (run with LC_ALL=C): `  123     1 Mon Oct  6 00:03:12 2026 00:00:01  12345`. `lstart` is local time. */
export function parsePsProcesses(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  const line = /^\s*(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\S+)\s+(\d+)\s*$/;
  for (const raw of text.split(/\r?\n/)) {
    const match = line.exec(raw);
    if (match === null) continue;
    const [, pid, ppid, month, day, hour, minute, second, year, cpu, rss] = match;
    const monthIndex = MONTHS[month ?? ""];
    if (monthIndex === undefined) continue;
    const startedAtMs = new Date(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second)).getTime();
    rows.push({ pid: Number(pid), ppid: Number(ppid), startedAtMs, cpuSeconds: parseCpuTime(cpu ?? "0"), rssBytes: Number(rss) * 1024 });
  }
  return rows;
}

function portOf(address: string): number | null {
  const port = /:(\d+)$/.exec(address)?.[1];
  return port === undefined ? null : Number(port);
}

/** `netstat -ano -p tcp` (Windows): `  TCP    127.0.0.1:5554    0.0.0.0:0    LISTENING    1234`. */
export function parseNetstat(text: string): Listener[] {
  const listeners: Listener[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
    const port = portOf(parts[1] ?? "");
    const pid = Number(parts[4]);
    if (port !== null && Number.isInteger(pid)) listeners.push({ pid, port });
  }
  return listeners;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then one `n<address>` line per listening socket. */
export function parseLsof(text: string): Listener[] {
  const listeners: Listener[] = [];
  let pid: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("p")) pid = Number(raw.slice(1));
    else if (raw.startsWith("n") && pid !== null && Number.isInteger(pid)) {
      const port = portOf(raw.slice(1));
      if (port !== null) listeners.push({ pid, port });
    }
  }
  return listeners;
}

/** `ss -Hltnp` (Linux): `LISTEN 0 1 127.0.0.1:5554 0.0.0.0:* users:(("qemu-system-x86",pid=1234,fd=14))`. */
export function parseSs(text: string): Listener[] {
  const listeners: Listener[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] !== "LISTEN") continue;
    const port = portOf(parts[3] ?? "");
    if (port === null) continue;
    for (const match of raw.matchAll(/pid=(\d+)/g)) listeners.push({ pid: Number(match[1]), port });
  }
  return listeners;
}

// ── the host ─────────────────────────────────────────────────────────────────

function run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(file, args, { encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...(env ? { env } : {}) }, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
  return promise;
}

/** CIM, because `wmic` is gone from current Windows. Operators only (`-f`), no method calls, so it also runs where PowerShell is in constrained-language mode. */
const WINDOWS_PROCESS_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2:o}|{3}|{4}|{5}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate, $_.KernelModeTime, $_.UserModeTime, $_.WorkingSetSize }";

export function nodeProcessTable(): ProcessTable {
  const windows = process.platform === "win32";
  return {
    processes: async () => {
      if (windows) return parseWindowsProcesses(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PROCESS_SCRIPT]));
      return parsePsProcesses(await run("ps", ["-A", "-o", "pid=,ppid=,lstart=,cputime=,rss="], { ...process.env, LC_ALL: "C" }));
    },
    listeners: async () => {
      try {
        if (windows) return parseNetstat(await run("netstat", ["-ano", "-p", "tcp"]));
        if (process.platform === "linux") {
          try {
            return parseSs(await run("ss", ["-Hltnp"]));
          } catch {
            // no iproute2: lsof, below
          }
        }
        return parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
      } catch {
        return null;
      }
    },
    killTree: async (pid, rows) => {
      if (windows) {
        const { promise, resolve } = Promise.withResolvers<void>();
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
        await promise;
        return;
      }
      // The pack spawns the emulator detached, so it leads its own process group: one signal reaches the launcher and qemu. The listed children cover one that left the group.
      for (const target of [-pid, ...processTree(rows, pid).map(row => row.pid).reverse()]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // already gone
        }
      }
    },
  };
}

/** Cheap liveness (no table): signal 0. EPERM means it exists and is not ours to signal. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
