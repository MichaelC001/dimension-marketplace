import { expect, test } from "bun:test";
import { join } from "node:path";
import { BOT_TOKEN } from "./support/shipped-extension";
import { UPLOAD_FILE_ID, UPLOAD_URL } from "./support/upload-fixture";
import { jsonBody, runUpload, type SlackRequest, STARTED } from "./support/upload-run";

const SLACK_API = "https://slack.com/api/";
const CHANNEL = "C0123ABCD";
const THREAD = "1700000000.000400";
const FILE_BYTES = Uint8Array.from({ length: 4096 }, (_, index) => (index * 31 + 7) % 256);

const ASK = `GET ${SLACK_API}files.getUploadURLExternal`;
const SEND = `POST ${UPLOAD_URL}`;
const COMPLETE = `POST ${SLACK_API}files.completeUploadExternal`;

const label = (request: SlackRequest) => `${request.method} ${request.url.split("?")[0]}`;

const [full, bare] = await Promise.all([
	runUpload({
		inside: { "report.bin": FILE_BYTES },
		params: () => ({
			channel: CHANNEL,
			path: "report.bin",
			title: "Q3 report",
			comment: "the *Q3* numbers",
			threadTs: THREAD,
		}),
	}),
	runUpload({
		inside: { "exports/report.bin": FILE_BYTES },
		params: () => ({ channel: CHANNEL, path: "exports/report.bin" }),
	}),
]);
const [ask, send, complete] = full.requests;

test("sharing a file makes exactly three Slack calls in order: ask for an address, send the bytes there, complete the upload", () => {
	expect(full.outcome.ok).toBe(true);
	expect(full.requests.map(label)).toEqual([ASK, SEND, COMPLETE]);
});

test("the upload address is requested under the file's name and exact length, signed with the bot token", () => {
	const query = new URL(ask?.url ?? "").searchParams;

	expect(query.get("filename")).toBe("report.bin");
	expect(query.get("length")).toBe(String(FILE_BYTES.length));
	expect(ask?.headers.authorization).toBe(`Bearer ${BOT_TOKEN}`);
});

test("the file's bytes reach the upload address unmodified, and nothing sent there carries the bot token", () => {
	expect(send?.bytes.equals(FILE_BYTES)).toBe(true);
	expect(send?.headers.authorization).toBeUndefined();
	expect(JSON.stringify([send?.url, send?.headers])).not.toContain(BOT_TOKEN);
});

test("the upload is completed with the file id Slack issued, the title, the channel, the message and the thread", () => {
	expect(complete?.headers.authorization).toBe(`Bearer ${BOT_TOKEN}`);
	expect(complete?.headers["content-type"]).toContain("application/json");
	expect(jsonBody(complete as SlackRequest)).toEqual({
		files: [{ id: UPLOAD_FILE_ID, title: "Q3 report" }],
		channel_id: CHANNEL,
		initial_comment: "the *Q3* numbers",
		thread_ts: THREAD,
	});
});

test("the result names the file, its size, the channel, the thread and the file id", () => {
	expect(full.outcome.text).toContain("report.bin");
	expect(full.outcome.text).toContain(`${FILE_BYTES.length} bytes`);
	expect(full.outcome.text).toContain(CHANNEL);
	expect(full.outcome.text).toContain("in the thread");
	expect(full.outcome.text).toContain(UPLOAD_FILE_ID);
});

test("a file given by a path into subfolders is requested under its name alone", () => {
	const [bareAsk] = bare.requests;

	expect(bare.outcome.ok).toBe(true);
	expect(new URL(bareAsk?.url ?? "").searchParams.get("filename")).toBe("report.bin");
});

test("with no title given, the upload is titled with the file's name", () => {
	const [, , bareComplete] = bare.requests;

	expect(jsonBody(bareComplete as SlackRequest)).toMatchObject({ files: [{ id: UPLOAD_FILE_ID, title: "report.bin" }] });
});

test("with no message or thread given, neither is sent and the result does not claim a thread", () => {
	const [, , bareComplete] = bare.requests;

	expect(Object.keys(jsonBody(bareComplete as SlackRequest) as object).sort()).toEqual(["channel_id", "files"]);
	expect(bare.outcome.text).not.toContain("in the thread");
});

