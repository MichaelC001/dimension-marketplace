/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack stops an emulator that
 *  is not its own, or leaks one that is. The pack once stopped the SERIAL
 *  emulator-5554 when its own boot failed, and that was the person's; so
 *  ownership is a PROCESS ({pid, startedAt}), a serial alone never stops
 *  anything, an AVD that already runs is returned instead of duplicated, a cap
 *  bounds what the pack boots, an idle emulator is stopped, and a crashed pack's
 *  emulators are found again at the next start only when they are provably the
 *  ones it spawned.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type SimulatorSettings } from "../src/settings";
import { Fleet, fileOwnershipStore, type OwnedRecord, type OwnershipStore, type Timer } from "../src/fleet";
import { until } from "./fake-android-tools";
import { type FakeBoot, FakeBackend, emulatorDevice } from "./fake-backend";

const PACK_PID = 1000;
const SIBLING_PID = 2000;
const DEAD_PID = 3000;
const T0 = 1_800_000_000_000;

class MemoryStore implements OwnershipStore {
  records: OwnedRecord[];
  readonly writes: OwnedRecord[][] = [];

  constructor(initial: readonly OwnedRecord[] = []) {
    this.records = [...initial];
  }

  read(): OwnedRecord[] {
    return [...this.records];
  }

  write(records: readonly OwnedRecord[]): void {
    this.records = [...records];
    this.writes.push([...records]);
  }
}

interface FakeTimer extends Timer {
  readonly run: () => void;
  readonly ms: number;
  cancelled: boolean;
}

interface Rig {
  readonly backend: FakeBackend;
  readonly store: MemoryStore;
  readonly fleet: Fleet;
  readonly timers: FakeTimer[];
  /** Timers that were not cancelled: the idle clocks that are actually running. */
  active(): FakeTimer[];
}

function rig(options: { settings?: Partial<SimulatorSettings>; stored?: readonly OwnedRecord[]; alive?: readonly number[] } = {}): Rig {
  const backend = new FakeBackend();
  backend.avdNames = ["Pixel_A", "Pixel_B", "Pixel_C"];
  const store = new MemoryStore(options.stored);
  const timers: FakeTimer[] = [];
  const alive = new Set(options.alive ?? []);
  const fleet = new Fleet({
    backend,
    store,
    log: () => undefined,
    settings: () => ({ ...DEFAULT_SETTINGS, ...options.settings }),
    pid: PACK_PID,
    isAlive: pid => alive.has(pid),
    schedule: (run, ms) => {
      const timer: FakeTimer = { run, ms, cancelled: false, cancel: () => void (timer.cancelled = true) };
      timers.push(timer);
      return timer;
    },
  });
  return { backend, store, fleet, timers, active: () => timers.filter(timer => !timer.cancelled) };
}

/** Boot `avd` to the end: spawned, console matched to `serial`, up. */
async function bootUp(r: Rig, avd: string, serial: string): Promise<FakeBoot> {
  const count = r.backend.boots.length;
  const outcome = r.fleet.boot({ avd }, 10_000);
  await until(() => r.backend.boots.length > count, `${avd} to spawn`);
  const boot = r.backend.boots[count];
  if (boot === undefined) throw new Error("no boot");
  const entry = r.backend.processes.get(boot.process.pid);
  if (entry !== undefined) entry.serial = serial;
  boot.observer.serial(serial);
  const info = emulatorDevice(serial, avd);
  r.backend.devices.push(info);
  boot.ready.resolve(info);
  await outcome;
  return boot;
}

