import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createCredentialStore, TOKEN_PATH } from "./credential";
import { createIdentity } from "./identity";
import { createMcpClient } from "./mcp-client";
import { createSlackActTool, createSlackReadTool, createSlackToolsTool, createToolCatalog } from "./tools";

export default function slackUserExtension(pi: ExtensionAPI): void {
	const store = createCredentialStore({ path: TOKEN_PATH });
	const client = createMcpClient({
		accessToken: () => store.accessToken(),
		renewRejected: rejected => store.renewRejected(rejected),
	});
	const deps = {
		client,
		store,
		catalog: createToolCatalog(client),
		identity: createIdentity({ store }),
	};
	pi.registerTool(createSlackToolsTool(deps));
	pi.registerTool(createSlackReadTool(deps));
	pi.registerTool(createSlackActTool(deps));
}
