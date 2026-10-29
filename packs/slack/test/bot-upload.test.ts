import { expect, test } from "bun:test";
import { join } from "node:path";
import { canHardLink } from "./support/hard-link";
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

const ACCENTED_TEXT = "héllo wörld — 日本語 🚀\n";

const [full, bare, accented] = await Promise.all([
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
	runUpload({
		inside: { "notes.txt": ACCENTED_TEXT },
		params: () => ({ channel: CHANNEL, path: "notes.txt" }),
	}),
]);
const [ask, send, complete] = full.requests;

test("sharing a file makes exactly three Slack calls in order: ask for an address, send the bytes there, complete the upload", () => {
	expect(full.outcome.ok).toBe(true);
	expect(full.requests.map(label)).toEqual([ASK, SEND, COMPLETE]);
});

test("the upload address is requested under the file's name and the exact length of the bytes then sent, signed with the bot token", () => {
	const query = new URL(ask?.url ?? "").searchParams;

	expect(query.get("filename")).toBe("report.bin");
	expect(query.get("length")).toBe(String(FILE_BYTES.length));
	expect(query.get("length")).toBe(String(send?.bytes.byteLength));
	expect(ask?.headers.authorization).toBe(`Bearer ${BOT_TOKEN}`);
});

test("the announced length of a text file with multi-byte characters counts bytes, not characters", () => {
	const [accentedAsk, accentedSend] = accented.requests;

	expect(accentedSend?.bytes.toString("utf8")).toBe(ACCENTED_TEXT);
	expect(new URL(accentedAsk?.url ?? "").searchParams.get("length")).toBe(String(Buffer.byteLength(ACCENTED_TEXT)));
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
	{
		name: "a file that does not exist and is named like Slack's missing_scope error",
		path: () => "missing_scope.txt",
		says: "There is no file at missing_scope.txt.",
	},
	{
		name: "a file that does not exist and is named like Slack's not_in_channel error",
		path: () => "not_in_channel.txt",
		says: "There is no file at not_in_channel.txt.",
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

test.each(refusals)(
	"$name is refused before any Slack call is made, even with no bot token saved, and never blamed on the Slack app",
	({ run, says }) => {
		expect(run.outcome.ok).toBe(false);
		expect(run.outcome.text).toContain(says);
		expect(run.outcome.text).not.toContain("files:write");
		expect(run.outcome.text).not.toContain("/invite");
		expect(run.requests).toEqual([]);
	},
);

interface Failure {
	readonly name: string;
	readonly start?: unknown;
	readonly upload?: number;
	readonly complete?: unknown;
	readonly says: readonly string[];
	readonly silent: readonly string[];
	readonly sent: string[];
}

const HOSTILE_ADDRESSES: readonly (readonly [string, string])[] = [
	["a host that only starts with Slack's", "https://files.slack.com.evil.example/upload/v1/x"],
	["a host that only ends like Slack's", "https://evilslack.com/upload/v1/x"],
	["a Slack name used as credentials for another host", "https://files.slack.com@evil.example/upload/v1/x"],
	["a Slack name only in the query", "https://evil.example/upload/v1/x?host=files.slack.com"],
	["an address that is not a URL", "files.slack.com/upload/v1/x"],
];

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
	...HOSTILE_ADDRESSES.map(([name, upload_url]) => ({
		name: `an upload address on ${name}`,
		start: { ...STARTED, upload_url },
		says: ["Slack did not return an address to upload the file to."],
		silent: [],
		sent: [ASK],
	})),
	{
		name: "an upload address that is not a string",
		start: { ...STARTED, upload_url: 42 },
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

const ACCEPTED = [
	"https://files.slack.com/upload/v1/x",
	"https://slack.com/upload/v1/x",
	"https://upload.files.slack.com/v1/x",
];

const accepted = await Promise.all(
	ACCEPTED.map(async address => ({
		address,
		run: await runUpload({
			inside: { "report.bin": FILE_BYTES },
			params: () => ({ channel: CHANNEL, path: "report.bin" }),
			start: { ...STARTED, upload_url: address },
		}),
	})),
);

test.each(accepted)("an upload address of $address receives the file's bytes and the upload is completed", ({
	address,
	run,
}) => {
	expect(run.outcome.ok).toBe(true);
	expect(run.requests.map(label)).toEqual([ASK, `POST ${address}`, COMPLETE]);
	expect(run.requests[1]?.bytes.equals(FILE_BYTES)).toBe(true);
});

const EVIL_REDIRECT = "https://evil.example/collect";

const [redirected, cancelled, cancelledWhileCompleting, noContext] = await Promise.all([
	runUpload({
		inside: { "report.bin": FILE_BYTES },
		params: () => ({ channel: CHANNEL, path: "report.bin" }),
		redirectTo: EVIL_REDIRECT,
	}),
	runUpload({
		inside: { "report.bin": FILE_BYTES },
		params: () => ({ channel: CHANNEL, path: "report.bin" }),
		abortOn: "upload",
	}),
	runUpload({
		inside: { "report.bin": FILE_BYTES },
		params: () => ({ channel: CHANNEL, path: "report.bin" }),
		abortOn: "complete",
	}),
	runUpload({
		inside: { "report.bin": FILE_BYTES },
		params: () => ({ channel: CHANNEL, path: "report.bin" }),
		withoutContext: true,
	}),
]);

test("an upload address that redirects elsewhere is not followed, so the file's bytes never reach the other host and nothing is shared", () => {
	expect(redirected.outcome.ok).toBe(false);
	expect(redirected.requests.map(label)).toEqual([ASK, SEND]);
});

test("an upload cancelled after the bytes were sent is not completed, so nothing is shared", () => {
	expect(cancelled.outcome.ok).toBe(false);
	expect(cancelled.outcome.text).toContain("cancelled");
	expect(cancelled.requests.map(label)).toEqual([ASK, SEND]);
});

test("an upload cancelled while Slack is completing it fails as cancelled instead of reporting a shared file", () => {
	expect(cancelledWhileCompleting.outcome.ok).toBe(false);
	expect(cancelledWhileCompleting.outcome.text).toContain("cancelled");
});

test("an upload called without the session's folder fails and sends nothing, even from a process whose own folder holds the file", () => {
	expect(noContext.outcome.ok).toBe(false);
	expect(noContext.requests).toEqual([]);
});

const SAVED_TOKENS: readonly (readonly [string, string])[] = [
	["the bot token", "dimension-slack/token.json"],
	["the As you sign-in", "dimension-slack-user/token.json"],
];

const [tokenControl, ...tokenRefusals] = await Promise.all([
	runUpload({
		userSignedIn: true,
		folderInHome: ".config",
		inside: { "dimension-slack/notes.txt": "notes next to the token" },
		params: () => ({ channel: CHANNEL, path: "dimension-slack/notes.txt" }),
	}),
	...SAVED_TOKENS.map(async ([name, path]) => ({
		name,
		run: await runUpload({
			userSignedIn: true,
			folderInHome: ".config",
			params: () => ({ channel: CHANNEL, path }),
		}),
	})),
]);

test("a session folder that holds the saved tokens still uploads the files next to them", () => {
	expect(tokenControl.outcome.ok).toBe(true);
	expect(tokenControl.requests.map(label)).toEqual([ASK, SEND, COMPLETE]);
});

test.each(tokenRefusals)("$name's saved file is refused as a token even when the session is in the folder that holds it, and nothing is sent", ({
	run,
}) => {
	expect(run.outcome.ok).toBe(false);
	expect(run.outcome.text).toContain("is a saved Slack token");
	expect(run.requests).toEqual([]);
});

const HARD_LINKED_TOKENS = [
	["the bot token", "bot"],
	["the As you sign-in", "user"],
] as const;

const hardLinkRefusals = await Promise.all(
	HARD_LINKED_TOKENS.map(async ([name, token]) => ({
		name,
		run: canHardLink
			? await runUpload({
					userSignedIn: true,
					linkedTokens: { "quarterly-notes.json": token },
					params: () => ({ channel: CHANNEL, path: "quarterly-notes.json" }),
				})
			: null,
	})),
);

test.skipIf(!canHardLink).each(hardLinkRefusals)("a hard link in the session's folder to $name's saved file is refused as a token, whatever it is named, and nothing is sent", ({
	run,
}) => {
	expect(run?.outcome.ok).toBe(false);
	expect(run?.outcome.text).toContain("is a saved Slack token");
	expect(run?.requests).toEqual([]);
});
