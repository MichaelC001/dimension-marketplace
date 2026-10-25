import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname } from "node:path";
import { errorMessage, LibraryError } from "./errors";

const execFileAsync = promisify(execFile);

const TRASH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 5_000;
const PATH_VARIABLE = "DIMENSION_TRASH_PATH";

const WINDOWS_RECYCLE = [
	"$ProgressPreference = 'SilentlyContinue'",
	"$ErrorActionPreference = 'Stop'",
	"try {",
	"Add-Type -AssemblyName Microsoft.VisualBasic",
	`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:${PATH_VARIABLE}, 'AllDialogs', 'SendToRecycleBin')`,
	"} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
].join("\n");

const MACOS_FINDER = ["on run argv", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "end run"];

interface Command {
	readonly program: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly tool: string;
}

function commandFor(path: string, platform: NodeJS.Platform): Command {
	if (platform === "win32") {
		const encoded = Buffer.from(WINDOWS_RECYCLE, "utf16le").toString("base64");
		return {
			program: "powershell.exe",
			args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
			env: { [PATH_VARIABLE]: path },
			tool: "PowerShell",
		};
	}
	if (platform === "darwin") {
		return { program: "osascript", args: [...MACOS_FINDER.flatMap(line => ["-e", line]), path], tool: "Finder" };
	}
	return { program: "gio", args: ["trash", "--", path], tool: "gio" };
}

async function run(program: string, args: readonly string[], options: { readonly env?: Readonly<Record<string, string>>; readonly timeout: number; readonly cwd?: string }): Promise<{ readonly code: number; readonly stderr: string }> {
	try {
		await execFileAsync(program, [...args], {
			env: { ...process.env, ...options.env },
			timeout: options.timeout,
			windowsHide: true,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		});
		return { code: 0, stderr: "" };
	} catch (error) {
		if (error instanceof Error && "code" in error && typeof error.code === "number") {
			return { code: error.code, stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "" };
		}
		throw error;
	}
}

export async function moveToTrash(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
	const command = commandFor(path, platform);
	let outcome: { readonly code: number; readonly stderr: string };
	try {
		outcome = await run(command.program, command.args, { timeout: TRASH_TIMEOUT_MS, ...(command.env === undefined ? {} : { env: command.env }) });
	} catch (error) {
		throw new LibraryError(`${command.tool} could not move the file to the trash: ${errorMessage(error)}`);
	}
	if (outcome.code !== 0) {
		const detail = outcome.stderr.trim().split(/\r?\n/)[0] ?? "";
		throw new LibraryError(`${command.tool} could not move the file to the trash${detail === "" ? "" : `: ${detail}`}`);
	}
}

export async function defaultTrash(path: string): Promise<boolean> {
	try {
		const outcome = await run("git", ["ls-files", "--error-unmatch", "--", basename(path)], { timeout: GIT_TIMEOUT_MS, cwd: dirname(path) });
		return outcome.code !== 0;
	} catch {
		return true;
	}
}
