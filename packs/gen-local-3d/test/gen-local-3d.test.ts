// The local `generation` pack (doc 75 §3.3): what this machine can run, what it
// refuses before it spawns anything, the command line a job runs, how a job's
// life is reported, and - the part with teeth - that cancelling or aborting a job
// kills ONLY the child it spawned and returns only once that process is gone.
//
// The CLI is a real child process: a fake `trellis-cli` (a script behind a tiny
// launcher) that prints the stage banners, writes the GLB and its atlas, fails,
// or hangs, as a file beside it says. No GPU, no weights worth the name, nothing
// outside a temp dir.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationProvider, GenerationRequest, GenerationStatus } from "@dimension/sdk/provider";
import { type ArgvEntry, buildArgv, createLocalGenerationProvider, type ModelSpec, readConfig, resolveOptions } from "../index.ts";
import models from "../models.json";
import { encodePng, labCutout } from "./png.ts";

setDefaultTimeout(60_000);

const PIXAL = "pixal3d-sv";
const specs = models.models as unknown as ModelSpec[];
const pixalSpec = specs.find(spec => spec.id === PIXAL) as ModelSpec;
const otherSpec = specs.find(spec => spec.id !== PIXAL) as ModelSpec;

describe("buildArgv", () => {
	const argv = (entries: ArgvEntry[], values: Record<string, unknown>) => buildArgv({ argv: entries }, values);

	test("a flag takes the value of a built-in or option; a value that is missing drops its flag", () => {
		expect(argv([{ flag: "--seed", from: "seed" }, { flag: "--gss", from: "gss" }], { seed: 7 })).toEqual(["--seed", "7"]);
	});

	test("a constant flag always carries its constant, a bare flag is a switch, a positional is just its value, in the order written", () => {
		const entries: ArgvEntry[] = [{ flag: "--res", value: 1024 }, { flag: "--require-gpu" }, { flag: "--seed", from: "seed" }, { arg: "output" }];
		expect(argv(entries, { seed: 3, output: "out.glb" })).toEqual(["--res", "1024", "--require-gpu", "--seed", "3", "out.glb"]);
		expect(argv(entries, {})).toEqual(["--res", "1024", "--require-gpu"]);
	});

	test("a conditional switch appears only when its value equals the condition, not when it is unset or the other value", () => {
		const entries: ArgvEntry[] = [{ flag: "--no-texture", from: "texture", when: false }];
		expect(argv(entries, { texture: false })).toEqual(["--no-texture"]);
		expect(argv(entries, { texture: true })).toEqual([]);
		expect(argv(entries, {})).toEqual([]);
	});

	test("an argument with a space in it stays one argument", () => {
		expect(argv([{ flag: "--sv-image", from: "image" }], { image: "C:/My Pictures/hero cut.png" })).toEqual(["--sv-image", "C:/My Pictures/hero cut.png"]);
	});
});

describe("resolveOptions", () => {
	test("an option the model does not have is refused, naming the ones it does", () => {
		expect(() => resolveOptions(pixalSpec, { warp: 9 })).toThrow(/has no option "warp".*it has:.*gss/);
	});

	test("a value of the wrong type, or outside the schema's range, is refused with what was expected", () => {
		expect(() => resolveOptions(pixalSpec, { gss: "high" })).toThrow('option "gss" of pixal3d-sv must be a number');
		expect(() => resolveOptions(pixalSpec, { gss: -1 })).toThrow("at least 0");
		expect(() => resolveOptions(pixalSpec, { fov: 9 })).toThrow("at most 1.5");
		expect(() => resolveOptions(pixalSpec, { atlas: 1.5 })).toThrow("an integer");
		expect(() => resolveOptions(pixalSpec, { texture: "no" })).toThrow("true or false");
	});

	test("a value the caller gave wins over the model's default, and a value left undefined falls back to it", () => {
		const given = resolveOptions(pixalSpec, { gss: 3 });
		expect(given.gss).toBe(3);
		const fallback = resolveOptions(pixalSpec, { gss: undefined });
		expect(fallback.gss).toBe(pixalSpec.options.properties.gss?.default);
	});
});

