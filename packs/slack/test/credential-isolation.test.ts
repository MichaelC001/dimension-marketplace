import { expect, test } from "bun:test";
import { connectPath } from "./support/pack";
import {
	ALREADY_EXPIRED,
	BOT_TOKEN,
	botCredentialFile,
	type ExtensionRun,
	NEVER_EXPIRES,
	RENEWED_USER_REFRESH,
	RENEWED_USER_TOKEN,
	runInFreshProcessWithHome,
	type SeenRequest,
	USER_CLIENT_ID,
	USER_REFRESH,
	USER_TOKEN,
	userCredentialFile,
} from "./support/shipped-extension";

const BOT_TOOLS = [
	"slack_list_channels",
	"slack_read_messages",
	"slack_post_message",
	"slack_read_thread",
	"slack_reply_thread",
	"slack_add_reaction",
	"slack_edit_message",
	"slack_delete_message",
	"slack_list_users",
];
const USER_TOOLS = ["slack_tools", "slack_read", "slack_act"];

const SLACK_API = "https://slack.com/api/";
const TOKEN_ENDPOINT = `${SLACK_API}oauth.v2.user.access`;
const AS_YOU_ENDPOINTS = [
	`${SLACK_API}auth.test`,
	TOKEN_ENDPOINT,
	`${SLACK_API}conversations.info`,
	`${SLACK_API}users.info`,
	`${SLACK_API}chat.postMessage`,
	`${SLACK_API}chat.scheduleMessage`,
	`${SLACK_API}chat.getPermalink`,
];
const MCP_ENDPOINT = "https://mcp.slack.com/mcp";

const bearer = (token: string) => `Bearer ${token}`;
const isBotMethod = (request: SeenRequest) =>
	request.endpoint.startsWith(SLACK_API) &&
	(!AS_YOU_ENDPOINTS.includes(request.endpoint) || request.authorization === bearer(BOT_TOKEN));
const isMcp = (request: SeenRequest) => request.endpoint === MCP_ENDPOINT;
const carrying = (run: ExtensionRun, token: string) =>
	run.requests.filter(request => request.authorization === bearer(token));
const tokensSent = (requests: readonly SeenRequest[]) => [...new Set(requests.map(request => request.authorization))];
const notRefusing = (run: ExtensionRun, tools: readonly string[], connectOption: string) =>
	tools.filter(name => {
		const outcome = run.outcomes[name];
		return !(outcome && !outcome.ok && outcome.text.includes(connectOption));
	});
const notWorking = (run: ExtensionRun, tools: readonly string[]) =>
	tools.filter(name => run.outcomes[name]?.ok !== true);

const botFile = await botCredentialFile(BOT_TOKEN);
const liveUserFile = userCredentialFile(USER_TOKEN, NEVER_EXPIRES);

const [userOnly, botOnly, both, renewing, botFileGarbage, userFileGarbage] = await Promise.all([
	runInFreshProcessWithHome({ user: liveUserFile }),
	runInFreshProcessWithHome({ bot: botFile }),
	runInFreshProcessWithHome({ bot: botFile, user: liveUserFile }),
	runInFreshProcessWithHome({ bot: botFile, user: userCredentialFile(USER_TOKEN, ALREADY_EXPIRED) }),
	runInFreshProcessWithHome({ bot: "{ not json", user: liveUserFile }),
	runInFreshProcessWithHome({ bot: botFile, user: "{ not json" }),
]);

test("with only the As you sign-in saved, every bot tool refuses naming the bot Connect option and sends nothing to the Web API", () => {
	expect(notRefusing(userOnly, BOT_TOOLS, connectPath("bot"))).toEqual([]);
	expect(userOnly.requests.filter(isBotMethod)).toEqual([]);
});

test("with only the As you sign-in saved, the As you tools work and send only that sign-in's token", () => {
	expect(notWorking(userOnly, USER_TOOLS)).toEqual([]);
	expect(userOnly.requests.filter(isMcp).length).toBeGreaterThan(0);
	expect(tokensSent(userOnly.requests)).toEqual([bearer(USER_TOKEN)]);
});

