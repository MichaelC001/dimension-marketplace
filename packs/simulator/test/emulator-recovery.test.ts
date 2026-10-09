/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a boot that can recover from
 *  what the owner's Windows PC actually did does not. Live, (1) the emulator's
 *  qemu process was SUSPENDED by the system (all threads `Wait, Suspended`, ~0.3 s
 *  of CPU, no adb device): the pack called it a hung GPU, waited 75 s, killed it
 *  and relaunched it, and the relaunch froze too, where resuming the process made
 *  it boot at once; and (2) relaunching within a second of the kill made the new
 *  emulator exit 253 with no log line, because the AVD's lock still named the
 *  killed pid. Here the backend runs against the fake adb/emulator (test/fake-tool),
 *  a host table the test writes (which pids are frozen, who accepts a resume, what
 *  still runs after a kill), and a clock that jumps. Assertions are on what the
 *  pack DID: which pid it resumed or killed, what it launched and when, what the
 *  tool answered, what the result said.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidBackend, type BootTiming } from "../src/android/backend";
import { LOCK_EXIT_CODE, stillSuspendedReason } from "../src/android/emulator-boot";
import type { ProcessRow, ThreadSample } from "../src/android/process-table";
import type { OwnedProcess } from "../src/backend";
import type { DeviceInfo } from "../src/contracts";
import type { Toolchain } from "../src/toolchain";
import { buildFakeTools, type FakeDevice, FakeHost, type FakeTools, type FakeWorld, JumpClock, probeOutput, until } from "./fake-android-tools";

setDefaultTimeout(60_000);

const AVD = "SimTest_Pixel";
const PERSON_PID = 7001;
/** The qemu child of the nth launcher is QEMU_PID + n. */
const QEMU_PID = 8100;
/** A process of the killed tree that is slow to die. */
const LINGER_PID = 8500;
/** A process the AVD's lock can name. */
const LOCK_PID = 6100;
const RELAUNCH_WAIT_MS = 10_000;

/** The timings a scenario's clock jumps are written against, stated here so no default decides what a test means. */
const TIMING: Partial<BootTiming> = {
  pollMs: 20,
  stallCheckMs: 20,
  stopGraceMs: 10,
  stall: { afterMs: 75_000, maxCpuSeconds: 3 },
  suspend: { firstCheckMs: 8_000, checkMs: 10_000, recheckMs: 5_000, maxResumes: 3 },
  relaunchWaitMs: RELAUNCH_WAIT_MS,
};

const FROZEN: ThreadSample = { total: 18, suspended: 18 };
const RUNNING: ThreadSample = { total: 18, suspended: 0 };

/** The person's own emulator, from long before the pack started anything. */
const PERSON: FakeDevice = { serial: "emulator-5554", state: "device", avd: "Person_AVD", probe: probeOutput({ avd: "Person_AVD", qemu: true, hardware: "ranchu" }) };
const PERSON_ROW: ProcessRow = { pid: PERSON_PID, ppid: 1, startedAtMs: Date.now() - 3_600_000, cpuSeconds: 400, rssBytes: 2_000_000_000 };
/** The pack's emulator as adb shows it once it has booted. */
const OURS: FakeDevice = { serial: "emulator-5556", state: "device", avd: AVD, probe: probeOutput({ avd: AVD, qemu: true, hardware: "ranchu" }) };
/** A world in which the pack's emulator never appears. */
const SILENT: FakeWorld = { avds: [AVD], devices: [PERSON] };

let tools: FakeTools;
let root: string;

beforeAll(async () => {
  tools = await buildFakeTools();
  root = mkdtempSync(join(tmpdir(), "sim-recovery-"));
});

afterAll(() => {
  for (const dir of [tools?.dir, root]) {
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a fake emulator that has not exited yet still holds its folder; it ends itself shortly
    }
  }
});

interface Rig {
  readonly backend: AndroidBackend;
  readonly host: FakeHost;
  readonly clock: JumpClock;
  /** The AVD's own folder, where its lock lives. */
  readonly avdDir: string;
}

