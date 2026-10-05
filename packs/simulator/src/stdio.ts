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
// The host ends the conversation by closing our stdin: stop what the pack booted, then leave.
process.stdin.once("end", exitAfterStop);
process.once("SIGINT", exitAfterStop);
process.once("SIGTERM", exitAfterStop);
await server.connect(new StdioServerTransport());
