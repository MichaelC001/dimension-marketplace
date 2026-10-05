// The Android DeviceBackend: adb for everything a person or an agent does to a
// device, the emulator binary for booting one, scrcpy-server for live video.

import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BootHandle, BootObserver, DeviceBackend, OwnedProcess, ResolvedBoot, RunningEmulator, StopOutcome, VideoStream, VideoStreamHandlers, VideoStreamOptions } from "../backend";
import { type DeviceInfo, type DeviceKind, type DeviceState, fail, type KeyName, type Screenshot, type UiSnapshot } from "../contracts";
import { classifyDevice } from "../device-safety";
import type { Size } from "../shared/pointer";
import type { GpuMode } from "../settings";
import { fixFor, type Toolchain } from "../toolchain";
import { Adb } from "./adb";
import { type AdbEntry, type BootSample, bootFailureMessage, bootStalled, buildEmulatorArgs, consolePortOf, fallbackNote, freshEmulators, parseAvdName, pickSerial, SOFTWARE_GPU, STALL_POLICY, type StallPolicy } from "./emulator-boot";
import { isProcessAlive, nodeProcessTable, type ProcessTable, processVerdict, START_TOLERANCE_MS, treePorts, treeUsage } from "./process-table";
import { rawToPng } from "./png";
import { openVideoSession } from "./scrcpy";
import { KEYCODES } from "./scrcpy-wire";
import { parseUiDump } from "./ui-tree";

/** How long each part of a boot waits. The defaults are the measured ones; a test shrinks them. */
export interface BootTiming {
  /** Between looks at `adb devices` while the emulator starts. Boot-bounded: it ends when the device is found, the process dies or the budget runs out. */
  readonly pollMs: number;
  /** When a boot with no device counts as stalled, and on how little CPU. */
  readonly stall: StallPolicy;
  /** Between stall checks once the first is due (each reads the process table). */
  readonly stallCheckMs: number;
  /** The whole boot, spawn to `sys.boot_completed`. */
  readonly budgetMs: number;
  /** How long an emulator asked to close itself gets before its process tree is killed. */
  readonly stopGraceMs: number;
}

export const DEFAULT_BOOT_TIMING: BootTiming = { pollMs: 1_000, stall: STALL_POLICY, stallCheckMs: 15_000, budgetMs: 240_000, stopGraceMs: 20_000 };

export interface AndroidBackendDeps {
  /** The toolchain as it is NOW (the caller decides how often it is re-resolved). */
  readonly toolchain: () => Toolchain;
  readonly log: (message: string) => void;
  /** Where emulator logs go. */
  readonly logDir: string;
  /** The `-gpu` mode the person chose (`simulator.gpu`), read when a boot starts. */
  readonly gpu: () => GpuMode;
  /** The host's process and listener tables. The real ones unless a test supplies its own. */
  readonly processes?: ProcessTable;
  readonly timing?: Partial<BootTiming>;
  readonly now?: () => number;
}

interface Probe {
  readonly version: string | null;
  readonly booted: boolean;
  readonly avd: string | null;
  readonly model: string | null;
  readonly display: Size | null;
  readonly density: number | null;
  /** `ro.kernel.qemu`, `ro.boot.qemu`, `ro.hardware`, `ro.build.characteristics`: what says whether it is an emulator (see classifyDevice). */
  readonly kernelQemu: string | null;
  readonly bootQemu: string | null;
  readonly hardware: string | null;
  readonly characteristics: string | null;
}

/** One `adb shell` instead of six: marker lines, so a missing property cannot shift the rest. */
const PROBE_COMMAND = [
  "echo V=$(getprop ro.build.version.release)",
  "echo B=$(getprop sys.boot_completed)",
  "echo A=$(getprop ro.boot.qemu.avd_name)",
  "echo K=$(getprop ro.kernel.qemu.avd_name)",
  "echo M=$(getprop ro.product.model)",
  "echo Q=$(getprop ro.kernel.qemu)",
  "echo QB=$(getprop ro.boot.qemu)",
  "echo H=$(getprop ro.hardware)",
  "echo C=$(getprop ro.build.characteristics)",
  "wm size",
  "wm density",
].join("; ");

