/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: under Bun the launcher
 *  relaunches the server under the wrong Node or under none: Bun's own bun-node
 *  shim, a Bun copy named node, the running Bun itself, a Node older than the
 *  engines floor, a node planted through an empty PATH entry, or nothing when
 *  Node is only in a standard install folder.
 *
 *  pickNode and atLeast over a scripted machine; no process is started.
 */
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, test } from "bun:test";
import { atLeast, pickNode, type NodeSearch } from "../src/launch-node";

const EXE = "node";

interface Machine {
  files: Record<string, string | undefined>;
  path?: string[];
  fallbacks?: string[];
  self?: string;
}

const binary = (directory: string): string => join(directory, EXE);

function searchOn({ files, path = [], fallbacks = [], self = binary("elsewhere") }: Machine): NodeSearch {
  return {
    path,
    fallbacks,
    exe: EXE,
    self,
    exists: file => file in files,
    versionOf: file => files[file],
  };
}

function machine(installed: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(installed).map(([directory, version]) => [binary(directory), version]));
}

describe("atLeast: the floor the pack declares", () => {
  const rows: Array<{ name: string; version: string; accepted: boolean }> = [
    { name: "one patch below the floor's minor is refused", version: "22.11.9", accepted: false },
    { name: "the floor itself is accepted", version: "22.12.0", accepted: true },
    { name: "a later minor of the same major is accepted", version: "22.15.1", accepted: true },
    { name: "a higher major with a lower minor is accepted", version: "23.0.0", accepted: true },
    { name: "the current LTS is accepted", version: "24.12.0", accepted: true },
    { name: "a lower major with a high minor is refused", version: "20.99.0", accepted: false },
    { name: "node's `v` prefix is read, and a high major with a low minor still passes", version: "v24.1.0", accepted: true },
    { name: "node's `v` prefix does not rescue a version below the floor", version: "v22.11.0", accepted: false },
    { name: "a major with no minor is below a floor that asks for one", version: "22", accepted: false },
    { name: "an empty answer is not a version", version: "", accepted: false },
    { name: "a runtime's name is not a version", version: "bun", accepted: false },
    { name: "a version with a garbage minor is not enough", version: "22.x.0", accepted: false },
  ];
  for (const { name, version, accepted } of rows) {
    test(name, () => {
      expect(atLeast(version)).toBe(accepted);
    });
  }

  test("the floor the launcher enforces is the floor package.json declares in engines", () => {
    const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    const [, major, minor] = /(\d+)\.(\d+)/.exec(engines.node) ?? [];
    expect(atLeast(`${major}.${minor}.0`)).toBe(true);
    expect(atLeast(`${major}.${Number(minor) - 1}.99`)).toBe(false);
  });
});

describe("pickNode: which Node the server is relaunched under", () => {
  test("the first usable Node on PATH wins, not the newest one and not one in a standard install folder", () => {
    const files = machine({ first: "24.1.0", second: "24.12.0", standard: "24.12.0" });
    const found = pickNode(searchOn({ files, path: ["first", "second"], fallbacks: ["standard"] }));
    expect(found).toEqual({ file: binary("first"), version: "24.1.0" });
  });

  test("the standard install folders are searched when PATH holds no usable Node, so a GUI host with a short PATH still finds Node", () => {
    const files = machine({ onPath: "20.11.0", standard: "24.1.0" });
    const found = pickNode(searchOn({ files, path: ["onPath", "missing"], fallbacks: ["nowhere", "standard"] }));
    expect(found).toEqual({ file: binary("standard"), version: "24.1.0" });
  });

  test("a bun-node-<hash> directory is never used, even though its binary exists and claims a good version", () => {
    const shim = join("tmp", "bun-node-5b2fcb4");
    const files = machine({ [shim]: "24.12.0", real: "24.1.0" });
    const found = pickNode(searchOn({ files, path: [shim, "real"] }));
    expect(found).toEqual({ file: binary("real"), version: "24.1.0" });
  });

  test("a bun-node-<hash> directory written with a trailing separator is still recognised as the shim", () => {
    const shim = join("tmp", "bun-node-5b2fcb4");
    const files = machine({ [shim]: "24.12.0" });
    expect(pickNode(searchOn({ files, path: [`${shim}${sep}`] }))).toBeUndefined();
  });

  test("a directory that only resembles the shim's name is searched like any other", () => {
    const files = machine({ "my-bun-node-tools": "24.1.0" });
    expect(pickNode(searchOn({ files, path: ["my-bun-node-tools"] }))?.version).toBe("24.1.0");
  });

  test("a binary that reports no version (a copy of Bun named node) is skipped and the search goes on", () => {
    const files = machine({ copyOfBun: undefined, real: "24.1.0" });
    const found = pickNode(searchOn({ files, path: ["copyOfBun", "real"] }));
    expect(found).toEqual({ file: binary("real"), version: "24.1.0" });
  });

  test("a Node older than the floor earlier on PATH is skipped for a newer one later on it", () => {
    const files = machine({ old: "20.11.0", older: "18.20.4", current: "24.12.0" });
    const found = pickNode(searchOn({ files, path: ["old", "older", "current"] }));
    expect(found).toEqual({ file: binary("current"), version: "24.12.0" });
  });

  test("the running runtime's own binary is never chosen, however good a version it reports", () => {
    const self = binary("here");
    const files = machine({ here: "24.12.0", other: "24.1.0" });
    const found = pickNode(searchOn({ files, path: ["here", "other"], self }));
    expect(found).toEqual({ file: binary("other"), version: "24.1.0" });
    expect(pickNode(searchOn({ files: machine({ here: "24.12.0" }), path: ["here"], self }))).toBeUndefined();
  });

  test("an empty PATH entry is not read as the working directory, where a planted node would be found", () => {
    const files: Record<string, string | undefined> = { [EXE]: "24.12.0" };
    expect(pickNode(searchOn({ files, path: ["", ""], fallbacks: [""] }))).toBeUndefined();
  });

  test("nothing usable anywhere is undefined, so the launcher can say so instead of starting something", () => {
    const files = machine({ copyOfBun: undefined, old: "20.0.0" });
    expect(pickNode(searchOn({ files, path: ["copyOfBun", "old", "absent"], fallbacks: ["alsoAbsent"] }))).toBeUndefined();
    expect(pickNode(searchOn({ files: {} }))).toBeUndefined();
  });
});
