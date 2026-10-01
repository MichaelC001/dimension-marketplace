// A `generation` provider that runs image-to-3D models ON THIS MACHINE through
// pixal3d.cpp's `trellis-cli` (doc 75 §3.3; character-pipeline design G1).
//
// Pixal3D (single view) and TRELLIS.2 run from GGUF weights on the local GPU. A
// job is the CLI process: `submit` spawns it into a per-job work dir, `status`
// reports the live child (progress comes from the `[n/N]` stage banners it
// prints), `fetch` copies the GLB and its texture atlas into the `outDir` the
// engine passes, `cancel` and an aborted signal kill that one pid tree and wait
// until it is gone. The engine holds the machine-wide GPU lease for the job, so
// this provider never second-guesses it and keeps no queue of its own.
//
// What this pack adds over the bare CLI is what the lab's `pixal3d_generate.py`
// learned the hard way: the measured settings (gss 10, fov 20 degrees, 1024,
// seed 42) as defaults, and a matte guard — the CLI reads "has an alpha channel"
// as "already cut out", so a generator's noise-alpha PNG sails through and the
// backdrop becomes geometry. `requireCutout` judges the alpha by its contents.
// Producing the cutout is a separate concern and this pack never does it.
//
// Nothing about a model is hard-coded: which folder is which model, the argv
// each model's run takes, its option schema and its licence are in `models.json`.
// Code holds the protocol only. Connect writes two PATHS (not secrets) to
// CONFIG_TARGET, so nothing about this machine is hard-coded either.
//
// Runtime imports are `node:` builtins and this pack's own files, so the engine
// can import this file as-is. Types come from `@dimension/sdk/provider` and are
// erased.

import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	GenerationCatalogue,
	GenerationFile,
	GenerationLicence,
	GenerationModality,
	GenerationModel,
	GenerationProvider,
	GenerationQuote,
	GenerationRequest,
	GenerationResult,
	GenerationStatus,
	GenerationSubmitted,
} from "@dimension/sdk/provider";
import { type CutoutReport, type CutoutRule, requireCutout } from "./cutout.js";
import { type RunningProcess, startProcess, stopOrphan, stopProcess } from "./runner.js";
import { startVramSampler, type VramReading } from "./vram.js";

const execFileAsync = promisify(execFile);

/** MUST match `connect.configTarget` in plugin.json. */
const CONFIG_TARGET = join(homedir(), ".config", "dimension-gen-local-3d", "config.json");

/** MUST match `providers.generation[].id` in plugin.json. */
export const PROVIDER_ID = "local-3d";

const MODELS_PATH = fileURLToPath(new URL("./models.json", import.meta.url));

/** The connect form's fields, in the order the config template writes them. */
const CONFIG_FIELDS = ["cliPath", "modelsRoot"] as const;

/** `--help` loads the CUDA libraries and answers in well under a second; a CLI
 *  that has not answered in this long is not going to. */
const PROBE_TIMEOUT_MS = 20_000;

/** A GLB's JSON chunk is a few KB; this only bounds a corrupt length field. */
const MAX_GLB_JSON_BYTES = 4 * 1024 * 1024;

const RESULT_FILE = "result.json";
const LOG_FILE = "cli.log";

// --- models.json ------------------------------------------------------------------------------

/** One argv entry. `flag` + `from` passes an option or a built-in value; `flag` +
 *  `value` a constant; `flag` alone a bare switch; `flag` + `from` + `when` a bare
 *  switch emitted only when that value equals `when`; `arg` a positional value. A
 *  value that is undefined drops its entry. */
export interface ArgvEntry {
	readonly flag?: string;
	readonly arg?: string;
	readonly from?: string;
	readonly value?: string | number;
	readonly when?: boolean;
}

export interface OptionSchema {
	readonly type: "number" | "integer" | "boolean" | "string";
	readonly minimum?: number;
	readonly maximum?: number;
	readonly enum?: readonly unknown[];
	readonly default?: unknown;
}

