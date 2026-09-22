export const BROWSER_ENGINES = ["chromium", "chrome-relay", "abp", "browser4", "jev", "browser-use"] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
/** Maximum encoded PNG accepted by the host's image model-context contract. */
export const MAX_ANNOTATION_BYTES = 2_097_152;
export interface Viewport { width: number; height: number }
export interface BrowserAction {
  kind: "navigate" | "click" | "type" | "press" | "scroll";
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
}
export interface PendingAction {
  id: string;
  requestId: string;
  action: BrowserAction;
  status: "pending" | "denied" | "claimed" | "completed" | "failed" | "unknown";
  revision: number;
  error?: string;
}
export interface BrowserState {
  browserId: string;
  profile: string;
  engine: BrowserEngine;
  url: string;
  title: string;
  revision: number;
  viewport: Viewport;
  actions: PendingAction[];
}
export interface BrowserFrame {
  state: BrowserState;
  frameId: string;
  mimeType: "image/png";
  data: string;
  capturedAt: string;
}
export interface BrowserRegion { x: number; y: number; width: number; height: number }
export interface BrowserAnnotation {
  url: string;
  note: string;
  region: BrowserRegion;
  capturedAt: string;
  mimeType: "image/png";
  data: string;
  elements: string;
}
export interface BrowserOpenOptions {
  profile: string;
  engine?: BrowserEngine;
  viewport?: Viewport;
}
/** Capability is the opaque browserId; it must never appear in global listings. */
export interface BrowserRuntimePort {
  open(options: BrowserOpenOptions): Promise<BrowserState>;
  state(browserId: string): Promise<BrowserState>;
  frame(browserId: string): Promise<BrowserFrame>;
  snapshot(browserId: string): Promise<{ state: BrowserState; text: string }>;
  requestAction(browserId: string, requestId: string, action: BrowserAction): Promise<PendingAction>;
  previewAction(browserId: string, actionId: string): Promise<BrowserAction>;
  resolveAction(browserId: string, actionId: string, approve: boolean, signal?: AbortSignal): Promise<PendingAction>;
  annotate(browserId: string, frameId: string, region: BrowserRegion, note: string): Promise<BrowserAnnotation>;
  profiles(): Promise<string[]>;
  close(browserId: string): Promise<void>;
  dispose(): Promise<void>;
}
