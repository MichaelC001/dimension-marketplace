// What the AndroidBackend tests stand on: a fake `adb` + `emulator` pair (real
// executables, built once, answering from a world the test writes), a fake host
// process table, and a clock a test can jump. No emulator, no device, no window:
// the executables are built as Windows GUI-subsystem programs, so not even a
// console can open.

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootObserver, OwnedProcess } from "../src/backend";
import type { Listener, ProcessRow, ProcessTable, ThreadSample } from "../src/android/process-table";

// ── the fake tools ───────────────────────────────────────────────────────────

export interface FakeDevice {
  readonly serial: string;
  readonly state: string;
  readonly model?: string;
  readonly avd?: string;
  readonly probe?: string;
  readonly afterLaunches?: number;
}

export interface FakeEmulatorBehaviour {
  readonly output?: string;
  readonly exitCode?: number;
}

export interface FakeWorld {
  readonly avds: readonly string[];
  readonly devices: readonly FakeDevice[];
  /** What an emulator process does; `launches[n]` replaces it for the nth launch since the world was set (0 = the first). */
  readonly emulator?: FakeEmulatorBehaviour & { readonly launches?: readonly FakeEmulatorBehaviour[] };
}

export interface ToolCall {
  readonly tool: "adb" | "emulator";
  readonly kind?: "launch";
  readonly serial?: string | null;
  readonly args: readonly string[];
}

export interface FakeTools {
  readonly dir: string;
  readonly adb: string;
  readonly emulator: string;
  /** Replace what the fake tools know, and forget the calls so far. */
  setWorld(world: FakeWorld): void;
  calls(): ToolCall[];
  /** The argv of every emulator process the pack launched (not `-list-avds`). */
  launches(): string[][];
  /** adb calls that ask an emulator to close (`emu kill`), by serial. */
  killRequests(): string[];
  dispose(): void;
}

const PROGRAM = fileURLToPath(new URL("./fake-tool/main.ts", import.meta.url));