describe("an AVD that already runs", () => {
  test("is returned, not booted again; it is the person's, so the pack will not stop it", async () => {
    const r = rig();
    r.backend.devices = [emulatorDevice("emulator-5554", "Pixel_A")];
    const outcome = await r.fleet.boot({ avd: "Pixel_A" }, 1_000);
    expect(outcome).toMatchObject({ reused: true, pending: false, device: { serial: "emulator-5554", owned: false } });
    expect(outcome.notes.join(" ")).toContain("not started by this pack");
    expect(r.backend.boots).toHaveLength(0);
    await expect(r.fleet.stop("emulator-5554")).rejects.toMatchObject({ code: "not_owned" });
    expect(r.backend.stops).toEqual([]);
  });

  test("an emulator still starting that its console names is returned too, as booting", async () => {
    const r = rig();
    r.backend.devices = [emulatorDevice("emulator-5554", "emulator-5554", { state: "offline" })];
    r.backend.running = [{ serial: "emulator-5554", avd: "Pixel_A" }];
    const outcome = await r.fleet.boot({ avd: "Pixel_A" }, 50);
    expect(outcome).toMatchObject({ reused: true, pending: true, device: { serial: "emulator-5554", state: "booting" } });
    expect(r.backend.boots).toHaveLength(0);
  });

  test("a second boot of the same AVD while the first is starting joins it", async () => {
    const r = rig();
    const first = await r.fleet.boot({ avd: "Pixel_A" }, 0);
    expect(first).toMatchObject({ pending: true, reused: false });
    const second = await r.fleet.boot({ avd: "Pixel_A" }, 0);
    expect(second).toMatchObject({ pending: true, reused: true });
    expect(r.backend.boots).toHaveLength(1);
    expect(r.fleet.owned()).toHaveLength(1);
  });

  test("readOnly starts a second, throwaway instance of it, and tells the caller so", async () => {
    const r = rig();
    r.backend.devices = [emulatorDevice("emulator-5554", "Pixel_A")];
    const outcome = await r.fleet.boot({ avd: "Pixel_A", readOnly: true }, 0);
    expect(r.backend.boots).toHaveLength(1);
    expect(r.backend.boots[0]?.request).toMatchObject({ avd: "Pixel_A", readOnly: true });
    expect(outcome.reused).toBe(false);
    expect(outcome.notes.join(" ")).toContain("-read-only");
    // The new instance is the pack's; the person's is still not.
    expect(r.fleet.owned()).toHaveLength(1);
    expect(r.fleet.isOwned("emulator-5554")).toBe(false);
  });
});

describe("the cap on what the pack boots", () => {
  test("counts boots still starting, and refuses the next one with the way out", async () => {
    const r = rig({ settings: { maxDevices: 2 } });
    await r.fleet.boot({ avd: "Pixel_A" }, 0);
    await r.fleet.boot({ avd: "Pixel_B" }, 0);
    await expect(r.fleet.boot({ avd: "Pixel_C" }, 0)).rejects.toMatchObject({ code: "device_cap" });
    expect(r.backend.boots).toHaveLength(2);
  });

  test("does not count emulators the person runs", async () => {
    const r = rig({ settings: { maxDevices: 1 } });
    r.backend.devices = [emulatorDevice("emulator-5554", "Pixel_B"), emulatorDevice("emulator-5556", "Pixel_C")];
    await r.fleet.boot({ avd: "Pixel_A" }, 0);
    expect(r.backend.boots).toHaveLength(1);
  });

  test("frees a slot when the pack stops one of its own", async () => {
    const r = rig({ settings: { maxDevices: 1 } });
    await bootUp(r, "Pixel_A", "emulator-5556");
    await expect(r.fleet.boot({ avd: "Pixel_B" }, 0)).rejects.toMatchObject({ code: "device_cap" });
    await r.fleet.stop("emulator-5556");
    await r.fleet.boot({ avd: "Pixel_B" }, 0);
    expect(r.backend.boots).toHaveLength(2);
  });
});

