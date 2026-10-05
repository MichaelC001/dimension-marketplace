// The fleet: which virtual devices THIS pack booted, and the rules that keep
// them from outliving their use.
//
//   ownership   Only a device the pack booted is ever stopped by it. A device the
//               person started themselves (Android Studio, a terminal) is theirs:
//               stop is refused, idle shutdown skips it, exit leaves it running.
//   cap         At most `simulator.maxDevices` booted at once.
//   idle        An owned device with no viewer and no tool call for
//               `simulator.idleMinutes` is stopped. One timer per device, set and
//               reset by events (a tool call, a viewer coming or going): nothing polls.
//   orphans     The ownership record is a file, so a crashed pack's emulators are
//               found again at the next start. A device is adopted only when it is
//               still running, still the AVD the record names, and its previous
//               owner is dead: never from `adb devices` alone, so an emulator the
//               person started since is never mistaken for ours.
//   exit        `shutdown()` stops what the pack booted.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BootHandle, DeviceBackend } from "./backend";
import { type BootRequest, type DeviceInfo, fail } from "./contracts";
import type { SimulatorSettings } from "./settings";

export interface OwnedRecord {
  readonly serial: string;
  readonly avd: string;
  readonly pid: number | null;
  readonly bootedAt: number;
  /** The pack process that booted (or adopted) it. */
  readonly ownerPid: number;
}

export interface OwnershipStore {
  read(): OwnedRecord[];
  write(records: readonly OwnedRecord[]): void;
}

/** A JSON file, written atomically. A missing or corrupt file reads as "nothing owned": never a reason to refuse a boot. */
export function fileOwnershipStore(path: string): OwnershipStore {
  return {
    read: () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
          (entry): entry is OwnedRecord =>
            typeof entry === "object" && entry !== null && typeof entry.serial === "string" && typeof entry.avd === "string" && typeof entry.ownerPid === "number" && typeof entry.bootedAt === "number" && (entry.pid === null || typeof entry.pid === "number"),
        );
      } catch {
        return [];
      }
    },
    write: records => {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(records, null, 2));
      renameSync(temp, path);
    },
  };
}

export interface Timer {
  cancel(): void;
}

export interface FleetDeps {
  readonly backend: DeviceBackend;
  readonly settings: () => SimulatorSettings;
  readonly store: OwnershipStore;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly schedule?: (run: () => void, ms: number) => Timer;
}

export interface BootOutcome {
  readonly device: DeviceInfo;
  /** True while the device is still starting; call device_boot again to wait for it. */
  readonly pending: boolean;
  /** True when an already-running device was returned instead of booting another. */
  readonly reused: boolean;
}

