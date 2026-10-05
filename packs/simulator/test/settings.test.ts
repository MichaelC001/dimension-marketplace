/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the person's own switches stop
 *  meaning what they set. `simulator.allowPhysical` is the safety key for the
 *  owner's phone, so a typo must leave it OFF; `simulator.gpu` goes straight
 *  onto the emulator's command line, where an unknown word stops the emulator
 *  starting at all. The pack's server reads the same config file the engine
 *  does, in either of the shapes `omp config set` leaves.
 */
import { describe, expect, test } from "bun:test";
import { agentConfigPath, GPU_MODES, readGroupScalars, readSettings, type SettingsSource } from "../src/settings";

function source(yaml: string | null, env: Record<string, string> = {}): SettingsSource {
  return { env, home: "/home/me", readFile: () => yaml };
}

describe("simulator.allowPhysical fails closed", () => {
  const on = ["true", "TRUE", "on", "On", "yes", "1", '"true"', "true # the owner said so"];
  for (const value of on) {
    test(`${value} turns it on`, () => {
      expect(readSettings(source(`simulator:\n  allowPhysical: ${value}\n`)).allowPhysical).toBe(true);
    });
  }

  const off = ["false", "off", "no", "0", "ture", "enabled", "2", "", "truee", '"yes please"'];
  for (const value of off) {
    test(`${JSON.stringify(value)} leaves it off`, () => {
      expect(readSettings(source(`simulator:\n  allowPhysical: ${value}\n`)).allowPhysical).toBe(false);
    });
  }

  test("a file with no mention of it leaves it off", () => {
    expect(readSettings(source("simulator:\n  maxDevices: 3\n")).allowPhysical).toBe(false);
    expect(readSettings(source(null)).allowPhysical).toBe(false);
  });

  test("the environment overrides the file, in both directions", () => {
    expect(readSettings(source("simulator:\n  allowPhysical: false\n", { SIMULATOR_ALLOW_PHYSICAL: "true" })).allowPhysical).toBe(true);
    expect(readSettings(source("simulator:\n  allowPhysical: true\n", { SIMULATOR_ALLOW_PHYSICAL: "false" })).allowPhysical).toBe(false);
  });
});

describe("simulator.gpu is always a mode the emulator knows", () => {
  for (const mode of GPU_MODES) {
    test(`${mode} is passed through`, () => {
      expect(readSettings(source(`simulator:\n  gpu: ${mode}\n`)).gpu).toBe(mode);
    });
  }

  test("case and padding do not matter", () => {
    expect(readSettings(source('simulator:\n  gpu: "  Swiftshader_Indirect "\n')).gpu).toBe("swiftshader_indirect");
  });

  const unknown = ["swiftshader", "gpu_host", "vulkan", "host,auto", ""];
  for (const value of unknown) {
    test(`${JSON.stringify(value)} never reaches the emulator`, () => {
      const { gpu } = readSettings(source(`simulator:\n  gpu: ${JSON.stringify(value)}\n`));
      expect(GPU_MODES as readonly string[]).toContain(gpu);
    });
  }
});

describe("numeric settings", () => {
  test("a valid number is read", () => {
    expect(readSettings(source("simulator:\n  maxDevices: 4\n  idleMinutes: 30\n"))).toMatchObject({ maxDevices: 4, idleMinutes: 30 });
  });

  test("the emulator cap is 1 to 8: a mistaken 99 does not boot ninety-nine, and 0 does not boot none", () => {
    expect(readSettings(source("simulator:\n  maxDevices: 8\n")).maxDevices).toBe(8);
    expect(readSettings(source("simulator:\n  maxDevices: 1\n")).maxDevices).toBe(1);
    for (const value of ["9", "99", "0", "-1", "2.5", "many"]) {
      const { maxDevices } = readSettings(source(`simulator:\n  maxDevices: ${value}\n`));
      expect({ value, withinBounds: maxDevices >= 1 && maxDevices <= 8, rejected: String(maxDevices) !== value }).toEqual({ value, withinBounds: true, rejected: true });
    }
  });

  test("the idle time must be a whole number of minutes", () => {
    expect(readSettings(source("simulator:\n  idleMinutes: 2.5\n")).idleMinutes).not.toBe(2.5);
    expect(readSettings(source("simulator:\n  idleMinutes: 0\n")).idleMinutes).not.toBe(0);
  });
});

describe("where the values come from", () => {
  test("both shapes omp config set can leave: a nested block and dotted keys", () => {
    expect(readGroupScalars("simulator:\n  gpu: host\n  allowPhysical: true\n", "simulator")).toEqual({ gpu: "host", allowPhysical: "true" });
    expect(readGroupScalars("simulator.gpu: host\nsimulator.allowPhysical: true\n", "simulator")).toEqual({ gpu: "host", allowPhysical: "true" });
  });

  test("another group's keys, comments and quoting are not this group's", () => {
    const yaml = ["# settings", "browser:", "  gpu: angle_indirect", "simulator:", '  gpu: "host"  # trailing', "other:", "  allowPhysical: true"].join("\n");
    expect(readGroupScalars(yaml, "simulator")).toEqual({ gpu: "host" });
  });

  test("a sibling group whose name starts the same is not ours", () => {
    expect(readGroupScalars("simulator_extra:\n  gpu: host\n", "simulator")).toEqual({});
    expect(readGroupScalars("simulator_extra.gpu: host\n", "simulator")).toEqual({});
  });

  test("PI_CODING_AGENT_DIR names the config directory; otherwise PI_CONFIG_DIR (or .omp) under the home", () => {
    expect(agentConfigPath({ env: { PI_CODING_AGENT_DIR: "/agent" }, home: "/home/me", readFile: () => null }).replaceAll("\\", "/")).toBe("/agent/config.yml");
    expect(agentConfigPath({ env: { PI_CONFIG_DIR: ".inso" }, home: "/home/me", readFile: () => null }).replaceAll("\\", "/")).toBe("/home/me/.inso/agent/config.yml");
  });
});