describe("ownership of a boot", () => {
  test("is recorded the moment the process spawns, and dropped when the boot fails; the fleet kills nothing itself", async () => {
    const r = rig();
    // The person's own emulator, running a different AVD.
    r.backend.devices = [emulatorDevice("emulator-5554", "Pixel_B")];
    const outcome = r.fleet.boot({ avd: "Pixel_A" }, 10_000);
    const failed = outcome.then(
      () => undefined,
      (error: unknown) => error,
    );
    await until(() => r.backend.boots.length === 1, "the boot to spawn");
    const boot = r.backend.boots[0];
    if (boot === undefined) throw new Error("no boot");
    // Before the console is matched, before anything can fail, the record names exactly this process.
    expect(r.store.records).toEqual([{ serial: null, avd: "Pixel_A", pid: boot.process.pid, startedAt: boot.process.startedAt, bootedAt: expect.any(Number) as number, ownerPid: PACK_PID }]);

    boot.ready.reject(new Error("the emulator for Pixel_A exited with code 1 before it finished booting."));
    expect(await failed).toMatchObject({ message: expect.stringContaining("exited with code 1") });
    expect(r.store.records).toEqual([]);
    expect(r.fleet.owned()).toEqual([]);
    expect(r.backend.stops).toEqual([]);
    expect(r.fleet.isOwned("emulator-5554")).toBe(false);
  });

  test("a boot that fails after the waiting call returned is told to the next call, once, not silently restarted", async () => {
    const r = rig();
    const pending = await r.fleet.boot({ avd: "Pixel_A" }, 0);
    expect(pending.pending).toBe(true);
    r.backend.boots[0]?.ready.reject(new Error("the emulator never answered"));
    await until(() => r.fleet.owned().length === 0, "the failed boot to be released");

    await expect(r.fleet.boot({ avd: "Pixel_A" }, 0)).rejects.toThrow(/earlier device_boot.*failed.*the emulator never answered/s);
    expect(r.backend.boots).toHaveLength(1);
    // Told once: the call after that starts afresh.
    await r.fleet.boot({ avd: "Pixel_A" }, 0);
    expect(r.backend.boots).toHaveLength(2);
  });

  test("a boot the pack itself stopped is not reported as a failure to the next boot", async () => {
    const r = rig();
    await r.fleet.boot({ avd: "Pixel_A" }, 0);
    const boot = r.backend.boots[0];
    if (boot === undefined) throw new Error("no boot");
    boot.observer.serial("emulator-5556");
    const entry = r.backend.processes.get(boot.process.pid);
    if (entry !== undefined) entry.serial = "emulator-5556";
    await r.fleet.stop("emulator-5556");
    // The fleet's handler on the boot's rejection was registered first, so it has run once this settles.
    await boot.ready.promise.catch(() => undefined);
    await r.fleet.boot({ avd: "Pixel_A" }, 0);
    expect(r.backend.boots).toHaveLength(2);
  });
});

describe("stopping", () => {
  test("acts on the process the pack spawned (pid and start time), and hands the serial over only as a label", async () => {
    const r = rig();
    const boot = await bootUp(r, "Pixel_A", "emulator-5556");
    expect(await r.fleet.stop("emulator-5556")).toBe("stopped");
    expect(r.backend.stops).toEqual([{ process: { pid: boot.process.pid, startedAt: boot.process.startedAt }, serial: "emulator-5556" }]);
    expect(r.fleet.owned()).toEqual([]);
    expect(r.store.records).toEqual([]);
  });

  test("a pid that now belongs to another process is never touched, and the record is let go", async () => {
    const r = rig();
    const boot = await bootUp(r, "Pixel_A", "emulator-5556");
    const entry = r.backend.processes.get(boot.process.pid);
    if (entry === undefined) throw new Error("no process");
    // The pid was reused: it is running, but it started hours after the pack's emulator did.
    entry.startedAt = boot.process.startedAt + 3 * 3_600_000;
    expect(await r.fleet.stop("emulator-5556")).toBe("already-exited");
    expect(r.backend.processes.has(boot.process.pid)).toBe(true);
    expect(r.fleet.owned()).toEqual([]);
  });

  test("refuses a serial the pack did not boot, and never reaches the backend", async () => {
    const r = rig();
    await bootUp(r, "Pixel_A", "emulator-5556");
    r.backend.devices.push(emulatorDevice("emulator-5554", "Pixel_B"));
    await expect(r.fleet.stop("emulator-5554")).rejects.toMatchObject({ code: "not_owned" });
    expect(r.backend.stops).toEqual([]);
    expect(r.fleet.owned()).toHaveLength(1);
  });

  test("shutdown stops what the pack booted and leaves what the person runs", async () => {
    const r = rig();
    const a = await bootUp(r, "Pixel_A", "emulator-5556");
    const b = await bootUp(r, "Pixel_B", "emulator-5558");
    r.backend.devices.push(emulatorDevice("emulator-5554", "Pixel_C"));
    await r.fleet.shutdown(2_000);
    expect(r.backend.stops.map(stop => stop.process.pid).sort()).toEqual([a.process.pid, b.process.pid].sort());
    expect(r.backend.processes.size).toBe(0);
    expect(r.fleet.owned()).toEqual([]);
  });
});

