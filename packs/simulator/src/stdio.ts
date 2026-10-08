import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSimulatorServer } from "./server";

const server = await createSimulatorServer();
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= server.close();
  return stopping;
}
const exitAfterStop = (): void => {
  void stop()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => process.exit());
};
let crashing = false;
const exitAfterCrash =
  (origin: string) =>
  (error: unknown): void => {
    console.error(`[sim] ${origin}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (crashing) return;
    crashing = true;
    console.error("[sim] stopping what the pack booted, then exiting");
    process.exitCode = 1;
    exitAfterStop();
  };
process.on("uncaughtException", exitAfterCrash("uncaught exception"));
process.on("unhandledRejection", exitAfterCrash("unhandled rejection"));
// The host ends the conversation by closing our stdin: stop what the pack booted, then leave.
process.stdin.once("end", exitAfterStop);
process.once("SIGINT", exitAfterStop);
process.once("SIGTERM", exitAfterStop);
await server.connect(new StdioServerTransport());
