// A GENERATION provider backed by Tripo's pay-per-use API (doc 75 §3.3; the
// character-pipeline design G1, palace `mupq0k0fh97rbe`).
//
// Tripo turns an image (or several views) into a 3D model and then works on
// that model - separate it into parts, retopologise it, rig it, bake preset
// animations onto the rig, convert it for a game engine. Every step is an
// asynchronous TASK, and every later step names the earlier one by its task
// id. That id is this pack's `handle`: a job's result carries it, and a later
// request chains with `input.from.handle` - no download-and-reupload between
// steps, which is also what keeps the rig on the exact mesh that was generated.
//
// API VERSION. This pack speaks Tripo's V3 API (`openapi.tripo3d.ai/v3`). V2
// (`api.tripo3d.ai/v2/openapi`, one `POST /task` with a `type`) stops being
// maintained on 2026-10-01 and stops serving on 2026-11-01 (Tripo's migration
// guide), so building on it would ship a pack that dies in a month. Keys are
// shared between the two versions and task ids carry across.
//
// Nothing vendor-volatile lives in this file. Model ids, parameters, prices,
// the licence, upload limits and the task-output keys are all in `models.json`,
// next to the sources they were read from; this module is the protocol - how a
// request is validated, priced, shaped on the wire, polled and downloaded. A
// price change or a new model version is a data edit, not a code edit.
//
// MONEY. Tripo freezes the credits when a task is created, spends them if it
// succeeds and releases them if it fails or is cancelled (docs/billing), so a
// failed task is `billed: false` exactly when the task reports no credits
// consumed. Task-creating POSTs are billed per submission: they are never
// retried after a failure that might have reached Tripo. Only 429/503 - where
// Tripo declined the request unprocessed - are retried, with its Retry-After.
//
// NOT VERIFIED AGAINST THE LIVE API (read from Tripo's docs and official SDK
// only; they need a funded key): the exact `output` keys a generate_parts or
// PBR task returns (collectOutputs reads every documented and legacy key), the
// wire shape of `texture_prompt.image` / `.images`, whether a retarget batch's
// `model_urls` follows the order of `animations`, and the rig v2.5 price (the
// pricing page says 25, the rig page's sample response says 30). `models.json`
// marks every other price it had to infer.
//
// The API key comes from this pack's connect form, written to CONFIG_TARGET by
// the host. It is sent only to the Tripo API host: output URLs are signed CDN
// links and are fetched without it. It is never logged or put in an error.
//
// Runtime imports are `node:` builtins and `fetch` only, so the engine can
// import this file as-is. Types come from `@dimension/sdk/provider` and are
// erased.

