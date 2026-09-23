/** What the browser IS. `abp` and `browser4` are refused with the reason (see engines/refused.ts). */
export const BROWSER_ENGINES = ["chromium", "chrome-relay", "abp", "browser4"] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
/** Who drives a whole task at its own speed: upstream agent loops, used as published. */
export const TASK_AGENTS = ["jev", "browser-use"] as const;
export type TaskAgent = (typeof TASK_AGENTS)[number];
/** Maximum encoded PNG accepted by the host's image model-context contract. */
export const MAX_ANNOTATION_BYTES = 2_097_152;
export interface Viewport { width: number; height: number }
export interface BrowserAction {
  kind: "navigate" | "click" | "type" | "select" | "press" | "scroll";
  url?: string;
  selector?: string;
  text?: string;
  /** `select`: the option's value or visible text. */
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
}
/** `failed`: provably nothing happened. `unknown`: dispatched, then errored — may have taken effect. */
export type ActionStatus = "completed" | "failed" | "unknown";
export interface ActionResult { status: ActionStatus; error?: string; state: BrowserState }
export interface TaskStep { n: number; action: string; url: string; elapsedMs: number }
export interface TaskUsage { modelCalls: number; inputTokens: number; outputTokens: number; costUsd: number | null }
export type TaskStatus = "running" | "done" | "blocked" | "failed" | "cancelled";
export interface TaskRun {
  id: string;
  agent: TaskAgent;
  task: string;
  status: TaskStatus;
  /** The agent's final message, or the failure reason. */
  summary: string;
  /** The most recent steps (bounded); `stepCount` is the total. */
  steps: TaskStep[];
  stepCount: number;
  startedAt: string;
  elapsedMs: number;
  usage: TaskUsage;
}
export interface TaskRequest { agent: TaskAgent; task: string; maxSteps?: number }
export interface BrowserState {
  browserId: string;
  profile: string;
  engine: BrowserEngine;
  url: string;
  title: string;
  revision: number;
  viewport: Viewport;
  /** The running or most recent task on this browser. */
  task: TaskRun | null;
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
  act(browserId: string, action: BrowserAction): Promise<ActionResult>;
  runTask(browserId: string, request: TaskRequest, onStep?: (step: TaskStep, run: TaskRun) => void): Promise<TaskRun>;
  cancelTask(browserId: string): Promise<TaskRun>;
  annotate(browserId: string, frameId: string, region: BrowserRegion, note: string): Promise<BrowserAnnotation>;
  profiles(): Promise<string[]>;
  close(browserId: string): Promise<void>;
  dispose(): Promise<void>;
}
