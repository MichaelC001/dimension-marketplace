// A real MCP client talking to the pack's real MCP server over an in-memory pipe,
// with a FakeBackend underneath: the tools are exercised exactly as an agent calls
// them (argument validation, text results, isError), with no process or device.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSimulatorServer } from "../src/server";
import { DEFAULT_SETTINGS, type SimulatorSettings } from "../src/settings";
import type { FakeBackend } from "./fake-backend";

export interface Answer {
  readonly isError: boolean;
  readonly text: string;
}

export interface McpSession {
  call(tool: string, args: Record<string, unknown>): Promise<Answer>;
  close(): Promise<void>;
}

/** A folder holding the View document the server insists on, and where it keeps its ownership file. */
export interface ServerFolder {
  readonly path: string;
  dispose(): void;
}

export function serverFolder(): ServerFolder {
  const path = mkdtempSync(join(tmpdir(), "sim-mcp-"));
  writeFileSync(join(path, "view.html"), "<!doctype html><title>simulator</title>");
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

export async function connectServer(folder: ServerFolder, backend: FakeBackend, settings: Partial<SimulatorSettings> = {}): Promise<McpSession> {
  const server = await createSimulatorServer({ backend, settings: () => ({ ...DEFAULT_SETTINGS, ...settings }), dataDir: folder.path, viewPath: join(folder.path, "view.html"), log: () => undefined });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "simulator-test", version: "0.0.0" });
  await client.connect(clientSide);
  return {
    call: async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.flatMap(part => (part.type === "text" ? [String(part.text)] : [])).join("\n");
      return { isError: result.isError === true, text };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
