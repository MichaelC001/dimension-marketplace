import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSlackBot } from "../../bot";
import type { UploadWire } from "./upload-run";

const SLACK_API = "https://slack.com/api/";

interface RegisteredTool {
	readonly name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		context: { readonly cwd: string },
	): Promise<{ readonly content: readonly { readonly text?: string }[] }>;
}

interface SeenRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string;
}

const scenario = JSON.parse(process.env.SLACK_UPLOAD_SCENARIO ?? "null") as UploadWire | null;
const home = process.env.SLACK_TEST_HOME;
const fromHome = home === undefined ? null : relative(home, homedir());
if (scenario === null || fromHome === null || fromHome.startsWith("..") || isAbsolute(fromHome)) {
	process.stderr.write("refusing to run: no scenario, or the home directory is not the test home\n");
	process.exit(2);
}

const seen: SeenRequest[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	const body = init?.body;
	const bytes =
		body === undefined || body === null
			? Buffer.alloc(0)
			: typeof body === "string"
				? Buffer.from(body)
				: Buffer.from(body as Uint8Array);
	seen.push({
		url,
		method: init?.method ?? "GET",
		headers: Object.fromEntries(new Headers(init?.headers)),
		body: bytes.toString("base64"),
	});
	if (!url.startsWith(SLACK_API)) return new Response(null, { status: scenario.upload });
	const method = url.slice(SLACK_API.length).split("?")[0];
	if (method === "files.getUploadURLExternal") return Response.json(scenario.start);
	if (method === "files.completeUploadExternal") return Response.json(scenario.complete);
	throw new Error(`unexpected request to ${url}`);
}) as typeof fetch;

const tools = new Map<string, RegisteredTool>();
registerSlackBot({ registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);

const tool = tools.get("slack_upload_file");
if (!tool) throw new Error("the extension did not register slack_upload_file");

let outcome: { ok: boolean; text: string };
try {
	const result = await tool.execute("call", scenario.params, undefined, undefined, { cwd: scenario.folder });
	outcome = { ok: true, text: result.content[0]?.text ?? "" };
} catch (error) {
	outcome = { ok: false, text: error instanceof Error ? error.message : String(error) };
}

await Bun.write(Bun.stdout, JSON.stringify({ outcome, requests: seen }));
process.exit(0);
