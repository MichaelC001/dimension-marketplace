import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createCredentialStore, TOKEN_PATH } from "./credential";
import { createIdentity } from "./identity";
import { createMcpClient } from "./mcp-client";
import { createNativeRoutes } from "./native-routes";
import { createSlackActTool, createSlackReadTool, createSlackToolsTool, createToolCatalog } from "./tools";
import { createWebApiClient } from "./web-api";

export function registerSlackUser(pi: ExtensionAPI): void {
	const store = createCredentialStore({ path: TOKEN_PATH });
	const tokens = {
		accessToken: () => store.accessToken(),
		renewRejected: (rejected: string) => store.renewRejected(rejected),
	};
	const client = createMcpClient(tokens);
	const deps = {
		client,
		store,
		catalog: createToolCatalog(client),
		identity: createIdentity({ store }),
		api: createWebApiClient(tokens),
		routes: createNativeRoutes(),
	};
	pi.registerTool(createSlackToolsTool(deps));
	pi.registerTool(createSlackReadTool(deps));
	pi.registerTool(createSlackActTool(deps));
}
