// THE seam between the pack and a platform.
//
// Everything above this file (the fleet, the frame relay, the MCP tools, the
// View) is platform-neutral: it speaks `DeviceBackend`. Everything below it is
// one platform's tools. Android ships (src/android). An iOS simulator is a
// macOS-host backend that implements this same interface with `xcrun simctl`; see
// the README for why it is not here.

import type { BootRequest, DeviceInfo, KeyName, Screenshot, UiSnapshot, VideoPacket } from "./contracts";
import type { Size } from "./shared/pointer";

export interface VideoStreamOptions {
  /** Longest edge of the encoded video, in pixels. */
  readonly maxSize: number;
  readonly maxFps: number;
  readonly bitRate: number;
}

export const DEFAULT_VIDEO_OPTIONS: VideoStreamOptions = { maxSize: 1280, maxFps: 30, bitRate: 4_000_000 };

export interface VideoStreamHandlers {
  session(size: Size): void;
  packet(packet: VideoPacket): void;
  closed(reason: string, deliberate: boolean): void;
}

/** A live encoder on one device, shared by every viewer of it. */
export interface VideoStream {
  readonly serial: string;
  size(): Size | null;
  requestKeyframe(): void;
  /** Touch at a normalized point; false when it could not be delivered. */
  touch(action: "down" | "move" | "up", nx: number, ny: number): boolean;
  key(key: KeyName): boolean;
  text(text: string): boolean;
  close(): Promise<void>;
}

/** What booting hands back: the device is named at once, `ready` settles when it is usable. */
export interface BootHandle {
  readonly serial: string;
  readonly avd: string;
  /** The process that owns the VM, when the platform has one to signal. */
  readonly pid: number | null;
  /** Resolves when the device accepts input; rejects with the reason it never will. */
  readonly ready: Promise<DeviceInfo>;
}

export interface DeviceBackend {
  readonly platform: "android";

  list(): Promise<DeviceInfo[]>;
  /** Bootable virtual devices (AVD names). */
  avds(): Promise<string[]>;
  /** Start a virtual device. Does not wait for it to finish booting: see `BootHandle.ready`. */
  startBoot(request: BootRequest): Promise<BootHandle>;
  /** Shut a virtual device down. Callers (the fleet) decide whether the pack may. */
  stop(serial: string, pid: number | null): Promise<void>;
  /** Is `serial` running AND is it this virtual device? The identity check before adopting an orphan. */
  identify(serial: string): Promise<{ readonly avd: string } | null>;

  screenshot(serial: string, maxEdge: number): Promise<Screenshot>;
  tap(serial: string, x: number, y: number): Promise<void>;
  swipe(serial: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>;
  text(serial: string, text: string): Promise<void>;
  key(serial: string, key: KeyName): Promise<void>;
  openUrl(serial: string, url: string): Promise<void>;
  install(serial: string, apkPath: string): Promise<string>;
  launch(serial: string, target: string): Promise<void>;
  uiTree(serial: string): Promise<UiSnapshot>;
  /** The device's current display size (what tap/swipe coordinates are in). */
  display(serial: string): Promise<Size>;

  /** Start the shared H.264 encoder. Throws with the missing-prerequisite fix when it cannot. */
  openStream(serial: string, options: VideoStreamOptions, handlers: VideoStreamHandlers): Promise<VideoStream>;
  /** Whether Live video is possible at all on this machine (the encoder's prerequisites are present). */
  liveAvailable(): boolean;
}
