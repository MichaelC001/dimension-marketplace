// The View's whole reach into the pack: one typed wrapper per tool it uses, every
// call a standard `tools/call` proxied by the host (`App.callServerTool`).

import type { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DeviceInfo } from "../contracts";
import type { StreamMode } from "../shared/frame-protocol";
import type { ListState } from "./view-model";

type Result = CallToolResult;

/** An `isError` result is raised with the tool's own words; the View never substitutes a plausible value. */
function structured(tool: string, result: Result): Record<string, unknown> {
  if (result.isError === true) {
    const text = (result.content ?? []).flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
    throw new ToolError(text || `${tool} failed`);
  }
  const value = result.structuredContent;
  if (typeof value !== "object" || value === null) throw new ToolError(`${tool} answered without data`);
  return value as Record<string, unknown>;
}

export function readList(value: Record<string, unknown>): ListState | null {
  const { devices, avds, toolchain, live, settings } = value;
  if (!Array.isArray(devices) || !Array.isArray(avds) || typeof toolchain !== "object" || toolchain === null) return null;
  // The setting is the person's key to a phone: absent or unreadable reads as off.
  const allowPhysical = typeof settings === "object" && settings !== null && "allowPhysical" in settings && settings.allowPhysical === true;
  return { devices: devices as DeviceInfo[], avds: avds as ListState["avds"], toolchain: toolchain as ListState["toolchain"], live: live === true, allowPhysical };
}

export interface Grant {
  readonly url: string;
  readonly mode: StreamMode;
  readonly downgraded: string | null;
}

export class SimulatorClient {
  readonly #app: App;

  constructor(app: App) {
    this.#app = app;
  }

  async list(): Promise<ListState> {
    const list = readList(structured("device_list", await this.#app.callServerTool({ name: "device_list", arguments: {} })));
    if (list === null) throw new ToolError("device_list answered a shape this View cannot read");
    return list;
  }

  /** Boot, or keep waiting for a boot already under way: the tool returns within its wait cap, and says whether it is done. */
  async boot(avd: string): Promise<{ pending: boolean; device: DeviceInfo }> {
    const value = structured("device_boot", await this.#app.callServerTool({ name: "device_boot", arguments: { avd, waitSeconds: 20 } }));
    return { pending: value.pending === true, device: value.device as DeviceInfo };
  }

  async stop(serial: string): Promise<void> {
    structured("device_stop", await this.#app.callServerTool({ name: "device_stop", arguments: { serial } }));
  }

  /** `allowPhysical` is the View's half of the phone opt-in: true only for a phone the person picked after turning on Show physical devices. */
  async stream(serial: string, mode: StreamMode, allowPhysical: boolean): Promise<Grant> {
    const value = structured("device_stream", await this.#app.callServerTool({ name: "device_stream", arguments: { serial, mode, ...(allowPhysical ? { allowPhysical: true } : {}) } }));
    if (typeof value.url !== "string" || (value.mode !== "h264" && value.mode !== "shot")) throw new ToolError("device_stream answered a shape this View cannot read");
    return { url: value.url, mode: value.mode, downgraded: typeof value.downgraded === "string" ? value.downgraded : null };
  }
}

export function failureText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