export function parseProbe(output: string): Probe {
  const field = (marker: string): string | null => {
    const value = new RegExp(`^${marker}=(.*)$`, "m").exec(output)?.[1]?.trim();
    return value ? value : null;
  };
  // An override (set with `wm size`/`wm density`) is what input coordinates are in; it prints after the physical value.
  const sizes = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const lastSize = sizes.at(-1);
  const densities = [...output.matchAll(/(?:Physical|Override) density:\s*(\d+)/g)];
  const lastDensity = densities.at(-1);
  return {
    version: field("V"),
    booted: field("B") === "1",
    avd: field("A") ?? field("K"),
    model: field("M"),
    display: lastSize?.[1] && lastSize[2] ? { width: Number(lastSize[1]), height: Number(lastSize[2]) } : null,
    density: lastDensity?.[1] ? Number(lastDensity[1]) : null,
    kernelQemu: field("Q"),
    bootQemu: field("QB"),
    hardware: field("H"),
    characteristics: field("C"),
  };
}

const BOOT_COMPLETED_LOOP = 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done';
/** An emulator log past this is started afresh at the next launch. */
const LOG_ROTATE_BYTES = 1024 * 1024;

/** What one boot is, across a graphics fallback. */
interface BootContext {
  readonly avd: string;
  readonly request: ResolvedBoot;
  readonly emulator: string;
  readonly adb: Adb;
  readonly observer: BootObserver;
  /** adb's devices before the first spawn. */
  readonly before: readonly AdbEntry[];
  readonly baked: boolean;
  readonly timing: BootTiming;
  fellBack: boolean;
}

/** One spawned emulator process. */
interface Launch {
  readonly process: OwnedProcess;
  readonly gpu: GpuMode;
  readonly logPath: string;
  exited: boolean;
  code: number | null;
  /** Settles with the exit code when the process ends. */
  readonly exit: Promise<number | null>;
}

type Watch =
  | { readonly kind: "found"; readonly serial: string }
  | { readonly kind: "exited" }
  | { readonly kind: "timeout" }
  | { readonly kind: "stalled"; readonly sample: BootSample };

export class AndroidBackend implements DeviceBackend {
  readonly platform = "android" as const;
  readonly #deps: AndroidBackendDeps;
  readonly #adbs = new Map<string, Adb>();
  readonly #static = new Map<string, Probe>();
  readonly #displays = new Map<string, Size>();
  /** Emulators this backend spawned and still holds the handle of. */
  readonly #launches = new Map<number, Launch>();
  readonly #table: ProcessTable;

  constructor(deps: AndroidBackendDeps) {
    this.#deps = deps;
    this.#table = deps.processes ?? nodeProcessTable();
  }

