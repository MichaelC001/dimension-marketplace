// What an emulator boot is made of, as pure functions: the argv, the verdict that
// a boot has stalled, the choice of which adb serial is the one this pack started,
// and the words a boot is reported in. No process, no file, no clock: the backend
// does the I/O and feeds these.

import type { GpuMode } from "../settings";

/** The RAM the pack gives a slim emulator (MB): what avdslim boots the same AVDs with. */
export const DEFAULT_MEMORY_MB = 1536;

/** The golden snapshot `avdslim bake` leaves in an AVD. */
export const BAKED_SNAPSHOT = "avdslim_clean";

/** The graphics mode that needs no GPU at all: what a boot falls back to when the host GPU never answers. */
export const SOFTWARE_GPU: GpuMode = "swiftshader_indirect";

export interface EmulatorArgsInput {
  readonly avd: string;
  /** No window: nothing on the user's screen. */
  readonly headless: boolean;
  /** Ignore any saved snapshot and boot from scratch. */
  readonly cold: boolean;
  /** The AVD has the `avdslim_clean` snapshot (ignored for a cold boot). */
  readonly bakedSnapshot: boolean;
  /** The emulator's `-gpu` mode (the `simulator.gpu` setting, or the software fallback). */
  readonly gpu: GpuMode;
  /** A second instance of an AVD that already runs: the emulator's own `-read-only` (its changes are discarded when it stops). */
  readonly readOnly?: boolean;
  readonly memoryMb?: number;
}

/**
 * The emulator's own flags, never `-qemu` passthrough: `-lowram` is an emulator
 * option, and Android Emulator 37 rejects it after `-qemu` ("-lowram: invalid
 * option"). The set is avdslim's, which boots these AVDs: the memory and CPU a
 * simulator pane would otherwise spend on audio, cameras and the boot animation.
 *
 * There is NO `-port`. A forced console port collides with an emulator the person
 * already runs on it; left alone, the emulator takes the first free pair itself and
 * the pack learns which one is its own (`pickSerial`).
 */
export function buildEmulatorArgs(input: EmulatorArgsInput): string[] {
  const args = [
    "-avd", input.avd,
    "-memory", String(input.memoryMb ?? DEFAULT_MEMORY_MB),
    "-gpu", input.gpu,
    "-no-audio",
    "-camera-back", "none",
    "-camera-front", "none",
    "-no-boot-anim",
    "-lowram",
  ];
  if (input.headless) args.push("-no-window");
  if (input.readOnly === true) args.push("-read-only");
  if (input.cold) args.push("-no-snapshot-load");
  else if (input.bakedSnapshot) args.push("-snapshot", BAKED_SNAPSHOT);
  // Stopping an emulator kills it: saving a snapshot first would only slow the stop.
  args.push("-no-snapshot-save");
  return args;
}

// ── the stall verdict ────────────────────────────────────────────────────────

/** What is known about a boot that has not produced a device yet. */
export interface BootSample {
  /** Milliseconds since the emulator process was spawned. */
  readonly elapsedMs: number;
  /** The spawned process is still running. */
  readonly alive: boolean;
  /** An adb device has appeared for it (its console was matched to this process). */
  readonly deviceSeen: boolean;
  /** CPU seconds used by the spawned process and everything under it; null = the host could not say. */
  readonly cpuSeconds: number | null;
}

export interface StallPolicy {
  /** A boot younger than this is never called stalled. */
  readonly afterMs: number;
  /** Used less CPU than this over `afterMs`: it is waiting on something, not booting. */
  readonly maxCpuSeconds: number;
}

/**
 * Measured: with `-gpu auto` on a busy host GPU the qemu process sat at ~0.6 s of
 * CPU and 106 MB for 80+ s with no adb device; a healthy boot of the same AVD is
 * past 10 s of CPU by then and shows a device within ~50 s.
 */
export const STALL_POLICY: StallPolicy = { afterMs: 75_000, maxCpuSeconds: 3 };

/**
 * Is this boot hung rather than slow? True only when the process is alive, no device
 * has appeared for it, it is old enough, and it has used almost no CPU. A CPU reading
 * that could not be taken is never a reason to kill a process.
 */
export function bootStalled(sample: BootSample, policy: StallPolicy = STALL_POLICY): boolean {
  if (!sample.alive || sample.deviceSeen) return false;
  if (sample.elapsedMs < policy.afterMs) return false;
  if (sample.cpuSeconds === null) return false;
  return sample.cpuSeconds < policy.maxCpuSeconds;
}

