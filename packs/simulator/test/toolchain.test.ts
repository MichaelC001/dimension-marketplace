/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack reports a tool as
 *  missing that is installed. That happened: the Dimension dev desktop repoints
 *  HOME/USERPROFILE at a worktree-local folder, so `~/.inso/tools` resolved to an
 *  empty directory and scrcpy-server was "missing" while it sat, unzipped into a
 *  versioned folder, under the real account home. The resolution runs against an
 *  in-memory file tree, so any machine layout can be stood up here.
 */
import { describe, expect, test } from "bun:test";
import { candidateHomes, fixFor, resolveToolchain, type ToolchainProbe } from "../src/toolchain";

const norm = (path: string | null): string | null => (path === null ? null : path.replaceAll("\\", "/"));

/** An in-memory disk: `files` are the paths that exist; directories are whatever contains one. Paths compare case- and separator-insensitively, as on Windows. */
function disk(files: readonly string[]): Pick<ToolchainProbe, "exists" | "list"> {
  const key = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const existing = new Set(files.map(key));
  const children = new Map<string, Map<string, boolean>>();
  for (const file of files) {
    const parts = file.split(/[\\/]/);
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = key(parts.slice(0, depth).join("/"));
      const entries = children.get(parent) ?? new Map<string, boolean>();
      entries.set(parts[depth] ?? "", depth + 1 < parts.length);
      children.set(parent, entries);
    }
  }
  return {
    exists: path => existing.has(key(path)),
    list: path => [...(children.get(key(path)) ?? [])].map(([name, dir]) => ({ name, dir })),
  };
}

const ACCOUNT_HOME = "C:\\Users\\Sameer Pallav";
const WORKTREE_HOME = "C:\\Users\\Sameer Pallav\\.inso\\wt\\inso-mobile-v2\\.home";

function windows(files: readonly string[], more: Partial<ToolchainProbe> = {}): ToolchainProbe {
  return { env: {}, platform: "win32", homes: [WORKTREE_HOME, ACCOUNT_HOME], ...disk(files), ...more };
}

describe("scrcpy-server", () => {
  const nested = `${ACCOUNT_HOME}\\.inso\\tools\\mobile-sim\\scrcpy\\scrcpy-win64-v5.0\\scrcpy-server`;

  test("is found in the release folder it was unzipped into, under the account home, when HOME was repointed", () => {
    const toolchain = resolveToolchain(windows([nested]));
    expect(norm(toolchain.scrcpyServer)).toBe(norm(nested));
    expect(toolchain.missing.map(item => item.tool)).not.toContain("scrcpy-server");
  });

  test("is found under the repointed home too, when that is where it was put", () => {
    const local = `${WORKTREE_HOME}\\.inso\\tools\\mobile-sim\\scrcpy\\scrcpy-server`;
    expect(norm(resolveToolchain(windows([local])).scrcpyServer)).toBe(norm(local));
  });

  test("is found under $INSO_HOME, which names the engine home outright", () => {
    const elsewhere = "D:\\engine\\tools\\mobile-sim\\scrcpy\\scrcpy-win64-v5.0\\scrcpy-server";
    const toolchain = resolveToolchain(windows([elsewhere], { env: { INSO_HOME: "D:\\engine" } }));
    expect(norm(toolchain.scrcpyServer)).toBe(norm(elsewhere));
  });

  test("SCRCPY_SERVER_PATH wins over a copy in the tools folder", () => {
    const explicit = "E:\\vendor\\scrcpy-server";
    const toolchain = resolveToolchain(windows([nested, explicit], { env: { SCRCPY_SERVER_PATH: explicit } }));
    expect(norm(toolchain.scrcpyServer)).toBe(norm(explicit));
  });

  test("a SCRCPY_SERVER_PATH that points nowhere is reported, and the search goes on to the tools folder", () => {
    const toolchain = resolveToolchain(windows([nested], { env: { SCRCPY_SERVER_PATH: "E:\\gone\\scrcpy-server" } }));
    expect(norm(toolchain.scrcpyServer)).toBe(norm(nested));
    expect(toolchain.tried["scrcpy-server"].map(norm)).toContain("E:/gone/scrcpy-server");
  });

  test("the jar name is accepted too", () => {
    const jar = `${ACCOUNT_HOME}\\.inso\\tools\\mobile-sim\\scrcpy\\scrcpy-server.jar`;
    expect(norm(resolveToolchain(windows([jar])).scrcpyServer)).toBe(norm(jar));
  });

  test("a scrcpy install on PATH brings its server beside it", () => {
    const install = "C:\\tools\\scrcpy";
    const toolchain = resolveToolchain(windows([`${install}\\scrcpy.exe`, `${install}\\scrcpy-server`], { env: { PATH: `C:\\Windows;${install}` } }));
    expect(norm(toolchain.scrcpyServer)).toBe(norm(`${install}\\scrcpy-server`));
  });

  test("when it is nowhere, the error lists every place it looked, in every home", () => {
    const toolchain = resolveToolchain(windows([], { env: { SCRCPY_SERVER_PATH: "E:\\gone\\scrcpy-server" } }));
    expect(toolchain.scrcpyServer).toBeNull();
    const fix = norm(fixFor(toolchain, "scrcpy-server"));
    expect(fix).toContain("Looked in:");
    expect(fix).toContain("E:/gone/scrcpy-server");
    for (const home of [WORKTREE_HOME, ACCOUNT_HOME]) {
      expect(fix).toContain(`${norm(home)}/.inso/tools/mobile-sim/scrcpy/**/scrcpy-server`);
    }
    expect(toolchain.missing.find(item => item.tool === "scrcpy-server")?.tried).toEqual(toolchain.tried["scrcpy-server"]);
  });

  test("a missing tool does not hide a found one", () => {
    const toolchain = resolveToolchain(windows([nested]));
    expect(toolchain.missing.map(item => item.tool).sort()).toEqual(["adb", "emulator"]);
  });
});

