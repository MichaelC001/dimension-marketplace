// The DeviceToolchain: where adb, the emulator and scrcpy-server are, resolved
// at run time from the environment — never a hard-coded path. Every lookup is
// injectable (`ToolchainProbe`) so the order below is provable without a machine
// that has the tools.
//
// Order, per tool:
//   adb          <sdk>/platform-tools, then PATH, then a scrcpy bundle's own adb (last resort)
//   emulator     <sdk>/emulator, then PATH
//   scrcpy-server  $SCRCPY_SERVER_PATH, then ~/.inso/tools/mobile-sim/** (and $INSO_HOME's), then
//                  a scrcpy install's sibling file / share directory
// where <sdk> is, in order: the `simulator.sdkPath` setting, $ANDROID_HOME,
// $ANDROID_SDK_ROOT, then the platform's default Android Studio location.
//
// Why a scrcpy bundle's adb is only a last resort: the SDK's adb is the one the
// user's Android Studio already runs a server for; a second adb binary against the
// same server socket is how "adb server version doesn't match" restarts happen.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type ToolName = "adb" | "emulator" | "scrcpy-server";

export interface Prerequisite {
  readonly tool: ToolName;
  /** What stops working without it. */
  readonly needed: string;
  /** What to do, in order. */
  readonly fix: string;
}

export interface Toolchain {
  readonly adb: string | null;
  readonly emulator: string | null;
  readonly scrcpyServer: string | null;
  readonly sdkRoot: string | null;
  /** Everything not found, with the fix. Empty = fully equipped. */
  readonly missing: readonly Prerequisite[];
}

export interface ToolchainProbe {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** The `simulator.sdkPath` setting, when set. */
  readonly sdkPathSetting?: string | null;
  readonly exists: (path: string) => boolean;
  /** Directory entries (`name`, `dir`), or [] when unreadable. */
  readonly list: (path: string) => readonly { readonly name: string; readonly dir: boolean }[];
}

export function nodeProbe(init: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home: string; sdkPathSetting?: string | null }): ToolchainProbe {
  return {
    env: init.env ?? process.env,
    platform: init.platform ?? process.platform,
    home: init.home,
    sdkPathSetting: init.sdkPathSetting ?? null,
    exists: existsSync,
    list: path => {
      try {
        return readdirSync(path, { withFileTypes: true }).map(entry => ({ name: entry.name, dir: entry.isDirectory() }));
      } catch {
        return [];
      }
    },
  };
}

const exe = (platform: NodeJS.Platform, name: string): string => (platform === "win32" ? `${name}.exe` : name);

function sdkRoots(probe: ToolchainProbe): string[] {
  const { env, platform, home } = probe;
  const roots = [probe.sdkPathSetting, env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (platform === "win32" && env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, "Android", "Sdk"));
  else if (platform === "darwin") roots.push(join(home, "Library", "Android", "sdk"));
  else if (platform === "linux") roots.push(join(home, "Android", "Sdk"));
  return [...new Set(roots.filter((root): root is string => typeof root === "string" && root.length > 0))];
}

function onPath(probe: ToolchainProbe, command: string): string | null {
  const windows = probe.platform === "win32";
  const path = probe.env.PATH ?? probe.env.Path ?? "";
  const names = windows ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
  for (const dir of path.split(windows ? ";" : ":")) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (probe.exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Breadth-first, depth-limited search for a file named `names` under `root`. */
function findFile(probe: ToolchainProbe, root: string, names: readonly string[], maxDepth: number): string | null {
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const entry of probe.list(dir)) {
        if (!entry.dir && names.includes(entry.name)) return join(dir, entry.name);
        if (entry.dir) next.push(join(dir, entry.name));
      }
    }
    level = next;
  }
  return null;
}

function engineHomes(probe: ToolchainProbe): string[] {
  const homes = [probe.env.INSO_HOME, join(probe.home, ".inso")];
  return [...new Set(homes.filter((home): home is string => typeof home === "string" && home.length > 0))];
}

function findScrcpyServer(probe: ToolchainProbe): string | null {
  const explicit = probe.env.SCRCPY_SERVER_PATH;
  if (explicit && probe.exists(explicit)) return explicit;
  const names = ["scrcpy-server", "scrcpy-server.jar"];
  for (const home of engineHomes(probe)) {
    const found = findFile(probe, join(home, "tools", "mobile-sim"), names, 3);
    if (found) return found;
  }
  const scrcpy = onPath(probe, "scrcpy");
  if (scrcpy) {
    const sibling = join(dirname(scrcpy), "scrcpy-server");
    if (probe.exists(sibling)) return sibling;
  }
  for (const share of ["/opt/homebrew/share/scrcpy", "/usr/local/share/scrcpy", "/usr/share/scrcpy"]) {
    const candidate = join(share, "scrcpy-server");
    if (probe.exists(candidate)) return candidate;
  }
  return null;
}

function findAdb(probe: ToolchainProbe, sdk: string | null): string | null {
  if (sdk) {
    const candidate = join(sdk, "platform-tools", exe(probe.platform, "adb"));
    if (probe.exists(candidate)) return candidate;
  }
  const fromPath = onPath(probe, "adb");
  if (fromPath) return fromPath;
  for (const home of engineHomes(probe)) {
    const found = findFile(probe, join(home, "tools", "mobile-sim"), [exe(probe.platform, "adb")], 3);
    if (found) return found;
  }
  return null;
}

export function resolveToolchain(probe: ToolchainProbe): Toolchain {
  const roots = sdkRoots(probe);
  const sdkRoot = roots.find(root => probe.exists(join(root, "platform-tools", exe(probe.platform, "adb"))) || probe.exists(join(root, "emulator", exe(probe.platform, "emulator")))) ?? null;
  const adb = findAdb(probe, sdkRoot);
  const emulatorInSdk = sdkRoot ? join(sdkRoot, "emulator", exe(probe.platform, "emulator")) : null;
  const emulator = emulatorInSdk !== null && probe.exists(emulatorInSdk) ? emulatorInSdk : onPath(probe, "emulator");
  const scrcpyServer = findScrcpyServer(probe);

  const missing: Prerequisite[] = [];
  if (!adb) {
    missing.push({
      tool: "adb",
      needed: "everything: listing, screenshots, input and install all go through adb",
      fix: "Install Android platform-tools (Android Studio -> SDK Manager -> SDK Tools -> Android SDK Platform-Tools; or `winget install Google.PlatformTools` / `brew install android-platform-tools`), then point the pack at the SDK with ANDROID_HOME or the simulator.sdkPath setting.",
    });
  }
  if (!emulator) {
    missing.push({
      tool: "emulator",
      needed: "booting a device (an already running emulator or a USB phone works without it)",
      fix: "Install the Android Emulator (Android Studio -> SDK Manager -> SDK Tools -> Android Emulator), add a system image, and create an AVD in Device Manager. Set ANDROID_HOME or the simulator.sdkPath setting if the SDK is not in the default place.",
    });
  }
  if (!scrcpyServer) {
    missing.push({
      tool: "scrcpy-server",
      needed: "live H.264 video in the pane (without it the pane shows Shot fallback: a still picture a few times a second)",
      fix: "Download scrcpy 5.0 (Apache-2.0) from https://github.com/Genymobile/scrcpy/releases, unzip it under ~/.inso/tools/mobile-sim/scrcpy/, or set SCRCPY_SERVER_PATH to its scrcpy-server file.",
    });
  }
  return { adb, emulator, scrcpyServer, sdkRoot, missing };
}
