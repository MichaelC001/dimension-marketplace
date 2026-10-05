// The DeviceToolchain: where adb, the emulator and scrcpy-server are, resolved
// at run time from the environment — never a hard-coded path. Every lookup is
// injectable (`ToolchainProbe`: the environment, the homes, `exists`, `list`) so
// the order below is provable without a machine that has the tools.
//
// Order, per tool:
//   adb            <sdk>/platform-tools, then PATH, then <engine home>/tools/mobile-sim/**
//   emulator       <sdk>/emulator, then PATH, then <engine home>/tools/mobile-sim/**
//   scrcpy-server  $SCRCPY_SERVER_PATH, then <engine home>/tools/mobile-sim/scrcpy/**
//                  (and the rest of mobile-sim/**), then a scrcpy install's sibling
//                  file / share directory
// where <sdk> is, in order: the `simulator.sdkPath` setting, $ANDROID_HOME,
// $ANDROID_SDK_ROOT, then the platform's default Android Studio location under
// each home; and an <engine home> is $INSO_HOME, then `<home>/.inso` for each home.
//
// Several homes, on purpose. The Dimension dev desktop repoints HOME/USERPROFILE
// at a worktree-local directory, so `os.homedir()` names that, while the tools the
// user installed live under the OS account's own home (`os.userInfo().homedir`).
// Every distinct home is searched.
//
// Why a scrcpy bundle's adb is only a last resort: the SDK's adb is the one the
// user's Android Studio already runs a server for; a second adb binary against the
// same server socket is how "adb server version doesn't match" restarts happen.

import { existsSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";

export type ToolName = "adb" | "emulator" | "scrcpy-server";

export interface Prerequisite {
  readonly tool: ToolName;
  /** What stops working without it. */
  readonly needed: string;
  /** What to do, in order. Ends with every place that was looked in. */
  readonly fix: string;
  /** Every path (or `folder/**` searched) that was tried, in order. */
  readonly tried: readonly string[];
}

export interface Toolchain {
  readonly adb: string | null;
  readonly emulator: string | null;
  readonly scrcpyServer: string | null;
  readonly sdkRoot: string | null;
  /** Everything not found, with the fix. Empty = fully equipped. */
  readonly missing: readonly Prerequisite[];
  /** Where each tool was looked for, found or not. */
  readonly tried: Readonly<Record<ToolName, readonly string[]>>;
}

export interface ToolchainProbe {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Every distinct home directory the user may mean (see `candidateHomes`). */
  readonly homes: readonly string[];
  /** The `simulator.sdkPath` setting, when set. */
  readonly sdkPathSetting?: string | null;
  readonly exists: (path: string) => boolean;
  /** Directory entries (`name`, `dir`), or [] when unreadable. */
  readonly list: (path: string) => readonly { readonly name: string; readonly dir: boolean }[];
}

/**
 * Every distinct home to look under: what the process was told (`os.homedir()`,
 * which follows HOME/USERPROFILE), the OS account's own home, and the
 * environment's HOME/USERPROFILE. Order is preserved; duplicates (by path, case-
 * and separator-insensitively on Windows) are dropped.
 */
export function candidateHomes(input: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; osHome: string | null; accountHome: string | null }): string[] {
  const windows = input.platform === "win32";
  const key = (home: string): string => {
    const normal = home.replace(/[\\/]+$/, "");
    return windows ? normal.replaceAll("\\", "/").toLowerCase() : normal;
  };
  const seen = new Set<string>();
  const homes: string[] = [];
  for (const home of [input.osHome, input.accountHome, windows ? input.env.USERPROFILE : undefined, input.env.HOME]) {
    if (typeof home !== "string" || home === "" || seen.has(key(home))) continue;
    seen.add(key(home));
    homes.push(home);
  }
  return homes;
}

/** `os.userInfo().homedir` throws when the account has no passwd entry; that is "unknown", not a crash. */
function accountHome(): string | null {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
}