export interface ModelSpec {
	readonly id: string;
	readonly label: string;
	/** Folder under `modelsRoot` holding this model's weights. */
	readonly weightsDir: string;
	readonly requiredFiles: readonly string[];
	/** Flags every run of this model passes; the CLI's `--help` must list them. */
	readonly requiresFlags: readonly string[];
	readonly defaultSeed: number;
	readonly argv: readonly ArgvEntry[];
	readonly produces: GenerationModality;
	readonly accepts: GenerationModel["accepts"];
	readonly maxImages: number;
	readonly features: readonly string[];
	readonly priceBasis: string;
	readonly licence: GenerationLicence;
	readonly options: { readonly properties: Readonly<Record<string, OptionSchema>> } & Record<string, unknown>;
}

export interface Sidecar {
	readonly name: string;
	readonly role: GenerationFile["role"];
	readonly format: string;
	readonly label: string;
}

export interface ModelsFile {
	readonly cli: {
		/** The GLB's file name inside the job's work dir. */
		readonly output: string;
		/** Files the CLI writes beside the GLB that are results too. */
		readonly sidecars: readonly Sidecar[];
		/** Variables stripped from the CLI's environment so a stray one cannot
		 *  change a run behind its recorded settings. */
		readonly unsetEnv: readonly string[];
	};
	readonly cutout: CutoutRule;
	readonly models: readonly ModelSpec[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadModelsFile(): Promise<ModelsFile> {
	const data: unknown = JSON.parse(await readFile(MODELS_PATH, "utf8"));
	if (!isRecord(data) || !isRecord(data.cli) || !isRecord(data.cutout) || !Array.isArray(data.models)) {
		throw new Error("gen-local-3d's models.json is malformed — reinstall the pack");
	}
	return data as unknown as ModelsFile;
}

function toModel(spec: ModelSpec): GenerationModel {
	return {
		id: spec.id,
		label: spec.label,
		produces: spec.produces,
		accepts: spec.accepts,
		maxImages: spec.maxImages,
		options: spec.options,
		priceBasis: spec.priceBasis,
		licence: spec.licence,
		features: spec.features,
	};
}

// --- connect config ---------------------------------------------------------------------------

export interface LocalConfig {
	/** Absolute path of `trellis-cli`. */
	readonly cliPath: string;
	/** Folder holding one subfolder of GGUF weights per model. */
	readonly modelsRoot: string;
}

/** The pack is not (correctly) connected. `describe` answers it as `ready: false`. */
export class NotConnected extends Error {}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(1)) : path;
}

/** The config file is rendered from a template by plain `${field}` substitution,
 *  which does not JSON-escape: a pasted Windows path (`C:\Tools\...`) arrives with
 *  raw backslashes and is not valid JSON. A file that parses is taken as is; one
 *  that does not is read for the template's own shape, one `"field": "value"` per
 *  line, and the value kept verbatim. */
function parseConfigText(raw: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		const found: Record<string, unknown> = {};
		for (const field of CONFIG_FIELDS) {
			const line = new RegExp(`"${field}"\\s*:\\s*"(.*)"\\s*,?\\s*$`, "m").exec(raw);
			if (line) found[field] = line[1];
		}
		if (Object.keys(found).length === 0) {
			throw new NotConnected("gen-local-3d's config is not valid JSON — reconnect the pack");
		}
		return found;
	}
}

/** Read what the connect form wrote. `path` is the test seam. */
export async function readConfig(path: string = CONFIG_TARGET): Promise<LocalConfig> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new NotConnected(
			"gen-local-3d is not connected — give the path of trellis-cli and the models folder on the pack's Connect page",
		);
	}
	const stored = parseConfigText(raw);
	const values = {} as Record<(typeof CONFIG_FIELDS)[number], string>;
	for (const field of CONFIG_FIELDS) {
		const value = stored[field];
		if (typeof value !== "string" || value.trim() === "") {
			throw new NotConnected(`gen-local-3d's ${field} is empty — reconnect the pack`);
		}
		values[field] = expandHome(value.trim());
	}
	return values;
}

// --- what this machine can run ----------------------------------------------------------------

