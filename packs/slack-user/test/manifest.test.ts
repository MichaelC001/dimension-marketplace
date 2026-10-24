import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type } from "arktype";
import { TOKEN_PATH } from "../credential";
import slackUserExtension from "../index";

const CREATE_APP_LINK_PREFIX = "https://api.slack.com/apps?new_app=1&manifest_json=";
const ASSIST_PROMPT_LIMIT = 8_000;

const packRoot = join(import.meta.dir, "..");
const shelfRoot = join(packRoot, "..");

const pluginSchema = type({
	extensions: {
		"ai.insodimension.dimension": {
			connect: {
				assist: { prompt: "string", requires: "string[]" },
				setup: type({ "url?": "string" }).array(),
				oauth: {
					authUrl: "string",
					tokenUrl: "string",
					scopes: "string[]",
					usePkce: "boolean",
					callbackPort: "number",
					scopeOptions: type({ id: "string", scopes: "string[]", "default?": "boolean" }).array(),
				},
				form: type({ id: "string", "required?": "boolean" }).array(),
				configTarget: "string",
			},
			tools: type({ name: "string" }).array(),
		},
	},
});

const appSchema = type({
	oauth_config: { redirect_urls: "string[]", scopes: { user: "string[]" }, pkce_enabled: "boolean" },
	settings: { is_mcp_enabled: "boolean", token_rotation_enabled: "boolean" },
});

const plugin = pluginSchema.assert(await Bun.file(join(packRoot, "plugin.json")).json());
const appManifestJson: unknown = await Bun.file(join(packRoot, "connect", "slack-app-manifest.json")).json();
const app = appSchema.assert(appManifestJson);
const dimension = plugin.extensions["ai.insodimension.dimension"];
const { connect } = dimension;

const createAppLink = connect.setup.find(step => step.url?.startsWith(CREATE_APP_LINK_PREFIX))?.url ?? "";

test("the setup link opens Slack's create-app screen with exactly the manifest this pack ships", () => {
	expect(createAppLink).not.toBe("");

	const embedded = new URL(createAppLink).searchParams.get("manifest_json");

	expect(JSON.parse(embedded ?? "null")).toEqual(appManifestJson);
});

test("the agent-assisted setup hands the agent that same link and stays inside the prompt limit", () => {
	expect(connect.assist.prompt).toContain(createAppLink);
	expect(connect.assist.prompt.length).toBeLessThanOrEqual(ASSIST_PROMPT_LIMIT);
});

test("the agent-assisted setup only requires plugins that ship on this shelf", () => {
	const shipped = readdirSync(shelfRoot);

	expect(connect.assist.requires.length).toBeGreaterThan(0);
	for (const required of connect.assist.requires) expect(shipped).toContain(required);
});

test("the app registers the loopback redirect the connect flow listens on, with PKCE and MCP switched on", () => {
	expect(app.oauth_config.redirect_urls).toContain(`http://localhost:${connect.oauth.callbackPort}/callback`);
	expect(app.oauth_config.pkce_enabled).toBe(connect.oauth.usePkce);
	expect(app.settings.is_mcp_enabled).toBe(true);
});

test("only the Client ID has to be filled in: the app uses PKCE, and a required blank secret would make Connect do nothing", () => {
	const mustFill = connect.form.filter(field => field.required !== false).map(field => field.id);

	expect(mustFill).toEqual(["clientId"]);
});

test("every scope the connect flow can request is one the app declares, so Slack never refuses the consent screen", () => {
	const declared = new Set(app.oauth_config.scopes.user);
	const requestable = [...connect.oauth.scopes, ...connect.oauth.scopeOptions.flatMap(option => option.scopes)];

	expect(requestable.filter(scope => !declared.has(scope))).toEqual([]);
});

test("exactly one scope option is the default and it matches the base scopes", () => {
	const defaults = connect.oauth.scopeOptions.filter(option => option.default === true);

	expect(defaults).toHaveLength(1);
	expect(defaults[0]?.scopes).toEqual(connect.oauth.scopes);
});

test("the authorization and token endpoints are Slack's user-token OAuth endpoints", () => {
	expect(connect.oauth.authUrl).toBe("https://slack.com/oauth/v2_user/authorize");
	expect(connect.oauth.tokenUrl).toBe("https://slack.com/api/oauth.v2.user.access");
});

test("the extension reads the credential file the connect flow writes", () => {
	const written = normalize(connect.configTarget.replace(/^~/, homedir()));

	expect(normalize(TOKEN_PATH)).toBe(written);
});

test("the extension registers exactly the tools the manifest lists", () => {
	const registered: string[] = [];
	const pi = { registerTool: (tool: { name: string }) => registered.push(tool.name) } as unknown as ExtensionAPI;

	slackUserExtension(pi);

	expect(registered.sort()).toEqual(dimension.tools.map(tool => tool.name).sort());
});

test.each(["skills/slack-user/SKILL.md", "rules/slack-user-context.md"])(
	"%s keeps its whole description through the YAML parser the host loads it with",
	async path => {
		const text = (await Bun.file(join(packRoot, path)).text()).replace(/\r\n/g, "\n");
		const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
		const raw = /^description: (.+)$/m.exec(front)?.[1];

		expect(raw).toBeDefined();
		expect(Bun.YAML.parse(front)).toMatchObject({ description: raw });
	},
);
