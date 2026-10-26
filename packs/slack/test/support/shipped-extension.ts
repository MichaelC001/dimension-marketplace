import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type } from "arktype";
import { connectMethod, packRoot } from "./pack";

const CHILD = join(import.meta.dir, "shipped-extension-child.ts");
const CHILD_TIMEOUT_MS = 60_000;
const CONFIG_TARGET_HOME_PREFIX = /^~[\\/]/;

export const BOT_TOKEN = "xoxb-bot-token";
export const USER_TOKEN = "xoxp-user-token";
export const RENEWED_USER_TOKEN = "xoxe-renewed-access";
export const RENEWED_USER_REFRESH = "xoxe-renewed-refresh";
export const USER_REFRESH = "xoxe-1-user-refresh";
export const USER_CLIENT_ID = "1.2";
export const NEVER_EXPIRES = 4_102_444_800_000;
export const ALREADY_EXPIRED = 1;

const outputSchema = type({
	outcomes: { "[string]": { ok: "boolean", text: "string" } },
	requests: type({
		endpoint: "string",
		authorization: "string | null",
		rpc: "string | null",
		body: "string",
	}).array(),
});

export type Outcome = { readonly ok: boolean; readonly text: string };
export type SeenRequest = (typeof outputSchema.infer)["requests"][number];

export interface ExtensionRun {
	readonly outcomes: Readonly<Record<string, Outcome>>;
	readonly requests: readonly SeenRequest[];
	readonly files: Readonly<Record<"bot" | "user", string | null>>;
	readonly tree: readonly string[];
}

export async function botCredentialFile(token: string): Promise<string> {
	const bot = connectMethod("bot");
	const field = bot.form?.find(candidate => candidate.secret === true);
	if (!bot.configTemplate || !field) throw new Error("the bot method declares no secret field or template");
	const template = await Bun.file(join(packRoot, bot.configTemplate)).text();
	return template.replace(new RegExp(`\\$\\{${field.id}\\}`, "g"), token);
}

export function userCredentialFile(access: string, expires: number): string {
	return JSON.stringify({
		provider: "slack",
		access,
		refresh: USER_REFRESH,
		expires,
		clientId: USER_CLIENT_ID,
		scopes: ["chat:write"],
	});
}

async function readIfPresent(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return null;
	}
}

export async function runInFreshProcessWithHome(files: {
	readonly bot?: string;
	readonly user?: string;
}): Promise<ExtensionRun> {
	const home = await mkdtemp(join(tmpdir(), "slack-pack-home-"));
	const target = (id: "bot" | "user") =>
		join(home, connectMethod(id).configTarget.replace(CONFIG_TARGET_HOME_PREFIX, ""));
	try {
		for (const id of ["bot", "user"] as const) {
			const content = files[id];
			if (content === undefined) continue;
			await mkdir(dirname(target(id)), { recursive: true });
			await writeFile(target(id), content);
		}
		const child = Bun.spawn([process.execPath, CHILD], {
			env: { ...process.env, HOME: home, USERPROFILE: home, SLACK_TEST_HOME: home },
			stdout: "pipe",
			stderr: "pipe",
			timeout: CHILD_TIMEOUT_MS,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`the extension process exited ${code}: ${stderr}`);
		const output = outputSchema.assert(JSON.parse(stdout));
		const entries = await readdir(home, { recursive: true, withFileTypes: true });
		return {
			outcomes: output.outcomes,
			requests: output.requests,
			files: { bot: await readIfPresent(target("bot")), user: await readIfPresent(target("user")) },
			tree: entries
				.filter(entry => entry.isFile())
				.map(entry => relative(home, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
				.sort(),
		};
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}