describe("the idle clock", () => {
  test("one timer per owned device, for the configured minutes; a tool call restarts it", async () => {
    const r = rig({ settings: { idleMinutes: 7 } });
    await bootUp(r, "Pixel_A", "emulator-5556");
    expect(r.active().map(timer => timer.ms)).toEqual([7 * 60_000]);
    const before = r.active()[0];
    r.fleet.touch("emulator-5556");
    expect(before?.cancelled).toBe(true);
    expect(r.active()).toHaveLength(1);
    expect(r.active()[0]).not.toBe(before);
  });

  test("a viewer stops the clock; the last one leaving starts it again", async () => {
    const r = rig();
    await bootUp(r, "Pixel_A", "emulator-5556");
    r.fleet.setViewers("emulator-5556", 1);
    expect(r.active()).toHaveLength(0);
    // A tool call while somebody is watching does not start it either.
    r.fleet.touch("emulator-5556");
    expect(r.active()).toHaveLength(0);
    r.fleet.setViewers("emulator-5556", 0);
    expect(r.active()).toHaveLength(1);
  });

  test("an idle emulator is stopped by its process and its record let go", async () => {
    const r = rig();
    const boot = await bootUp(r, "Pixel_A", "emulator-5556");
    r.active()[0]?.run();
    await until(() => r.backend.stops.length === 1, "the idle stop");
    expect(r.backend.stops[0]?.process).toEqual({ pid: boot.process.pid, startedAt: boot.process.startedAt });
    await until(() => r.fleet.owned().length === 0, "the record to be released");
  });

  test("a device the pack did not boot never gets an idle clock", async () => {
    const r = rig();
    r.backend.devices = [emulatorDevice("emulator-5554", "Pixel_B")];
    r.fleet.touch("emulator-5554");
    r.fleet.setViewers("emulator-5554", 0);
    expect(r.timers).toHaveLength(0);
  });
});