  #adb(): Adb {
    const toolchain = this.#deps.toolchain();
    const path = toolchain.adb;
    if (path === null) fail("missing_adb", `adb is not installed or not found. ${fixFor(toolchain, "adb")}`);
    let adb = this.#adbs.get(path);
    if (adb === undefined) {
      adb = new Adb(path);
      this.#adbs.set(path, adb);
    }
    return adb;
  }

  liveAvailable(): boolean {
    return this.#deps.toolchain().scrcpyServer !== null;
  }

  async list(): Promise<DeviceInfo[]> {
    const adb = this.#adb();
    const devices = await adb.devices();
    const live = new Set(devices.map(device => device.serial));
    for (const serial of this.#static.keys()) if (!live.has(serial)) this.#static.delete(serial);
    return Promise.all(
      devices.map(async (device): Promise<DeviceInfo> => {
        const base = { serial: device.serial, platform: "android" as const, owned: false, live: false, viewers: 0 };
        const emulator = consolePortOf(device.serial) !== null;
        if (device.state !== "device") {
          const state: DeviceState = device.state === "unauthorized" ? "unauthorized" : "offline";
          // An emulator adb cannot talk to yet still answers on its console: it knows which AVD it is.
          const name = (emulator ? await this.#consoleAvd(adb, device.serial) : null) ?? device.model ?? device.serial;
          return { ...base, kind: classifyDevice({ serial: device.serial }), state, name, androidVersion: null, display: null, density: null };
        }
        // A device that has just appeared and does not answer a shell yet is still booting: not a reason for the whole list to fail.
        const probe = await this.#probe(adb, device.serial).catch(() => null);
        const display = probe?.display ?? this.#displays.get(device.serial) ?? null;
        if (probe?.display) this.#displays.set(device.serial, probe.display);
        const consoleName = emulator && (probe?.avd ?? null) === null ? await this.#consoleAvd(adb, device.serial) : null;
        return {
          ...base,
          kind: classifyDevice({ serial: device.serial, ...probe }),
          state: probe?.booted === true ? "online" : "booting",
          name: probe?.avd ?? consoleName ?? probe?.model ?? device.model ?? device.serial,
          androidVersion: probe?.version ?? null,
          display,
          density: probe?.density ?? null,
        };
      }),
    );
  }

  async kindOf(serial: string): Promise<DeviceKind> {
    // An emulator names itself `emulator-<console port>`: the common case needs no round trip.
    if (classifyDevice({ serial }) === "emulator") return "emulator";
    const adb = this.#adb();
    const listed = (await adb.devices()).find(device => device.serial === serial);
    if (listed === undefined) fail("not_connected", `${serial} is not connected. Run device_list to see what is, or device_boot to start an emulator.`);
    if (listed.state !== "device") return classifyDevice({ serial });
    // Asked of the device itself every time, never cached: a serial (a Wi-Fi address, say) can be reused by a different device. A probe that fails leaves "physical".
    const probe = await adb.shell(serial, PROBE_COMMAND, { timeoutMs: 10_000 }).then(parseProbe, () => null);
    return classifyDevice({ serial, ...probe });
  }

  async #probe(adb: Adb, serial: string): Promise<Probe> {
    try {
      const probe = parseProbe(await adb.shell(serial, PROBE_COMMAND, { timeoutMs: 10_000 }));
      // Identity does not change while the device runs; boot state and size do.
      this.#static.set(serial, probe);
      return probe;
    } catch (error) {
      const known = this.#static.get(serial);
      if (known) return { ...known, booted: false };
      throw error;
    }
  }

  async avds(): Promise<string[]> {
    const emulator = this.#deps.toolchain().emulator;
    if (emulator === null) return [];
    const { promise, resolve } = Promise.withResolvers<string[]>();
    const child = spawn(emulator, ["-list-avds"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", chunk => {
      out += chunk.toString();
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.split(/\r?\n/).map(line => line.trim()).filter(line => line !== "" && !line.startsWith("INFO") && !line.includes(" ")));
    });
    child.on("error", () => resolve([]));
    return promise;
  }

  // ── booting ───────────────────────────────────────────────────────────────
  //
  // The pack spawns the emulator WITHOUT a port (it takes the first free pair, so it can never
  // collide with one the person runs), then learns which serial is its own from the process it
  // spawned: the tree listens on that console port. Everything it later does to that emulator
  // (stop, kill after a stall, kill after a failed boot) acts on that process tree, verified by
  // pid AND start time, and never on a serial.

  async startBoot(request: ResolvedBoot, observer: BootObserver): Promise<BootHandle> {
    const toolchain = this.#deps.toolchain();
    const { emulator } = toolchain;
    if (emulator === null) fail("missing_emulator", `the Android emulator is not installed or not found. ${fixFor(toolchain, "emulator")}`);
    const adb = this.#adb();
    const { avd } = request;
    const avds = await this.avds();
    if (!avds.includes(avd)) fail("unknown_avd", `no AVD named "${avd}". Available: ${avds.join(", ") || "none"}`);

    // What adb shows before the spawn is not ours, whatever appears next to it.
    const before = (await adb.devices()).map(({ serial, state }): AdbEntry => ({ serial, state }));
    const baked = existsSync(join(avdHome(), `${avd}.avd`, "snapshots", "avdslim_clean"));
    const ctx: BootContext = { avd, request, emulator, adb, observer, before, baked, timing: { ...DEFAULT_BOOT_TIMING, ...this.#deps.timing }, fellBack: false };
    const first = await this.#launch(ctx, this.#deps.gpu());
    const ready = this.#supervise(ctx, first);
    ready.catch(() => undefined);
    return { avd, ready };
  }

  /** Spawn the emulator and tell the observer which process it is, before anything else can fail. */
  async #launch(ctx: BootContext, gpu: GpuMode): Promise<Launch> {
    const { avd, request } = ctx;
    const readOnly = request.readOnly === true;
    const args = buildEmulatorArgs({ avd, headless: request.headless === true, cold: request.cold === true, bakedSnapshot: ctx.baked, gpu, ...(readOnly ? { readOnly } : {}) });
    mkdirSync(this.#deps.logDir, { recursive: true });
    const logPath = join(this.#deps.logDir, `${avd}${readOnly ? ".read-only" : ""}.log`);
    const fd = openSync(logPath, existsSync(logPath) && statSync(logPath).size > LOG_ROTATE_BYTES ? "w" : "a");
    const startedAt = this.#now();
    // The argv, first: the log then shows exactly what the pack asked for.
    writeSync(fd, `\n--- ${new Date(startedAt).toISOString()} the pack launches: emulator ${args.join(" ")}\n`);
    const child = spawn(ctx.emulator, args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    child.unref();
    const failure = (reason: string): Error => new Error(bootFailureMessage(reason, { path: logPath, text: readLogTail(logPath) }));
    const spawnError = Promise.withResolvers<Error>();
    const exit = Promise.withResolvers<number | null>();
    child.once("error", spawnError.resolve);
    if (child.pid === undefined) throw failure(`could not start the emulator: ${(await spawnError.promise).message}`);

    const launch: Launch = { process: { pid: child.pid, startedAt }, gpu, logPath, exited: false, code: null, exit: exit.promise };
    const done = (code: number | null): void => {
      launch.exited = true;
      launch.code = code;
      this.#launches.delete(launch.process.pid);
      exit.resolve(code);
    };
    child.once("exit", done);
    void spawnError.promise.then(() => done(null));
    this.#launches.set(launch.process.pid, launch);
    ctx.observer.spawned(launch.process);
    this.#deps.log(`[sim] booting ${avd} (pid ${launch.process.pid}, ${request.headless ? "headless" : "windowed"}, ${request.cold ? "cold" : ctx.baked ? "baked snapshot" : "default snapshot"}, -gpu ${gpu}${readOnly ? ", read-only" : ""}); log ${logPath}`);
    return launch;
  }

  /** Watch one launch until the device is up, the process dies, the boot stalls or the budget ends; on a stall, relaunch ONCE with software graphics. Anything that fails leaves nothing of the pack's running. */
  async #supervise(ctx: BootContext, first: Launch): Promise<DeviceInfo> {
    let launch = first;
    for (;;) {
      const seen = await this.#watch(ctx, launch);
      const fallenBack = ctx.fellBack ? " (It had already fallen back to software graphics.)" : "";
      const failure = (reason: string): Error => new Error(bootFailureMessage(`${reason}${fallenBack}`, { path: launch.logPath, text: readLogTail(launch.logPath) }));
      switch (seen.kind) {
        case "found":
          return this.#finish(ctx, launch, seen.serial, failure);
        case "exited":
          throw failure(`the emulator for ${ctx.avd} exited with code ${launch.code ?? "?"} before it finished booting.`);
        case "timeout":
          await this.#end(launch);
          throw failure(`the emulator for ${ctx.avd} did not show up in adb within ${Math.round(ctx.timing.budgetMs / 1000)} s; the pack stopped it.`);
        case "stalled": {
          await this.#end(launch);
          const seconds = Math.round(seen.sample.elapsedMs / 1000);
          if (ctx.fellBack || launch.gpu === SOFTWARE_GPU) {
            throw failure(`the emulator for ${ctx.avd} showed no sign of booting after ${seconds} s (${seen.sample.cpuSeconds?.toFixed(1) ?? "?"} s of CPU, no adb device, -gpu ${launch.gpu}); the pack stopped it.`);
          }
          const note = fallbackNote(seen.sample, launch.gpu);
          this.#deps.log(`[sim] ${ctx.avd}: ${note}`);
          ctx.observer.note(note);
          ctx.fellBack = true;
          launch = await this.#launch(ctx, SOFTWARE_GPU);
          break;
        }
      }
    }
  }

  async #watch(ctx: BootContext, launch: Launch): Promise<Watch> {
    const { timing } = ctx;
    let nextStallCheck = launch.process.startedAt + timing.stall.afterMs;
    for (;;) {
      if (launch.exited) return { kind: "exited" };
      const serial = await this.#findSerial(ctx, launch).catch(() => null);
      if (serial !== null) return { kind: "found", serial };
      if (this.#now() - launch.process.startedAt >= timing.budgetMs) return { kind: "timeout" };
      if (this.#now() >= nextStallCheck) {
        nextStallCheck = this.#now() + timing.stallCheckMs;
        const sample = await this.#sample(launch);
        if (bootStalled(sample, timing.stall)) return { kind: "stalled", sample };
      }
      await Promise.race([delay(timing.pollMs), launch.exit]);
    }
  }

  /** The wait that follows the serial: Android itself reaching `sys.boot_completed`. */
  async #finish(ctx: BootContext, launch: Launch, serial: string, failure: (reason: string) => Error): Promise<DeviceInfo> {
    ctx.observer.serial(serial);
    this.#deps.log(`[sim] ${ctx.avd} (pid ${launch.process.pid}) answers as ${serial}`);
    const abort = new AbortController();
    void launch.exit.then(() => abort.abort());
    try {
      await this.#bootCompleted(ctx.adb, serial, Math.max(10_000, ctx.timing.budgetMs - (this.#now() - launch.process.startedAt)), abort.signal);
    } catch (error) {
      if (launch.exited) throw failure(`the emulator for ${ctx.avd} exited with code ${launch.code ?? "?"} before it finished booting.`);
      await this.#end(launch);
      throw failure(error instanceof Error ? error.message : String(error));
    }
    const info = (await this.list()).find(device => device.serial === serial);
    if (info === undefined) throw failure(`${serial} booted but is not listed by adb.`);
    return info;
  }

  /** The serial of the emulator under `launch`, or null while it cannot be told. */
  async #findSerial(ctx: BootContext, launch: Launch): Promise<string | null> {
    const after = (await ctx.adb.devices()).map(({ serial, state }): AdbEntry => ({ serial, state }));
    // Nothing new to look at: no reason to read the process table.
    if (freshEmulators(ctx.before, after).length === 0) return null;
    const pick = pickSerial({ before: ctx.before, after, treePorts: await this.#consolePorts(launch.process.pid) });
    if (pick === null) return null;
    // Without a listener list the only newcomer is a guess: the emulator itself says whether it is our AVD.
    if (pick.basis === "diff" && (await this.#consoleAvd(ctx.adb, pick.serial)) !== ctx.avd) return null;
    return pick.serial;
  }

  /** TCP ports the process tree under `pid` listens on; null when the host cannot list processes or listeners. */
  async #consolePorts(pid: number): Promise<number[] | null> {
    const [rows, listeners] = await Promise.all([this.#table.processes().catch(() => null), this.#table.listeners().catch(() => null)]);
    return rows === null ? null : treePorts(rows, listeners, pid);
  }

  async #sample(launch: Launch): Promise<BootSample> {
    const rows = await this.#table.processes().catch(() => null);
    const usage = rows === null ? null : treeUsage(rows, launch.process.pid);
    return { elapsedMs: this.#now() - launch.process.startedAt, alive: !launch.exited, deviceSeen: false, cpuSeconds: usage === null ? null : usage.cpuSeconds };
  }

  /** Stop what a boot spawned, and wait (briefly) until it is gone. */
  async #end(launch: Launch): Promise<void> {
    await this.#kill(launch.process);
    await Promise.race([launch.exit, delay(5_000)]);
  }

  /** Kill the tree under `target` if, and only if, it is still the process the pack spawned. */
  async #kill(target: OwnedProcess): Promise<"ours" | "gone" | "reused" | "unknown"> {
    const verdict = await this.processState(target);
    if (verdict !== "ours") {
      if (verdict !== "gone") this.#deps.log(`[sim] not killing pid ${target.pid}: ${verdict === "reused" ? "it started at another time, so the pid now belongs to something else" : "the process table could not be read, so it cannot be verified"}`);
      return verdict;
    }
    // Windows' taskkill /T finds the children itself; elsewhere the listed ones are signalled too.
    const rows = process.platform === "win32" ? [] : await this.#table.processes().catch(() => []);
    await this.#table.killTree(target.pid, rows);
    return verdict;
  }

  async processState(target: OwnedProcess): Promise<"ours" | "gone" | "reused" | "unknown"> {
    // A child this process spawned and still holds: the live handle proves the pid is ours, no table needed.
    const launch = this.#launches.get(target.pid);
    if (launch !== undefined && !launch.exited && Math.abs(launch.process.startedAt - target.startedAt) <= START_TOLERANCE_MS) return "ours";
    return processVerdict(await this.#table.processes().catch(() => null), target);
  }

  async serialOf(target: OwnedProcess): Promise<string | null> {
    const adb = this.#adb();
    const [rows, listeners, devices] = await Promise.all([this.#table.processes().catch(() => null), this.#table.listeners().catch(() => null), adb.devices().catch(() => null)]);
    if (rows === null || devices === null) return null;
    const live = this.#launches.get(target.pid);
    if ((live === undefined || live.exited) && processVerdict(rows, target) !== "ours") return null;
    const ports = treePorts(rows, listeners, target.pid);
    if (ports === null) return null;
    return pickSerial({ before: [], after: devices.map(({ serial, state }): AdbEntry => ({ serial, state })), treePorts: ports })?.serial ?? null;
  }

  async stop(target: OwnedProcess, serial: string | null): Promise<StopOutcome> {
    const verdict = await this.processState(target);
    if (verdict === "unknown") {
      fail("cannot_verify", `the pack could not read the host's process table, so it cannot prove that pid ${target.pid} is the emulator it started, and it stops nothing it cannot prove. Close the emulator yourself.`);
    }
    if (serial !== null) {
      this.#static.delete(serial);
      this.#displays.delete(serial);
    }
    // Gone: nothing runs. Reused: the pid is somebody else's process now, and is never touched.
    if (verdict !== "ours") return "already-exited";
    // Ask it to close itself, but only through a console that is demonstrably this process's own.
    if (serial !== null && (await this.serialOf(target)) === serial) {
      await this.#adb().run(serial, ["emu", "kill"], { timeoutMs: 15_000 }).catch(() => undefined);
      await this.#exitWithin(target, this.#timing().stopGraceMs);
    }
    if (this.#alive(target.pid)) {
      await this.#kill(target);
      await this.#exitWithin(target, 5_000);
    }
    return "stopped";
  }

  #alive(pid: number): boolean {
    const launch = this.#launches.get(pid);
    return launch === undefined ? isProcessAlive(pid) : !launch.exited;
  }

  async #exitWithin(target: OwnedProcess, ms: number): Promise<void> {
    const deadline = this.#now() + ms;
    while (this.#alive(target.pid) && this.#now() < deadline) await delay(250);
  }

  async runningEmulators(): Promise<RunningEmulator[]> {
    const adb = this.#adb();
    const emulators = (await adb.devices()).filter(device => consolePortOf(device.serial) !== null);
    const named = await Promise.all(emulators.map(async device => ({ serial: device.serial, avd: await this.#consoleAvd(adb, device.serial) })));
    return named.flatMap(emulator => (emulator.avd === null ? [] : [{ serial: emulator.serial, avd: emulator.avd }]));
  }

  /** The emulator's own answer to "which AVD are you?" (`adb -s <serial> emu avd name`): its console replies while Android is still starting, which `getprop` cannot. */
  async #consoleAvd(adb: Adb, serial: string): Promise<string | null> {
    return adb.text(serial, ["emu", "avd", "name"], { timeoutMs: 5_000 }).then(parseAvdName, () => null);
  }

  async waitBooted(serial: string, timeoutMs: number): Promise<DeviceInfo | null> {
    try {
      await this.#bootCompleted(this.#adb(), serial, timeoutMs);
    } catch {
      return null;
    }
    return (await this.list()).find(device => device.serial === serial) ?? null;
  }

  #bootCompleted(adb: Adb, serial: string, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
    return adb.run(serial, ["wait-for-device", "shell", BOOT_COMPLETED_LOOP], { timeoutMs, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #timing(): BootTiming {
    return { ...DEFAULT_BOOT_TIMING, ...this.#deps.timing };
  }

  async display(serial: string): Promise<Size> {
    const known = this.#displays.get(serial);
    if (known) return known;
    const probe = await this.#probe(this.#adb(), serial);
    if (probe.display === null) fail("no_display", `${serial} did not report a display size; is it fully booted?`);
    this.#displays.set(serial, probe.display);
    return probe.display;
  }

  async screenshot(serial: string, maxEdge: number): Promise<Screenshot> {
    const adb = this.#adb();
    const raw = await adb.execOut(serial, ["screencap"], { timeoutMs: 20_000 });
    const shot = await rawToPng(raw, maxEdge);
    this.#displays.set(serial, shot.source);
    return { png: shot.png, width: shot.width, height: shot.height, scale: shot.scale, display: shot.source };
  }

  async tap(serial: string, x: number, y: number): Promise<void> {
    await this.#adb().shell(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(serial: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void> {
    await this.#adb().shell(serial, `input swipe ${Math.round(from.x)} ${Math.round(from.y)} ${Math.round(to.x)} ${Math.round(to.y)} ${Math.round(durationMs)}`);
  }

  async text(serial: string, text: string): Promise<void> {
    if (!/^[\x20-\x7e]*$/.test(text)) fail("text_not_ascii", "device_type sends printable ASCII through adb. For other characters, open the pane (device_open) so a live session can type them, or paste them from the app.");
    // `input text` reads %s as a space; the quotes stop the device shell reading anything else.
    const body = text.replaceAll(" ", "%s").replaceAll("'", "'\\''");
    await this.#adb().shell(serial, `input text '${body}'`);
  }

  async key(serial: string, key: KeyName): Promise<void> {
    const code = KEYCODES[key];
    if (code === undefined) fail("unknown_key", `unknown key "${key}".`);
    await this.#adb().shell(serial, `input keyevent ${code}`);
  }

  async openUrl(serial: string, url: string): Promise<void> {
    const out = await this.#adb().shell(serial, `am start -W -a android.intent.action.VIEW -d '${url.replaceAll("'", "'\\''")}'`);
    if (/Error:|Exception/.test(out)) fail("open_url_failed", `no app on ${serial} could open ${url}: ${out.trim().split("\n").find(line => /Error/.test(line)) ?? out.trim().slice(0, 160)}`);
  }

  async install(serial: string, apkPath: string): Promise<string> {
    if (!existsSync(apkPath) || !statSync(apkPath).isFile()) fail("apk_not_found", `no file at ${apkPath}. Pass the absolute path of a built .apk.`);
    if (!apkPath.toLowerCase().endsWith(".apk")) fail("apk_not_apk", `${apkPath} is not an .apk. For an .aab or split APKs, use bundletool to build a universal .apk first.`);
    const out = await this.#adb().text(serial, ["install", "-r", "-g", "-t", apkPath], { timeoutMs: 180_000 });
    return out.trim().split(/\r?\n/).filter(line => line !== "").pop() ?? "Success";
  }

  async launch(serial: string, target: string): Promise<void> {
    if (!/^[A-Za-z0-9_.]+(\/[A-Za-z0-9_.$]+)?$/.test(target)) fail("bad_package", `"${target}" is not a package name (com.example.app) or a component (com.example.app/.MainActivity).`);
    const out = target.includes("/")
      ? await this.#adb().shell(serial, `am start -n ${target}`)
      : await this.#adb().shell(serial, `monkey -p ${target} -c android.intent.category.LAUNCHER 1`);
    if (/No activities found|Error:|does not exist/.test(out)) fail("launch_failed", `could not launch ${target}: it is not installed on ${serial}, or has no launcher activity. device_install the .apk first.`);
  }

  async uiTree(serial: string): Promise<UiSnapshot> {
    const adb = this.#adb();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const snapshot = parseUiDump((await adb.execOut(serial, ["uiautomator", "dump", "/dev/tty"], { timeoutMs: 25_000 })).toString("utf8"));
        if (snapshot.nodes.length > 0) {
          this.#displays.set(serial, snapshot.display);
          return snapshot;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw lastError instanceof Error ? lastError : new Error("uiautomator returned an empty hierarchy; the screen may be secure or mid-transition. Retry in a second.");
  }

  async openStream(serial: string, options: VideoStreamOptions, handlers: VideoStreamHandlers): Promise<VideoStream> {
    const toolchain = this.#deps.toolchain();
    const { scrcpyServer } = toolchain;
    if (scrcpyServer === null) fail("missing_scrcpy", `live video needs scrcpy-server (not found). ${fixFor(toolchain, "scrcpy-server")}`);
    return openVideoSession({ adb: this.#adb(), serverPath: scrcpyServer, log: this.#deps.log }, serial, options, handlers);
  }
}

/** The AVD directory, by the SDK's own rule: ANDROID_AVD_HOME, ANDROID_USER_HOME/avd, then ~/.android/avd. */
function avdHome(): string {
  const env = process.env;
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_USER_HOME) return join(env.ANDROID_USER_HOME, "avd");
  return join(homedir(), ".android", "avd");
}

/** The end of a log file (at most 64 KiB), or null when it cannot be read. */
function readLogTail(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
