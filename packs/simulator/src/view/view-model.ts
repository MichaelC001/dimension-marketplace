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
  /** The user's `simulator.allowPhysical` setting: without it the pane never lists a phone. */
  readonly allowPhysical: boolean;
}

export type Screen =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "missing-adb"; readonly missing: readonly MissingTool[] }
  /** `hiddenPhones`: attached phones the pane is not listing (emulators only, unless the person asks and the setting allows). `listedPhones`: phones in the picker that nobody picked. */
  | { readonly kind: "no-device"; readonly avds: readonly string[]; readonly missing: readonly MissingTool[]; readonly hiddenPhones: number; readonly listedPhones: number }
  /** `notes`: what the boot said about itself (fell back to software graphics, ...). */
  | { readonly kind: "booting"; readonly avd: string; readonly notes: readonly string[] }
  /** `bootNotes`: what the boot that produced this device said about itself (software graphics fallback, an already-running device, ...). */
  | { readonly kind: "device"; readonly device: DeviceInfo; readonly notes: readonly MissingTool[]; readonly bootNotes: readonly string[] };

export interface Selection {
  /** A running device's serial, or null for "the first one". */
  readonly serial: string | null;
  /** An AVD being booted from this pane. */
  readonly booting: string | null;
  /** What the boot in progress has said about itself; empty when none is. */
  readonly notes: readonly string[];
}

/**
 * Online or starting devices the pane may offer: every emulator, and a physical
 * phone only while the person asked to see phones AND the setting allows driving one.
 * An emulator adb lists as `offline` is one that is still starting (it has a console
 * before adb has a transport): it is shown as booting, not as "no device".
 */
export function usableDevices(list: ListState, showPhysical: boolean): DeviceInfo[] {
  const phones = showPhysical && list.allowPhysical;
  return list.devices.filter(device => (device.state === "online" || device.state === "booting" || (device.state === "offline" && device.kind === "emulator")) && (device.kind === "emulator" || phones));
}

export function deriveScreen(list: ListState | null, selection: Selection, failure: string | null, showPhysical: boolean): Screen {
  if (failure !== null && list === null) return { kind: "unavailable", reason: failure };
  if (list === null) return { kind: "loading" };
  if (list.toolchain.adb === null) return { kind: "missing-adb", missing: list.toolchain.missing };
  if (selection.booting !== null) return { kind: "booting", avd: selection.booting, notes: selection.notes };
  const usable = usableDevices(list, showPhysical);
  // A phone is shown only when the person picked it: never as "the first device".
  const chosen = usable.find(device => device.serial === selection.serial) ?? usable.find(device => device.kind === "emulator");
  if (chosen === undefined) {
    const attachedPhones = list.devices.filter(device => device.kind === "physical" && (device.state === "online" || device.state === "booting")).length;
    const listedPhones = usable.length;
    return { kind: "no-device", avds: list.avds.filter(avd => !avd.running).map(avd => avd.name), missing: list.toolchain.missing.filter(missing => missing.tool !== "scrcpy-server"), hiddenPhones: attachedPhones - listedPhones, listedPhones };
  }
  if (chosen.state === "booting" || chosen.state === "offline") return { kind: "booting", avd: chosen.name, notes: [] };
  return { kind: "device", device: chosen, notes: list.toolchain.missing.filter(missing => missing.tool === "scrcpy-server"), bootNotes: chosen.serial === selection.serial ? selection.notes : [] };
}

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly group: "running" | "physical" | "boot";
}

/** Running emulators first; then phones (only when shown), each marked "physical device"; then every AVD that is not running, as "Boot <name>". */
export function pickerOptions(list: ListState, showPhysical: boolean): PickerOption[] {
  const usable = usableDevices(list, showPhysical);
  const running = usable.filter(device => device.kind === "emulator").map((device): PickerOption => ({ value: `serial:${device.serial}`, label: `${device.name}  (${device.serial})`, group: "running" }));
  const phones = usable.filter(device => device.kind === "physical").map((device): PickerOption => ({ value: `serial:${device.serial}`, label: `${device.name}  (${device.serial})  ·  physical device`, group: "physical" }));
  const bootable = list.avds.filter(avd => !avd.running && list.toolchain.emulator !== null).map((avd): PickerOption => ({ value: `avd:${avd.name}`, label: `Boot ${avd.name}`, group: "boot" }));
  return [...running, ...phones, ...bootable];
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
