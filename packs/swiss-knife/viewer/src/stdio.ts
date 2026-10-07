import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createViewerServer } from "./server";

const server = await createViewerServer();
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
	stopping ??= server.close();
	return stopping;
}
function shutdown(): void {
	void stop().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
process.stdin.once("end", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await server.connect(new StdioServerTransport());