test("with only the bot token saved, slack_tools, slack_read and slack_act refuse naming As you, and nothing but the bot tools' own requests is made", () => {
	expect(notRefusing(botOnly, USER_TOOLS, connectPath("user"))).toEqual([]);
	expect(botOnly.requests.filter(request => !isBotMethod(request))).toEqual([]);
});

test("with only the bot token saved, written the way Connect writes it, the bot tools work and send only the bot token", () => {
	expect(notWorking(botOnly, BOT_TOOLS)).toEqual([]);
	expect(botOnly.requests.filter(isBotMethod).length).toBeGreaterThan(0);
	expect(tokensSent(botOnly.requests)).toEqual([bearer(BOT_TOKEN)]);
});

test("with both saved, the bot tools send the bot token and the As you tools send the sign-in's token, never each other's", () => {
	expect(notWorking(both, [...BOT_TOOLS, ...USER_TOOLS])).toEqual([]);
	expect(tokensSent(both.requests.filter(isBotMethod))).toEqual([bearer(BOT_TOKEN)]);
	expect(tokensSent(both.requests.filter(isMcp))).toEqual([bearer(USER_TOKEN)]);
	expect(carrying(both, BOT_TOKEN).filter(request => !isBotMethod(request))).toEqual([]);
	expect(carrying(both, USER_TOKEN).filter(isBotMethod)).toEqual([]);
});

test("renewing the As you sign-in rewrites only its own file and leaves the bot token file byte for byte as it was", () => {
	expect(notWorking(renewing, [...BOT_TOOLS, ...USER_TOOLS])).toEqual([]);
	expect(renewing.files.bot).toBe(botFile);
	expect(JSON.parse(renewing.files.user ?? "null")).toEqual({
		provider: "slack",
		access: RENEWED_USER_TOKEN,
		refresh: RENEWED_USER_REFRESH,
		expires: expect.any(Number),
		clientId: USER_CLIENT_ID,
		scopes: ["chat:write"],
	});
	expect(renewing.tree).toEqual(
		[".config/dimension-slack-user/token.json", ".config/dimension-slack/token.json"].sort(),
	);
});

test("the renewal presents the As you refresh token and is never mixed with the bot token", () => {
	const renewals = renewing.requests.filter(request => request.endpoint === TOKEN_ENDPOINT);

	expect(renewals).toHaveLength(1);
	const form = new URLSearchParams(renewals[0]?.body);
	expect(form.get("refresh_token")).toBe(USER_REFRESH);
	expect(form.get("client_id")).toBe(USER_CLIENT_ID);
	expect(carrying(renewing, BOT_TOKEN).filter(request => !isBotMethod(request))).toEqual([]);
	expect(JSON.stringify(renewals)).not.toContain(BOT_TOKEN);
	expect(tokensSent(renewing.requests.filter(isMcp))).toEqual([bearer(RENEWED_USER_TOKEN)]);
	expect(tokensSent(renewing.requests.filter(isBotMethod))).toEqual([bearer(BOT_TOKEN)]);
});

test("an unreadable bot token file does not disturb the As you tools", () => {
	expect(notWorking(botFileGarbage, USER_TOOLS)).toEqual([]);
	expect(tokensSent(botFileGarbage.requests)).toEqual([bearer(USER_TOKEN)]);
});

test("an unreadable As you sign-in file does not disturb the bot tools", () => {
	expect(notWorking(userFileGarbage, BOT_TOOLS)).toEqual([]);
	expect(tokensSent(userFileGarbage.requests)).toEqual([bearer(BOT_TOKEN)]);
});

test("an As you send reaches Slack's Web API with the sign-in's token and the message untouched, never through the MCP server", () => {
	const posted = userOnly.requests.filter(request => request.endpoint === `${SLACK_API}chat.postMessage`);
	const sentThroughMcp = userOnly.requests.filter(
		request => isMcp(request) && request.rpc === "tools/call" && request.body.includes('"slack_send_message"'),
	);

	expect(posted).toHaveLength(1);
	expect(posted[0]?.authorization).toBe(bearer(USER_TOKEN));
	expect(new URLSearchParams(posted[0]?.body).get("markdown_text")).toBe("from me");
	expect(sentThroughMcp).toEqual([]);
});
