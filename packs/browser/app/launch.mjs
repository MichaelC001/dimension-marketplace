// src/launch.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

// src/launch-node.ts
import { basename, join } from "node:path";
var MIN_NODE = { major: 22, minor: 12 };
function atLeast(version, min = MIN_NODE) {
  const [major = Number.NaN, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > min.major || major === min.major && minor >= min.minor;
}
function isBunShimDirectory(directory) {
  return basename(directory).startsWith("bun-node-");
}
function pickNode(search) {
  for (const directory of [...search.path, ...search.fallbacks]) {
    if (directory === "" || isBunShimDirectory(directory)) continue;
    const file = join(directory, search.exe);
    if (file === search.self || !search.exists(file)) continue;
    const version = search.versionOf(file);
    if (version !== void 0 && atLeast(version)) return { file, version };
  }
  return void 0;
}

// src/launch.ts
var SERVER = new URL("./server.mjs", import.meta.url);
var RELAUNCHED = "DIMENSION_BROWSER_RELAUNCHED";
var FLOOR = `${MIN_NODE.major}.${MIN_NODE.minor}`;
function fail(message) {
  process.stderr.write(`[browser] ${message}
`);
  process.exit(1);
}
function installPlaces() {
  const env = process.env;
  if (process.platform === "win32") return [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]].flatMap((base) => base ? [`${base}\\nodejs`] : []).concat(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Programs\\nodejs`] : []);
  return process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin", "/usr/bin"];
}
function versionOf(file) {
  const run = spawnSync(file, ["-p", "process.versions.bun ? '' : process.versions.node"], { encoding: "utf8", timeout: 5e3, windowsHide: true });
  const version = run.status === 0 ? run.stdout.trim() : "";
  return version === "" ? void 0 : version;
}
var underBun = "bun" in process.versions;
if (!underBun) {
  if (!atLeast(process.versions.node)) {
    fail(`The Browser pack needs Node ${FLOOR} or newer; this is Node ${process.versions.node} (${process.execPath}). Install a current Node from https://nodejs.org/ and restart Dimension.`);
  }
  delete process.env[RELAUNCHED];
  await import(SERVER.href);
} else {
  if (process.env[RELAUNCHED] !== void 0) fail(`The Browser pack was relaunched under Node and is still running under Bun (${process.execPath}).`);
  const node = pickNode({
    path: (process.env.PATH ?? "").split(delimiter),
    fallbacks: installPlaces(),
    exe: process.platform === "win32" ? "node.exe" : "node",
    self: process.execPath,
    exists: existsSync,
    versionOf
  });
  if (node === void 0) {
    fail(`The Browser pack is running under Bun (${process.execPath}), which cannot start its code worker, and no Node ${FLOOR}+ was found on PATH. Install Node from https://nodejs.org/ and restart Dimension.`);
  }
  process.stderr.write(`[browser] running under Bun; relaunching under Node ${node.version} (${node.file})
`);
  const child = spawn(node.file, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true, env: { ...process.env, [RELAUNCHED]: "1" } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => fail(`The Browser pack could not start Node (${node.file}): ${error.message}`));
  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
}
