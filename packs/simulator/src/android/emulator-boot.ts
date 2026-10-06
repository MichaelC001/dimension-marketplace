// What an emulator boot is made of, as pure functions: the argv, the verdict that
// a boot has stalled, the choice of which adb serial is the one this pack started,
// what to do about an emulator the system froze, what a relaunch has to wait for,
// and the words a boot is reported in. No process, no file, no clock: the backend
// does the I/O and feeds these.

import { join } from "node:path";
import type { GpuMode } from "../settings";
import { type ProcessRow, treeSurvivors } from "./process-table";

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

// ── an emulator the system froze ─────────────────────────────────────────────

/**
 * Measured on Windows: the qemu process of three launches sat with ALL its threads in a
 * suspended wait (security software, a game's anti-cheat or Game Mode can do that) at
 * 0.3-0.6 s of CPU, which looks exactly like a hung GPU; waiting does not thaw it and
 * a relaunch is frozen the same way. Resuming it (NtResumeProcess) made it run at once.
 */
export interface SuspendPolicy {
  /** First look at the emulator's threads, after the spawn: past the launcher starting qemu, long before the stall verdict. */
  readonly firstCheckMs: number;
  /** Between looks while it runs. */
  readonly checkMs: number;
  /** Between a resume and the look that shows whether it took (and resumes again if it did not). */
  readonly recheckMs: number;
  /** Resumes one boot may spend, across its relaunches: an emulator something keeps freezing is reported, not nursed. */
  readonly maxResumes: number;
}

export const SUSPEND_POLICY: SuspendPolicy = { firstCheckMs: 8_000, checkMs: 10_000, recheckMs: 5_000, maxResumes: 3 };

/** Said in the tool result when the pack found the emulator suspended and resumed it. */
export const RESUMED_NOTE =
  "Resumed a frozen emulator: the emulator process had been suspended by the system (security software, a game's anti-cheat or Game Mode can do that); the pack resumed it. That is not a graphics problem, so the boot went on and was not relaunched.";

/** Why a boot failed when the emulator was still suspended after every resume the pack was allowed (`attempts` of them, whether or not the host accepted each). */
export function stillSuspendedReason(avd: string, attempts: number): string {
  const tried = attempts === 0 ? "the pack could not resume it" : `resuming it (${attempts} attempt${attempts === 1 ? "" : "s"}) did not last`;
  return `the emulator process for ${avd} is suspended by the system (security software, a game's anti-cheat or Game Mode can do that) and ${tried}, so it never booted; the pack stopped it. A relaunch, with software graphics too, would be frozen the same way: close what is freezing it, then boot again.`;
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

const EMULATOR_IMAGE = /^(?:emulator(?:64)?(?:-(?:x86|arm|arm64|mips|headless))?|qemu-system-[\w.-]+)$/i;
const COMMAND_TOKEN = /"([^"]*)"|\S+/g;

function splitCommand(command: string): { readonly program: string; readonly args: string[] } {
  const trimmed = command.trim();
  const quoted = /^"([^"]*)"/.exec(trimmed);
  const firstFlag = trimmed.search(/\s[-@]/);
  const programEnd = quoted !== null ? quoted[0].length : firstFlag < 0 ? trimmed.length : firstFlag;
  const program = quoted !== null ? (quoted[1] ?? "") : trimmed.slice(0, programEnd);
  const args = [...trimmed.slice(programEnd).matchAll(COMMAND_TOKEN)].map(match => match[1] ?? match[0]);
  return { program, args };
}

export type LaunchVerdict = "launch" | "other" | "unknown";

export function emulatorLaunchVerdict(row: ProcessRow, avd: string): LaunchVerdict {
  if (row.command === undefined) return "unknown";
  const { program, args } = splitCommand(row.command);
  const image = (program.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "");
  if (!EMULATOR_IMAGE.test(image)) return "other";
  const avdAt = args.indexOf("-avd");
  const named = (avdAt >= 0 && args[avdAt + 1] === avd) || args.includes(`@${avd}`);
  return named ? "launch" : "other";
}

// ── launching an AVD again ───────────────────────────────────────────────────

/**
 * The pid the emulator wrote into the AVD's lock (`<avd>.avd/hardware-qemu.ini.lock/pid`,
 * decimal, no newline) while it runs, or null when there is none or it is not a pid. The
 * lock outlives a process the pack killed: relaunched at once, the new emulator exits
 * with code 253 and says nothing. (`multiinstance.lock` beside it is an EMPTY file the OS
 * holds; it lets go when its holder dies, so waiting for the holder covers it.)
 */
export function avdLockHolder(avdDir: string, readFile: (path: string) => string | null): number | null {
  const text = readFile(join(avdDir, "hardware-qemu.ini.lock", "pid"));
  const pid = Number(/^\s*(\d+)\s*$/.exec(text ?? "")?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * What still stops an AVD being launched again after its tree was killed: members of that
 * tree that run (same pid AND start), and the pid in the AVD's lock if something runs under
 * it (by pid alone: a lock file records no start time). Empty = free to launch.
 */
export function relaunchBlockers(rows: readonly ProcessRow[], killed: readonly ProcessRow[], lockHolder: number | null): number[] {
  const blockers = treeSurvivors(rows, killed);
  if (lockHolder !== null && !blockers.includes(lockHolder) && rows.some(row => row.pid === lockHolder)) blockers.push(lockHolder);
  return blockers;
}

/** The exit code of an emulator that could not take the AVD's lock. */
export const LOCK_EXIT_CODE = 253;

/** An emulator that dies this soon after its spawn never got to boot anything. */
export const LOCK_EXIT_WINDOW_MS = 5_000;

/** The line the backend writes into the emulator log before each launch; what follows it is that launch's own output. */
export const LAUNCH_MARKER = "the pack launches:";

/** The part of an emulator log written by its LAST launch (the log is appended to across launches, and an earlier launch's FATAL is not this one's). */
export function lastLaunchOutput(logText: string): string {
  const at = logText.lastIndexOf(LAUNCH_MARKER);
  return at < 0 ? logText : logText.slice(at + LAUNCH_MARKER.length);
}

/**
 * Did this launch lose a race for the AVD's lock rather than fail? Exit code 253 within
 * seconds of the spawn and no FATAL line in what the launch itself printed. An emulator
 * that names its reason (a FATAL line) is reported, never retried; a log that cannot be
 * read does not make the exit a failure of its own.
 */
export function isLockRaceExit(exit: { readonly code: number | null; readonly elapsedMs: number }, logText: string | null): boolean {
  if (exit.code !== LOCK_EXIT_CODE || exit.elapsedMs >= LOCK_EXIT_WINDOW_MS) return false;
  return logText === null || !/\bFATAL\b/.test(lastLaunchOutput(logText));
}