export async function buildFakeTools(): Promise<FakeTools> {
  const dir = mkdtempSync(join(tmpdir(), "sim-fake-tools-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const adb = join(dir, `adb${suffix}`);
  const emulator = join(dir, `emulator${suffix}`);
  const built = await Bun.build({
    entrypoints: [PROGRAM],
    compile: process.platform === "win32" ? { outfile: adb, windows: { hideConsole: true } } : { outfile: adb },
  });
  if (!built.success) throw new Error(`could not build the fake adb/emulator: ${built.logs.map(String).join("; ")}`);
  copyFileSync(adb, emulator);
  const callsPath = join(dir, "calls.jsonl");
  const calls = (): ToolCall[] => {
    try {
      return readFileSync(callsPath, "utf8")
        .split("\n")
        .filter(line => line !== "")
        .map(line => JSON.parse(line) as ToolCall);
    } catch {
      return [];
    }
  };
  return {
    dir,
    adb,
    emulator,
    setWorld: world => {
      writeFileSync(callsPath, "");
      writeFileSync(join(dir, "world.json"), JSON.stringify(world));
    },
    calls,
    launches: () => calls().filter(call => call.kind === "launch").map(call => [...call.args]),
    killRequests: () => calls().filter(call => call.tool === "adb" && call.args[0] === "emu" && call.args[1] === "kill").map(call => call.serial ?? ""),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** What the pack's one `adb shell` probe prints for a device (see PROBE_COMMAND in android/backend.ts). */
export function probeOutput(device: { release?: string; booted?: boolean; avd?: string; model?: string; qemu?: boolean; hardware?: string; characteristics?: string }): string {
  return [
    `V=${device.release ?? "14"}`,
    `B=${device.booted === false ? "" : "1"}`,
    `A=${device.avd ?? ""}`,
    "K=",
    `M=${device.model ?? ""}`,
    `Q=${device.qemu === true ? "1" : ""}`,
    `QB=${device.qemu === true ? "1" : ""}`,
    `H=${device.hardware ?? ""}`,
    `C=${device.characteristics ?? ""}`,
    "Physical size: 1080x2400",
    "Physical density: 420",
    "",
  ].join("\n");
}

// ── the host ─────────────────────────────────────────────────────────────────

/**
 * The host's process table as the test says it is. The emulators the pack spawns are real (fake)
 * processes; what the table reports about them (CPU, the ports they listen on) is the test's call.
 * `killTree` records every pid it is asked to kill, and really ends only a process the pack spawned
 * (or one the test registered): never an arbitrary pid, whatever the code under test asks for.
 */
export class FakeHost implements ProcessTable {
  /** Every process the pack reported spawning, in order. */
  readonly spawned: OwnedProcess[] = [];
  readonly serials: string[] = [];
  readonly notes: string[] = [];
  /** Every pid `killTree` was asked about. */
  readonly killed: number[] = [];
  /** Rows of processes that are not the pack's: the person's own emulator, say. */
  others: ProcessRow[] = [];
  /** Listeners of those other processes. */
  othersListening: Listener[] = [];
  /** CPU seconds the nth spawned emulator's tree has used. */
  cpuSeconds: (index: number) => number = () => 0;
  /** Console ports the nth spawned emulator's tree listens on. */
  consolePorts: (index: number) => number[] = () => [];
  /** The qemu child the nth spawned launcher has started, if any (the launcher itself idles): it appears in the table under that launcher. */
  qemuChild: (index: number, launcher: OwnedProcess) => ProcessRow | null = () => null;
  /** What the host says of a pid's threads; null = it cannot say. */
  threads: (pid: number) => ThreadSample | null = () => null;
  /** Whether the host accepts a resume. */
  resumeAccepted = true;
  /** Every pid `threadStates` was asked about. */
  readonly sampled: number[] = [];
  /** Every pid `resume` was asked to resume. */
  readonly resumed: number[] = [];
  tableReadable = true;
  listenersReadable = true;
  /** How many times the process table was read. */
  processReads = 0;
  readonly #killable = new Set<number>();

  /** The observer to hand a boot: it records what the pack reports. */
  readonly observer: BootObserver = {
    spawned: process => {
      this.spawned.push(process);
      this.#killable.add(process.pid);
    },
    serial: serial => {
      this.serials.push(serial);
    },
    note: message => {
      this.notes.push(message);
    },
  };

  /** A real process the test itself started, that `killTree` may end. */
  allowKill(pid: number): void {
    this.#killable.add(pid);
  }

  async processes(): Promise<ProcessRow[]> {
    this.processReads++;
    if (!this.tableReadable) throw new Error("the process table cannot be read");
    const mine = this.spawned.flatMap((process, index): ProcessRow[] => (this.killed.includes(process.pid) ? [] : [{ pid: process.pid, ppid: 1, startedAtMs: process.startedAt, cpuSeconds: this.cpuSeconds(index), rssBytes: 1_000_000 }]));
    const children = this.spawned.flatMap((process, index): ProcessRow[] => {
      const child = this.killed.includes(process.pid) ? null : this.qemuChild(index, process);
      return child === null ? [] : [child];
    });
    return [...mine, ...children, ...this.others];
  }

  async listeners(): Promise<Listener[] | null> {
    if (!this.listenersReadable) return null;
    const mine = this.spawned.flatMap((process, index) => (this.killed.includes(process.pid) ? [] : this.consolePorts(index).map((port): Listener => ({ pid: process.pid, port }))));
    return [...mine, ...this.othersListening];
  }

  async threadStates(pid: number): Promise<ThreadSample | null> {
    this.sampled.push(pid);
    return this.threads(pid);
  }

  async resume(pid: number): Promise<boolean> {
    this.resumed.push(pid);
    return this.resumeAccepted;
  }

  async killTree(pid: number): Promise<void> {
    this.killed.push(pid);
    if (!this.#killable.has(pid)) return;
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
}

// ── time and waiting ─────────────────────────────────────────────────────────

/** Wall time plus a jump: a boot that has "run for 80 s" without the test waiting 80 s. */
export class JumpClock {
  #skew = 0;

  readonly now = (): number => Date.now() + this.#skew;

  jump(ms: number): void {
    this.#skew += ms;
  }
}

/** Resolve when `condition` holds; fail with `what` if it never does. A condition wait, not a sleep. */
export async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
