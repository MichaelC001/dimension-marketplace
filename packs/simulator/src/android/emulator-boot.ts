// What an emulator boot is made of, as pure functions: the argv, and the words
// a failed boot is reported in. No process, no file: the backend does the I/O.

/** The RAM the pack gives a slim emulator (MB): what avdslim boots the same AVDs with. */
export const DEFAULT_MEMORY_MB = 1536;

/** The golden snapshot `avdslim bake` leaves in an AVD. */
export const BAKED_SNAPSHOT = "avdslim_clean";

export interface EmulatorArgsInput {
  readonly avd: string;
  /** The console port: the device will be `emulator-<port>`, which the pack needs to know before it exists. */
  readonly port: number;
  /** No window: nothing on the user's screen. */
  readonly headless: boolean;
  /** Ignore any saved snapshot and boot from scratch. */
  readonly cold: boolean;
  /** The AVD has the `avdslim_clean` snapshot (ignored for a cold boot). */
  readonly bakedSnapshot: boolean;
  readonly memoryMb?: number;
}

/**
 * The emulator's own flags, never `-qemu` passthrough: `-lowram` is an emulator
 * option, and Android Emulator 37 rejects it after `-qemu` ("-lowram: invalid
 * option"). The set is avdslim's, which boots these AVDs: the memory and CPU a
 * simulator pane would otherwise spend on audio, cameras and the boot animation.
 */
export function buildEmulatorArgs(input: EmulatorArgsInput): string[] {
  const args = [
    "-avd", input.avd,
    "-port", String(input.port),
    "-memory", String(input.memoryMb ?? DEFAULT_MEMORY_MB),
    "-gpu", "auto",
    "-no-audio",
    "-camera-back", "none",
    "-camera-front", "none",
    "-no-boot-anim",
    "-lowram",
  ];
  if (input.headless) args.push("-no-window");
  if (input.cold) args.push("-no-snapshot-load");
  else if (input.bakedSnapshot) args.push("-snapshot", BAKED_SNAPSHOT);
  // Stopping an emulator kills it: saving a snapshot first would only slow the stop.
  args.push("-no-snapshot-save");
  return args;
}

/** The last `count` lines of `text`, trailing blank lines not counted. */
export function lastLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  return lines.slice(-count);
}

/** A boot failure as the tool reports it: the reason, then the end of the emulator's own log, which is where the emulator says what it did not like. */
export function bootFailureMessage(reason: string, log: { readonly path: string; readonly text: string | null }, count = 15): string {
  const tail = log.text === null ? [] : lastLines(log.text, count);
  if (tail.length === 0) return `${reason}\nThe emulator log (${log.path}) is empty or could not be read.`;
  return `${reason}\nLast ${tail.length} line${tail.length === 1 ? "" : "s"} of the emulator log (${log.path}):\n${tail.join("\n")}`;
}
