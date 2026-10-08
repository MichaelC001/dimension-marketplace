// A thin, honest wrapper over the adb binary. Every call names its device with
// `-s` (a machine with two emulators makes a bare `adb` fail), runs without a
// shell on the host, has a deadline, and turns adb's stderr into a message that
// names the fix. Nothing here polls.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { fail } from "../contracts";

export interface AdbDevice {
  readonly serial: string;
  /** adb's own state word: device, offline, unauthorized, ... */
  readonly state: string;
  readonly model: string | null;
}

export interface AdbRunOptions {
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  /** Abort the call (the child is killed). */
  readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** adb's stderr -> what the person should do. `null` = nothing specific. */
export function explainAdbFailure(serial: string | null, stderr: string): string | null {
  const who = serial ?? "the device";
  if (/device offline/i.test(stderr)) return `${who} is offline: it is still booting or crashed. Wait a few seconds and retry, or device_stop it and device_boot it again.`;
  if (/unauthorized/i.test(stderr)) return `${who} is unauthorized: accept the "Allow USB debugging" prompt on the phone, then retry.`;
  if (/(device '[^']*' not found|no devices\/emulators found|device not found)/i.test(stderr)) return `${who} is not connected. Run device_list to see what is, or device_boot to start an emulator.`;
  if (/(cannot connect to daemon|failed to start daemon|could not install \*smartsocket\*)/i.test(stderr)) return "the adb server could not start. Another program may hold port 5037; close it (or run `adb kill-server` yourself) and retry.";
  if (/more than one device/i.test(stderr)) return "more than one device is attached; pass serial from device_list.";
  return null;
}

export class Adb {
  readonly path: string;
  readonly #timeoutMs: number;

  constructor(path: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.path = path;
    this.#timeoutMs = timeoutMs;
  }

  /** Run `adb [-s serial] ...args`; resolves with raw stdout bytes. */
  run(serial: string | null, args: readonly string[], options: AdbRunOptions = {}): Promise<Buffer> {
    const argv = serial === null ? [...args] : ["-s", serial, ...args];
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    execFile(
      this.path,
      argv,
      { encoding: "buffer", maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER, timeout: options.timeoutMs ?? this.#timeoutMs, windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean };
        const detail = stderr.toString("utf8").trim() || stdout.toString("utf8").trim();
        if (options.signal?.aborted) {
          reject(new Error(`adb ${args[0] ?? ""} was cancelled.`));
          return;
        }
        if (err.code === "ENOENT") reject(new Error(`adb was not found at ${this.path}. Install Android platform-tools or set ANDROID_HOME.`));
        else if (err.killed === true) reject(new Error(`adb ${args[0] ?? ""} timed out after ${(options.timeoutMs ?? this.#timeoutMs) / 1000}s${serial ? ` on ${serial}` : ""}.`));
        else reject(new Error(explainAdbFailure(serial, detail) ?? `adb ${args.join(" ")} failed: ${detail.split("\n")[0] ?? err.message}`));
      },
    );
    return promise;
  }

  async text(serial: string | null, args: readonly string[], options?: AdbRunOptions): Promise<string> {
    return (await this.run(serial, args, options)).toString("utf8");
  }

  /** `adb -s serial shell <command>`: `command` is ONE string, run by the device's sh. */
  shell(serial: string, command: string, options?: AdbRunOptions): Promise<string> {
    return this.text(serial, ["shell", command], options);
  }

  execOut(serial: string, args: readonly string[], options?: AdbRunOptions): Promise<Buffer> {
    return this.run(serial, ["exec-out", ...args], options);
  }

  async devices(): Promise<AdbDevice[]> {
    const out = await this.text(null, ["devices", "-l"], { timeoutMs: 15_000 });
    const devices: AdbDevice[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line === "" || line.startsWith("*") || line.startsWith("List of devices")) continue;
      const [serial, state, ...rest] = line.trim().split(/\s+/);
      if (serial === undefined || state === undefined) continue;
      const model = rest.find(part => part.startsWith("model:"))?.slice("model:".length) ?? null;
      devices.push({ serial, state, model });
    }
    return devices;
  }

  /** A long-lived `adb -s serial shell ...` (the scrcpy server): the caller owns the process. */
  spawnShell(serial: string, command: string): ChildProcess {
    return spawn(this.path, ["-s", serial, "shell", command], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  }

  /** `adb forward tcp:0 <remote>` -> the local port adb chose. */
  async forward(serial: string, remote: string): Promise<number> {
    const out = (await this.text(serial, ["forward", "tcp:0", remote], { timeoutMs: 10_000 })).trim();
    const port = Number(out.split(/\s+/).pop());
    if (!Number.isInteger(port) || port <= 0) fail("adb_forward", `adb forward did not return a port (got "${out}")`);
    return port;
  }

  async forwardRemove(serial: string, port: number): Promise<void> {
    await this.run(serial, ["forward", "--remove", `tcp:${port}`], { timeoutMs: 10_000 }).catch(() => undefined);
  }

  push(serial: string, local: string, remote: string): Promise<Buffer> {
    return this.run(serial, ["push", local, remote], { timeoutMs: 30_000 });
  }
}
