import type { BrowserAction, BrowserRegion, Viewport } from "../contracts.js";

export interface EngineState {
  url: string;
  title: string;
  /** Stable for one document; MUST change on reload and same-URL navigation. */
  documentId: string;
  viewport: Viewport;
}

export interface EngineDriver {
  state(): Promise<EngineState>;
  /** Viewport PNG, not a full-page image; device scale factor is one. */
  screenshot(): Promise<Uint8Array>;
  snapshot(limit: number): Promise<string>;
  elements(region: BrowserRegion, limit: number): Promise<string>;
  /**
   * Perform one action now, once, never retried. Throws `ActionNotDispatched`
   * when provably nothing reached the page; any other error means the effect
   * may have happened.
   */
  perform(action: BrowserAction): Promise<void>;
  /** CDP websocket endpoint of this browser, for an upstream task agent to attach to. */
  cdpEndpoint(): string;
  /**
   * While a task agent runs, show the page it works in: a page it opens becomes
   * the current page. Returns a function that stops following.
   */
  followNewPages(): () => void;
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
