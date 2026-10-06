import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidBackend, apkPathRefusal } from "../src/android/backend";
import type { Toolchain } from "../src/toolchain";
import { buildFakeTools, FakeHost, type FakeTools, type FakeWorld } from "./fake-android-tools";

setDefaultTimeout(60_000);

const SERIAL = "emulator-5556";
const WORLD: FakeWorld = { avds: [], devices: [{ serial: SERIAL, state: "device" }] };

let tools: FakeTools;
let dir: string;

beforeAll(async () => {
  tools = await buildFakeTools();
  dir = mkdtempSync(join(tmpdir(), "sim-apk-"));
});

afterAll(() => {
  for (const folder of [tools?.dir, dir]) if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

function backend(): AndroidBackend {
  tools.setWorld(WORLD);
  const toolchain: Toolchain = { adb: tools.adb, emulator: tools.emulator, scrcpyServer: null, sdkRoot: null, missing: [], tried: { adb: [], emulator: [], "scrcpy-server": [] } };
  return new AndroidBackend({ toolchain: () => toolchain, log: () => undefined, logDir: dir, gpu: () => "auto", processes: new FakeHost() });
}

function installCalls() {
  return tools.calls().filter(call => call.args[0] === "install");
}

describe("apkPathRefusal: which paths the pack will not open", () => {
  const rows: { name: string; platform: NodeJS.Platform; path: string; code: "apk_path_network" | "apk_path_not_absolute" | null }[] = [
    { name: "a UNC share", platform: "win32", path: "\\\\evil\\share\\a.apk", code: "apk_path_network" },
    { name: "a UNC share with forward slashes", platform: "win32", path: "//evil/share/a.apk", code: "apk_path_network" },
    { name: "a UNC share with mixed slashes", platform: "win32", path: "/\\evil/share/a.apk", code: "apk_path_network" },
    { name: "a \\\\?\\ extended path", platform: "win32", path: "\\\\?\\C:\\x\\a.apk", code: "apk_path_network" },
    { name: "a \\\\.\\ device path", platform: "win32", path: "\\\\.\\C:\\x\\a.apk", code: "apk_path_network" },
    { name: "a bare file name", platform: "win32", path: "a.apk", code: "apk_path_not_absolute" },
    { name: "a path relative to the working folder", platform: "win32", path: ".\\build\\a.apk", code: "apk_path_not_absolute" },
    { name: "a path relative to the drive's own working folder", platform: "win32", path: "C:a.apk", code: "apk_path_not_absolute" },
    { name: "an absolute path on a local drive", platform: "win32", path: "C:\\x\\a.apk", code: null },
    { name: "an absolute path on a local drive, forward slashes", platform: "win32", path: "C:/x/a.apk", code: null },
    { name: "an absolute posix path", platform: "linux", path: "/x/a.apk", code: null },
    { name: "a relative posix path", platform: "linux", path: "x/a.apk", code: "apk_path_not_absolute" },
    { name: "a bare file name on posix", platform: "darwin", path: "a.apk", code: "apk_path_not_absolute" },
    { name: "a Windows drive path, which is no absolute path on posix", platform: "linux", path: "C:\\x\\a.apk", code: "apk_path_not_absolute" },
    { name: "two leading slashes, which are only a slash on posix", platform: "linux", path: "//host/share/a.apk", code: null },
  ];
  for (const row of rows) {
    test(`${row.platform}: ${row.name}: ${row.code ?? "allowed"}`, () => {
      expect(apkPathRefusal(row.path, row.platform)?.code ?? null).toBe(row.code);
    });
  }

  test("a refusal says what to pass instead", () => {
    expect(apkPathRefusal("a.apk", "linux")?.message).toContain("absolute path");
    expect(apkPathRefusal("\\\\evil\\s\\a.apk", "win32")?.message).toContain("local drive");
  });
});

describe("install: the order of what it checks", () => {
  test("a relative path is refused before adb is asked anything", async () => {
    await expect(backend().install(SERIAL, "build/app.apk")).rejects.toMatchObject({ code: "apk_path_not_absolute" });
    expect(tools.calls()).toEqual([]);
  });

  test.if(process.platform === "win32")("a UNC path is refused as a network path, not looked up on its server first", async () => {
    for (const path of ["\\\\127.0.0.1\\sim-test\\a.apk", "//127.0.0.1/sim-test/a.apk", "\\\\?\\UNC\\127.0.0.1\\sim-test\\a.apk"]) {
      await expect(backend().install(SERIAL, path)).rejects.toMatchObject({ code: "apk_path_network" });
    }
    expect(installCalls()).toEqual([]);
  });

  test("an absolute path with nothing there is not found", async () => {
    await expect(backend().install(SERIAL, join(dir, "missing.apk"))).rejects.toMatchObject({ code: "apk_not_found" });
    expect(installCalls()).toEqual([]);
  });

  test("a folder named like an apk is not a file", async () => {
    mkdirSync(join(dir, "folder.apk"), { recursive: true });
    await expect(backend().install(SERIAL, join(dir, "folder.apk"))).rejects.toMatchObject({ code: "apk_not_found" });
    expect(installCalls()).toEqual([]);
  });

  test("a file that is not an .apk is refused", async () => {
    writeFileSync(join(dir, "notes.txt"), "not an apk");
    await expect(backend().install(SERIAL, join(dir, "notes.txt"))).rejects.toMatchObject({ code: "apk_not_apk" });
    expect(installCalls()).toEqual([]);
  });

  test("a path through a link installs the file it leads to, and adb is given that resolved path", async () => {
    const real = join(dir, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "app.apk"), "PK");
    symlinkSync(real, join(dir, "link"), "junction");
    const viaLink = join(dir, "link", "app.apk");
    const resolved = realpathSync(join(real, "app.apk"));
    expect(realpathSync(viaLink)).toBe(resolved);
    expect(viaLink).not.toBe(resolved);

    expect(await backend().install(SERIAL, viaLink)).toBe("Success");
    expect(installCalls()).toEqual([{ tool: "adb", serial: SERIAL, args: ["install", "-r", "-g", "-t", resolved] }]);
  });
});
