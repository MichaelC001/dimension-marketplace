// One CLI run as a child process: spawn it, read its progress, stop it, and
// prove it is gone.
//
// A local job holds this machine's GPU for minutes and the engine's lease is
// released the moment the job ends, so every path that ends a job has to be
// true about the process: a job is never reported finished while its child runs,
// and cancelling it kills ONLY that child's pid tree (never by image name) and
// does not return until the OS says the process is gone.
//
// The child is spawned `detached: false`. On Windows libuv puts such a child in
// the engine's job object, so it dies with the engine instead of surviving as a
// GPU-holding orphan; the pid and start time the caller records are for the case
// where it did survive (see `stopOrphan`), where a bare pid could by then belong
// to a stranger.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long a forced kill may take to show up as an exit. */
const STOP_TIMEOUT_MS = 10_000;

/** A pid whose start time is within this of the recorded one is the same process. */
const SAME_PROCESS_WINDOW_MS = 30_000;

/** Meaningful CLI lines kept for a failure message. */
const TAIL_LINES = 12;

/** Longest line kept, so one runaway line cannot fill the failure message. */
const MAX_LINE_CHARS = 300;

export interface CliProgress {
	/** 0..0.99 and never decreasing: the banner index over the banner count, as the
	 *  lab measured it. The stages are very uneven, so it is a pulse, not a clock. */
	progress: number;
	/** The current stage banner and, inside a sampling stage, its step. */
	message: string | undefined;
	/** The current stage's name, the banner without its `[n/N]`. */
	stage: string;
}

export interface Outcome {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly endedAt: number;
	/** The last meaningful CLI lines, for the failure message. */
	readonly tail: readonly string[];
}

export interface RunningProcess {
	readonly pid: number;
	readonly startedAt: number;
	readonly child: ChildProcess;
	readonly progress: CliProgress;
	/** Set when the CLI has exited and its output is drained. */
	outcome: Outcome | undefined;
	/** True once a stop was requested, so a non-zero exit reads as "cancelled". */
	cancelled: boolean;
	readonly closed: Promise<Outcome>;
}

/** `[n/N] label`, which both models print at the start of each stage. */
const BANNER = /^\[(\d+)\/(\d+)\]\s*(.*)$/;