/** Every rig has its own AVD folder and log folder, so no test sees another's lock or log. */
function rig(world: FakeWorld, host: FakeHost = new FakeHost(), timing: Partial<BootTiming> = TIMING): Rig {
  tools.setWorld(world);
  const dir = mkdtempSync(join(root, "boot-"));
  const avdHome = join(dir, "avd");
  const avdDir = join(avdHome, `${AVD}.avd`);
  mkdirSync(avdDir, { recursive: true });
  host.others = [PERSON_ROW];
  host.othersListening = [{ pid: PERSON_PID, port: 5554 }];
  const clock = new JumpClock();
  const toolchain: Toolchain = { adb: tools.adb, emulator: tools.emulator, scrcpyServer: null, sdkRoot: null, missing: [], tried: { adb: [], emulator: [], "scrcpy-server": [] } };
  const backend = new AndroidBackend({ toolchain: () => toolchain, log: () => undefined, logDir: join(dir, "logs"), gpu: () => "auto", processes: host, avdHome: () => avdHome, now: clock.now, timing });
  return { backend, host, clock, avdDir };
}

type Settled = { readonly device: DeviceInfo } | { readonly error: Error };

function settle(ready: Promise<DeviceInfo>): Promise<Settled> {
  return ready.then(
    device => ({ device }),
    (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
  );
}

function failureOf(settled: Settled): Error {
  if ("device" in settled) throw new Error(`the boot succeeded: ${settled.device.serial}`);
  return settled.error;
}

function valueOf(args: readonly string[] | undefined, flag: string): string | undefined {
  const at = args?.indexOf(flag) ?? -1;
  return at < 0 ? undefined : args?.[at + 1];
}

function spawned(host: FakeHost, index: number): OwnedProcess {
  const process = host.spawned[index];
  if (process === undefined) throw new Error(`no emulator was spawned at index ${index}`);
  return process;
}

/** Start a boot and wait for its first emulator process to be launched. */
async function begin({ backend, host }: Rig): Promise<{ readonly end: Promise<Settled> }> {
  const handle = await backend.startBoot({ avd: AVD }, host.observer);
  const end = settle(handle.ready);
  await until(() => tools.launches().length >= 1, "the first launch");
  return { end };
}

/** The qemu child the nth launcher starts: it holds the memory, the launcher idles. */
function qemuOf(index: number, launcher: OwnedProcess): ProcessRow {
  return { pid: QEMU_PID + index, ppid: launcher.pid, startedAtMs: launcher.startedAt + 200, cpuSeconds: 0, rssBytes: 600_000_000 };
}

/** A process the host runs that is no part of the pack's tree. */
function strangerRow(pid: number): ProcessRow {
  return { pid, ppid: 1, startedAtMs: Date.now() - 7_200_000, cpuSeconds: 1, rssBytes: 50_000_000 };
}

/** What the emulator writes into the AVD's folder while it runs, and leaves behind when it is killed. */
function writeLock(avdDir: string, pid: number): void {
  const lock = join(avdDir, "hardware-qemu.ini.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), String(pid));
}

/** The pack has read the process table several times since the kill and has launched nothing: it is waiting. */
async function waitsWithoutLaunching(host: FakeHost): Promise<void> {
  const reads = host.processReads;
  await until(() => host.processReads >= reads + 5 || host.spawned.length > 1, "the pack to wait on the process table");
  expect(host.spawned).toHaveLength(1);
}

/** Stop the emulator the pack has running (so no fake emulator outlives its test) and let the boot that watched it settle. */
async function finish(r: Rig, index: number, end: Promise<Settled>): Promise<void> {
  await r.backend.stop(spawned(r.host, index), null, { avd: AVD });
  await end;
}

describe("booting: an emulator the system froze", () => {
  test("the frozen qemu child is resumed by its OWN pid, not killed or relaunched; the boot goes on and the result says so", async () => {
    const r = rig(SILENT);
    const { host, clock, backend } = r;
    host.cpuSeconds = () => 0.3;
    host.qemuChild = qemuOf;
    host.consolePorts = () => [5556, 5557];
    host.threads = pid => (host.resumed.includes(pid) ? RUNNING : FROZEN);
    const { end } = await begin(r);

    clock.jump(9_000);
    await until(() => host.notes.length === 1, "the resume");

    // The launcher idles by design: it is the qemu child that was looked at and resumed.
    expect(host.resumed).toEqual([QEMU_PID]);
    expect(host.sampled).not.toContain(spawned(host, 0).pid);
    expect(host.killed).toEqual([]);
    expect(host.spawned).toHaveLength(1);
    expect(tools.launches()).toHaveLength(1);
    expect(host.notes[0]).toContain("suspended");
    expect(host.notes[0]).toContain("resumed");

    // It was never a hung GPU: the same process goes on to boot.
    tools.setWorld({ avds: [AVD], devices: [PERSON, OURS] });
    const settled = await end;
    expect("device" in settled ? settled.device : null).toMatchObject({ serial: "emulator-5556", kind: "emulator" });
    expect(host.serials).toEqual(["emulator-5556"]);
    expect(host.spawned).toHaveLength(1);
    expect(host.killed).toEqual([]);
    expect(host.notes).toHaveLength(1);
    expect(await backend.stop(spawned(host, 0), "emulator-5556", { avd: AVD })).toBe("stopped");
  });

  test("the resume carries the start time of the process that was looked at, so the host can refuse a successor that took its pid", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.3;
    host.qemuChild = qemuOf;
    host.threads = pid => (host.resumed.includes(pid) ? RUNNING : FROZEN);
    const { end } = await begin(r);
    clock.jump(9_000);
    await until(() => host.resumed.length === 1, "the resume");

    expect(host.resumedStartedAt).toEqual([qemuOf(0, spawned(host, 0)).startedAtMs]);
    await finish(r, 0, end);
  });

  test("a resume gives the boot a fresh stall clock: the time spent frozen is not the GPU's, but a boot still silent 75 s after it is", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.3;
    host.qemuChild = qemuOf;
    host.threads = pid => (pid === QEMU_PID && !host.resumed.includes(pid) ? FROZEN : RUNNING);
    const { end } = await begin(r);
    clock.jump(9_000);
    await until(() => host.notes.length === 1, "the resume");
    const looks = host.sampled.length;

    // 79 s after the spawn, 70 s after the resume: as little CPU as a hung GPU, and still not stalled.
    clock.jump(70_000);
    await until(() => host.sampled.length > looks, "the next look at the emulator");
    expect(host.killed).toEqual([]);
    expect(host.spawned).toHaveLength(1);

    // 80 s after the resume it is running and silent: now it is the GPU, and the ordinary fallback applies.
    clock.jump(10_000);
    await until(() => tools.launches().length === 2, "the relaunch");
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(valueOf(tools.launches()[1], "-gpu")).toBe("swiftshader_indirect");
    expect(host.notes).toHaveLength(2);
    expect(host.notes[0]).toContain("suspended");
    expect(host.notes[1]).toContain("software graphics");
    await finish(r, 1, end);
  });

  test("an emulator that freezes again after every resume is resumed three times, then the boot fails saying so: no fourth resume, no relaunch", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.3;
    host.qemuChild = qemuOf;
    host.threads = () => FROZEN;
    const { end } = await begin(r);
    for (const [attempt, ms] of [[1, 9_000], [2, 5_000], [3, 5_000]] as const) {
      clock.jump(ms);
      await until(() => host.resumed.length === attempt, `resume ${attempt}`);
    }
    // The limit is spent: the next look sees the freeze and leaves it.
    const looks = host.sampled.length;
    clock.jump(5_000);
    await until(() => host.sampled.length > looks, "the look after the third resume");
    expect(host.resumed).toHaveLength(3);

    clock.jump(80_000);
    const error = failureOf(await end);

    expect(error.message).toContain(stillSuspendedReason(AVD, 3));
    expect(host.resumed).toEqual([QEMU_PID, QEMU_PID, QEMU_PID]);
    // A freeze is not the GPU: no software-graphics relaunch, which would be frozen the same way. The result says "resumed" once, not three times.
    expect(host.spawned).toHaveLength(1);
    expect(tools.launches()).toHaveLength(1);
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(host.notes).toHaveLength(1);
    expect(host.notes[0]).toContain("suspended");
  });

  test("a resume the host refuses counts against the limit too, says nothing was resumed, and the boot fails the same way", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.3;
    host.qemuChild = qemuOf;
    host.threads = () => FROZEN;
    host.resumeAccepted = false;
    const { end } = await begin(r);
    for (const [attempt, ms] of [[1, 9_000], [2, 5_000], [3, 5_000]] as const) {
      clock.jump(ms);
      await until(() => host.resumed.length === attempt, `resume attempt ${attempt}`);
    }
    const looks = host.sampled.length;
    clock.jump(5_000);
    await until(() => host.sampled.length > looks, "the look after the third attempt");
    expect(host.resumed).toHaveLength(3);

    clock.jump(80_000);
    const error = failureOf(await end);

    expect(error.message).toContain(stillSuspendedReason(AVD, 3));
    expect(host.notes).toEqual([]);
    expect(host.spawned).toHaveLength(1);
    expect(host.killed).toEqual([spawned(host, 0).pid]);
  });

  test("the three resumes are one budget for the whole boot, across its relaunch: the second launch gets only what the first left", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.3;
    host.qemuChild = qemuOf;
    // The first launch's qemu thaws for good after its second resume; the relaunch's never does.
    host.threads = pid => (pid === QEMU_PID && host.resumed.filter(resumed => resumed === pid).length >= 2 ? RUNNING : FROZEN);
    const { end } = await begin(r);
    clock.jump(9_000);
    await until(() => host.resumed.length === 1, "the first resume");
    clock.jump(5_000);
    await until(() => host.resumed.length === 2, "the second resume");

    // Thawed, and silent for 75 s: the GPU after all, so the stalled tree is killed and the AVD relaunched.
    clock.jump(80_000);
    await until(() => tools.launches().length === 2, "the relaunch");
    expect(valueOf(tools.launches()[1], "-gpu")).toBe("swiftshader_indirect");

    clock.jump(9_000);
    await until(() => host.resumed.length === 3, "the third resume, on the relaunch");
    const looks = host.sampled.length;
    clock.jump(5_000);
    await until(() => host.sampled.length > looks, "the look that finds the relaunch frozen again");
    expect(host.resumed).toEqual([QEMU_PID, QEMU_PID, QEMU_PID + 1]);

    clock.jump(80_000);
    const error = failureOf(await end);

    expect(error.message).toContain(stillSuspendedReason(AVD, 3));
    expect(tools.launches()).toHaveLength(2);
    expect(host.killed).toEqual([spawned(host, 0).pid, spawned(host, 1).pid]);
    // "Resumed" is said once, and the graphics fallback is said too.
    expect(host.notes).toHaveLength(2);
    expect(host.notes.filter(note => note.includes("suspended"))).toHaveLength(1);
    expect(host.notes.filter(note => note.includes("software graphics"))).toHaveLength(1);
  });

  test("a hung GPU is still a hung GPU when the threads can be read: one live thread, nothing is resumed, and the boot falls back to software graphics", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.6;
    host.qemuChild = qemuOf;
    host.threads = () => ({ total: 18, suspended: 17 });
    const { end } = await begin(r);

    clock.jump(80_000);
    await until(() => tools.launches().length === 2, "the relaunch");

    expect(host.sampled).toContain(QEMU_PID);
    expect(host.resumed).toEqual([]);
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(valueOf(tools.launches()[1], "-gpu")).toBe("swiftshader_indirect");
    expect(host.notes).toHaveLength(1);
    expect(host.notes[0]).toContain("software graphics");
    await finish(r, 1, end);
  });

  test("a launcher whose start time is not the one the pack recorded is a reused pid: nothing under it is looked at, let alone resumed", async () => {
    // The table reports the launcher's pid as started an hour before the pack spawned it.
    class ReusedLauncherHost extends FakeHost {
      override async processes(): Promise<ProcessRow[]> {
        const rows = await super.processes();
        const launcher = this.spawned[0]?.pid;
        return rows.map(row => (row.pid === launcher ? { ...row, startedAtMs: row.startedAtMs - 3_600_000 } : row));
      }
    }
    const host = new ReusedLauncherHost();
    const r = rig(SILENT, host);
    host.cpuSeconds = () => 0.3;
    host.qemuChild = qemuOf;
    host.threads = () => FROZEN;
    const { end } = await begin(r);

    r.clock.jump(9_000);
    await until(() => host.processReads >= 1, "the look at the process table");

    expect(host.sampled).toEqual([]);
    expect(host.resumed).toEqual([]);
    await finish(r, 0, end);
  });

  test("a frozen process that is not provably the same on a second read is not resumed, and the boot then fails rather than relaunching into the same freeze", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.3;
    // A different process answers to the pid on every read: the one looked at is never the one that would be resumed.
    host.qemuChild = (index, launcher) => ({ ...qemuOf(index, launcher), startedAtMs: launcher.startedAt + 200 + host.processReads });
    host.threads = () => FROZEN;
    const { end } = await begin(r);

    clock.jump(80_000);
    const error = failureOf(await end);

    expect(host.sampled).toContain(QEMU_PID);
    expect(host.resumed).toEqual([]);
    expect(error.message).toContain(stillSuspendedReason(AVD, 0));
    expect(tools.launches()).toHaveLength(1);
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(host.notes).toEqual([]);
  });

  test("a frozen process that only NAMES the launcher as its parent, and started before it, is a reused parent id: never looked at, never resumed", async () => {
    const stale = 8999;
    const r = rig(SILENT);
    const { host, clock } = r;
    host.qemuChild = (index, launcher) => (index === 0 ? { pid: stale, ppid: launcher.pid, startedAtMs: launcher.startedAt - 3_600_000, cpuSeconds: 0, rssBytes: 900_000_000 } : null);
    host.threads = pid => (pid === stale ? FROZEN : RUNNING);
    const { end } = await begin(r);

    clock.jump(9_000);
    await until(() => host.sampled.length >= 1, "the look at the emulator");

    expect(host.sampled).not.toContain(stale);
    expect(host.resumed).toEqual([]);
    await finish(r, 0, end);
  });
});

