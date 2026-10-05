// The pack's settings group (`simulator.maxDevices`, `simulator.idleMinutes`,
// `simulator.sdkPath`) as the server reads it.
//
// The values live in the user's ordinary config under `<group>.<key>` (the
// plugin-settings contract), which the engine owns; an MCP server is a separate
// process and is handed none of it. So the server reads the same file the engine
// reads, lazily, at the moment a value is needed (no watcher, no polling): the
// agent config at `$PI_CODING_AGENT_DIR` or `~/<$PI_CONFIG_DIR | .omp>/agent`.
// An environment variable of the same meaning overrides the file, so a launcher
// can pin a value without touching the user's config.
//
// Only the three scalars this pack declares are read, from the two shapes `omp
// config set` can leave: a nested `simulator:` block, or a dotted `simulator.key:`.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SimulatorSettings {
  /** Most emulators THIS pack will have booted at once. */
  readonly maxDevices: number;
  /** Minutes without a viewer or a tool call before an owned emulator is stopped. */
  readonly idleMinutes: number;
  /** The Android SDK folder; null = ANDROID_HOME / the platform default. */
  readonly sdkPath: string | null;
}

export const DEFAULT_SETTINGS: SimulatorSettings = { maxDevices: 2, idleMinutes: 15, sdkPath: null };

const GROUP = "simulator";
const ENV_KEYS = { maxDevices: "SIMULATOR_MAX_DEVICES", idleMinutes: "SIMULATOR_IDLE_MINUTES", sdkPath: "SIMULATOR_SDK_PATH" } as const;

/** Scalars of one top-level group of a YAML document: `group:` block entries and `group.key:` lines. */
export function readGroupScalars(yaml: string, group: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inBlock = false;
  for (const raw of yaml.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indented = /^\s/.test(raw);
    if (!indented) {
      inBlock = new RegExp(`^${group}\\s*:\\s*(#.*)?$`).test(raw);
      const dotted = new RegExp(`^${group}\\.([A-Za-z0-9_]+)\\s*:\\s*(.*)$`).exec(raw);
      if (dotted?.[1] !== undefined && dotted[2] !== undefined) out[dotted[1]] = scalar(dotted[2]);
      continue;
    }
    if (!inBlock) continue;
    const entry = /^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(raw);
    if (entry?.[1] !== undefined && entry[2] !== undefined) out[entry[1]] = scalar(entry[2]);
  }
  return out;
}

function scalar(raw: string): string {
  const value = raw.replace(/\s+#.*$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}

function positiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export interface SettingsSource {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly readFile: (path: string) => string | null;
}

export const nodeSettingsSource = (): SettingsSource => ({
  env: process.env,
  home: homedir(),
  readFile: path => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
});

export function agentConfigPath(source: SettingsSource): string {
  const dir = source.env.PI_CODING_AGENT_DIR;
  if (dir) return join(dir, "config.yml");
  return join(source.home, source.env.PI_CONFIG_DIR || ".omp", "agent", "config.yml");
}

export function readSettings(source: SettingsSource = nodeSettingsSource()): SimulatorSettings {
  const text = source.readFile(agentConfigPath(source));
  const file = text === null ? {} : readGroupScalars(text, GROUP);
  const pick = (key: keyof typeof ENV_KEYS): string | undefined => source.env[ENV_KEYS[key]] ?? file[key];
  const sdk = pick("sdkPath");
  return {
    maxDevices: positiveInt(pick("maxDevices"), DEFAULT_SETTINGS.maxDevices, 1, 8),
    idleMinutes: positiveInt(pick("idleMinutes"), DEFAULT_SETTINGS.idleMinutes, 1, 24 * 60),
    sdkPath: sdk !== undefined && sdk !== "" ? sdk : null,
  };
}
