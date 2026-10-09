// Written for the Browser pack. Which Node the pack's server runs on, decided without touching the process: `launch.ts` supplies the filesystem and the child process, this file only chooses.
//
// Why a choice exists at all: the pack declares Node 22.12+ (`engines`), and a host spawns it as a bare `node`. Under `bun run` that name resolves to `%TEMP%\bun-node-<hash>\node.exe`, which is Bun. A Bun process
// whose stdin is a flowing pipe never brings a new `worker_threads` thread online (measured on Windows, Bun 1.3.14: the thread is constructed, `online` never fires, a trivial worker in the same process starts in
// 30 ms), so every `browser_run` cell times out at "initializing browser tab worker". The launcher therefore relaunches the server under a real Node when it finds itself under Bun.

import { basename, join } from "node:path";

/** The floor in package.json `engines`: the oldest Node the code worker's memory accounting is written for (22.12 to 22.15 read the commit charge through a helper, 22.16+ ask the worker). */
export const MIN_NODE = { major: 22, minor: 12 } as const;

export interface NodeFound {
  file: string;
  version: string;
}

export interface NodeSearch {
  /** `PATH`, split, in order. */
  path: readonly string[];
  /** Where a Node installs to that a host's PATH may lack, tried after `path`. */
  fallbacks: readonly string[];
  /** The binary name: `node.exe` or `node`. */
  exe: string;
  /** The running runtime's own binary, never chosen: relaunching under it would loop. */
  self: string;
  exists(file: string): boolean;
  /** The Node version a binary reports; undefined when it does not run, or is not Node (Bun answers to `node` too and says so by reporting no version here). */
  versionOf(file: string): string | undefined;
}

/** Whether `version` ("22.12.0", "v24.1.0") is at least `min`. Anything that is not a version is not enough. */
export function atLeast(version: string, min: { major: number; minor: number } = MIN_NODE): boolean {
  const [major = Number.NaN, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > min.major || (major === min.major && minor >= min.minor);
}

/** The directory `bun run` puts its `node` stand-in in. A Bun that has been copied to a file named `node` is still Bun, so the directory is skipped by name and the binary is asked what it is as well. */
function isBunShimDirectory(directory: string): boolean {
  return basename(directory).startsWith("bun-node-");
}

/** The first real Node of at least the pack's floor: PATH in order, then the usual install places. */
export function pickNode(search: NodeSearch): NodeFound | undefined {
  for (const directory of [...search.path, ...search.fallbacks]) {
    if (directory === "" || isBunShimDirectory(directory)) continue;
    const file = join(directory, search.exe);
    if (file === search.self || !search.exists(file)) continue;
    const version = search.versionOf(file);
    if (version !== undefined && atLeast(version)) return { file, version };
  }
  return undefined;
}