/** Said in the tool result when the pack stopped a stalled boot and relaunched it with software graphics. */
export function fallbackNote(sample: BootSample, gpu: GpuMode): string {
  const seconds = Math.round(sample.elapsedMs / 1000);
  const cpu = sample.cpuSeconds === null ? "" : `, ${sample.cpuSeconds.toFixed(1)} s of CPU`;
  return `Fell back to software graphics: with -gpu ${gpu} the emulator showed no adb device after ${seconds} s${cpu}, which means it is waiting on the host GPU (busy or unavailable). The pack stopped that emulator and relaunched it once with -gpu ${SOFTWARE_GPU}: slower to draw, but it needs no GPU. Set simulator.gpu to ${SOFTWARE_GPU} to skip the wait.`;
}

// ── which adb serial is ours ─────────────────────────────────────────────────

export interface AdbEntry {
  readonly serial: string;
  /** adb's own state word: device, offline, unauthorized, ... */
  readonly state: string;
}

const EMULATOR_SERIAL = /^emulator-(\d+)$/;

/** The console port an `emulator-<port>` serial names; null for any other serial. */
export function consolePortOf(serial: string): number | null {
  const port = EMULATOR_SERIAL.exec(serial)?.[1];
  return port === undefined ? null : Number(port);
}

/** Emulators adb shows now that it did not show before the spawn, or that changed state since (a stale `offline` entry whose port the new emulator took). */
export function freshEmulators(before: readonly AdbEntry[], after: readonly AdbEntry[]): string[] {
  const known = new Map(before.map(entry => [entry.serial, entry.state]));
  return after.filter(entry => consolePortOf(entry.serial) !== null && known.get(entry.serial) !== entry.state).map(entry => entry.serial);
}

export interface SerialSearch {
  readonly before: readonly AdbEntry[];
  readonly after: readonly AdbEntry[];
  /** The TCP ports the spawned process and its children listen on; null = the host could not list them. */
  readonly treePorts: readonly number[] | null;
}

export interface SerialPick {
  readonly serial: string;
  /** `process`: the spawned process tree listens on that serial's console port. `diff`: the only emulator that appeared (used when the host cannot list listeners, and confirmed by the AVD's name). */
  readonly basis: "process" | "diff";
}

/**
 * The serial of the emulator THIS pack spawned, or null while it cannot be told yet.
 * An emulator is ours when the process we spawned (or its children) listens on its
 * console port: nobody else's emulator can pass that. Without a listener list the
 * only emulator that appeared since the spawn is the candidate, and the caller
 * confirms it by asking the emulator which AVD it is. Two newcomers and no listener
 * list is "not yet": a guess here would later stop somebody else's device.
 */
export function pickSerial(search: SerialSearch): SerialPick | null {
  if (search.treePorts !== null) {
    const ports = search.treePorts;
    const mine = search.after.filter(entry => {
      const port = consolePortOf(entry.serial);
      return port !== null && ports.includes(port);
    });
    const first = mine.sort((a, b) => (consolePortOf(a.serial) ?? 0) - (consolePortOf(b.serial) ?? 0))[0];
    return first === undefined ? null : { serial: first.serial, basis: "process" };
  }
  const fresh = freshEmulators(search.before, search.after);
  const only = fresh.length === 1 ? fresh[0] : undefined;
  return only === undefined ? null : { serial: only, basis: "diff" };
}

// ── words ────────────────────────────────────────────────────────────────────

/** The last `count` lines of `text`, trailing blank lines not counted. */
export function lastLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  return lines.slice(-count);
}

/** What the emulator's log says the user can act on, in the pack's tools. null = nothing known. */
export function bootFailureHint(logText: string | null): string | null {
  if (logText !== null && /Running multiple emulators with the same AVD/i.test(logText)) {
    return "That AVD is already running (started by you, or by an earlier boot). device_boot returns the running one instead of starting it again; pass readOnly: true for a second, throwaway instance of it.";
  }
  return null;
}

/** A boot failure as the tool reports it: the reason, then the end of the emulator's own log, which is where the emulator says what it did not like. */
export function bootFailureMessage(reason: string, log: { readonly path: string; readonly text: string | null }, count = 15): string {
  const tail = log.text === null ? [] : lastLines(log.text, count);
  const hint = bootFailureHint(log.text);
  const head = hint === null ? reason : `${reason} ${hint}`;
  if (tail.length === 0) return `${head}\nThe emulator log (${log.path}) is empty or could not be read.`;
  return `${head}\nLast ${tail.length} line${tail.length === 1 ? "" : "s"} of the emulator log (${log.path}):\n${tail.join("\n")}`;
}

/** `adb -s <serial> emu avd name` prints the AVD's name, then `OK` (or `KO: <why>`): the name, or null when the console refused. */
export function parseAvdName(output: string): string | null {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line !== "");
  if (lines.some(line => line.startsWith("KO"))) return null;
  return lines.find(line => line !== "OK" && !line.startsWith("Android Console")) ?? null;
}