import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import type {
	GenerationCatalogue,
	GenerationFile,
	GenerationInputKind,
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

/** MUST match `connect.configTarget` in plugin.json. */
const CONFIG_TARGET = join(homedir(), ".config", "dimension-gen-tripo", "key.json");
const MODELS_PATH = fileURLToPath(new URL("./models.json", import.meta.url));

/** The whole of one API call, retries included. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Under the engine's 120 s submit deadline, so a slow upload fails here with a reason. */
const UPLOAD_TIMEOUT_MS = 110_000;
/** The balance only annotates a quote, and the engine gives a quote 30 s. */
const BALANCE_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
/** 429 and 503 are the statuses where Tripo declined the request unprocessed. */
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 30_000;

/** The task-creation endpoints all name the version in the `model` field. */
const VERSION_FIELD = "model";

const IMAGE_MIME: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

type Json = Readonly<Record<string, unknown>>;

/** A condition on one option: a literal to equal, `{ in }` a set, `{ set }` the
 *  caller named it (a default does not count), `{ min }` a number floor. A key
 *  starting with `$` reads a request fact instead of an option (`$images`). */
type Predicate =
	| string
	| number
	| boolean
	| { readonly in: readonly unknown[] }
	| { readonly set: true }
	| { readonly min: number };
type Condition = Readonly<Record<string, Predicate>>;

interface PriceRule {
	readonly label: string;
	readonly credits: number;
	readonly when?: Condition;
	/** Any one of these conditions is enough. */
	readonly whenAny?: readonly Condition[];
	/** Charge per element of this array option (1 when only the scalar form is used). */
	readonly multiplyBy?: string;
}

interface Constraint {
	readonly when?: Condition;
	readonly require?: Condition;
	/** Exactly one of these options must be named. */
	readonly oneOf?: readonly string[];
	readonly message: string;
}

type InputKind = "image" | "views" | "model" | "handle";

interface TaskSpec {
	readonly endpoint: string;
	readonly version?: string;
	readonly input: { readonly field: string; readonly kind: InputKind };
	/** Body fields the contract's single `seed` fills. */
	readonly seed?: readonly string[];
	/** Body field an optional reference image goes in. */
	readonly refImageField?: string;
	/** Body field the texture prompt object (text / image / images) goes in. */
	readonly texturePromptField?: string;
}

export interface TripoModel {
	readonly id: string;
	readonly label: string;
	readonly produces: GenerationModality;
	readonly accepts: readonly GenerationInputKind[];
	readonly maxImages?: number;
	readonly options: readonly string[];
	readonly optionOverrides?: Readonly<Record<string, Json>>;
	readonly required?: readonly string[];
	readonly task: TaskSpec;
	readonly pricing: { readonly base: number; readonly rules: readonly PriceRule[] };
	readonly constraints?: readonly Constraint[];
	readonly priceBasis: string;
	readonly fileRole: GenerationFile["role"];
	readonly features?: readonly string[];
}

interface OutputSpec {
	readonly key: string;
	/** Aliases share a name; the first key present wins. */
	readonly name: string;
	readonly role: GenerationFile["role"];
	readonly list?: boolean;
}

export interface TripoCatalogue {
	readonly apiVersion: string;
	readonly api: { readonly baseUrl: string };
	readonly credit: { readonly usd: number };
	readonly licence: GenerationLicence;
	readonly upload: {
		readonly endpoint: string;
		readonly image: { readonly extensions: readonly string[]; readonly maxBytes: number };
		readonly model: { readonly extensions: readonly string[]; readonly maxBytes: number };
	};
	/** Tripo's canonical view order. */
	readonly views: readonly string[];
	readonly outputs: readonly OutputSpec[];
	readonly defaultExtension: Readonly<Record<string, string>>;
	readonly options: Readonly<Record<string, Json>>;
	readonly models: readonly TripoModel[];
}

export interface UploadRef {
	readonly path: string;
	readonly kind: "image" | "model";
}

export interface TaskRequest {
	readonly endpoint: string;
	readonly body: Readonly<Record<string, unknown>>;
	readonly credits: number;
	readonly usd: number;
	/** One line: the total and how it adds up. */
	readonly basis: string;
}

/** What Tripo's `GET /tasks/{id}` returns that this pack reads. */
export interface TripoTask {
	readonly task_id?: string;
	readonly type?: string;
	readonly status: string;
	readonly progress?: number;
	readonly output?: Json;
	readonly input?: Json;
	readonly credits_consumed?: number | string;
	readonly created_at?: string;
	readonly completed_at?: string;
	readonly error_code?: number;
	readonly error_message?: string;
}

export interface TripoProviderOptions {
	/** Where the API key comes from. Default: the connect form's config file. */
	readonly apiKey?: () => Promise<string>;
	/** Test seam. */
	readonly fetch?: typeof fetch;
	/** Test seam; default loads `models.json` beside this file. */
	readonly catalogue?: TripoCatalogue;
	/** Test seam for the 429/503 back-off. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/** Read the API key the connect form wrote. Every error names the problem and
 *  never the file's content. `path` is the test seam; production reads the
 *  connect form's configTarget. */
export async function readConnectKey(path: string = CONFIG_TARGET): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new Error("gen-tripo is not connected - add a Tripo API key on the pack's Connect page");
	}
	// A parse error quotes the offending token - which in a hand-edited file IS
	// the key - and a provider error lands in the job record. So the parse
	// error is replaced, never passed on.
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		throw new Error("gen-tripo's stored key is not valid JSON - reconnect the pack");
	}
	const access = isRecord(stored) ? stored.access : undefined;
	if (typeof access !== "string" || access.trim() === "") {
		throw new Error("gen-tripo's stored key is empty - reconnect the pack");
	}
	return access.trim();
}

// ---------------------------------------------------------------------------
// The catalogue (models.json)
// ---------------------------------------------------------------------------

/** Every name the data points at must be an option of its model (or a `$fact`):
 *  a typo in `models.json` would otherwise price or gate nothing, silently. */
function referencedNames(model: TripoModel): string[] {
	const conditions: Condition[] = [];
	for (const rule of model.pricing.rules) conditions.push(...(rule.when ? [rule.when] : []), ...(rule.whenAny ?? []));
	for (const constraint of model.constraints ?? []) {
		conditions.push(
			...(constraint.when ? [constraint.when] : []),
			...(constraint.require ? [constraint.require] : []),
		);
	}
	return [
		...conditions.flatMap(condition => Object.keys(condition)),
		...model.pricing.rules.flatMap(rule => (rule.multiplyBy ? [rule.multiplyBy] : [])),
		...(model.constraints ?? []).flatMap(constraint => constraint.oneOf ?? []),
		...(model.required ?? []),
		...Object.keys(model.optionOverrides ?? {}),
		...(model.task.seed ?? []),
	];
}

