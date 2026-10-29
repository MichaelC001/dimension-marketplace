import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";
import { BOT_TOKEN, botCredentialFile, credentialTarget } from "./shipped-extension";
import { UPLOAD_FILE_ID, UPLOAD_URL } from "./upload-fixture";

const CHILD = join(import.meta.dir, "upload-child.ts");
const CHILD_TIMEOUT_MS = 60_000;

export const STARTED = { ok: true, upload_url: UPLOAD_URL, file_id: UPLOAD_FILE_ID };

type Content = Uint8Array | string;

export interface Folders {
	readonly folder: string;
	readonly beside: string;
}

export interface UploadScenario {
	readonly signedIn?: boolean;
	readonly inside?: Readonly<Record<string, Content>>;
	readonly beside?: Readonly<Record<string, Content>>;
	readonly params: (folders: Folders) => Record<string, unknown>;
	readonly start?: unknown;
	readonly upload?: number;
	readonly complete?: unknown;
}

export interface UploadWire {
	readonly folder: string;
	readonly params: Record<string, unknown>;
	readonly start: unknown;
	readonly upload: number;
	readonly complete: unknown;
}

const outputSchema = type({
	outcome: { ok: "boolean", text: "string" },
	requests: type({
		url: "string",
		method: "string",
		headers: { "[string]": "string" },
		body: "string",
	}).array(),
});

export interface SlackRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly bytes: Buffer;
}

export interface UploadRun {
	readonly outcome: { readonly ok: boolean; readonly text: string };
	readonly requests: readonly SlackRequest[];
}

async function writeTree(root: string, files: Readonly<Record<string, Content>> | undefined): Promise<void> {
	for (const [relativePath, content] of Object.entries(files ?? {})) {
		const target = join(root, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

export async function runUpload(scenario: UploadScenario): Promise<UploadRun> {
	const home = await mkdtemp(join(tmpdir(), "slack-pack-home-"));
	const beside = await mkdtemp(join(tmpdir(), "slack-pack-upload-"));
	const folder = join(beside, "session");
	try {
		await mkdir(folder);
		await Promise.all([writeTree(folder, scenario.inside), writeTree(beside, scenario.beside)]);
		if (scenario.signedIn !== false) {
			const credential = credentialTarget(home, "bot");
			await mkdir(dirname(credential), { recursive: true });
			await writeFile(credential, await botCredentialFile(BOT_TOKEN));
		}
		const wire: UploadWire = {
			folder,
			params: scenario.params({ folder, beside }),
			start: scenario.start ?? STARTED,
			upload: scenario.upload ?? 200,
			complete: scenario.complete ?? { ok: true },
		};
		const child = Bun.spawn([process.execPath, CHILD], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				SLACK_TEST_HOME: home,
				SLACK_UPLOAD_SCENARIO: JSON.stringify(wire),
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: CHILD_TIMEOUT_MS,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`the upload process exited ${code}: ${stderr}`);
		const output = outputSchema.assert(JSON.parse(stdout));
		return {
			outcome: output.outcome,
			requests: output.requests.map(({ url, method, headers, body }) => ({
				url,
				method,
				headers,
				bytes: Buffer.from(body, "base64"),
			})),
		};
	} finally {
		await Promise.all([rm(home, { recursive: true, force: true }), rm(beside, { recursive: true, force: true })]);
	}
}

export function jsonBody(request: SlackRequest): unknown {
	return JSON.parse(request.bytes.toString("utf8"));
}