interface Refusal {
	readonly name: string;
	readonly inside?: Readonly<Record<string, string>>;
	readonly beside?: Readonly<Record<string, string>>;
	readonly path: (beside: string) => string;
	readonly says: string;
}

const REFUSED: readonly Refusal[] = [
	{
		name: "a path that climbs out of the session's folder",
		beside: { "secret.txt": "not yours to share" },
		path: () => "../secret.txt",
		says: "outside the session's folder",
	},
	{
		name: "an absolute path to a file elsewhere",
		beside: { "secret.txt": "not yours to share" },
		path: (beside: string) => join(beside, "secret.txt"),
		says: "outside the session's folder",
	},
	{
		name: "a dotfile in the folder",
		inside: { ".env": "SLACK_BOT_TOKEN=xoxb-real" },
		path: () => ".env",
		says: "hidden file or folder",
	},
	{
		name: "a file inside a hidden folder",
		inside: { ".git/config": "[remote]" },
		path: () => ".git/config",
		says: "hidden file or folder",
	},
	{
		name: "a file that does not exist",
		path: () => "missing.csv",
		says: "There is no file at missing.csv.",
	},
];

const refusals = await Promise.all(
	REFUSED.map(async row => ({
		...row,
		run: await runUpload({
			signedIn: false,
			inside: row.inside,
			beside: row.beside,
			params: ({ beside }) => ({ channel: CHANNEL, path: row.path(beside) }),
		}),
	})),
);

test.each(refusals)("$name is refused before any Slack call is made, even with no bot token saved", ({ run, says }) => {
	expect(run.outcome.ok).toBe(false);
	expect(run.outcome.text).toContain(says);
	expect(run.requests).toEqual([]);
});

interface Failure {
	readonly name: string;
	readonly start?: unknown;
	readonly upload?: number;
	readonly complete?: unknown;
	readonly says: readonly string[];
	readonly silent: readonly string[];
	readonly sent: string[];
}

const FAILURES: readonly Failure[] = [
	{
		name: "a Slack app without the files:write scope",
		start: { ok: false, error: "missing_scope", needed: "files:write" },
		says: ["missing_scope", "files:write"],
		silent: [],
		sent: [ASK],
	},
	{
		name: "a bot that is not in the channel",
		complete: { ok: false, error: "not_in_channel" },
		says: ["not_in_channel", "/invite"],
		silent: ["files:write"],
		sent: [ASK, SEND, COMPLETE],
	},
	{
		name: "any other Slack error",
		complete: { ok: false, error: "channel_not_found" },
		says: ["channel_not_found"],
		silent: ["files:write", "/invite"],
		sent: [ASK, SEND, COMPLETE],
	},
	{
		name: "an upload address that is not https",
		start: { ...STARTED, upload_url: "http://files.slack.com/upload/v1/x" },
		says: ["Slack did not return an address to upload the file to."],
		silent: [],
		sent: [ASK],
	},
	{
		name: "no upload address",
		start: { ok: true, file_id: UPLOAD_FILE_ID },
		says: ["Slack did not return an address to upload the file to."],
		silent: [],
		sent: [ASK],
	},
	{
		name: "no file id",
		start: { ok: true, upload_url: UPLOAD_URL },
		says: ["Slack did not return an address to upload the file to."],
		silent: [],
		sent: [ASK],
	},
	{
		name: "an upload address that answers 500",
		upload: 500,
		says: ["Slack did not accept the file bytes (500)."],
		silent: [],
		sent: [ASK, SEND],
	},
];

const failures = await Promise.all(
	FAILURES.map(async row => ({
		...row,
		run: await runUpload({
			inside: { "report.bin": FILE_BYTES },
			params: () => ({ channel: CHANNEL, path: "report.bin" }),
			start: row.start,
			upload: row.upload,
			complete: row.complete,
		}),
	})),
);

test.each(failures)("$name fails the tool with Slack's reason and nothing past the failed step is sent", ({
	run,
	says,
	silent,
	sent,
}) => {
	expect(run.outcome.ok).toBe(false);
	for (const text of says) expect(run.outcome.text).toContain(text);
	for (const text of silent) expect(run.outcome.text).not.toContain(text);
	expect(run.requests.map(label)).toEqual(sent);
});