describe("relaunching: the AVD's lock and the killed tree", () => {
  test("after a stalled boot is killed, the relaunch waits until nothing of the killed tree still runs", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.6;
    const { end } = await begin(r);
    // qemu outlives the kill of its launcher for a while.
    const launcher = spawned(host, 0);
    host.others = [...host.others, { pid: LINGER_PID, ppid: launcher.pid, startedAtMs: launcher.startedAt + 200, cpuSeconds: 0, rssBytes: 600_000_000 }];

    clock.jump(80_000);
    await until(() => host.killed.length === 1, "the kill of the stalled tree");
    await waitsWithoutLaunching(host);
    expect(tools.launches()).toHaveLength(1);

    host.others = host.others.filter(row => row.pid !== LINGER_PID);
    await until(() => tools.launches().length === 2, "the relaunch once the tree is gone");
    expect(valueOf(tools.launches()[1], "-gpu")).toBe("swiftshader_indirect");
    await finish(r, 1, end);
  });

  test("…and for the process the AVD's lock names, even one outside the killed tree", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.6;
    host.others = [...host.others, strangerRow(LOCK_PID)];
    writeLock(r.avdDir, LOCK_PID);
    const { end } = await begin(r);

    clock.jump(80_000);
    await until(() => host.killed.length === 1, "the kill of the stalled tree");
    await waitsWithoutLaunching(host);

    // The lock file stays on disk naming the pid; nothing runs under it now.
    host.others = host.others.filter(row => row.pid !== LOCK_PID);
    await until(() => tools.launches().length === 2, "the relaunch once the lock's holder is gone");
    await finish(r, 1, end);
  });

  test("a lock that still names the killed process does not hold the relaunch back: the file outlives its holder", async () => {
    // The wait is an hour on the pack's clock, which this test never advances: a relaunch that waited on the stale lock could not happen.
    const r = rig(SILENT, new FakeHost(), { ...TIMING, relaunchWaitMs: 3_600_000 });
    const { host, clock } = r;
    host.cpuSeconds = () => 0.6;
    host.qemuChild = qemuOf;
    writeLock(r.avdDir, QEMU_PID);
    const { end } = await begin(r);

    clock.jump(80_000);
    await until(() => tools.launches().length === 2, "the relaunch, with nothing left to wait for");

    expect(host.killed).toEqual([spawned(host, 0).pid]);
    await finish(r, 1, end);
  });

  test("a holder that never goes away delays the relaunch by at most the wait, then the emulator is started anyway", async () => {
    const r = rig(SILENT);
    const { host, clock } = r;
    host.cpuSeconds = () => 0.6;
    host.others = [...host.others, strangerRow(LOCK_PID)];
    writeLock(r.avdDir, LOCK_PID);
    const { end } = await begin(r);

    clock.jump(80_000);
    await until(() => host.killed.length === 1, "the kill of the stalled tree");
    await waitsWithoutLaunching(host);

    clock.jump(RELAUNCH_WAIT_MS + 1_000);
    await until(() => tools.launches().length === 2, "the relaunch after the wait ran out");
    expect(valueOf(tools.launches()[1], "-gpu")).toBe("swiftshader_indirect");
    await finish(r, 1, end);
  });
});