function assertCatalogue(catalogue: TripoCatalogue): void {
	const seen = new Set<string>();
	for (const model of catalogue.models) {
		if (seen.has(model.id)) throw new Error(`models.json: duplicate model id ${model.id}`);
		seen.add(model.id);
		for (const name of model.options) {
			if (!isRecord(catalogue.options[name]))
				throw new Error(`models.json: ${model.id} lists unknown option ${name}`);
		}
		for (const name of referencedNames(model)) {
			if (name.startsWith("$") || model.options.includes(name)) continue;
			throw new Error(`models.json: ${model.id} refers to ${name}, which is not one of its options`);
		}
	}
}

export async function loadCatalogue(path: string = MODELS_PATH): Promise<TripoCatalogue> {
	const catalogue = JSON.parse(await readFile(path, "utf8")) as TripoCatalogue;
	assertCatalogue(catalogue);
	return catalogue;
}

/** The JSON Schema an agent sees for one model's options. */
export function optionSchema(catalogue: TripoCatalogue, model: TripoModel): Json {
	const properties: Record<string, Json> = {};
	for (const name of model.options)
		properties[name] = { ...catalogue.options[name], ...model.optionOverrides?.[name] };
	return {
		type: "object",
		properties,
		additionalProperties: false,
		...(model.required?.length ? { required: [...model.required] } : {}),
	};
}

export function describeModels(catalogue: TripoCatalogue): GenerationModel[] {
	return catalogue.models.map(model => ({
		id: model.id,
		label: model.label,
		produces: model.produces,
		accepts: model.accepts,
		...(model.maxImages === undefined ? {} : { maxImages: model.maxImages }),
		options: optionSchema(catalogue, model),
		priceBasis: model.priceBasis,
		licence: catalogue.licence,
		...(model.features ? { features: model.features } : {}),
	}));
}

function modelOf(catalogue: TripoCatalogue, id: string): TripoModel {
	const model = catalogue.models.find(candidate => candidate.id === id);
	if (!model)
		throw new Error(`gen-tripo has no model "${id}" (it offers: ${catalogue.models.map(m => m.id).join(", ")})`);
	return model;
}

// ---------------------------------------------------------------------------
// Validation and price: one pass over the request
// ---------------------------------------------------------------------------

/** A small JSON Schema subset - the keywords `models.json` uses. */
function violations(schema: Json, value: unknown, at: string): string[] {
	if (Array.isArray(schema.enum) && !schema.enum.includes(value))
		return [`${at} must be one of ${schema.enum.map(String).join(", ")}`];
	const found: string[] = [];
	switch (schema.type) {
		case "boolean":
			if (typeof value !== "boolean") found.push(`${at} must be a boolean`);
			break;
		case "integer":
		case "number": {
			const whole =
				schema.type === "integer" ? Number.isInteger(value) : typeof value === "number" && Number.isFinite(value);
			if (!whole) {
				found.push(`${at} must be ${schema.type === "integer" ? "an integer" : "a number"}`);
				break;
			}
			if (typeof schema.minimum === "number" && (value as number) < schema.minimum)
				found.push(`${at} must be >= ${schema.minimum}`);
			if (typeof schema.maximum === "number" && (value as number) > schema.maximum)
				found.push(`${at} must be <= ${schema.maximum}`);
			break;
		}
		case "string":
			if (typeof value !== "string") found.push(`${at} must be a string`);
			else if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
				found.push(`${at} must match ${schema.pattern}`);
			}
			break;
		case "array": {
			if (!Array.isArray(value)) {
				found.push(`${at} must be an array`);
				break;
			}
			if (typeof schema.minItems === "number" && value.length < schema.minItems)
				found.push(`${at} needs at least ${schema.minItems} items`);
			if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
				found.push(`${at} takes at most ${schema.maxItems} items`);
			if (schema.uniqueItems === true && new Set(value).size !== value.length)
				found.push(`${at} must not repeat an item`);
			if (isRecord(schema.items))
				value.forEach((item, index) => found.push(...violations(schema.items as Json, item, `${at}[${index}]`)));
			break;
		}
	}
	return found;
}

interface Facts {
	/** Defaults overlaid with what the caller named. */
	readonly effective: Json;
	/** Only what the caller named. */
	readonly explicit: Json;
	readonly images: number;
}

function predicateHolds(predicate: Predicate, key: string, facts: Facts): boolean {
	const value = key === "$images" ? facts.images : facts.effective[key];
	if (typeof predicate !== "object") return value === predicate;
	if ("in" in predicate) return predicate.in.includes(value);
	if ("set" in predicate) return facts.explicit[key] !== undefined;
	return typeof value === "number" && value >= predicate.min;
}

