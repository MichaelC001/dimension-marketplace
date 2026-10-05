// What the pane shows, derived from facts. Pure: no DOM, no network. The pane's
// states are listed once here so "what does a person with no adb see?" has one
// answer, written next to the others.

import type { DeviceInfo } from "../contracts";

export interface MissingTool {
  readonly tool: string;
  readonly needed: string;
  readonly fix: string;
}

export interface ListState {
  readonly devices: readonly DeviceInfo[];
  readonly avds: readonly { readonly name: string; readonly running: boolean }[];
  readonly toolchain: { readonly adb: string | null; readonly emulator: string | null; readonly scrcpyServer: string | null; readonly missing: readonly MissingTool[] };
  readonly live: boolean;
}

export type Screen =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "missing-adb"; readonly missing: readonly MissingTool[] }
  | { readonly kind: "no-device"; readonly avds: readonly string[]; readonly missing: readonly MissingTool[] }
  | { readonly kind: "booting"; readonly avd: string }
  | { readonly kind: "device"; readonly device: DeviceInfo; readonly notes: readonly MissingTool[] };

export interface Selection {
  /** A running device's serial, or null for "the first one". */
  readonly serial: string | null;
  /** An AVD being booted from this pane. */
  readonly booting: string | null;
}

export function deriveScreen(list: ListState | null, selection: Selection, failure: string | null): Screen {
  if (failure !== null && list === null) return { kind: "unavailable", reason: failure };
  if (list === null) return { kind: "loading" };
  if (list.toolchain.adb === null) return { kind: "missing-adb", missing: list.toolchain.missing };
  if (selection.booting !== null) return { kind: "booting", avd: selection.booting };
  const usable = list.devices.filter(device => device.state === "online" || device.state === "booting");
  const chosen = usable.find(device => device.serial === selection.serial) ?? usable[0];
  if (chosen === undefined) {
    return { kind: "no-device", avds: list.avds.filter(avd => !avd.running).map(avd => avd.name), missing: list.toolchain.missing.filter(missing => missing.tool !== "scrcpy-server") };
  }
  if (chosen.state === "booting") return { kind: "booting", avd: chosen.name };
  return { kind: "device", device: chosen, notes: list.toolchain.missing.filter(missing => missing.tool === "scrcpy-server") };
}

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly group: "running" | "boot";
}

/** Running devices first; then every AVD that is not running, as "Boot <name>". */
export function pickerOptions(list: ListState): PickerOption[] {
  const running = list.devices
    .filter(device => device.state === "online" || device.state === "booting")
    .map((device): PickerOption => ({ value: `serial:${device.serial}`, label: `${device.name}  (${device.serial})`, group: "running" }));
  const bootable = list.avds.filter(avd => !avd.running && list.toolchain.emulator !== null).map((avd): PickerOption => ({ value: `avd:${avd.name}`, label: `Boot ${avd.name}`, group: "boot" }));
  return [...running, ...bootable];
}

export type StreamPhase = "connecting" | "live" | "reconnecting" | "ended";

export interface StreamStatus {
  readonly phase: StreamPhase;
  readonly mode: "h264" | "shot";
  /** Why it is not the live video the person expects ("Shot fallback"), or null. */
  readonly fallbackReason: string | null;
  readonly fps: number;
  readonly latencyMs: number | null;
  readonly detail: string | null;
}

/** The chip text for the stream: honest about what is being shown. */
export function modeLabel(status: StreamStatus): string {
  if (status.phase === "connecting") return "Connecting";
  if (status.phase === "reconnecting") return "Reconnecting";
  if (status.phase === "ended") return "Stopped";
  return status.mode === "h264" ? "Live H.264" : "Shot fallback";
}
