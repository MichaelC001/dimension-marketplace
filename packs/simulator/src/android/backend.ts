// The Android DeviceBackend: adb for everything a person or an agent does to a
// device, the emulator binary for booting one, scrcpy-server for live video.

import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BootHandle, DeviceBackend, VideoStream, VideoStreamHandlers, VideoStreamOptions } from "../backend";
import { type BootRequest, type DeviceInfo, type DeviceKind, type DeviceState, fail, type KeyName, type Screenshot, type UiSnapshot } from "../contracts";
import { classifyDevice } from "../device-safety";
import type { Size } from "../shared/pointer";
import { fixFor, type Toolchain } from "../toolchain";
import { Adb } from "./adb";
import { bootFailureMessage, buildEmulatorArgs } from "./emulator-boot";
import { rawToPng } from "./png";
import { openVideoSession } from "./scrcpy";
import { KEYCODES } from "./scrcpy-wire";
import { parseUiDump } from "./ui-tree";

export interface AndroidBackendDeps {
  /** The toolchain as it is NOW (the caller decides how often it is re-resolved). */
  readonly toolchain: () => Toolchain;
  readonly log: (message: string) => void;
  /** Where emulator logs go. */
  readonly logDir: string;
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

const CONSOLE_PORTS = { first: 5554, last: 5682 } as const;
const BOOT_BUDGET_MS = 240_000;

function listening(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const probe = net.createServer();
  probe.once("error", () => resolve(true));
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)));
  return promise;
}

export class AndroidBackend implements DeviceBackend {
  readonly platform = "android" as const;
  readonly #deps: AndroidBackendDeps;
  readonly #adbs = new Map<string, Adb>();
  readonly #static = new Map<string, Probe>();
  readonly #displays = new Map<string, Size>();

  constructor(deps: AndroidBackendDeps) {
    this.#deps = deps;
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
        if (device.state !== "device") {
          const state: DeviceState = device.state === "unauthorized" ? "unauthorized" : "offline";
          return { ...base, kind: classifyDevice({ serial: device.serial }), state, name: device.model ?? device.serial, androidVersion: null, display: null, density: null };
        }
        const probe = await this.#probe(adb, device.serial);
        const display = probe.display ?? this.#displays.get(device.serial) ?? null;
        if (probe.display) this.#displays.set(device.serial, probe.display);
        return {
          ...base,
          kind: classifyDevice({ serial: device.serial, ...probe }),
          state: probe.booted ? "online" : "booting",
          name: probe.avd ?? probe.model ?? device.model ?? device.serial,
          androidVersion: probe.version,
          display,
          density: probe.density,
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

  async startBoot(request: BootRequest): Promise<BootHandle> {
    const toolchain = this.#deps.toolchain();
    const { emulator } = toolchain;
    if (emulator === null) fail("missing_emulator", `the Android emulator is not installed or not found. ${fixFor(toolchain, "emulator")}`);
    const adb = this.#adb();
    const avds = await this.avds();
    if (avds.length === 0) fail("no_avd", "there is no AVD to boot. Create one in Android Studio -> Device Manager (or `avdmanager create avd`), then call device_boot again.");
    const avd = request.avd ?? (avds.length === 1 ? avds[0] : undefined);
    if (avd === undefined) fail("avd_required", `several AVDs exist; pass avd. Available: ${avds.join(", ")}`);
    if (!avds.includes(avd)) fail("unknown_avd", `no AVD named "${avd}". Available: ${avds.join(", ")}`);

    const port = await this.#freeConsolePort(adb);
    const serial = `emulator-${port}`;
    const baked = existsSync(join(avdHome(), `${avd}.avd`, "snapshots", "avdslim_clean"));
    const args = buildEmulatorArgs({ avd, port, headless: request.headless === true, cold: request.cold === true, bakedSnapshot: baked });

    mkdirSync(this.#deps.logDir, { recursive: true });
    const logPath = join(this.#deps.logDir, `${serial}.log`);
    const fd = openSync(logPath, "a");
    const child = spawn(emulator, args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    child.unref();
    this.#deps.log(`[sim] booting ${avd} as ${serial} (pid ${child.pid ?? "?"}, ${request.headless ? "headless" : "windowed"}, ${request.cold ? "cold" : baked ? "baked snapshot" : "default snapshot"}); log ${logPath}`);

    const abort = new AbortController();
    /** Every boot failure carries the end of the emulator's own log: that is where it says what it did not like. */
    const failure = (reason: string): Error => new Error(bootFailureMessage(reason, { path: logPath, text: readLogTail(logPath) }));
    const exited = new Promise<never>((_resolve, reject) => {
      child.once("exit", code => {
        abort.abort();
        reject(failure(`the emulator for ${avd} exited with code ${code ?? "?"} before it finished booting.`));
      });
      child.once("error", error => reject(failure(`could not start the emulator: ${error.message}`)));
    });
    exited.catch(() => undefined);
    const booted = adb
      .run(serial, ["wait-for-device", "shell", "while [ \"$(getprop sys.boot_completed)\" != 1 ]; do sleep 1; done"], { timeoutMs: BOOT_BUDGET_MS, maxBuffer: 1024 * 1024, signal: abort.signal })
      .then(async () => {
        const info = (await this.list()).find(device => device.serial === serial);
        if (info === undefined) throw new Error(`${serial} booted but is not listed by adb`);
        return info;
      })
      .catch((error: unknown) => {
        throw failure(abort.signal.aborted ? `the emulator for ${avd} exited before it finished booting.` : error instanceof Error ? error.message : String(error));
      });
    const ready = Promise.race([booted, exited]);
    ready.catch(() => undefined);
    return { serial, avd, pid: child.pid ?? null, ready };
  }

  async #freeConsolePort(adb: Adb): Promise<number> {
    const taken = new Set((await adb.devices()).map(device => device.serial));
    for (let port = CONSOLE_PORTS.first; port <= CONSOLE_PORTS.last; port += 2) {
      if (taken.has(`emulator-${port}`)) continue;
      if (!(await listening(port)) && !(await listening(port + 1))) return port;
    }
    return fail("no_console_port", `no free emulator console port in ${CONSOLE_PORTS.first}-${CONSOLE_PORTS.last}; stop an emulator first.`);
  }

  async stop(serial: string, pid: number | null): Promise<void> {
    const adb = this.#adb();
    await adb.run(serial, ["emu", "kill"], { timeoutMs: 15_000 }).catch(() => undefined);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (!(await adb.devices()).some(device => device.serial === serial)) {
        this.#static.delete(serial);
        this.#displays.delete(serial);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (pid !== null) await killTree(pid);
    this.#static.delete(serial);
  }

  async identify(serial: string): Promise<{ readonly avd: string } | null> {
    const adb = this.#adb();
    if (!(await adb.devices()).some(device => device.serial === serial && device.state === "device")) return null;
    const probe = await this.#probe(adb, serial).catch(() => null);
    return probe?.avd ? { avd: probe.avd } : null;
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

async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    return;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("close", () => resolve());
  await promise;
}