type Survey =
	| { readonly ok: false; readonly reason: string }
	| {
			readonly ok: true;
			readonly config: LocalConfig;
			readonly available: readonly ModelSpec[];
			/** Why each unlisted model is unlisted, one sentence each. */
			readonly unavailable: readonly string[];
	  };

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).size > 0;
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function listMissing(names: readonly string[]): string {
	return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
}

// --- argv -------------------------------------------------------------------------------------

/** Render a model's argv from its `models.json` entries. `values` holds the
 *  built-ins (`image`, `models`, `output`, `seed`) and the model's options. */
export function buildArgv(spec: Pick<ModelSpec, "argv">, values: Readonly<Record<string, unknown>>): string[] {
	const argv: string[] = [];
	for (const entry of spec.argv) {
		if (entry.arg !== undefined) {
			const value = values[entry.arg];
			if (value !== undefined) argv.push(String(value));
			continue;
		}
		const flag = entry.flag as string;
		const value = entry.from !== undefined ? values[entry.from] : entry.value;
		if (entry.when !== undefined) {
			if (value === entry.when) argv.push(flag);
		} else if (entry.from === undefined && entry.value === undefined) {
			argv.push(flag);
		} else if (value !== undefined) {
			argv.push(flag, String(value));
		}
	}
	return argv;
}

function checkOption(model: string, name: string, value: unknown, schema: OptionSchema): void {
	const fail = (expected: string) => {
		throw new Error(`option "${name}" of ${model} must be ${expected}, got ${JSON.stringify(value)}`);
	};
	switch (schema.type) {
		case "boolean":
			if (typeof value !== "boolean") fail("true or false");
			break;
		case "string":
			if (typeof value !== "string") fail("a string");
			break;
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) fail("an integer");
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) fail("a number");
			break;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		fail(`one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}`);
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) fail(`at least ${schema.minimum}`);
		if (schema.maximum !== undefined && value > schema.maximum) fail(`at most ${schema.maximum}`);
	}
}

/** The model's options with defaults filled in; throws on an unknown or bad one. */
export function resolveOptions(
	spec: ModelSpec,
	given: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
	const properties = spec.options.properties;
	const unknown = Object.keys(given ?? {}).filter(name => !Object.hasOwn(properties, name));
	if (unknown.length > 0) {
		const names = unknown.map(name => `"${name}"`).join(", ");
		throw new Error(`${spec.id} has no option ${names} (it has: ${Object.keys(properties).join(", ")})`);
	}
	const settings: Record<string, unknown> = {};
	for (const [name, schema] of Object.entries(properties)) {
		const value = given?.[name] ?? schema.default;
		if (value === undefined) continue;
		checkOption(spec.id, name, value, schema);
		settings[name] = value;
	}
	return settings;
}

// --- the job ref and what survives a restart --------------------------------------------------

/** The opaque reference the engine stores: everything `status`, `fetch` and
 *  `cancel` need, including after this provider instance is gone. */
interface JobRef {
	readonly v: 1;
	readonly pid: number;
	/** Epoch ms the child was spawned. With `pid` it names ONE process; a pid alone
	 *  can be reused by an unrelated program once ours has died. */
	readonly startedAt: number;
	readonly dir: string;
	readonly model: string;
	readonly seed: number;
	readonly settings: Readonly<Record<string, unknown>>;
	/** The exact command line, for the provenance record. */
	readonly command: readonly string[];
	readonly input: CutoutReport;
}

function parseRef(ref: string): JobRef {
	let data: unknown;
	try {
		data = JSON.parse(ref);
	} catch {
		data = undefined;
	}
	if (
		!isRecord(data) ||
		data.v !== 1 ||
		typeof data.pid !== "number" ||
		typeof data.startedAt !== "number" ||
		typeof data.dir !== "string" ||
		typeof data.model !== "string" ||
		typeof data.seed !== "number" ||
		!isRecord(data.settings) ||
		!Array.isArray(data.command) ||
		!isRecord(data.input)
	) {
		throw new Error("gen-local-3d was handed a job reference it did not write");
	}
	return data as unknown as JobRef;
}