function holds(condition: Condition | undefined, facts: Facts): boolean {
	return Object.entries(condition ?? {}).every(([key, predicate]) => predicateHolds(predicate, key, facts));
}

function resolveFacts(
	catalogue: TripoCatalogue,
	model: TripoModel,
	request: GenerationRequest,
	problems: string[],
): Facts {
	const schema = optionSchema(catalogue, model);
	const properties = schema.properties as Record<string, Json>;
	const explicit: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(request.options ?? {})) {
		if (value === undefined) continue;
		const fragment = properties[name];
		if (!fragment) {
			problems.push(`unknown option "${name}" (this model takes: ${Object.keys(properties).join(", ") || "none"})`);
			continue;
		}
		problems.push(...violations(fragment, value, name));
		explicit[name] = value;
	}
	for (const name of model.required ?? []) {
		if (explicit[name] === undefined) problems.push(`option "${name}" is required`);
	}
	const effective: Record<string, unknown> = {};
	for (const [name, fragment] of Object.entries(properties)) {
		if ("default" in fragment) effective[name] = fragment.default;
	}
	Object.assign(effective, explicit);
	const facts: Facts = { effective, explicit, images: request.input.images?.length ?? 0 };
	for (const constraint of model.constraints ?? []) {
		const violated = constraint.oneOf
			? constraint.oneOf.filter(name => explicit[name] !== undefined).length !== 1
			: holds(constraint.when, facts) && !holds(constraint.require, facts);
		if (violated) problems.push(constraint.message);
	}
	return facts;
}

/** Credits to dollars. Rounded to 6 places to keep the product out of
 *  binary-float noise (70 * 0.01 is not 0.7). */
function creditsToUsd(catalogue: TripoCatalogue, credits: number): number {
	return Math.round(credits * catalogue.credit.usd * 1e6) / 1e6;
}

function priceOf(
	catalogue: TripoCatalogue,
	model: TripoModel,
	facts: Facts,
): Pick<TaskRequest, "credits" | "usd" | "basis"> {
	let credits = model.pricing.base;
	const parts = model.pricing.base > 0 ? [`base ${model.pricing.base}`] : [];
	for (const rule of model.pricing.rules) {
		const applies =
			holds(rule.when, facts) && (!rule.whenAny || rule.whenAny.some(condition => holds(condition, facts)));
		if (!applies) continue;
		const named = rule.multiplyBy ? facts.effective[rule.multiplyBy] : undefined;
		const count = Array.isArray(named) ? named.length : 1;
		credits += rule.credits * count;
		parts.push(count > 1 ? `${count} x ${rule.label} ${rule.credits}` : `${rule.label} ${rule.credits}`);
	}
	const usd = creditsToUsd(catalogue, credits);
	return { credits, usd, basis: `${credits} credits = ${parts.join(" + ")} ($${usd.toFixed(2)})` };
}

// ---------------------------------------------------------------------------
// Request building (pure)
// ---------------------------------------------------------------------------

/** How `input.images` map onto Tripo's views: `options.views` names each image;
 *  without it the images are the first N of [front, left, back, right]. */
function viewBody(
	catalogue: TripoCatalogue,
	images: readonly string[],
	named: unknown,
	token: (file: UploadRef) => string,
	problems: string[],
) {
	const names = Array.isArray(named) ? (named as string[]) : catalogue.views.slice(0, images.length);
	if (names.length !== images.length)
		problems.push(`options.views names ${names.length} views for ${images.length} images`);
	if (!names.includes("front")) problems.push("the front view is mandatory");
	if (images.length < 2) problems.push("multiview needs at least 2 images");
	return catalogue.views.flatMap(view => {
		const at = names.indexOf(view);
		const path = images[at];
		return at >= 0 && path !== undefined ? [{ [view]: token({ path, kind: "image" }) }] : [];
	});
}

/** Tripo's texture prompt is exactly one of: text, one image, four images
 *  (front, left, back, right); a style image may ride along with text. */
function texturePrompt(
	prompt: string | undefined,
	images: readonly string[],
	token: (file: UploadRef) => string,
	problems: string[],
) {
	const file = (path: string) => ({ file_token: token({ path, kind: "image" }) });
	if (images.length === 0) return prompt === undefined ? undefined : { text: prompt };
	if (prompt !== undefined && images.length === 1) return { text: prompt, style_image: file(images[0] as string) };
	if (prompt !== undefined) problems.push("a text prompt combines with at most one (style) image");
	else if (images.length === 1) return { image: file(images[0] as string) };
	else if (images.length === 4) return { images: images.map(file) };
	else problems.push("texture images are 1 (a reference) or 4 (front, left, back, right)");
	return undefined;
}