/** `[flow] [####....] k/m  12.3s ...`, the sampling bar inside a stage. */
const FLOW_STEP = /^\s*\[flow\]\s*\[[#.]*\]\s*(\d+)\/(\d+)\s/;

/** Fold one CLI line into the progress; true when the line was progress noise
 *  that a failure message should not quote. */
export function foldCliLine(progress: CliProgress, line: string): boolean {
	const banner = BANNER.exec(line);
	if (banner) {
		const index = Number(banner[1]);
		const count = Number(banner[2]);
		progress.stage = (banner[3] ?? "").slice(0, 100);
		if (count > 0) progress.progress = Math.max(progress.progress, Math.min(0.99, index / count));
		progress.message = banner[0].slice(0, 120);
		return false;
	}
	const flow = FLOW_STEP.exec(line);
	if (flow) {
		progress.message = `${progress.stage} — sampling step ${flow[1]}/${flow[2]}`;
		return true;
	}
	return false;
}

/** Split a stream into lines on \n, \r\n and the bare \r a progress bar uses. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
	let pending = "";
	return {
		push(chunk) {
			pending += chunk.toString("utf8");
			const lines = pending.split(/\r\n|\r|\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		},
		end() {
			if (pending !== "") onLine(pending);
			pending = "";
		},
	};
}

export interface StartOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	/** Everything the CLI prints is also written here. */
	readonly logPath: string;
}

/** Spawn the CLI and resolve once the OS has given it a pid. */
export async function startProcess(
	command: string,
	argv: readonly string[],
	options: StartOptions,
): Promise<RunningProcess> {
	// Taken before the OS creates the process, not when the 'spawn' event is
	// delivered: a busy engine loop can deliver that event late, and a start time
	// recorded after the real one would stop `isSameProcess` recognising the child.
	const startedAt = Date.now();
	const child = spawn(command, [...argv], {
		cwd: options.cwd,
		env: options.env,
		detached: false,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	// A spawn failure (a missing or non-executable file) is an 'error' before 'spawn'.
	// The 'error' listener stays attached afterwards, which also keeps a late error
	// (a failed kill) from becoming an uncaught exception.
	const spawned = Promise.withResolvers<void>();
	child.once("spawn", spawned.resolve);
	child.once("error", spawned.reject);
	await spawned.promise;
	const pid = child.pid;
	if (pid === undefined) throw new Error(`${command} started without a process id`);

	const progress: CliProgress = { progress: 0, message: undefined, stage: "" };
	const tail: string[] = [];
	const log = createWriteStream(options.logPath);
	log.on("error", () => {});
	const splitter = lineSplitter(line => {
		if (foldCliLine(progress, line) || line.trim() === "") return;
		tail.push(line.slice(0, MAX_LINE_CHARS));
		if (tail.length > TAIL_LINES) tail.shift();
	});
	const onData = (chunk: Buffer) => {
		log.write(chunk);
		splitter.push(chunk);
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);

	const closed = Promise.withResolvers<Outcome>();
	const running: RunningProcess = {
		pid,
		startedAt,
		child,
		progress,
		outcome: undefined,
		cancelled: false,
		closed: closed.promise,
	};
	// 'close' follows 'exit' once the output streams are drained, so the tail is
	// complete. The outcome is published once the log file is closed too: whoever
	// reacts to it may delete the work dir, and Windows refuses to delete an open file.
	child.once("close", (exitCode, signal) => {
		splitter.end();
		const endedAt = Date.now();
		finished(log, () => {
			const outcome: Outcome = { exitCode, signal, endedAt, tail: [...tail] };
			running.outcome = outcome;
			closed.resolve(outcome);
		});
		log.end();
	});
	return running;
}

function exitCodeOf(command: string, args: readonly string[]): Promise<number> {
	const exited = Promise.withResolvers<number>();
	const child = spawn(command, [...args], { windowsHide: true, stdio: "ignore" });
	child.once("error", exited.reject);
	child.once("close", code => exited.resolve(code ?? -1));
	return exited.promise;
}

/** Kill `pid` and everything it started. Windows `taskkill /T /F` walks the tree;
 *  the CLI is a single process elsewhere, so SIGKILL on the pid is the whole tree. */
export async function killProcessTree(pid: number): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`refusing to kill invalid pid ${pid}`);
	if (process.platform === "win32") {
		const code = await exitCodeOf("taskkill", ["/PID", String(pid), "/T", "/F"]);
		// 128 is "no such process": it already ended.
		if (code !== 0 && code !== 128) throw new Error(`taskkill /PID ${pid} /T /F failed with exit code ${code}`);
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** Stop a child this process spawned and wait until the OS reports it gone. */
export async function stopProcess(running: RunningProcess): Promise<void> {
	if (running.outcome) return;
	running.cancelled = true;
	await killProcessTree(running.pid);
	const exited = await Promise.race([running.closed.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)]);
	if (!exited) {
		throw new Error(`pid ${running.pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s of a forced kill`);
	}
}

const UNIX_ETIME = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/;

/** When the OS started `pid`, in epoch ms, or null when no such process exists. */
export async function processStartMs(pid: number): Promise<number | null> {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		if (process.platform === "win32") {
			const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }`;
			const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
				windowsHide: true,
				encoding: "utf8",
			});
			const started = Number.parseInt(stdout.trim(), 10);
			return Number.isFinite(started) ? started : null;
		}
		const { stdout } = await execFileAsync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
		const parts = UNIX_ETIME.exec(stdout.trim());
		if (!parts) return null;
		const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = parts;
		const elapsed = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
		return Date.now() - elapsed * 1000;
	} catch {
		// Get-Process finds nothing, or `ps` exits 1 for a pid that does not exist.
		return null;
	}
}

/** True only when `pid` is alive AND is the process started at `startedAt`: a pid
 *  alone can be reused by an unrelated program after ours died. */
export async function isSameProcess(pid: number, startedAt: number): Promise<boolean> {
	const started = await processStartMs(pid);
	return started !== null && Math.abs(started - startedAt) <= SAME_PROCESS_WINDOW_MS;
}

/** Stop a recorded process this provider instance did not spawn (a previous
 *  engine run's job), after checking it is still the same process. "absent" when
 *  it was already gone or the pid now belongs to something else. */
export async function stopOrphan(pid: number, startedAt: number): Promise<"absent" | "killed"> {
	if (!(await isSameProcess(pid, startedAt))) return "absent";
	await killProcessTree(pid);
	const deadline = Date.now() + STOP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!(await isSameProcess(pid, startedAt))) return "killed";
		await sleep(250);
	}
	throw new Error(`pid ${pid} is still running ${STOP_TIMEOUT_MS / 1000}s after a forced kill`);
}
