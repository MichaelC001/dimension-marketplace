// A stand-in for `adb` and for the Android `emulator` binary, compiled to a real
// executable by fake-android-tools.ts and run by the pack exactly as it runs the
// real ones (execFile / a detached spawn). It talks to no device and boots
// nothing: it answers from `world.json`, and writes every call to `calls.jsonl`,
// both next to the executable, so a test can say what the pack ASKED.
//
// Which tool it is comes from its own file name (`adb` or `emulator`).

import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface FakeDevice {
  serial: string;
  /** adb's state word. */
  state: string;
  model?: string;
  /** What the emulator's console answers to `emu avd name`; absent = the console refuses. */
  avd?: string;
  /** The stdout of the pack's `getprop` probe; absent = `adb shell` fails. */
  probe?: string;
  /** Visible to adb only once this many emulator launches have been logged: a device that appears after the pack's spawn. */
  afterLaunches?: number;
}

interface World {
  avds: string[];
  devices: FakeDevice[];
  emulator?: EmulatorBehaviour & {
    /** By launch (0 = the first emulator process started since the world was set): that launch's own behaviour instead of the one above. A launch past the list's end falls back to it. */
    launches?: EmulatorBehaviour[];
  };
}

interface EmulatorBehaviour {
  /** Printed to the emulator's stdout, which the pack points at its log file. */
  output?: string;
  /** Exit with this code right after printing. Absent = stay alive until killed. */
  exitCode?: number;
}

/** A fake emulator that outlives its test (a failed assertion) ends itself. */
const MAX_LIFETIME_MS = 25_000;

const dir = dirname(process.execPath);
const tool = basename(process.execPath).replace(/\.exe$/i, "");
const args = process.argv.slice(2);
const callsPath = join(dir, "calls.jsonl");

function readWorld(): World {
  // The test may rewrite the file between calls; a read that lands mid-write is retried.
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(readFileSync(join(dir, "world.json"), "utf8")) as World;
    } catch (error) {
      if (attempt >= 50) throw error;
      Bun.sleepSync(5);
    }
  }
}

function log(entry: object): void {
  appendFileSync(callsPath, `${JSON.stringify({ tool, ...entry })}\n`);
}

function launchCount(): number {
  try {
    return readFileSync(callsPath, "utf8")
      .split("\n")
      .filter(line => line.includes('"kind":"launch"')).length;
  } catch {
    return 0;
  }
}

/** Written and flushed before the process exits: an exit that races a pipe write loses output. */
async function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  stream.write(text, () => resolve());
  await promise;
}

async function adb(): Promise<number> {
  let serial: string | null = null;
  let rest = args;
  if (args[0] === "-s") {
    serial = args[1] ?? null;
    rest = args.slice(2);
  }
  log({ serial, args: rest });
  const world = readWorld();
  const launches = launchCount();
  const visible = world.devices.filter(device => (device.afterLaunches ?? 0) <= launches);
  if (rest[0] === "devices") {
    const lines = visible.map(device => `${device.serial}\t${device.state}${device.model === undefined ? "" : ` product:p model:${device.model} device:d transport_id:1`}`);
    await write(process.stdout, `List of devices attached\n${lines.join("\n")}${lines.length === 0 ? "" : "\n"}\n`);
    return 0;
  }
  const device = visible.find(candidate => candidate.serial === serial);
  if (device === undefined) {
    await write(process.stderr, `error: device '${serial}' not found\n`);
    return 1;
  }
  if (rest[0] === "emu" && rest[1] === "avd" && rest[2] === "name") {
    await write(process.stdout, device.avd === undefined ? "KO: unknown command\r\n" : `${device.avd}\r\nOK\r\n`);
    return 0;
  }
  if (rest[0] === "emu" && rest[1] === "kill") {
    await write(process.stdout, "OK: killing emulator, bye bye\r\n");
    return 0;
  }
  if (rest[0] === "wait-for-device") return 0;
  if (rest[0] === "shell") {
    if (device.probe === undefined) {
      await write(process.stderr, "error: closed\n");
      return 1;
    }
    await write(process.stdout, device.probe);
    return 0;
  }
  await write(process.stderr, `fake adb: unsupported ${rest.join(" ")}\n`);
  return 1;
}

async function emulator(): Promise<number | null> {
  const world = readWorld();
  if (args[0] === "-list-avds") {
    await write(process.stdout, `${world.avds.join("\n")}\n`);
    return 0;
  }
  log({ kind: "launch", args });
  // This launch's own line is already logged: its index is the count before it.
  const behaviour = world.emulator?.launches?.[launchCount() - 1] ?? world.emulator;
  if (behaviour?.output !== undefined) await write(process.stdout, behaviour.output);
  if (behaviour?.exitCode !== undefined) return behaviour.exitCode;
  setTimeout(() => process.exit(0), MAX_LIFETIME_MS);
  setInterval(() => undefined, 1 << 30);
  return null;
}

const code = tool === "adb" ? await adb() : await emulator();
if (code !== null) process.exit(code);
