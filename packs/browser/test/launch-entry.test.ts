/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack does not start, or
 *  starts under Bun and every browser_run hangs at worker start (Bun cannot
 *  start the worker while stdin is a flowing pipe), or the launcher relaunches
 *  itself for ever, or a crashed server reads to the host as a clean exit, or
 *  with no usable Node the person gets silence instead of one [browser] line
 *  naming Node.
 *
 *  The launcher built from src as app/launch.mjs, run as a host runs it: real
 *  Bun, real Node 22.12+, real MCP stdio. The tests that need a real Node are
 *  SKIPPED, not passed, on a machine without one.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { atLeast } from "../src/launch-node";
import { BROWSER_TEST_TIMEOUT_MS } from "./fixture";

const PACK = fileURLToPath(new URL("..", import.meta.url));
const EXE = process.platform === "win32" ? "node.exe" : "node";
const BUN_SHIM_PREFIX = "bun-node-";
const CELL_TIMEOUT_MS = 60_000;
const LAUNCHER_EXIT_TIMEOUT_MS = 30_000;
const RELAUNCHED = "DIMENSION_BROWSER_RELAUNCHED";
const STANDARD_INSTALL_FOLDER_ENV = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA"];
const STANDARD_INSTALL_FOLDERS_ARE_EMPTY = process.platform === "win32" || ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].every(folder => !existsSync(join(folder, "node")));

const pathWithoutBunShim = (process.env.PATH ?? "").split(delimiter).filter(directory => !basename(directory).startsWith(BUN_SHIM_PREFIX)).join(delimiter);
const candidate = process.env.BROWSER_TEST_NODE ?? Bun.which("node", { PATH: pathWithoutBunShim }) ?? undefined;

function realNodeVersion(file: string | undefined): string | undefined {
  if (file === undefined || basename(file).toLowerCase() !== EXE) return undefined;
  const run = spawnSync(file, ["-p", "process.versions.bun ? '' : process.versions.node"], { encoding: "utf8" });
  const version = run.status === 0 ? run.stdout.trim() : "";
  return atLeast(version) ? version : undefined;
}

const NODE_VERSION = realNodeVersion(candidate);
const NODE_DIRECTORY = candidate === undefined ? "" : dirname(candidate);
if (NODE_VERSION === undefined) console.warn("[browser tests] the launcher tests that need a real Node are SKIPPED, not passed: needs a `node` 22.12+ on the PATH (or BROWSER_TEST_NODE=<path to node>)");
const describeWithNode = NODE_VERSION === undefined ? describe.skip : describe;

let out = "";
const scratch: string[] = [];
const closers: Array<() => Promise<void>> = [];

function scratchDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dimension-browser-launch-${name}-`));
  scratch.push(directory);
  return directory;
}

beforeAll(async () => {
  out = scratchDirectory("bundle");
  const app = join(out, "app");
  const pkg = JSON.parse(readFileSync(join(PACK, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const bundle = { bundle: true, platform: "node", format: "esm", target: "node22", external: Object.keys(pkg.dependencies), sourcemap: false, loader: { ".txt": "text", ".md": "text" }, logLevel: "silent" } as const;
  await build({ ...bundle, entryPoints: [join(PACK, "src/stdio.ts")], outfile: join(app, "server.mjs") });
  await build({ ...bundle, entryPoints: [join(PACK, "src/code/worker/entry.ts")], outfile: join(app, "code-worker.mjs") });
  await build({ ...bundle, entryPoints: [join(PACK, "src/launch.ts")], outfile: join(app, "launch.mjs") });
  cpSync(join(PACK, "app/dist"), join(app, "dist"), { recursive: true });
  cpSync(join(PACK, "recipes"), join(out, "recipes"), { recursive: true });
  symlinkSync(fileURLToPath(new URL("../../../../node_modules", import.meta.url)), join(out, "node_modules"), "junction");
}, 60_000);

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

afterAll(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function environment(overrides: Record<string, string | undefined>): Record<string, string> {
  const replaced = new Set(Object.keys(overrides).map(name => name.toUpperCase()));
  const kept = Object.entries(process.env).filter(([name, value]) => value !== undefined && !replaced.has(name.toUpperCase()));
  const added = Object.entries(overrides).filter(([, value]) => value !== undefined);
  return Object.fromEntries([...kept, ...added]) as Record<string, string>;
}

async function runLauncher(entry: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, entry], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: LAUNCHER_EXIT_TIMEOUT_MS });
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

interface Session {
  client: Client;
  stderr: () => string;
  failures: Error[];
}

async function connect(runtime: string, env: Record<string, string>): Promise<Session> {
  const root = scratchDirectory("root");
  const transport = new StdioClientTransport({ command: runtime, args: [join(out, "app", "launch.mjs")], cwd: out, env: { ...env, DIMENSION_BROWSER_ROOT: root }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", chunk => void (stderr += String(chunk)));
  const client = new Client({ name: "launch-entry-test", version: "0" });
  const failures: Error[] = [];
  client.onerror = error => void failures.push(error);
  closers.push(() => client.close());
  await client.connect(transport).catch((error: Error) => {
    throw new Error(`${error.message}\nlauncher stderr:\n${stderr}`);
  });
  return { client, stderr: () => stderr, failures };
}

async function runAliveCell({ client }: Session): Promise<{ isError: boolean; text: string; tools: string[] }> {
  const { tools } = await client.listTools();
  const result = await client.callTool(
    { name: "browser_run", arguments: { code: "console.log('alive')" }, _meta: { "ai.insodimension/caller": "model", "ai.insodimension/session": { sessionId: "s1" } } },
    undefined,
    { timeout: CELL_TIMEOUT_MS },
  );
  const content = result.content as Array<{ type: string; text?: string }>;
  return { isError: result.isError === true, text: content.map(part => part.text ?? "").join("\n"), tools: tools.map(tool => tool.name) };
}

describeWithNode("the launcher under Bun, as a host that runs the pack with `bun run` starts it", () => {
  test(
    "a cell runs: the server is relaunched under a real Node, because under Bun with a piped stdin no worker thread ever comes online",
    async () => {
      const session = await connect(process.execPath, { PATH: NODE_DIRECTORY });
      const cell = await runAliveCell(session);
      expect(cell.tools).toContain("browser_run");
      expect(cell.text).toContain("alive");
      expect(cell.isError).toBe(false);
      expect(session.stderr()).toContain(`[browser] running under Bun; relaunching under Node ${NODE_VERSION}`);
      expect(session.failures).toEqual([]);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  test("a server that fails to start fails the launcher with its exit code, so the host sees a crashed pack and not a clean exit", async () => {
    const withoutServer = join(scratchDirectory("without-server"), "app");
    mkdirSync(withoutServer);
    copyFileSync(join(out, "app", "launch.mjs"), join(withoutServer, "launch.mjs"));
    const run = await runLauncher(join(withoutServer, "launch.mjs"), environment({ PATH: NODE_DIRECTORY }));
    expect(run.stderr).toContain("[browser] running under Bun; relaunching under Node");
    expect(run.exitCode).toBe(1);
  });

  test("a relaunched process that is still Bun stops with one message and does not relaunch again", async () => {
    const run = await runLauncher(join(out, "app", "launch.mjs"), environment({ PATH: NODE_DIRECTORY, [RELAUNCHED]: "1" }));
    expect(run.exitCode).toBe(1);
    expect(run.stderr).not.toContain("relaunching");
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toStartWith("[browser] ");
    expect(run.stdout).toBe("");
  });
});

describeWithNode("the launcher under Node", () => {
  test(
    "a cell runs in place: the server is imported beside the launcher and nothing is relaunched",
    async () => {
      const session = await connect(join(NODE_DIRECTORY, EXE), {});
      const cell = await runAliveCell(session);
      expect(cell.text).toContain("alive");
      expect(cell.isError).toBe(false);
      expect(session.stderr()).not.toContain("relaunching");
      expect(session.failures).toEqual([]);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});

describe("the launcher under Bun with no usable Node", () => {
  test.skipIf(!STANDARD_INSTALL_FOLDERS_ARE_EMPTY)("it exits 1 with one [browser] line that names Node, and writes nothing to the MCP stream", async () => {
    const emptyPath = scratchDirectory("empty-path");
    const blanked = Object.fromEntries(STANDARD_INSTALL_FOLDER_ENV.map(name => [name, undefined]));
    const run = await runLauncher(join(out, "app", "launch.mjs"), environment({ ...blanked, PATH: emptyPath }));
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toMatch(/^\[browser\] .*Node/);
  });
});