describe("reading what the connect form wrote", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "gen-local-config-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const write = async (name: string, content: string): Promise<string> => {
		const path = join(dir, name);
		await writeFile(path, content);
		return path;
	};

	const WINDOWS = { cliPath: String.raw`C:\Tools\pixal3d\trellis-cli.exe`, modelsRoot: String.raw`D:\Models "v2"\weights` };

	test("JSON-escaped Windows paths, as the connect form now writes them, read back exactly as typed", async () => {
		expect(await readConfig(await write("escaped.json", JSON.stringify(WINDOWS)))).toEqual(WINDOWS);
	});

	test("a file written by the old unescaped template - raw backslashes, not valid JSON - still reads back with the paths verbatim", async () => {
		const legacy = `{\n\t"cliPath": "${String.raw`C:\Tools\pixal3d\trellis-cli.exe`}",\n\t"modelsRoot": "${String.raw`D:\Models`}"\n}\n`;
		expect(() => JSON.parse(legacy)).toThrow();
		expect(await readConfig(await write("legacy.json", legacy))).toEqual({ cliPath: String.raw`C:\Tools\pixal3d\trellis-cli.exe`, modelsRoot: String.raw`D:\Models` });
	});

	test("surrounding spaces are trimmed and ~ is the home directory", async () => {
		const config = await readConfig(await write("home.json", JSON.stringify({ cliPath: "  ~/bin/trellis-cli ", modelsRoot: "~" })));
		expect(config.cliPath).toBe(join(homedir(), "bin", "trellis-cli"));
		expect(config.modelsRoot).toBe(homedir());
	});

	test("a missing file says how to connect; an empty field names the field; a file with neither field is not read as connected", async () => {
		await expect(readConfig(join(dir, "absent.json"))).rejects.toThrow("Connect page");
		await expect(readConfig(await write("empty.json", JSON.stringify({ cliPath: "x", modelsRoot: " " })))).rejects.toThrow("modelsRoot is empty");
		await expect(readConfig(await write("junk.json", "not json at all"))).rejects.toThrow("not valid JSON");
	});
});

/** The fake CLI: stage banners, then whatever `mode` beside it says. */
const FAKE_CLI = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = import.meta.dirname;
const read = name => { try { return readFileSync(join(here, name), "utf8").trim(); } catch { return undefined; } };
const args = process.argv.slice(2);
if (args.includes("--help")) { console.error(read("help.txt") ?? "usage: fake-trellis-cli"); process.exit(0); }
const mode = read("mode") ?? "ok";
const at = args.indexOf("--output");
const output = at >= 0 ? args[at + 1] : args.at(-1);
const dir = dirname(output);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "fake.json"), JSON.stringify({ pid: process.pid, argv: args, env: { PIXAL3D_STEPS: process.env.PIXAL3D_STEPS ?? null } }));
console.log("[0/4] load weights");
console.log("[1/4] structure");
if (mode === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (mode === "fail") { console.error("cuda error: out of memory"); console.error("trellis: aborting"); process.exit(3); }
console.log("[2/4] shape");
if (mode === "gated") { while (!existsSync(join(here, "release"))) await new Promise(resolve => setTimeout(resolve, 20)); }
console.log("[4/4] write " + output);
if (mode === "nowrite") process.exit(0);
const json = Buffer.from(JSON.stringify({ asset: { version: "2.0", generator: "trellis.cpp v0.99.1-fake", extras: { commit: "deadbeef", backend: "cuda", build: "2026-01-01" } } }));
const body = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const head = Buffer.alloc(20);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8); head.writeUInt32LE(body.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
writeFileSync(output, Buffer.concat([head, body]));
writeFileSync(output.replace(/\\.glb$/, "_base.png"), "fake-png");
`;

let root: string;
let cliPath: string;
let cliDir: string;
let modelsRoot: string;
let workRoot: string;
let cutoutPath: string;
let opaquePath: string;

const allFlags = [...new Set([...pixalSpec.requiresFlags, ...otherSpec.requiresFlags])];
const fullHelp = `usage: fake-trellis-cli [options]\n${allFlags.map(flag => `  ${flag}`).join("\n")}\n`;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "gen-local-3d-"));
	cliDir = join(root, "cli");
	modelsRoot = join(root, "models");
	workRoot = join(root, "work");
	await mkdir(cliDir, { recursive: true });
	await writeFile(join(cliDir, "fake.mjs"), FAKE_CLI);
	await writeFile(join(cliDir, "help.txt"), fullHelp);
	if (process.platform === "win32") {
		cliPath = join(cliDir, "fake-trellis-cli.cmd");
		await writeFile(cliPath, `@echo off\r\n"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
	} else {
		cliPath = join(cliDir, "fake-trellis-cli");
		await writeFile(cliPath, `#!/bin/sh\nexec "${process.execPath}" "${join(cliDir, "fake.mjs")}" "$@"\n`);
		await chmod(cliPath, 0o755);
	}
	const weights = join(modelsRoot, pixalSpec.weightsDir);
	await mkdir(weights, { recursive: true });
	for (const name of pixalSpec.requiredFiles) await writeFile(join(weights, name), "weights");
	cutoutPath = join(root, "hero cutout.png");
	opaquePath = join(root, "hero opaque.png");
	await writeFile(cutoutPath, encodePng({ width: 64, height: 48, encoding: { kind: "rgba", depth: 8 }, pixel: labCutout }));
	await writeFile(opaquePath, encodePng({ width: 64, height: 48, encoding: { kind: "rgba", depth: 8 }, pixel: () => [9, 9, 9, 255] }));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const setMode = (mode: string): Promise<void> => writeFile(join(cliDir, "mode"), mode);