/** Validate a request against its model and shape it for the wire. `token`
 *  turns a local file into the `file_token` Tripo's upload answered with - a
 *  dry run with a recording token is how the caller learns what to upload. */
export function buildTaskRequest(
	catalogue: TripoCatalogue,
	model: TripoModel,
	request: GenerationRequest,
	token: (file: UploadRef) => string,
): TaskRequest {
	const problems: string[] = [];
	const facts = resolveFacts(catalogue, model, request, problems);
	const properties = optionSchema(catalogue, model).properties as Record<string, Json>;
	const { task } = model;
	const body: Record<string, unknown> = {};
	if (task.version) body[VERSION_FIELD] = task.version;
	for (const [name, value] of Object.entries(facts.explicit)) {
		if (properties[name]?.["x-local"] !== true) body[name] = value;
	}
	if (request.seed !== undefined) {
		if (!task.seed) problems.push("this model takes no seed");
		for (const field of task.seed ?? []) body[field] ??= request.seed;
	}

	const { prompt, negativePrompt, images = [], model: modelPath, from } = request.input;
	const handle = from?.handle;
	if (negativePrompt !== undefined) problems.push("Tripo's 3D models take no negative prompt");
	const relative = [...images, ...(modelPath === undefined ? [] : [modelPath])].filter(path => !isAbsolute(path));
	if (relative.length > 0) problems.push(`local files must be absolute paths: ${relative.join(", ")}`);
	if (task.input.kind === "image" || task.input.kind === "views") {
		if (handle !== undefined || modelPath !== undefined)
			problems.push("this model builds from images; input.from and input.model are for models that work on a model");
		if (prompt !== undefined) problems.push("this model takes no text prompt");
		if (task.input.kind === "image") {
			if (images.length !== 1)
				problems.push(`this model needs exactly one image in input.images (got ${images.length})`);
			else body[task.input.field] = token({ path: images[0] as string, kind: "image" });
		} else if (images.length > 4) {
			problems.push(`at most 4 images (got ${images.length})`);
		} else {
			body[task.input.field] = viewBody(catalogue, images, facts.explicit.views, token, problems);
		}
	} else {
		const fileInput = task.input.kind === "model";
		if (modelPath !== undefined && !fileInput)
			problems.push("this model continues a Tripo job; input.model (a local file) is not accepted");
		if (handle !== undefined && modelPath !== undefined)
			problems.push("give input.from.handle or input.model, not both");
		else if (handle !== undefined) body[task.input.field] = handle;
		else if (modelPath !== undefined && fileInput) body[task.input.field] = token({ path: modelPath, kind: "model" });
		else if (modelPath === undefined) {
			problems.push(
				fileInput
					? "this model needs input.from.handle or input.model"
					: "this model needs input.from.handle (a Tripo job it continues)",
			);
		}
		if (task.texturePromptField) {
			const built = texturePrompt(prompt, images, token, problems);
			if (built) body[task.texturePromptField] = built;
		} else {
			const imagesAllowed = task.refImageField ? 1 : 0;
			if (prompt !== undefined) problems.push("this model takes no text prompt");
			if (images.length > imagesAllowed)
				problems.push(
					imagesAllowed ? "this model takes at most one image (the reference)" : "this model takes no images",
				);
			else if (images.length === 1 && task.refImageField)
				body[task.refImageField] = token({ path: images[0] as string, kind: "image" });
		}
	}
	if (problems.length > 0) throw new Error(`${model.id}: ${problems.join("; ")}`);
	return { endpoint: task.endpoint, body, ...priceOf(catalogue, model, facts) };
}

/** What a request is worth and which local files it needs uploaded: a dry run
 *  of the builder with a token that records the files it was asked for. */
export function planRequest(
	catalogue: TripoCatalogue,
	model: TripoModel,
	request: GenerationRequest,
): { readonly price: Pick<TaskRequest, "credits" | "usd" | "basis">; readonly uploads: readonly UploadRef[] } {
	const wanted = new Map<string, UploadRef>();
	const { credits, usd, basis } = buildTaskRequest(catalogue, model, request, file => {
		wanted.set(file.path, file);
		return "";
	});
	return { price: { credits, usd, basis }, uploads: [...wanted.values()] };
}

