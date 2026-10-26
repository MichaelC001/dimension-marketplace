import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connectorMethod, parseConnectorDecl } from "@dimension/sdk/connector";
import { type } from "arktype";
import { connectMethod, dimension, shelfRoot } from "./support/pack";

const MARKETPLACE_ROOT = join(shelfRoot, "..");
const RETIRED_PACK = "slack-user";

const userMethodSchema = type({
	assist: { label: "string", requires: "string[]", prompt: "string" },
	oauth: { scopeOptions: type({ id: "string", scopes: "string[]", "default?": "boolean" }).array() },
});
const shelfSchema = type({ plugins: type({ name: "string", pluginId: "string" }).array() });
const packNameSchema = type({ name: "string" });

const { decl, issues } = parseConnectorDecl(dimension.connect);
const methods = decl?.methods ?? [];
const botDecl = decl ? connectorMethod(decl, "bot")?.decl : undefined;
const userDecl = decl ? connectorMethod(decl, "user")?.decl : undefined;
const rawUser = userMethodSchema.assert(connectMethod("user"));
const endsWithWrite = (scope: string) => scope.endsWith(":write");

test("the connect block parses with the SDK's parser into the bot form method then the As you oauth method, with nothing dropped", () => {
	expect(issues).toEqual([]);
	expect(decl?.kind).toEqual(["form", "oauth"]);
	expect(methods.map(method => ({ id: method.id, label: method.label, kind: method.decl.kind }))).toEqual([
		{ id: "bot", label: "A Slack bot app", kind: ["form"] },
		{ id: "user", label: "As you", kind: ["oauth"] },
	]);
});

test("neither the pack nor either method declares a gate or a license, so Slack can be enabled before anyone connects", () => {
	for (const declared of [dimension.connect, ...dimension.connect.methods]) {
		expect(Reflect.has(declared, "gate")).toBe(false);
		expect(Reflect.has(declared, "license")).toBe(false);
	}
	expect(decl?.gate).toBeUndefined();
	for (const method of methods) {
		expect(method.decl.gate).toBeUndefined();
		expect(method.decl.kind).not.toContain("license");
	}
});

test("each method keeps its own credential file, at the path installs from before the merge already hold", () => {
	expect(botDecl?.configTarget).toBe("~/.config/dimension-slack/token.json");
	expect(userDecl?.configTarget).toBe("~/.config/dimension-slack-user/token.json");
});

test("the As you method keeps its agent-assisted setup exactly as authored", () => {
	expect(userDecl?.assist).toEqual(rawUser.assist);
});

test("the As you method keeps its three permission levels, Read and send being the default", () => {
	const offered = userDecl?.oauth?.scopeOptions ?? [];

	expect(offered.map(option => ({ id: option.id, scopes: option.scopes, default: option.default === true }))).toEqual(
		rawUser.oauth.scopeOptions.map(option => ({
			id: option.id,
			scopes: option.scopes,
			default: option.default === true,
		})),
	);
	expect(offered.map(option => option.id)).toEqual(["read", "send", "full"]);
	expect(offered.find(option => option.default)?.id).toBe("send");
});

test("Read only asks Slack for no write scope, while Read and send and Everything do, which is what slack_act checks before sending", () => {
	const scopesOf = (id: string) => userDecl?.oauth?.scopeOptions?.find(option => option.id === id)?.scopes ?? [];

	expect(scopesOf("read").length).toBeGreaterThan(0);
	expect(scopesOf("read").filter(endsWithWrite)).toEqual([]);
	expect(scopesOf("send").some(endsWithWrite)).toBe(true);
	expect(scopesOf("full").some(endsWithWrite)).toBe(true);
});

test("the pack declares that it supersedes the retired slack-user pack", () => {
	expect(dimension.supersedes).toEqual([RETIRED_PACK]);
});

test("the shelf ships no pack named slack-user, so the Marketplace shows one Slack card", () => {
	const packs = readdirSync(shelfRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
	const declaredNames = packs.flatMap(entry => {
		const manifest = join(shelfRoot, entry.name, "plugin.json");
		return existsSync(manifest) ? [packNameSchema.assert(JSON.parse(readFileSync(manifest, "utf-8"))).name] : [];
	});

	expect(packs.map(entry => entry.name)).not.toContain(RETIRED_PACK);
	expect(declaredNames).not.toContain(RETIRED_PACK);
});

test.each([".dimension-plugin", ".omp-plugin"])(
	"the %s shelf manifest lists Slack once and never the retired slack-user",
	async directory => {
		const shelf = shelfSchema.assert(await Bun.file(join(MARKETPLACE_ROOT, directory, "marketplace.json")).json());
		const named = (id: string) => shelf.plugins.filter(plugin => plugin.name === id || plugin.pluginId === id);

		expect(named("slack")).toHaveLength(1);
		expect(named(RETIRED_PACK)).toEqual([]);
	},
);
