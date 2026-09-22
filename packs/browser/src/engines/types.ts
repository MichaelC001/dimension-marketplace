import type { BrowserAction, BrowserRegion, Viewport } from "../contracts.js";

export interface EngineState {
  url: string;
  title: string;
  /** Stable for one document; MUST change on reload and same-URL navigation. */
  documentId: string;
  viewport: Viewport;
}

export interface PreparedAction {
  /** Execute once, never retry. Recheck documentId before any native input. */
  dispatch(): Promise<void>;
  /** Release observed element handles even when no dispatch occurs. */
  dispose?(): Promise<void>;
}

export interface EngineDriver {
  state(): Promise<EngineState>;
  /** Viewport PNG, not a full-page image; device scale factor is one. */
  screenshot(): Promise<Uint8Array>;
  snapshot(limit: number): Promise<string>;
  elements(region: BrowserRegion, limit: number): Promise<string>;
  /** Read-only target preparation. Never navigate, focus, scroll or type here. */
  prepare(action: BrowserAction, documentId: string): Promise<PreparedAction>;
  /** Resolve only after owned resources shut down. Never close foreign browsers. */
  close(): Promise<void>;
}

export interface EngineOptions {
  /** Private persistent profile directory, already protected by the runtime lock. */
  profileDirectory: string;
  viewport: Viewport;
  /** Undefined permits the engine's supported default; explicit values must be honored. */
  headless?: boolean;
  executablePath?: string;
  relayUrl?: string;
  /**
   * Release callback, NOT merely a disconnected notification. Call exactly when
   * owned profile resources are confirmed stopped, including failed initialization
   * before anything launched. A failed/unconfirmed shutdown MUST retain the lock.
   * Do not call this for a parent/foreign browser that this driver does not own.
   */
  onClosed(): void;
}