export function nodeProbe(init: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; homes?: readonly string[]; sdkPathSetting?: string | null }): ToolchainProbe {
  const env = init.env ?? process.env;
  const platform = init.platform ?? process.platform;
  return {
    env,
    platform,
    homes: init.homes ?? candidateHomes({ env, platform, osHome: homedir(), accountHome: accountHome() }),
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

/** A search bounded in depth and in folders visited: a user's tools folder is small; a mistaken root must not be walked for seconds. */
const MAX_SEARCH_DEPTH = 6;
const MAX_SEARCH_DIRS = 400;

type PathApi = typeof win32;

export function resolveToolchain(probe: ToolchainProbe): Toolchain {
  const windows = probe.platform === "win32";
  const p: PathApi = windows ? win32 : posix;
  const exe = (name: string): string => (windows ? `${name}.exe` : name);
  const tried: Record<ToolName, string[]> = { adb: [], emulator: [], "scrcpy-server": [] };
  const note = (tool: ToolName, entry: string): void => {
    if (!tried[tool].includes(entry)) tried[tool].push(entry);
  };
  /** `exists`, remembered as tried. */
  const look = (tool: ToolName, path: string): boolean => {
    note(tool, path);
    return probe.exists(path);
  };

  const onPath = (tool: ToolName, command: string): string | null => {
    const path = probe.env.PATH ?? probe.env.Path ?? "";
    const folders = path.split(windows ? ";" : ":").filter(folder => folder !== "");
    const names = windows ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
    note(tool, `PATH (${folders.length} folder${folders.length === 1 ? "" : "s"}, for ${names.join(" / ")})`);
    for (const folder of folders) {
      for (const name of names) {
        const candidate = p.join(folder, name);
        if (probe.exists(candidate)) return candidate;
      }
    }
    return null;
  };

  /** Breadth-first search for a file named one of `names` anywhere under `root`. */
  const findUnder = (tool: ToolName, root: string, names: readonly string[]): string | null => {
    for (const name of names) note(tool, p.join(root, "**", name));
    let level = [root];
    let visited = 0;
    for (let depth = 0; depth <= MAX_SEARCH_DEPTH && level.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (++visited > MAX_SEARCH_DIRS) return null;
        for (const entry of probe.list(dir)) {
          if (!entry.dir && names.includes(entry.name)) return p.join(dir, entry.name);
          if (entry.dir) next.push(p.join(dir, entry.name));
        }
      }
      level = next;
    }
    return null;
  };

  const engineHomes = [...new Set([probe.env.INSO_HOME, ...probe.homes.map(home => p.join(home, ".inso"))].filter((home): home is string => typeof home === "string" && home !== ""))];
  const simRoots = engineHomes.map(home => p.join(home, "tools", "mobile-sim"));

  // ── the SDK ─────────────────────────────────────────────────────────────
  const sdkCandidates: (string | null | undefined)[] = [probe.sdkPathSetting, probe.env.ANDROID_HOME, probe.env.ANDROID_SDK_ROOT];
  if (windows) {
    if (probe.env.LOCALAPPDATA) sdkCandidates.push(p.join(probe.env.LOCALAPPDATA, "Android", "Sdk"));
    for (const home of probe.homes) sdkCandidates.push(p.join(home, "AppData", "Local", "Android", "Sdk"));
  } else if (probe.platform === "darwin") {
    for (const home of probe.homes) sdkCandidates.push(p.join(home, "Library", "Android", "sdk"));
  } else if (probe.platform === "linux") {
    for (const home of probe.homes) sdkCandidates.push(p.join(home, "Android", "Sdk"));
  }
  const sdkRoots = [...new Set(sdkCandidates.filter((root): root is string => typeof root === "string" && root !== ""))];
  let sdkRoot: string | null = null;
  for (const root of sdkRoots) {
    const hasAdb = look("adb", p.join(root, "platform-tools", exe("adb")));
    const hasEmulator = look("emulator", p.join(root, "emulator", exe("emulator")));
    if (hasAdb || hasEmulator) {
      sdkRoot = root;
      break;
    }
  }

  // ── adb ─────────────────────────────────────────────────────────────────
  let adb: string | null = null;
  const sdkAdb = sdkRoot === null ? null : p.join(sdkRoot, "platform-tools", exe("adb"));
  if (sdkAdb !== null && probe.exists(sdkAdb)) adb = sdkAdb;
  adb ??= onPath("adb", "adb");
  for (const root of simRoots) adb ??= findUnder("adb", root, [exe("adb")]);

  // ── emulator ────────────────────────────────────────────────────────────
  let emulator: string | null = null;
  const sdkEmulator = sdkRoot === null ? null : p.join(sdkRoot, "emulator", exe("emulator"));
  if (sdkEmulator !== null && probe.exists(sdkEmulator)) emulator = sdkEmulator;
  emulator ??= onPath("emulator", "emulator");
  for (const root of simRoots) emulator ??= findUnder("emulator", root, [exe("emulator")]);

  // ── scrcpy-server ───────────────────────────────────────────────────────
  let scrcpyServer: string | null = null;
  const explicit = probe.env.SCRCPY_SERVER_PATH;
  if (explicit && look("scrcpy-server", explicit)) scrcpyServer = explicit;
  const serverNames = ["scrcpy-server", "scrcpy-server.jar"];
  // The unzipped release is a folder inside `scrcpy/` (scrcpy-win64-v5.0/scrcpy-server): search under it first, then the rest of mobile-sim.
  for (const root of simRoots) scrcpyServer ??= findUnder("scrcpy-server", p.join(root, "scrcpy"), serverNames);
  for (const root of simRoots) scrcpyServer ??= findUnder("scrcpy-server", root, serverNames);
  if (scrcpyServer === null) {
    const scrcpy = onPath("scrcpy-server", "scrcpy");
    if (scrcpy !== null && look("scrcpy-server", p.join(p.dirname(scrcpy), "scrcpy-server"))) scrcpyServer = p.join(p.dirname(scrcpy), "scrcpy-server");
  }
  for (const share of ["/opt/homebrew/share/scrcpy", "/usr/local/share/scrcpy", "/usr/share/scrcpy"]) {
    if (scrcpyServer === null && look("scrcpy-server", posix.join(share, "scrcpy-server"))) scrcpyServer = posix.join(share, "scrcpy-server");
  }

  const looked = (tool: ToolName): string => ` Looked in: ${tried[tool].join("; ")}.`;
  const missing: Prerequisite[] = [];
  if (!adb) {
    missing.push({
      tool: "adb",
      needed: "everything: listing, screenshots, input and install all go through adb",
      fix: `Install Android platform-tools (Android Studio -> SDK Manager -> SDK Tools -> Android SDK Platform-Tools; or \`winget install Google.PlatformTools\` / \`brew install android-platform-tools\`), then point the pack at the SDK with ANDROID_HOME or the simulator.sdkPath setting.${looked("adb")}`,
      tried: tried.adb,
    });
  }
  if (!emulator) {
    missing.push({
      tool: "emulator",
      needed: "booting a device (an already running emulator or a USB phone works without it)",
      fix: `Install the Android Emulator (Android Studio -> SDK Manager -> SDK Tools -> Android Emulator), add a system image, and create an AVD in Device Manager. Set ANDROID_HOME or the simulator.sdkPath setting if the SDK is not in the default place.${looked("emulator")}`,
      tried: tried.emulator,
    });
  }
  if (!scrcpyServer) {
    missing.push({
      tool: "scrcpy-server",
      needed: "live H.264 video in the pane (without it the pane shows Shot fallback: a still picture a few times a second)",
      fix: `Download scrcpy 5.0 (Apache-2.0) from https://github.com/Genymobile/scrcpy/releases, unzip it under ~/.inso/tools/mobile-sim/scrcpy/, or set SCRCPY_SERVER_PATH to its scrcpy-server file.${looked("scrcpy-server")}`,
      tried: tried["scrcpy-server"],
    });
  }
  return { adb, emulator, scrcpyServer, sdkRoot, missing, tried };
}

/** The fix text for a tool that is missing from `toolchain` (what to do, and where it was looked for); "" when it is present. */
export function fixFor(toolchain: Toolchain, tool: ToolName): string {
  return toolchain.missing.find(item => item.tool === tool)?.fix ?? "";
}