const provider = (config: { cliPath: string; modelsRoot: string } = { cliPath, modelsRoot }): GenerationProvider =>
	createLocalGenerationProvider({ config: async () => config, workRoot });
const signal = new AbortController().signal;

let jobs = 0;
interface JobContext {
	readonly signal: AbortSignal;
	readonly jobId: string;
}
const context = (controller = new AbortController()): JobContext => ({ signal: controller.signal, jobId: `job-${++jobs}` });
const request = (extra: Partial<GenerationRequest> = {}): GenerationRequest => ({ model: PIXAL, input: { images: [cutoutPath] }, ...extra });

/** Poll a condition on a REAL child process (the fake CLI): there is no event to
 *  await, only the OS's view of the process, so a short real wait between reads
 *  is the honest lever. It waits on the condition, bounded, never on a guessed duration. */
async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
	for (let attempt = 0; attempt < 600; attempt++) {
		const found = await read();
		if (found !== undefined) return found;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

interface Fake {
	pid: number;
	argv: string[];
	env: { PIXAL3D_STEPS: string | null };
}

const fakeOf = (dir: string): Promise<Fake> =>
	waitFor(async () => {
		try {
			return JSON.parse(await readFile(join(dir, "fake.json"), "utf8")) as Fake;
		} catch {
			return undefined;
		}
	}, `the fake CLI to start in ${dir}`);

const refOf = (ref: string): { pid: number; dir: string; startedAt: number } => JSON.parse(ref);

async function untilFinished(p: GenerationProvider, ref: string, ctx: JobContext): Promise<GenerationStatus> {
	return waitFor(async () => {
		const status = await p.status(ref, ctx);
		return status.state === "running" || status.state === "queued" ? undefined : status;
	}, "the job to finish");
}

const exists = (path: string): Promise<boolean> =>
	stat(path).then(
		() => true,
		() => false,
	);

describe("what this machine can run", () => {
	test("without the connect form's paths the pack is not ready and says how to connect", async () => {
		const unconnected = createLocalGenerationProvider({ config: () => readConfig(join(root, "never-written.json")), workRoot });
		const catalogue = await unconnected.describe({ signal });
		expect(catalogue).toMatchObject({ ready: false, models: [] });
		expect(catalogue.reason).toContain("Connect page");
	});

	test("a model whose weights are present is offered; one whose folder is missing is withheld and the reason names it", async () => {
		const catalogue = await provider().describe({ signal });
		expect(catalogue.ready).toBe(true);
		expect(catalogue.models.map(model => model.id)).toEqual([PIXAL]);
		expect(catalogue.reason).toContain(otherSpec.label);
		expect(catalogue.reason).toContain(otherSpec.weightsDir.replace(/\//g, "\\").split("\\")[0] as string);
	});

	test("a model with one weight file missing is withheld and the missing file is named", async () => {
		const sparse = join(root, "sparse-models");
		const folder = join(sparse, pixalSpec.weightsDir);
		await mkdir(folder, { recursive: true });
		for (const name of pixalSpec.requiredFiles.slice(1)) await writeFile(join(folder, name), "weights");
		const catalogue = await provider({ cliPath, modelsRoot: sparse }).describe({ signal });
		expect(catalogue.ready).toBe(false);
		expect(catalogue.reason).toContain(pixalSpec.requiredFiles[0] as string);
	});

	test("a CLI whose --help does not list a flag the model needs cannot run that model, and the reason names the flag", async () => {
		const missingFlag = pixalSpec.requiresFlags.find(flag => !otherSpec.requiresFlags.includes(flag)) as string;
		await writeFile(join(cliDir, "help.txt"), fullHelp.replace(missingFlag, ""));
		try {
			const catalogue = await provider().describe({ signal });
			expect(catalogue.models.map(model => model.id)).not.toContain(PIXAL);
			expect(catalogue.reason).toContain(missingFlag);
		} finally {
			await writeFile(join(cliDir, "help.txt"), fullHelp);
		}
	});

	test("a CLI path that does not exist, and a models folder that does not exist, are named", async () => {
		const noCli = await provider({ cliPath: join(root, "no-such-cli"), modelsRoot }).describe({ signal });
		expect(noCli).toMatchObject({ ready: false });
		expect(noCli.reason).toContain("was not found");
		const noModels = await provider({ cliPath, modelsRoot: join(root, "no-models") }).describe({ signal });
		expect(noModels.reason).toContain("does not exist");
	});
});

describe("a request is refused before anything is spawned", () => {
	const REFUSED: readonly { name: string; request: () => GenerationRequest; reason: string | RegExp }[] = [
		{ name: "an unknown model, naming what is offered", request: () => request({ model: "nope" }), reason: `it offers: ${PIXAL}` },
		{ name: "a relative image path", request: () => request({ input: { images: ["hero.png"] } }), reason: "must be absolute" },
		{ name: "an image that does not exist", request: () => request({ input: { images: [join(root, "missing.png")] } }), reason: "does not exist" },
		{ name: "no image", request: () => request({ input: { prompt: "a fox" } }), reason: "needs one input image" },
		{ name: "two images", request: () => request({ input: { images: [cutoutPath, cutoutPath] } }), reason: "takes 1 image, got 2" },
		{ name: "a mesh input", request: () => request({ input: { images: [cutoutPath], model: join(root, "m.glb") } }), reason: "cannot build on a mesh" },
		{ name: "an earlier job", request: () => request({ input: { images: [cutoutPath], from: { handle: "x" } } }), reason: "cannot build on a mesh" },
		{ name: "a negative seed", request: () => request({ seed: -1 }), reason: "seed must be an integer" },
		{ name: "a fractional seed", request: () => request({ seed: 1.5 }), reason: "seed must be an integer" },
		{ name: "a seed past 31 bits", request: () => request({ seed: 2_147_483_648 }), reason: "seed must be an integer" },
		{ name: "an unknown option", request: () => request({ options: { warp: 1 } }), reason: /has no option "warp"/ },
		{ name: "an option out of range", request: () => request({ options: { gss: -2 } }), reason: "at least 0" },
	];

	for (const { name, request: make, reason } of REFUSED) {
		test(`${name}: quote and submit both refuse, and no job directory appears`, async () => {
			const p = provider();
			await expect(p.quote(make(), { signal })).rejects.toThrow(reason);
			await expect(p.submit(make(), context())).rejects.toThrow(reason);
			expect(await readdir(workRoot).catch(() => [])).toEqual([]);
		});
	}

	test("the quote is free and carries the model's own basis", async () => {
		expect(await provider().quote(request(), { signal })).toEqual({ usd: 0, basis: pixalSpec.priceBasis });
	});

	test("an image with no real cutout in it is refused at submit with how to fix it, and the CLI is never started", async () => {
		const p = provider();
		await expect(p.submit(request({ input: { images: [opaquePath] } }), context())).rejects.toThrow(/hero opaque\.png is not a cutout.*Remove the background/s);
		expect(await readdir(workRoot).catch(() => [])).toEqual([]);
	});
});

describe("a job's life", () => {
	test("runs the CLI with the request's settings, reports the stage banners as progress, and succeeds once the output is written", async () => {
		await setMode("gated");
		await rm(join(cliDir, "release"), { force: true });
		const p = provider();
		const ctx = context();
		const { ref } = await p.submit(request({ seed: 7, options: { gss: 8, texture: false } }), ctx);
		const { dir } = refOf(ref);
		const fake = await fakeOf(dir);

		const running = await waitFor(async () => {
			const status = await p.status(ref, ctx);
			return status.state === "running" && (status.progress ?? 0) >= 0.5 ? status : undefined;
		}, "the [2/4] banner");
		expect(running).toMatchObject({ state: "running", message: expect.stringContaining("[2/4]") });
		expect(running.state === "running" ? (running.progress as number) : 0).toBeLessThan(1);

		await writeFile(join(cliDir, "release"), "go");
		expect(await untilFinished(p, ref, ctx)).toEqual({ state: "succeeded" });

		// The command line the CLI actually received.
		const at = (flag: string): string | undefined => fake.argv[fake.argv.indexOf(flag) + 1];
		expect(at("--sv-image")).toBe(cutoutPath);
		expect(at("--seed")).toBe("7");
		expect(at("--gss")).toBe("8");
		expect(at("--models")).toBe(join(modelsRoot, pixalSpec.weightsDir));
		expect(fake.argv).toContain("--no-texture");
		expect(fake.argv.at(-1)).toBe(join(dir, models.cli.output));
		await rm(join(cliDir, "release"), { force: true });
	});

	test("an environment variable the model's recorded settings must not be changed by is stripped from the CLI's environment", async () => {
		await setMode("ok");
		const name = models.cli.unsetEnv[0] as string;
		const before = process.env[name];
		process.env[name] = "3";
		try {
			const p = provider();
			const ctx = context();
			const { ref } = await p.submit(request(), ctx);
			const fake = await fakeOf(refOf(ref).dir);
			expect(fake.env.PIXAL3D_STEPS).toBeNull();
			await untilFinished(p, ref, ctx);
		} finally {
			if (before === undefined) delete process.env[name];
			else process.env[name] = before;
		}
	});

	test("fetch copies the model and its atlas into the outDir only, with no cost, the licence, the seed and the CLI's own provenance, and clears the work dir", async () => {
		await setMode("ok");
		const p = provider();
		const ctx = context();
		const { ref } = await p.submit(request({ seed: 11 }), ctx);
		const { dir } = refOf(ref);
		expect((await untilFinished(p, ref, ctx)).state).toBe("succeeded");

		const outDir = join(root, "out", "job-fetch");
		const result = await p.fetch(ref, { ...ctx, outDir });
		expect((await readdir(outDir)).sort()).toEqual([models.cli.output, ...models.cli.sidecars.map(sidecar => sidecar.name)].sort());
		expect(result.files.every(file => file.path.startsWith(outDir))).toBe(true);
		expect(result.files.find(file => file.format === "glb")).toMatchObject({ role: "model" });
		expect(result.files.find(file => file.format === "png")).toMatchObject({ role: "texture" });
		expect(result.costUsd).toBe(0);
		expect(result.licence).toEqual(pixalSpec.licence);
		expect(result.meta).toMatchObject({ model: PIXAL, seed: 11, cli: { version: "v0.99.1-fake", commit: "deadbeef", backend: "cuda" } });
		expect(await exists(dir)).toBe(false);
	});

	test("a fresh provider (the engine restarted) still reports a job that finished before the restart, and fetches it", async () => {
		await setMode("ok");
		const first = provider();
		const ctx = context();
		const { ref } = await first.submit(request(), ctx);
		expect((await untilFinished(first, ref, ctx)).state).toBe("succeeded");
		// The finished job's result record is written as the child closes.
		await waitFor(async () => ((await exists(join(refOf(ref).dir, "result.json"))) ? true : undefined), "result.json");

		const restarted = provider();
		expect(await restarted.status(ref, ctx)).toEqual({ state: "succeeded" });
		const result = await restarted.fetch(ref, { ...ctx, outDir: join(root, "out", "job-restart") });
		expect(result.files).toHaveLength(1 + models.cli.sidecars.length);
	});

	test("a CLI that exits non-zero fails the job with its exit code and its last lines, and is never billed", async () => {
		await setMode("fail");
		const p = provider();
		const ctx = context();
		const { ref } = await p.submit(request(), ctx);
		const status = await untilFinished(p, ref, ctx);
		expect(status.state).toBe("failed");
		if (status.state !== "failed") throw new Error("unreachable");
		expect(status.billed).toBe(false);
		expect(status.error).toContain("exited with code 3");
		expect(status.error).toContain("cuda error: out of memory");
		await expect(p.fetch(ref, { ...ctx, outDir: join(root, "out", "job-failed") })).rejects.toThrow("nothing to fetch");
	});

	test("a CLI that exits 0 without writing its output is a failure, not a success", async () => {
		await setMode("nowrite");
		const p = provider();
		const ctx = context();
		const { ref } = await p.submit(request(), ctx);
		expect(await untilFinished(p, ref, ctx)).toMatchObject({ state: "failed", billed: false, error: expect.stringContaining("without writing its output") });
	});
});

describe("stopping a job", () => {
	/** Start `count` hanging jobs and wait until each CLI process exists. */
	async function startHanging(p: GenerationProvider, count: number) {
		await setMode("hang");
		const started = [];
		for (let index = 0; index < count; index++) {
			const controller = new AbortController();
			const ctx = context(controller);
			const { ref } = await p.submit(request(), ctx);
			const info = refOf(ref);
			started.push({ ref, ctx, controller, ...info, fake: await fakeOf(info.dir) });
		}
		return started;
	}

	test("cancel kills the child it spawned, returns only once that process is gone, and leaves a sibling job's process alone", async () => {
		const p = provider();
		const [a, b] = await startHanging(p, 2);
		if (a === undefined || b === undefined) throw new Error("two jobs were started");
		try {
			expect(alive(a.fake.pid)).toBe(true);
			expect(alive(b.fake.pid)).toBe(true);

			await p.cancel?.(a.ref, a.ctx);

			// No waiting: cancel must not have returned before the OS said the process was gone.
			expect(alive(a.fake.pid)).toBe(false);
			expect(alive(a.pid)).toBe(false);
			expect(alive(b.fake.pid)).toBe(true);
			expect(await p.status(a.ref, a.ctx)).toEqual({ state: "failed", error: "cancelled", billed: false });
			expect((await p.status(b.ref, b.ctx)).state).toBe("running");
		} finally {
			await p.cancel?.(b.ref, b.ctx);
		}
		expect(alive(b.fake.pid)).toBe(false);
	});

	test("aborting a job's signal kills that job's child, again leaving the other job alone", async () => {
		const p = provider();
		const [a, b] = await startHanging(p, 2);
		if (a === undefined || b === undefined) throw new Error("two jobs were started");
		try {
			a.controller.abort();
			await waitFor(() => (alive(a.fake.pid) ? undefined : true), "the aborted job's process to die");
			expect(alive(b.fake.pid)).toBe(true);
		} finally {
			await p.cancel?.(b.ref, b.ctx);
		}
	});

	test("a cancelled job's work directory is removed", async () => {
		const p = provider();
		const [a] = await startHanging(p, 1);
		if (a === undefined) throw new Error("a job was started");
		await p.cancel?.(a.ref, a.ctx);
		await waitFor(async () => ((await exists(a.dir)) ? undefined : true), "the work directory to be removed");
	});

	test("after a restart, a job whose CLI is still running is stopped and reported as a restart casualty, not left holding the GPU", async () => {
		const first = provider();
		const [a] = await startHanging(first, 1);
		if (a === undefined) throw new Error("a job was started");
		const restarted = provider();
		try {
			const status = await restarted.status(a.ref, a.ctx);
			expect(status).toMatchObject({ state: "failed", billed: false, error: expect.stringContaining("runner restarted") });
			expect(alive(a.fake.pid)).toBe(false);
		} finally {
			await first.cancel?.(a.ref, a.ctx);
		}
	});

	test("a recorded pid that now belongs to some other process is NOT killed: the start time must match", async () => {
		const first = provider();
		const [a] = await startHanging(first, 1);
		if (a === undefined) throw new Error("a job was started");
		try {
			// The same pid, but a start time an hour away: as if the pid had been reused by a stranger.
			const stale = JSON.stringify({ ...JSON.parse(a.ref), startedAt: a.startedAt - 3_600_000 });
			const restarted = provider();
			expect(await restarted.status(stale, a.ctx)).toMatchObject({ state: "failed", error: expect.stringContaining("is gone") });
			expect(alive(a.fake.pid)).toBe(true);
			expect(alive(a.pid)).toBe(true);
		} finally {
			await first.cancel?.(a.ref, a.ctx);
		}
		expect(alive(a.fake.pid)).toBe(false);
	});
});