const defaultSchedule = (run: () => void, ms: number): Timer => {
  const handle = setTimeout(run, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, we may not signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Booting {
  readonly handle: BootHandle;
  readonly settled: Promise<DeviceInfo>;
}

export class Fleet {
  readonly #deps: FleetDeps;
  readonly #pid: number;
  readonly #owned = new Map<string, OwnedRecord>();
  readonly #idle = new Map<string, Timer>();
  readonly #viewers = new Map<string, number>();
  readonly #booting = new Map<string, Booting>();
  #reconciled: Promise<void> | null = null;

  constructor(deps: FleetDeps) {
    this.#deps = deps;
    this.#pid = deps.pid ?? process.pid;
  }

  owned(): readonly OwnedRecord[] {
    return [...this.#owned.values()];
  }

  isOwned(serial: string): boolean {
    return this.#owned.has(serial);
  }

  /** Adopt what a dead pack left running. Once per process, lazily, before anything that depends on ownership. */
  reconcile(): Promise<void> {
    this.#reconciled ??= this.#adoptOrphans();
    return this.#reconciled;
  }

  async #adoptOrphans(): Promise<void> {
    const alive = this.#deps.isAlive ?? processAlive;
    const records = this.#deps.store.read();
    let changed = false;
    for (const record of records) {
      if (record.ownerPid !== this.#pid && alive(record.ownerPid)) continue; // a living sibling's
      const identity = await this.#deps.backend.identify(record.serial).catch(() => null);
      const stillOurs = identity !== null && identity.avd === record.avd && (record.pid === null || alive(record.pid));
      changed = true;
      if (!stillOurs) {
        this.#deps.log(`[sim] dropped stale ownership record for ${record.serial} (${record.avd}): not running as that AVD`);
        continue;
      }
      this.#owned.set(record.serial, { ...record, ownerPid: this.#pid });
      this.#deps.log(`[sim] adopted orphan ${record.serial} (${record.avd}) left by pack process ${record.ownerPid}`);
      this.#schedule(record.serial);
    }
    if (changed) this.#persist();
  }

  #persist(): void {
    const others = this.#deps.store.read().filter(record => record.ownerPid !== this.#pid && !this.#owned.has(record.serial));
    this.#deps.store.write([...others, ...this.#owned.values()]);
  }

  async boot(request: BootRequest, waitMs: number): Promise<BootOutcome> {
    await this.reconcile();
    const backend = this.#deps.backend;
    const avds = await backend.avds();
    const avd = request.avd ?? (avds.length === 1 ? avds[0] : undefined);

    if (avd !== undefined) {
      const pending = this.#booting.get(avd);
      if (pending) return this.#await(pending.handle, pending.settled, waitMs, true);
      const running = (await backend.list()).find(device => device.kind === "emulator" && device.name === avd);
      if (running) {
        this.touch(running.serial);
        return { device: { ...running, owned: this.isOwned(running.serial) }, pending: running.state === "booting", reused: true };
      }
    }

    const cap = this.#deps.settings().maxDevices;
    if (this.#owned.size >= cap) {
      const names = [...this.#owned.values()].map(record => `${record.serial} (${record.avd})`).join(", ");
      fail("device_cap", `this pack already booted ${this.#owned.size} emulator(s) (cap ${cap}, setting simulator.maxDevices): ${names}. Stop one with device_stop, or raise the cap.`);
    }

    const handle = await backend.startBoot(request);
    const record: OwnedRecord = { serial: handle.serial, avd: handle.avd, pid: handle.pid, bootedAt: (this.#deps.now ?? Date.now)(), ownerPid: this.#pid };
    this.#owned.set(handle.serial, record);
    this.#persist();
    this.#schedule(handle.serial);
    const settled = handle.ready.then(
      device => {
        this.#booting.delete(handle.avd);
        this.#deps.log(`[sim] ${handle.serial} (${handle.avd}) is up`);
        return device;
      },
      (error: unknown) => {
        this.#booting.delete(handle.avd);
        this.#release(handle.serial);
        this.#deps.log(`[sim] boot of ${handle.serial} (${handle.avd}) failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      },
    );
    settled.catch(() => undefined);
    this.#booting.set(handle.avd, { handle, settled });
    return this.#await(handle, settled, waitMs, false);
  }

  async #await(handle: BootHandle, settled: Promise<DeviceInfo>, waitMs: number, reused: boolean): Promise<BootOutcome> {
    const timeout = Promise.withResolvers<null>();
    const timer = setTimeout(() => timeout.resolve(null), waitMs);
    try {
      const device = await Promise.race([settled, timeout.promise]);
      if (device !== null) return { device: { ...device, owned: true }, pending: false, reused };
    } finally {
      clearTimeout(timer);
    }
    const placeholder: DeviceInfo = { serial: handle.serial, platform: "android", kind: "emulator", state: "booting", name: handle.avd, androidVersion: null, display: null, density: null, owned: true, live: false, viewers: 0 };
    return { device: placeholder, pending: true, reused };
  }

  async stop(serial: string): Promise<void> {
    await this.reconcile();
    const record = this.#owned.get(serial);
    if (record === undefined) {
      fail("not_owned", `${serial} was not booted by this pack, so the pack will not stop it. Close it yourself (its window, or \`adb -s ${serial} emu kill\`).`);
    }
    this.#deps.log(`[sim] stopping ${serial} (${record.avd})`);
    await this.#deps.backend.stop(serial, record.pid);
    this.#release(serial);
    this.#deps.log(`[sim] stopped ${serial}`);
  }

  #release(serial: string): void {
    this.#idle.get(serial)?.cancel();
    this.#idle.delete(serial);
    this.#viewers.delete(serial);
    if (this.#owned.delete(serial)) this.#persist();
  }

  /** A tool call, or anything else that shows the device is in use. */
  touch(serial: string): void {
    if (this.#owned.has(serial)) this.#schedule(serial);
  }

  /** A viewer attached or left. With none, the idle clock runs; with one, it does not. */
  setViewers(serial: string, count: number): void {
    this.#viewers.set(serial, count);
    if (this.#owned.has(serial)) this.#schedule(serial);
  }

  #schedule(serial: string): void {
    this.#idle.get(serial)?.cancel();
    this.#idle.delete(serial);
    if ((this.#viewers.get(serial) ?? 0) > 0) return;
    const minutes = this.#deps.settings().idleMinutes;
    const timer = (this.#deps.schedule ?? defaultSchedule)(() => {
      this.#deps.log(`[sim] idle-stop ${serial}: no viewer and no tool call for ${minutes} min`);
      void this.stop(serial).catch(error => this.#deps.log(`[sim] idle-stop of ${serial} failed: ${error instanceof Error ? error.message : String(error)}`));
    }, minutes * 60_000);
    this.#idle.set(serial, timer);
  }

  /** Pack exit: stop everything this pack booted. Bounded: a hung emulator must not hold the process. */
  async shutdown(budgetMs = 10_000): Promise<void> {
    for (const timer of this.#idle.values()) timer.cancel();
    this.#idle.clear();
    const serials = [...this.#owned.keys()];
    if (serials.length === 0) return;
    this.#deps.log(`[sim] shutdown: stopping ${serials.join(", ")}`);
    const budget = Promise.withResolvers<void>();
    const timer = setTimeout(() => budget.resolve(), budgetMs);
    await Promise.race([Promise.allSettled(serials.map(serial => this.stop(serial))), budget.promise]);
    clearTimeout(timer);
  }
}