/** Fail before any upload on a file Tripo would refuse: wrong type, empty, too big, not a file. */
async function checkLocalFiles(catalogue: TripoCatalogue, uploads: readonly UploadRef[]): Promise<void> {
	const problems: string[] = [];
	for (const { path, kind } of uploads) {
		const limits = catalogue.upload[kind];
		const extension = extname(path).slice(1).toLowerCase();
		if (!limits.extensions.includes(extension)) {
			problems.push(`${basename(path)}: Tripo accepts ${kind} files as ${limits.extensions.join(", ")}`);
			continue;
		}
		const info = await stat(path).catch(() => undefined);
		if (!info?.isFile()) problems.push(`${basename(path)}: not a readable file`);
		else if (info.size === 0) problems.push(`${basename(path)}: the file is empty`);
		else if (info.size > limits.maxBytes)
			problems.push(
				`${basename(path)}: ${info.size} bytes is over Tripo's ${limits.maxBytes} byte limit for a ${kind}`,
			);
	}
	if (problems.length > 0) throw new Error(problems.join("; "));
}

// ---------------------------------------------------------------------------
// Task state and results (pure)
// ---------------------------------------------------------------------------

function creditsOf(task: TripoTask): number | undefined {
	const value = typeof task.credits_consumed === "string" ? Number(task.credits_consumed) : task.credits_consumed;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const TERMINAL_FAILURES: Readonly<Record<string, string>> = {
	failed: "Tripo task failed",
	cancelled: "Tripo task was cancelled",
	banned: "Tripo rejected the input under its content policy",
	expired: "Tripo task expired - its outputs are no longer available",
	unknown: "Tripo reported the task status as unknown",
};

/** Tripo's task status -> the contract's. A failed task is `billed` only when
 *  Tripo reports credits consumed: it releases the frozen credits otherwise. */
export function taskStatus(task: TripoTask): GenerationStatus {
	switch (task.status) {
		case "queued":
			return { state: "queued" };
		case "running":
			return typeof task.progress === "number" && Number.isFinite(task.progress)
				? { state: "running", progress: Math.min(1, Math.max(0, task.progress / 100)) }
				: { state: "running" };
		case "success":
			return { state: "succeeded" };
	}
	const headline = TERMINAL_FAILURES[task.status];
	if (headline === undefined) throw new Error(`Tripo reported an unrecognised task status "${task.status}"`);
	const code = task.error_code === undefined ? "" : ` (error ${task.error_code})`;
	const detail = task.error_message ? `: ${task.error_message}` : "";
	return { state: "failed", error: `${headline}${code}${detail}`, billed: (creditsOf(task) ?? 0) > 0 };
}

interface OutputFile {
	readonly name: string;
	readonly url: string;
	/** File extension without the dot, from the URL. */
	readonly format: string;
	readonly role: GenerationFile["role"];
}

/** `fallbackKind` picks the default extension when the URL carries none. */
function outputFile(
	catalogue: TripoCatalogue,
	name: string,
	url: string,
	role: GenerationFile["role"],
	fallbackKind: string,
): OutputFile {
	let link: URL;
	try {
		link = new URL(url);
	} catch {
		throw new Error(`Tripo's ${name} output is not a URL`);
	}
	if (link.protocol !== "https:") throw new Error(`Tripo's ${name} output is not an https URL`);
	const fromUrl = extname(link.pathname).slice(1).toLowerCase();
	return {
		name,
		url,
		role,
		format: /^[a-z0-9]{1,8}$/.test(fromUrl) ? fromUrl : (catalogue.defaultExtension[fallbackKind] ?? "bin"),
	};
}

/** The downloadable URLs of a finished task, named. Aliases share a name and
 *  the first present key wins; a list of several expands to `name-1`, `name-2`, ... */
export function collectOutputs(
	catalogue: TripoCatalogue,
	model: TripoModel | undefined,
	output: Json | undefined,
): OutputFile[] {
	const files: OutputFile[] = [];
	const named = new Set<string>();
	for (const spec of catalogue.outputs) {
		if (named.has(spec.name)) continue;
		const value = output?.[spec.key];
		const links = (spec.list ? (Array.isArray(value) ? value : []) : [value]).filter(
			(url): url is string => typeof url === "string" && url !== "",
		);
		if (links.length === 0) continue;
		named.add(spec.name);
		const role = spec.role === "model" ? (model?.fileRole ?? "model") : spec.role;
		links.forEach((url, index) => {
			files.push(
				outputFile(catalogue, links.length === 1 ? spec.name : `${spec.name}-${index + 1}`, url, role, spec.role),
			);
		});
	}
	return files;
}

interface JobRef {
	readonly task: string;
	readonly model: string;
	/** What the quote said, for a result whose task reports no credits. */
	readonly usd: number;
}

function parseRef(ref: string): JobRef {
	let parsed: unknown;
	try {
		parsed = JSON.parse(ref);
	} catch {
		parsed = undefined;
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.task !== "string" ||
		typeof parsed.model !== "string" ||
		typeof parsed.usd !== "number"
	) {
		throw new Error("not a gen-tripo job reference");
	}
	return { task: parsed.task, model: parsed.model, usd: parsed.usd };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

function apiError(status: number, payload: unknown, text: string): Error {
	if (isRecord(payload) && typeof payload.message === "string") {
		const code = typeof payload.code === "number" ? payload.code : status;
		const hint =
			typeof payload.suggestion === "string" && payload.suggestion !== "" ? ` - ${payload.suggestion}` : "";
		return new Error(`Tripo ${code}: ${payload.message}${hint}`);
	}
	return new Error(`Tripo HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}`);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal.aborted) {
		reject(signal.reason);
		return promise;
	}
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal.reason);
	};
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function retryWait(response: Response, attempt: number): number {
	const seconds = Number(response.headers.get("retry-after"));
	const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** (attempt - 1);
	return Math.min(wait, MAX_RETRY_WAIT_MS);
}