describe("the Android SDK, adb and the emulator", () => {
  const sdk = (root: string): string[] => [`${root}\\platform-tools\\adb.exe`, `${root}\\emulator\\emulator.exe`];

  test("the simulator.sdkPath setting beats ANDROID_HOME, which beats ANDROID_SDK_ROOT", () => {
    const files = [...sdk("C:\\setting"), ...sdk("C:\\home"), ...sdk("C:\\root")];
    const env = { ANDROID_HOME: "C:\\home", ANDROID_SDK_ROOT: "C:\\root" };
    expect(norm(resolveToolchain(windows(files, { env, sdkPathSetting: "C:\\setting" })).sdkRoot)).toBe("C:/setting");
    expect(norm(resolveToolchain(windows(files, { env })).sdkRoot)).toBe("C:/home");
    expect(norm(resolveToolchain(windows(files, { env: { ANDROID_SDK_ROOT: "C:\\root" } })).sdkRoot)).toBe("C:/root");
  });

  test("an SDK folder with neither tool in it is passed over for the next candidate", () => {
    const toolchain = resolveToolchain(windows(sdk("C:\\home"), { env: { ANDROID_HOME: "C:\\home" }, sdkPathSetting: "C:\\empty" }));
    expect(norm(toolchain.sdkRoot)).toBe("C:/home");
    expect(norm(toolchain.adb)).toBe("C:/home/platform-tools/adb.exe");
    expect(norm(toolchain.emulator)).toBe("C:/home/emulator/emulator.exe");
  });

  test("Android Studio's default location is searched under the account home as well as the repointed one", () => {
    const toolchain = resolveToolchain(windows(sdk(`${ACCOUNT_HOME}\\AppData\\Local\\Android\\Sdk`)));
    expect(norm(toolchain.adb)).toBe(norm(`${ACCOUNT_HOME}\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe`));
  });

  test("the SDK's adb is preferred over a PATH adb, which is preferred over a bundle's", () => {
    const bundle = `${ACCOUNT_HOME}\\.inso\\tools\\mobile-sim\\scrcpy\\scrcpy-win64-v5.0\\adb.exe`;
    const onPath = "C:\\tools\\platform-tools\\adb.exe";
    const env = { PATH: "C:\\tools\\platform-tools", ANDROID_HOME: "C:\\home" };
    expect(norm(resolveToolchain(windows([bundle, onPath, ...sdk("C:\\home")], { env })).adb)).toBe("C:/home/platform-tools/adb.exe");
    expect(norm(resolveToolchain(windows([bundle, onPath], { env })).adb)).toBe("C:/tools/platform-tools/adb.exe");
    expect(norm(resolveToolchain(windows([bundle], { env })).adb)).toBe(norm(bundle));
  });

  test("macOS and Linux look in their own default SDK folders, with no .exe", () => {
    const mac = resolveToolchain({ env: {}, platform: "darwin", homes: ["/Users/me"], ...disk(["/Users/me/Library/Android/sdk/platform-tools/adb", "/Users/me/Library/Android/sdk/emulator/emulator"]) });
    expect(mac.adb).toBe("/Users/me/Library/Android/sdk/platform-tools/adb");
    const linux = resolveToolchain({ env: {}, platform: "linux", homes: ["/home/me"], ...disk(["/home/me/Android/Sdk/platform-tools/adb", "/home/me/Android/Sdk/emulator/emulator"]) });
    expect(linux.emulator).toBe("/home/me/Android/Sdk/emulator/emulator");
  });

  test("with no SDK at all, adb is found on PATH on Linux", () => {
    const toolchain = resolveToolchain({ env: { PATH: "/usr/bin:/opt/pt" }, platform: "linux", homes: ["/home/me"], ...disk(["/opt/pt/adb"]) });
    expect(toolchain.adb).toBe("/opt/pt/adb");
    expect(toolchain.sdkRoot).toBeNull();
  });
});

describe("candidateHomes", () => {
  const rows: { name: string; input: Parameters<typeof candidateHomes>[0]; homes: string[] }[] = [
    {
      name: "the process's home first, then the account's, then the environment's",
      input: { env: { USERPROFILE: "C:\\env", HOME: "C:\\home" }, platform: "win32", osHome: "C:\\os", accountHome: "C:\\acct" },
      homes: ["C:\\os", "C:\\acct", "C:\\env", "C:\\home"],
    },
    {
      name: "Windows drops a repeat that differs only by case, separators or a trailing slash",
      input: { env: { USERPROFILE: "c:/users/me/" }, platform: "win32", osHome: "C:\\Users\\Me", accountHome: "C:\\USERS\\ME" },
      homes: ["C:\\Users\\Me"],
    },
    {
      name: "POSIX keeps homes that differ by case",
      input: { env: { HOME: "/home/Me" }, platform: "linux", osHome: "/home/me", accountHome: null },
      homes: ["/home/me", "/home/Me"],
    },
    {
      name: "an unknown account home and empty values are not homes",
      input: { env: { HOME: "" }, platform: "linux", osHome: "/home/me", accountHome: null },
      homes: ["/home/me"],
    },
    {
      name: "USERPROFILE means nothing off Windows",
      input: { env: { USERPROFILE: "/ignored" }, platform: "linux", osHome: "/home/me", accountHome: "/home/me" },
      homes: ["/home/me"],
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      expect(candidateHomes(row.input)).toEqual(row.homes);
    });
  }
});
