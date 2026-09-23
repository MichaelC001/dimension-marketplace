import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrowserServer } from "./server.js";

const server = await createBrowserServer();
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= server.close();
  return stopping;
}
process.once("SIGINT", () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); });
process.once("SIGTERM", () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); });
await server.connect(new StdioServerTransport());
