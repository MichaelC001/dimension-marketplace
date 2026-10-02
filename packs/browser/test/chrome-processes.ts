/**
 * What the operating system says is running, for tests that must prove a Chrome is GONE — by pid, never by the
 * pack's own bookkeeping (a runtime that forgot a browser says nothing about whether its process died).
 *
 * A throwaway browser's command line carries `--user-data-dir=<root>/ephemeral/<random>/chrome`, and so does every
 * helper process of that Chrome (renderer, GPU, crashpad), so one path fragment names a browser's whole process tree.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

interface OsProcess {
	pid: number;
	command: string;
}

/** Every Chrome-family process on the machine with its command line. */
async function chromeProcesses(): Promise<OsProcess[]> {
	if (process.platform === "win32") {
		const script =
			"Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
		const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
		if (stdout.trim() === "") return [];
		const parsed = JSON.parse(stdout) as { ProcessId: number; CommandLine: string | null } | Array<{ ProcessId: number; CommandLine: string | null }>;
		return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({ pid: entry.ProcessId, command: entry.CommandLine ?? "" }));
	}
	const { stdout } = await run("ps", ["-eo", "pid=,args="], { maxBuffer: 64 * 1024 * 1024 });
	return stdout
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
		.filter((match): match is RegExpExecArray => match !== null && /chrom/i.test(match[2] ?? ""))
		.map((match) => ({ pid: Number(match[1]), command: match[2] as string }));
}

/**
 * The live Chrome browsers under `root`, as `{ <the throwaway directory's name>: pids of its whole tree }`. One OS query for
 * all of them, because on Windows each query costs a second.
 */
export async function chromePidsByThrowaway(root: string): Promise<Map<string, number[]>> {
	const byDirectory = new Map<string, number[]>();
	for (const entry of await chromeProcesses()) {
		if (!entry.command.includes(root)) continue;
		const match = /ephemeral[\\/]([0-9a-f]+)[\\/]/i.exec(entry.command);
		if (match === null) continue;
		const name = match[1] as string;
		byDirectory.set(name, [...(byDirectory.get(name) ?? []), entry.pid]);
	}
	return byDirectory;
}

/** Whether the OS still has a process with this pid. Signal 0 delivers nothing; it only asks. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Poll until none of `pids` is alive; the survivors at the deadline otherwise (an empty list is success). */
export async function waitUntilGone(pids: readonly number[], timeoutMs: number): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const survivors = pids.filter(isAlive);
		if (survivors.length === 0 || Date.now() >= deadline) return survivors;
		await Bun.sleep(50);
	}
}