describe("a crashed pack's emulators", () => {
  function record(over: Partial<OwnedRecord> = {}): OwnedRecord {
    return { serial: "emulator-5556", avd: "Pixel_A", pid: 4100, startedAt: T0, bootedAt: T0, ownerPid: DEAD_PID, ...over };
  }

  const rows: {
    name: string;
    stored: OwnedRecord;
    host: (backend: FakeBackend) => void;
    /** Adopted as the pack's own, with this serial; or not adopted. */
    adopted: string | null;
    /** The process the pack stopped, if any, and with which serial. */
    stopped: { serial: string | null } | null;
    kept?: boolean;
  }[] = [
    {
      name: "its pack died and the process is the one it spawned, answering on its console: adopted",
      stored: record(),
      host: backend => backend.processes.set(4100, { startedAt: T0, serial: "emulator-5556" }),
      adopted: "emulator-5556",
      stopped: null,
    },
    {
      name: "the process is gone: the record is dropped",
      stored: record(),
      host: () => undefined,
      adopted: null,
      stopped: null,
    },
    {
      name: "the pid now belongs to another process: dropped, and that process is never touched",
      stored: record(),
      host: backend => backend.processes.set(4100, { startedAt: T0 + 3 * 3_600_000, serial: "emulator-5556" }),
      adopted: null,
      stopped: null,
    },
    {
      name: "the process table cannot be read: dropped, nothing killed on a guess",
      stored: record(),
      host: backend => {
        backend.processes.set(4100, { startedAt: T0, serial: "emulator-5556" });
        backend.tableReadable = false;
      },
      adopted: null,
      stopped: null,
    },
    {
      name: "the process is ours but never opened a console: an unfinished boot, stopped by its pid",
      stored: record({ serial: null }),
      host: backend => backend.processes.set(4100, { startedAt: T0, serial: null }),
      adopted: null,
      stopped: { serial: null },
    },
    {
      name: "the host cannot tie a console to the process, but the recorded serial still runs this AVD: adopted on it",
      stored: record(),
      host: backend => {
        backend.processes.set(4100, { startedAt: T0, serial: null });
        backend.running = [{ serial: "emulator-5556", avd: "Pixel_A" }];
      },
      adopted: "emulator-5556",
      stopped: null,
    },
    {
      name: "the recorded serial now belongs to the person's other AVD: not adopted, and the process (not that serial) is what is stopped",
      stored: record(),
      host: backend => {
        backend.processes.set(4100, { startedAt: T0, serial: null });
        backend.running = [{ serial: "emulator-5556", avd: "Pixel_Other" }];
      },
      adopted: null,
      stopped: { serial: null },
    },
    {
      name: "its pack is still running: the record is a living sibling's and is left exactly as it is",
      stored: record({ ownerPid: SIBLING_PID }),
      host: backend => backend.processes.set(4100, { startedAt: T0, serial: "emulator-5556" }),
      adopted: null,
      stopped: null,
      kept: true,
    },
  ];

  for (const row of rows) {
    test(row.name, async () => {
      const r = rig({ stored: [row.stored], alive: [SIBLING_PID] });
      row.host(r.backend);
      await r.fleet.reconcile();
      expect(r.fleet.owned().map(owned => owned.serial)).toEqual(row.adopted === null ? [] : [row.adopted]);
      if (row.adopted !== null) {
        expect(r.fleet.owned()[0]).toMatchObject({ pid: 4100, startedAt: T0, ownerPid: PACK_PID });
        expect(r.fleet.isOwned(row.adopted)).toBe(true);
      }
      expect(r.backend.stops).toEqual(row.stopped === null ? [] : [{ process: { pid: 4100, startedAt: T0 }, serial: row.stopped.serial }]);
      // What is left in the file: the adopted record (now this pack's), a living sibling's untouched, and nothing else.
      expect(r.store.records).toEqual(row.kept === true ? [row.stored] : row.adopted === null ? [] : [{ ...row.stored, ownerPid: PACK_PID }]);
    });
  }

  test("the file keeps a living sibling's record beside this pack's own, and never a dead owner's", async () => {
    const sibling = record({ pid: 5000, ownerPid: SIBLING_PID, serial: "emulator-5560" });
    const dead = record({ pid: 4100, ownerPid: DEAD_PID });
    const r = rig({ stored: [sibling, dead], alive: [SIBLING_PID] });
    const boot = await bootUp(r, "Pixel_B", "emulator-5558");
    expect(r.store.records.map(item => item.pid).sort()).toEqual([sibling.pid, boot.process.pid].sort());
    await r.fleet.stop("emulator-5558");
    expect(r.store.records).toEqual([sibling]);
  });
});

describe("fileOwnershipStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sim-owned-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const valid: OwnedRecord = { serial: "emulator-5556", avd: "Pixel_A", pid: 4100, startedAt: T0, bootedAt: T0, ownerPid: PACK_PID };

  test("a file that is missing, corrupt or not a list reads as nothing owned: never a reason to refuse a boot", () => {
    expect(fileOwnershipStore(join(dir, "missing.json")).read()).toEqual([]);
    writeFileSync(join(dir, "corrupt.json"), "{ not json");
    expect(fileOwnershipStore(join(dir, "corrupt.json")).read()).toEqual([]);
    writeFileSync(join(dir, "object.json"), JSON.stringify({ pid: 1 }));
    expect(fileOwnershipStore(join(dir, "object.json")).read()).toEqual([]);
  });

  test("a record from before ownership was by process (no pid or start time) cannot be verified, so it is not read", () => {
    const legacy = { serial: "emulator-5554", avd: "Pixel_A", bootedAt: T0, ownerPid: PACK_PID };
    const wrongType = { ...valid, pid: "4100" };
    writeFileSync(join(dir, "owned.json"), JSON.stringify([legacy, valid, wrongType, null, 7]));
    expect(fileOwnershipStore(join(dir, "owned.json")).read()).toEqual([valid]);
  });

  test("what is written is read back, including a boot that has no serial yet, into a folder that did not exist", () => {
    const store = fileOwnershipStore(join(dir, "nested", "deeper", "owned.json"));
    const starting: OwnedRecord = { ...valid, serial: null, pid: 4200 };
    store.write([valid, starting]);
    expect(store.read()).toEqual([valid, starting]);
    store.write([]);
    expect(store.read()).toEqual([]);
  });
});
