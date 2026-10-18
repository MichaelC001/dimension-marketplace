// The Browser pack's MCP entry (`app/launch.mjs`): checks the runtime, then hands over to the server bundle beside it (`app/server.mjs`). Kept free of the server's imports on purpose: under a runtime that cannot run the
// server, nothing of it is loaded. The reasoning for the Bun case is in launch-node.ts.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_NODE, atLeast, pickNode } from "./launch-node.js";

const SERVER = new URL("./server.mjs", import.meta.url);
/** Set on the Node the launcher starts, so a runtime that is still Bun there stops with a message instead of starting itself again. */
const RELAUNCHED = "DIMENSION_BROWSER_RELAUNCHED";
const FLOOR = `${MIN_NODE.major}.${MIN_NODE.minor}`;

function fail(message: string): never {
  process.stderr.write(`[browser] ${message}\n`);
  process.exit(1);
}

/** Where a Node installs to when the host's PATH does not name it (a GUI app's PATH is shorter than a terminal's). */
function installPlaces(): string[] {
  const env = process.env;
  if (process.platform === "win32") return [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]].flatMap(base => (base ? [`${base}\\nodejs`] : [])).concat(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Programs\\nodejs`] : []);
  return process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin", "/usr/bin"];
}

/** What `file` says it is: its Node version, or nothing when it does not start or is Bun under the name `node`. */
function versionOf(file: string): string | undefined {
  const run = spawnSync(file, ["-p", "process.versions.bun ? '' : process.versions.node"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  const version = run.status === 0 ? run.stdout.trim() : "";
  return version === "" ? undefined : version;
}

/** Bun answers to `node` here too, and is told apart by the one property only it has. */
const underBun = "bun" in process.versions;

if (!underBun) {
  if (!atLeast(process.versions.node)) {
    fail(`The Browser pack needs Node ${FLOOR} or newer; this is Node ${process.versions.node} (${process.execPath}). Install a current Node from https://nodejs.org/ and restart Dimension.`);
  }
  delete process.env[RELAUNCHED];
  // A static import cannot work here: it would load (and run) the whole server before the version above is checked, on a runtime that may not be able to run it.
  await import(SERVER.href);
} else {
  if (process.env[RELAUNCHED] !== undefined) fail(`The Browser pack was relaunched under Node and is still running under Bun (${process.execPath}).`);
  const node = pickNode({
    path: (process.env.PATH ?? "").split(delimiter),
    fallbacks: installPlaces(),
    exe: process.platform === "win32" ? "node.exe" : "node",
    self: process.execPath,
    exists: existsSync,
    versionOf,
  });
  if (node === undefined) {
    fail(`The Browser pack is running under Bun (${process.execPath}), which cannot start its code worker, and no Node ${FLOOR}+ was found on PATH. Install Node from https://nodejs.org/ and restart Dimension.`);
  }
  process.stderr.write(`[browser] running under Bun; relaunching under Node ${node.version} (${node.file})\n`);
  // stdio is handed over, not read: a Bun that attaches a reader to the MCP pipe is the thing that stalls.
  const child = spawn(node.file, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true, env: { ...process.env, [RELAUNCHED]: "1" } });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", error => fail(`The Browser pack could not start Node (${node.file}): ${error.message}`));
  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
}