/** How a job ended. Written beside the output so a restarted provider can still
 *  report (and fetch) a job that finished before the restart. */
interface Finished {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly cancelled: boolean;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly tail: readonly string[];
	readonly vram?: VramReading;
}

async function readFinished(dir: string): Promise<Finished | undefined> {
	let data: unknown;
	try {
		data = JSON.parse(await readFile(join(dir, RESULT_FILE), "utf8"));
	} catch {
		return undefined;
	}
	if (!isRecord(data) || typeof data.endedAt !== "number" || typeof data.startedAt !== "number") return undefined;
	return data as unknown as Finished;
}

interface Job {
	readonly proc: RunningProcess;
	readonly dir: string;
	/** Set when an abort or cancel could not stop the child. */
	stopError?: string;
}

/** What the GLB says about the CLI that wrote it. */
async function readGlbAsset(path: string): Promise<Record<string, unknown> | undefined> {
	const file = await open(path, "r");
	try {
		const head = Buffer.alloc(20);
		const { bytesRead } = await file.read(head, 0, 20, 0);
		const isGlb = bytesRead === 20 && head.readUInt32LE(0) === 0x46546c67 && head.readUInt32LE(16) === 0x4e4f534a;
		const length = isGlb ? head.readUInt32LE(12) : 0;
		if (length === 0 || length > MAX_GLB_JSON_BYTES) return undefined;
		const json = Buffer.alloc(length);
		await file.read(json, 0, length, 20);
		const gltf: unknown = JSON.parse(json.toString("utf8"));
		return isRecord(gltf) && isRecord(gltf.asset) ? gltf.asset : undefined;
	} catch {
		return undefined;
	} finally {
		await file.close();
	}
}

function cliProvenance(asset: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!asset) return undefined;
	const generator = typeof asset.generator === "string" ? asset.generator : undefined;
	const extras = isRecord(asset.extras) ? asset.extras : {};
	return {
		...(generator ? { generator, version: /v?\d+\.\d+\.\d+\S*/.exec(generator)?.[0] } : {}),
		commit: extras.commit,
		backend: extras.backend,
		build: extras.build,
	};
}

// --- the provider -----------------------------------------------------------------------------

export interface LocalGenerationOptions {
	/** Where the connect form's values come from. Default: its config file. */
	readonly config?: () => Promise<LocalConfig>;
	/** Parent of the per-job work dirs. Default: a folder in the OS temp dir. */
	readonly workRoot?: string;
	/** Test seam for `models.json`. */
	readonly models?: ModelsFile;
}