describe("launching: an emulator that loses the race for the AVD's lock", () => {
  test("exit 253 right after the spawn with nothing FATAL waits for the lock's holder, then starts the SAME emulator once more, and the boot completes", async () => {
    const r = rig({ avds: [AVD], devices: [PERSON, { ...OURS, afterLaunches: 2 }], emulator: { launches: [{ exitCode: LOCK_EXIT_CODE }] } });
    const { host, backend } = r;
    host.consolePorts = index => (index === 1 ? [5556, 5557] : []);
    host.others = [...host.others, strangerRow(LOCK_PID)];
    writeLock(r.avdDir, LOCK_PID);
    const { end } = await begin(r);

    await waitsWithoutLaunching(host);
    host.others = host.others.filter(row => row.pid !== LOCK_PID);
    const settled = await end;

    expect("device" in settled ? settled.device : null).toMatchObject({ serial: "emulator-5556", kind: "emulator" });
    expect(tools.launches()).toHaveLength(2);
    expect(tools.launches()[1]).toEqual(tools.launches()[0]);
    expect(host.spawned).toHaveLength(2);
    // Nothing was killed: the first process had already exited by itself.
    expect(host.killed).toEqual([]);
    expect(await backend.stop(spawned(host, 1), "emulator-5556", { avd: AVD })).toBe("stopped");
  });

  test("253 twice: one retry, then the boot fails with the exit code and the pack starts nothing else", async () => {
    const r = rig({ avds: [AVD], devices: [PERSON], emulator: { launches: [{ exitCode: LOCK_EXIT_CODE }, { exitCode: LOCK_EXIT_CODE }] } });
    const { host } = r;
    const { end } = await begin(r);

    const error = failureOf(await end);

    expect(error.message).toContain("exited with code 253");
    expect(tools.launches()).toHaveLength(2);
    expect(host.spawned).toHaveLength(2);
  });

  test("253 WITH a FATAL line is the emulator naming its reason: reported with its own log, never retried", async () => {
    const r = rig({ avds: [AVD], devices: [PERSON], emulator: { launches: [{ exitCode: LOCK_EXIT_CODE, output: "FATAL   | Cannot find the system image for this AVD\n" }] } });
    const { host } = r;
    const { end } = await begin(r);

    const error = failureOf(await end);

    expect(error.message).toContain("exited with code 253");
    expect(error.message).toContain("FATAL   | Cannot find the system image for this AVD");
    expect(tools.launches()).toHaveLength(1);
    expect(host.spawned).toHaveLength(1);
  });

  test("a 253 on the software-graphics relaunch is retried with software graphics, not with the graphics the boot already gave up on", async () => {
    const r = rig({ avds: [AVD], devices: [PERSON, { ...OURS, afterLaunches: 3 }], emulator: { launches: [{}, { exitCode: LOCK_EXIT_CODE }] } });
    const { host, clock, backend } = r;
    host.cpuSeconds = () => 0.6;
    host.consolePorts = index => (index === 2 ? [5556, 5557] : []);
    const { end } = await begin(r);

    clock.jump(80_000);
    const settled = await end;

    expect("device" in settled ? settled.device : null).toMatchObject({ serial: "emulator-5556", kind: "emulator" });
    expect(tools.launches().map(argv => valueOf(argv, "-gpu"))).toEqual(["auto", "swiftshader_indirect", "swiftshader_indirect"]);
    expect(host.spawned).toHaveLength(3);
    // Only the stalled first tree was killed; the second had exited by itself.
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(await backend.stop(spawned(host, 2), "emulator-5556", { avd: AVD })).toBe("stopped");
  });
});