export function createTripoProvider(options: TripoProviderOptions = {}): GenerationProvider {
	const apiKey = options.apiKey ?? (() => readConnectKey());
	const doFetch = options.fetch ?? fetch;
	const sleep = options.sleep ?? pause;
	let loaded: Promise<TripoCatalogue> | undefined;
	const catalogue = (): Promise<TripoCatalogue> => {
		loaded ??= options.catalogue ? Promise.resolve(options.catalogue) : loadCatalogue();
		return loaded;
	};

	/** One authenticated call; resolves with the envelope's `data`. `billed`
	 *  marks a task-creating POST: a failure after it may have reached Tripo is
	 *  reported as such and never retried. */
	async function call(
		c: TripoCatalogue,
		init: {
			method: "GET" | "POST";
			path: string;
			signal: AbortSignal;
			json?: unknown;
			form?: FormData;
			billed?: boolean;
			timeoutMs?: number;
		},
	): Promise<unknown> {
		const key = await apiKey();
		const deadline = AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS)]);
		const headers: Record<string, string> = { authorization: `Bearer ${key}` };
		if (init.json !== undefined) headers["content-type"] = "application/json";
		for (let attempt = 1; ; attempt++) {
			let response: Response;
			try {
				response = await doFetch(`${c.api.baseUrl}${init.path}`, {
					method: init.method,
					headers,
					body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
					signal: deadline,
				});
			} catch (error) {
				if (init.signal.aborted) throw error;
				const maybeLanded = init.billed
					? " - the request may have reached Tripo; check your Tripo task list before resubmitting, or you may pay twice"
					: "";
				throw new Error(`Tripo ${init.method} ${init.path} failed: ${reason(error)}${maybeLanded}`);
			}
			const text = await response.text();
			if ((response.status === 429 || response.status === 503) && attempt < MAX_ATTEMPTS) {
				try {
					await sleep(retryWait(response, attempt), deadline);
				} catch (error) {
					if (init.signal.aborted) throw error;
					throw new Error(`Tripo ${init.method} ${init.path} was still answering ${response.status} when the call ran out of time`);
				}
				continue;
			}
			let payload: unknown;
			try {
				payload = JSON.parse(text);
			} catch {
				payload = undefined;
			}
			if (!response.ok || (isRecord(payload) && payload.code !== 0)) throw apiError(response.status, payload, text);
			if (!isRecord(payload) || !("data" in payload))
				throw new Error(`Tripo ${init.method} ${init.path} answered without data`);
			return payload.data;
		}
	}

	async function uploadFile(c: TripoCatalogue, file: UploadRef, signal: AbortSignal): Promise<string> {
		const extension = extname(file.path).slice(1).toLowerCase();
		const blob = await openAsBlob(file.path, {
			type: file.kind === "image" ? (IMAGE_MIME[extension] ?? "") : "application/octet-stream",
		});
		const form = new FormData();
		form.append("file", blob, basename(file.path));
		const data = await call(c, { method: "POST", path: c.upload.endpoint, form, signal, timeoutMs: UPLOAD_TIMEOUT_MS });
		const token = isRecord(data) ? data.file_token : undefined;
		if (typeof token !== "string" || token === "")
			throw new Error(`Tripo accepted ${basename(file.path)} but returned no file token`);
		return token;
	}

	async function taskOf(c: TripoCatalogue, id: string, signal: AbortSignal): Promise<TripoTask> {
		const data = await call(c, { method: "GET", path: `/tasks/${encodeURIComponent(id)}`, signal });
		if (!isRecord(data) || typeof data.status !== "string")
			throw new Error(`Tripo returned a malformed task for ${id}`);
		return data as unknown as TripoTask;
	}

	/** Output URLs are signed CDN links: fetched without the API key. */
	async function download(file: OutputFile, dest: string, signal: AbortSignal): Promise<void> {
		const response = await doFetch(file.url, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
		});
		if (!response.ok || !response.body)
			throw new Error(`downloading Tripo's ${file.name} output failed: HTTP ${response.status}`);
		const partial = `${dest}.part`;
		try {
			await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), createWriteStream(partial), {
				signal,
			});
			await rename(partial, dest);
		} catch (error) {
			await rm(partial, { force: true });
			throw error;
		}
	}

	return {
		id: "tripo",

		async describe(): Promise<GenerationCatalogue> {
			const c = await catalogue();
			const models = describeModels(c);
			try {
				await apiKey();
			} catch (error) {
				return { ready: false, reason: reason(error), models };
			}
			return { ready: true, models };
		},

		async quote(request, { signal }): Promise<GenerationQuote> {
			const c = await catalogue();
			const model = modelOf(c, request.model);
			const { price, uploads } = planRequest(c, model, request);
			await checkLocalFiles(c, uploads);
			// The balance is advice for the caller, not part of the price: a failure
			// to read it is said in the basis, and the submit will fail loudly on its own.
			let balance: string;
			try {
				const data = await call(c, { method: "GET", path: "/account/balance", signal, timeoutMs: BALANCE_TIMEOUT_MS });
				const credits = isRecord(data) ? data.balance : undefined;
				if (typeof credits !== "number") throw new Error("no balance in the answer");
				balance = `account balance ${credits} credits${credits < price.credits ? " - NOT ENOUGH, top up at https://platform.tripo3d.ai" : ""}`;
			} catch (error) {
				if (signal.aborted) throw error;
				balance = `account balance unavailable (${reason(error)})`;
			}
			return { usd: price.usd, basis: `${price.basis}; ${balance}` };
		},

		async submit(request, { signal }): Promise<GenerationSubmitted> {
			const c = await catalogue();
			const model = modelOf(c, request.model);
			const { uploads } = planRequest(c, model, request);
			await checkLocalFiles(c, uploads);
			const tokens = new Map<string, string>();
			await Promise.all(uploads.map(async file => tokens.set(file.path, await uploadFile(c, file, signal))));
			const built = buildTaskRequest(c, model, request, file => tokens.get(file.path) ?? "");
			const data = await call(c, { method: "POST", path: built.endpoint, json: built.body, signal, billed: true });
			const task = isRecord(data) ? data.task_id : undefined;
			if (typeof task !== "string" || task === "")
				throw new Error(
					"Tripo accepted the task but returned no task id - check your Tripo task list before resubmitting",
				);
			const ref: JobRef = { task, model: model.id, usd: built.usd };
			return { ref: JSON.stringify(ref) };
		},

		async status(ref, { signal }): Promise<GenerationStatus> {
			const c = await catalogue();
			return taskStatus(await taskOf(c, parseRef(ref).task, signal));
		},

		async fetch(ref, { signal, outDir }): Promise<GenerationResult> {
			const c = await catalogue();
			const job = parseRef(ref);
			// A job outliving a pack update that retired its model is still fetchable.
			const model = c.models.find(candidate => candidate.id === job.model);
			const task = await taskOf(c, job.task, signal);
			if (task.status !== "success") throw new Error(`Tripo task ${job.task} is ${task.status}, not finished`);
			const outputs = collectOutputs(c, model, task.output);
			if (outputs.length === 0)
				throw new Error(`Tripo task ${job.task} succeeded but listed no downloadable output`);
			await mkdir(outDir, { recursive: true });
			const files = await Promise.all(
				outputs.map(async (output): Promise<GenerationFile> => {
					const path = join(outDir, `${output.name}.${output.format}`);
					await download(output, path, signal);
					return { path, role: output.role, format: output.format, label: output.name };
				}),
			);
			const credits = creditsOf(task);
			const started = Date.parse(task.created_at ?? "");
			const finished = Date.parse(task.completed_at ?? "");
			return {
				files,
				costUsd: credits === undefined ? job.usd : creditsToUsd(c, credits),
				licence: c.licence,
				handle: job.task,
				meta: {
					vendor: "tripo",
					apiVersion: c.apiVersion,
					taskId: job.task,
					taskType: task.type ?? null,
					model: job.model,
					modelVersion: model?.task.version ?? null,
					endpoint: model?.task.endpoint ?? null,
					credits: credits ?? null,
					costSource: credits === undefined ? "quote" : "task",
					seconds: Number.isFinite(started) && Number.isFinite(finished) ? (finished - started) / 1000 : null,
					createdAt: task.created_at ?? null,
					completedAt: task.completed_at ?? null,
					...(task.input ? { vendorInput: task.input } : {}),
				},
			};
		},
	};
}

/** The factory the engine's provider lane imports (doc 75 §2). */
export function createGenerationProvider(): GenerationProvider {
	return createTripoProvider();
}