export function createLocalGenerationProvider(options: LocalGenerationOptions = {}): GenerationProvider {
	const getConfig = options.config ?? (() => readConfig());
	const workRoot = options.workRoot ?? join(tmpdir(), "dimension-gen-local-3d");
	const jobs = new Map<number, Job>();
	let modelsFile: Promise<ModelsFile> | undefined;
	const loadModels = () => {
		modelsFile ??= options.models ? Promise.resolve(options.models) : loadModelsFile();
		return modelsFile;
	};
	/** CLI `--help` output by exe path, size and mtime: a rebuilt exe is probed again. */
	const helpCache = new Map<string, string>();

	/** What `trellis-cli --help` prints (it goes to stderr), or why it did not run. */
	async function cliHelp(cliPath: string, signal: AbortSignal): Promise<{ help: string } | { problem: string }> {
		let info: Stats;
		try {
			info = await stat(cliPath);
		} catch {
			return { problem: `trellis-cli was not found at ${cliPath}` };
		}
		if (!info.isFile()) return { problem: `${cliPath} is not a file` };
		const key = `${cliPath}|${info.size}|${info.mtimeMs}`;
		const cached = helpCache.get(key);
		if (cached !== undefined) return { help: cached };
		try {
			const { stdout, stderr } = await execFileAsync(cliPath, ["--help"], {
				timeout: PROBE_TIMEOUT_MS,
				signal,
				windowsHide: true,
				encoding: "utf8",
			});
			const help = `${stdout}\n${stderr}`;
			if (!/usage:/i.test(help)) return { problem: `${cliPath} ran but is not trellis-cli (its --help printed no usage)` };
			helpCache.set(key, help);
			return { help };
		} catch (error) {
			signal.throwIfAborted();
			const failure = error as { killed?: boolean; code?: string | number; message?: string };
			if (failure.killed) return { problem: `${cliPath} did not answer --help within ${PROBE_TIMEOUT_MS / 1000}s` };
			return { problem: `${cliPath} does not run: ${failure.code ?? failure.message}` };
		}
	}

	/** Which models this machine can run right now: the CLI runs and supports the
	 *  model's flags, and its weight folder holds every file the model needs. */
	async function survey(signal: AbortSignal): Promise<Survey> {
		const models = await loadModels();
		let config: LocalConfig;
		try {
			config = await getConfig();
		} catch (error) {
			if (error instanceof NotConnected) return { ok: false, reason: error.message };
			throw error;
		}
		const cli = await cliHelp(config.cliPath, signal);
		if ("problem" in cli) return { ok: false, reason: cli.problem };
		if (!(await isDirectory(config.modelsRoot))) {
			return { ok: false, reason: `the models folder ${config.modelsRoot} does not exist` };
		}
		const available: ModelSpec[] = [];
		const unavailable: string[] = [];
		for (const spec of models.models) {
			const dir = join(config.modelsRoot, spec.weightsDir);
			const lacking = spec.requiresFlags.filter(flag => !cli.help.includes(flag));
			if (lacking.length > 0) {
				unavailable.push(`${spec.label}: this trellis-cli does not support ${lacking.join(", ")}`);
			} else if (!(await isDirectory(dir))) {
				unavailable.push(`${spec.label}: its weights folder ${dir} does not exist`);
			} else {
				const missing: string[] = [];
				for (const name of spec.requiredFiles) if (!(await isFile(join(dir, name)))) missing.push(name);
				if (missing.length > 0) unavailable.push(`${spec.label}: ${dir} is missing ${listMissing(missing)}`);
				else available.push(spec);
			}
		}
		if (available.length === 0) {
			return { ok: false, reason: `no model can run here — ${unavailable.join("; ")}` };
		}
		return { ok: true, config, available, unavailable };
	}

	interface Plan {
		readonly spec: ModelSpec;
		readonly config: LocalConfig;
		readonly models: ModelsFile;
		readonly image: string;
		readonly seed: number;
		readonly settings: Record<string, unknown>;
	}

	/** Check a request against this machine and the model; throws if it cannot run. */
	async function plan(request: GenerationRequest, signal: AbortSignal): Promise<Plan> {
		const found = await survey(signal);
		if (!found.ok) throw new Error(`gen-local-3d is not ready: ${found.reason}`);
		const spec = found.available.find(model => model.id === request.model);
		if (!spec) {
			const offered = found.available.map(model => model.id).join(", ");
			const missing = found.unavailable.length > 0 ? `; not usable here — ${found.unavailable.join("; ")}` : "";
			throw new Error(`gen-local-3d has no model "${request.model}" (it offers: ${offered}${missing})`);
		}
		const { input } = request;
		if (input.model !== undefined || input.from !== undefined) {
			throw new Error(`${spec.id} turns one image into a model; it cannot build on a mesh or an earlier job`);
		}
		const images = input.images ?? [];
		if (images.length === 0) throw new Error(`${spec.id} needs one input image (a transparent PNG cutout)`);
		if (images.length > spec.maxImages) {
			throw new Error(`${spec.id} takes ${spec.maxImages} image, got ${images.length}`);
		}
		const image = images[0] as string;
		if (!isAbsolute(image)) throw new Error(`the input image path must be absolute, got ${image}`);
		if (!(await isFile(image))) throw new Error(`the input image ${image} does not exist`);
		const seed = request.seed ?? spec.defaultSeed;
		if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) {
			throw new Error(`the seed must be an integer from 0 to 2147483647, got ${seed}`);
		}
		return {
			spec,
			config: found.config,
			models: await loadModels(),
			image,
			seed,
			settings: resolveOptions(spec, request.options),
		};
	}

	const workDirOf = (jobId: string) => join(workRoot, jobId.replace(/[^\w.-]/g, "_"));

	const liveJob = (ref: JobRef): Job | undefined => {
		const job = jobs.get(ref.pid);
		return job && job.proc.startedAt === ref.startedAt ? job : undefined;
	};

	/** The result of a job whose child has exited, from memory or from disk. */
	async function finishedOf(ref: JobRef): Promise<Finished | undefined> {
		const live = liveJob(ref);
		if (live?.proc.outcome) {
			const { outcome } = live.proc;
			return {
				exitCode: outcome.exitCode,
				signal: outcome.signal,
				cancelled: live.proc.cancelled,
				startedAt: live.proc.startedAt,
				endedAt: outcome.endedAt,
				tail: outcome.tail,
			};
		}
		return readFinished(ref.dir);
	}

	return {
		id: PROVIDER_ID,

		async describe({ signal }): Promise<GenerationCatalogue> {
			const found = await survey(signal);
			if (!found.ok) return { ready: false, reason: found.reason, models: [] };
			return {
				ready: true,
				...(found.unavailable.length > 0 ? { reason: `not listed — ${found.unavailable.join("; ")}` } : {}),
				models: found.available.map(toModel),
			};
		},

		async quote(request, { signal }): Promise<GenerationQuote> {
			const { spec } = await plan(request, signal);
			return { usd: 0, basis: spec.priceBasis };
		},

		async submit(request, context): Promise<GenerationSubmitted> {
			const { spec, config, models, image, seed, settings } = await plan(request, context.signal);
			const input = await requireCutout(image, models.cutout);
			context.signal.throwIfAborted();

			const dir = workDirOf(context.jobId);
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir, { recursive: true });
			const argv = buildArgv(spec, {
				...settings,
				image,
				models: join(config.modelsRoot, spec.weightsDir),
				output: join(dir, models.cli.output),
				seed,
			});
			const env = { ...process.env };
			for (const name of models.cli.unsetEnv) delete env[name];

			// Sampled from before the CLI loads, so the baseline is the GPU as it was.
			const vram = await startVramSampler();
			let proc: RunningProcess;
			try {
				const logPath = join(dir, LOG_FILE);
				proc = await startProcess(config.cliPath, argv, { cwd: dirname(config.cliPath), env, logPath });
			} catch (error) {
				vram?.stop();
				throw new Error(`trellis-cli could not be started: ${error instanceof Error ? error.message : String(error)}`);
			}
			const job: Job = { proc, dir };
			jobs.set(proc.pid, job);

			const onAbort = () => {
				stopProcess(proc).catch(error => {
					job.stopError = error instanceof Error ? error.message : String(error);
				});
			};
			context.signal.addEventListener("abort", onAbort, { once: true });
			if (context.signal.aborted) onAbort();

			void proc.closed.then(async outcome => {
				context.signal.removeEventListener("abort", onAbort);
				const finished: Finished = {
					exitCode: outcome.exitCode,
					signal: outcome.signal,
					cancelled: proc.cancelled,
					startedAt: proc.startedAt,
					endedAt: outcome.endedAt,
					tail: outcome.tail,
					...(vram ? { vram: vram.stop() } : {}),
				};
				// Work-dir bookkeeping must never become an unhandled rejection in the engine:
				// a cancelled job's dir is deleted (nobody will fetch it), and result.json is
				// read only by a restarted provider — the live job answers from memory.
				if (proc.cancelled) {
					await rm(dir, { recursive: true, force: true }).catch(() => {});
				} else {
					await writeFile(join(dir, RESULT_FILE), JSON.stringify(finished)).catch(() => {});
				}
			});

			const ref: JobRef = {
				v: 1,
				pid: proc.pid,
				startedAt: proc.startedAt,
				dir,
				model: spec.id,
				seed,
				settings,
				command: [config.cliPath, ...argv],
				input,
			};
			return { ref: JSON.stringify(ref) };
		},

		async status(ref): Promise<GenerationStatus> {
			const job = parseRef(ref);
			const live = liveJob(job);
			if (live && !live.proc.outcome) {
				const { progress, message } = live.proc.progress;
				const shown = live.stopError ? `could not be stopped: ${live.stopError}` : message;
				return { state: "running", progress, ...(shown ? { message: shown } : {}) };
			}
			const finished = await finishedOf(job);
			if (finished) {
				if (finished.cancelled) return { state: "failed", error: "cancelled", billed: false };
				if (finished.exitCode === 0) {
					const output = join(job.dir, (await loadModels()).cli.output);
					if (await isFile(output)) {
						return { state: "succeeded" };
					}
					return { state: "failed", error: "trellis-cli exited 0 without writing its output", billed: false };
				}
				const how =
					finished.exitCode === null ? `was killed by ${finished.signal}` : `exited with code ${finished.exitCode}`;
				const last = finished.tail.slice(-4).join(" | ");
				return { state: "failed", error: `trellis-cli ${how}${last ? `: ${last}` : ""}`, billed: false };
			}
			// Neither a live child nor a result: the engine restarted while it ran.
			const reaped = await stopOrphan(job.pid, job.startedAt);
			return {
				state: "failed",
				billed: false,
				error:
					reaped === "killed"
						? `runner restarted: trellis-cli (pid ${job.pid}) from the previous run was still going and has been stopped`
						: "runner restarted: the job's trellis-cli is gone",
			};
		},

		async fetch(ref, context): Promise<GenerationResult> {
			const job = parseRef(ref);
			const finished = await finishedOf(job);
			const models = await loadModels();
			const spec = models.models.find(model => model.id === job.model);
			if (!spec) throw new Error(`model "${job.model}" is no longer in gen-local-3d's models.json`);
			const output = join(job.dir, models.cli.output);
			if (finished?.exitCode !== 0 || finished.cancelled || !(await isFile(output))) {
				throw new Error("the job has not succeeded, so there is nothing to fetch");
			}

			const outDir = resolve(context.outDir);
			await mkdir(outDir, { recursive: true });
			const files: GenerationFile[] = [];
			const modelFile = join(outDir, models.cli.output);
			await copyFile(output, modelFile);
			files.push({ path: modelFile, role: "model", format: "glb", label: "Raw model, as the CLI wrote it" });
			for (const sidecar of models.cli.sidecars) {
				const source = join(job.dir, sidecar.name);
				if (!(await isFile(source))) continue;
				const target = join(outDir, sidecar.name);
				await copyFile(source, target);
				files.push({ path: target, role: sidecar.role, format: sidecar.format, label: sidecar.label });
			}
			const cli = cliProvenance(await readGlbAsset(modelFile));
			await rm(job.dir, { recursive: true, force: true });

			return {
				files,
				costUsd: 0,
				licence: spec.licence,
				meta: {
					provider: PROVIDER_ID,
					model: spec.id,
					seed: job.seed,
					seconds: Math.round((finished.endedAt - finished.startedAt) / 100) / 10,
					settings: job.settings,
					command: job.command,
					input: job.input,
					...(cli ? { cli } : {}),
					...(finished.vram
						? {
								vram: {
									baselineMiB: finished.vram.baselineMiB,
									peakTotalMiB: finished.vram.peakMiB,
									peakDeltaMiB: finished.vram.peakMiB - finished.vram.baselineMiB,
									note: "nvidia-smi total GPU memory in use (WDDM hides per-process); an upper bound, shared with every other GPU user",
								},
							}
						: {}),
				},
			};
		},

		async cancel(ref): Promise<void> {
			const job = parseRef(ref);
			const live = liveJob(job);
			if (live) {
				await stopProcess(live.proc);
				return;
			}
			if (await readFinished(job.dir)) return;
			await stopOrphan(job.pid, job.startedAt);
		},
	};
}

/** The factory the engine's provider lane imports (doc 75 §2). */
export function createGenerationProvider(): GenerationProvider {
	return createLocalGenerationProvider();
}
