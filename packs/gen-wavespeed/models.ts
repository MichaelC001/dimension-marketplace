// The pack's data file, `models.json`: which WaveSpeed models Dimension offers and
// the facts WaveSpeed's own APIs do not expose (see the `$comment` in models.json).
//
// The file is hand-edited, so it is read from disk when a catalogue is built —
// an edit takes effect without a restart — and checked field by field. A typo
// would otherwise surface as a vague failure deep inside a job.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerationInputKind, GenerationLicence, GenerationModality } from "@dimension/sdk/provider";
import { isRecord } from "./guards.ts";

const MODALITIES: readonly GenerationModality[] = ["image", "model3d", "parts", "rig", "retopo", "texture"];
const INPUT_KINDS: readonly GenerationInputKind[] = ["text", "image", "model3d"];

/** The image types this pack will send off the machine. `models.json` may narrow this
 *  per model (`imageFormats`) and can never widen it. */
export const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"];

/** How a request's images reach the model's fields. */
export type ImageFields =
	/** One image, one field. */
	| { readonly field: string }
	/** An array field of `min`..`max` image URLs. */
	| { readonly arrayField: string; readonly min: number; readonly max: number }
	/** One named field per view, in the order the caller lists images. */
	| { readonly fields: readonly string[] };

export interface ModelInputs {
	readonly images?: ImageFields;
	readonly prompt?: { readonly field: string; readonly required?: boolean };
	readonly negativePrompt?: string;
	/** The model field the request's `seed` goes to. */
	readonly seed?: string;
}

export interface ModelPricing {
	/** One sentence, in WaveSpeed's own terms, of how the price is made up. */
	readonly basis: string;
	/** Where `basis` was read. */
	readonly source: string;
}

export interface ModelEntry {
	/** WaveSpeed's model id, e.g. `tripo3d/p2/image-to-3d`. Also this pack's model id. */
	readonly modelId: string;
	readonly label: string;
	readonly produces: GenerationModality;
	readonly accepts: readonly GenerationInputKind[];
	readonly inputs: ModelInputs;
	/** Narrows the image types for a model whose docs name fewer than the pack's list. */
	readonly imageFormats?: readonly string[];
	/** A reference-image ceiling stricter than the pack's own, where WaveSpeed documents one. */
	readonly maxImageBytes?: number;
	readonly pricing: ModelPricing;
	readonly licence: GenerationLicence;
	readonly features?: readonly string[];
}

export interface PackData {
	/** How long WaveSpeed keeps an uploaded file; a cached upload is reused for half of it. */
	readonly uploadRetainSeconds: number;
	/** What stands in for a reference image when a price is asked for before any upload. */
	readonly pricingProbeImage: string;
	readonly models: readonly ModelEntry[];
}

const MODELS_PATH = join(dirname(fileURLToPath(import.meta.url)), "models.json");
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

function fail(where: string, problem: string): never {
	throw new Error(`gen-wavespeed models.json: ${where} ${problem}`);
}

function text(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim() === "") fail(where, "must be a non-empty string");
	return value;
}

function number(value: unknown, where: string, min: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min) fail(where, `must be a number >= ${min}`);
	return value;
}

function list<T>(value: unknown, where: string, each: (item: unknown, at: string) => T): T[] {
	if (!Array.isArray(value)) fail(where, "must be a list");
	return value.map((item, index) => each(item, `${where}[${index}]`));
}

function httpsUrl(value: unknown, where: string): string {
	const url = text(value, where);
	try {
		if (new URL(url).protocol === "https:") return url;
	} catch {
		// falls through to the failure below
	}
	return fail(where, "must be an https URL");
}

function parseImages(value: unknown, where: string): ImageFields {
	if (!isRecord(value)) fail(where, "must be an object");
	if (typeof value.field === "string") return { field: value.field };
	if (typeof value.arrayField === "string") {
		const min = value.min === undefined ? 1 : number(value.min, `${where}.min`, 1);
		const max = number(value.max, `${where}.max`, 1);
		if (min > max) fail(where, "has min above max");
		return { arrayField: value.arrayField, min, max };
	}
	if (Array.isArray(value.fields) && value.fields.length > 0) {
		return { fields: list(value.fields, `${where}.fields`, text) };
	}
	return fail(where, "needs `field`, `arrayField` + `max`, or `fields`");
}

function parseInputs(value: unknown, where: string): ModelInputs {
	if (!isRecord(value)) fail(where, "must be an object");
	const inputs: {
		-readonly [K in keyof ModelInputs]: ModelInputs[K];
	} = {};
	if (value.images !== undefined) inputs.images = parseImages(value.images, `${where}.images`);
	if (value.prompt !== undefined) {
		if (!isRecord(value.prompt)) fail(`${where}.prompt`, "must be an object");
		inputs.prompt = {
			field: text(value.prompt.field, `${where}.prompt.field`),
			...(value.prompt.required === true && { required: true }),
		};
	}
	if (value.negativePrompt !== undefined) inputs.negativePrompt = text(value.negativePrompt, `${where}.negativePrompt`);
	if (value.seed !== undefined) inputs.seed = text(value.seed, `${where}.seed`);
	return inputs;
}

function parseLicence(value: unknown, where: string): GenerationLicence {
	if (!isRecord(value)) fail(where, "must be an object");
	const commercialUse = value.commercialUse;
	if (commercialUse !== "yes" && commercialUse !== "no" && commercialUse !== "unknown") {
		fail(`${where}.commercialUse`, 'must be "yes", "no" or "unknown"');
	}
	return {
		id: text(value.id, `${where}.id`),
		commercialUse,
		...(value.territoryExcludes !== undefined && {
			territoryExcludes: list(value.territoryExcludes, `${where}.territoryExcludes`, text),
		}),
		...(value.prototypeOnly === true && { prototypeOnly: true }),
		...(value.url !== undefined && { url: text(value.url, `${where}.url`) }),
		...(value.note !== undefined && { note: text(value.note, `${where}.note`) }),
	};
}

function parseModel(value: unknown, where: string): ModelEntry {
	if (!isRecord(value)) fail(where, "must be an object");
	const produces = value.produces;
	if (typeof produces !== "string" || !(MODALITIES as readonly string[]).includes(produces)) {
		fail(`${where}.produces`, `must be one of ${MODALITIES.join(", ")}`);
	}
	const modelId = text(value.modelId, `${where}.modelId`);
	if (!MODEL_ID.test(modelId) || modelId.split("/").some(part => part === "." || part === "..")) {
		fail(`${where}.modelId`, "must look like owner/model/task");
	}
	const accepts = list(value.accepts, `${where}.accepts`, (item, at) =>
		typeof item === "string" && (INPUT_KINDS as readonly string[]).includes(item)
			? (item as GenerationInputKind)
			: fail(at, `must be one of ${INPUT_KINDS.join(", ")}`),
	);
	const inputs = parseInputs(value.inputs, `${where}.inputs`);
	if (accepts.length === 0) fail(`${where}.accepts`, "needs at least one input kind");
	if (accepts.includes("model3d")) fail(`${where}.accepts`, "cannot list model3d: no WaveSpeed model this pack offers takes a 3D file");
	if (accepts.includes("image") !== (inputs.images !== undefined)) {
		fail(`${where}.accepts`, 'lists "image" exactly when `inputs.images` is given');
	}
	if (accepts.includes("text") && inputs.prompt === undefined) fail(`${where}.accepts`, 'lists "text" but `inputs.prompt` is missing');
	const imageFormats =
		value.imageFormats === undefined
			? undefined
			: list(value.imageFormats, `${where}.imageFormats`, (item, at) => {
					const format = text(item, at).toLowerCase();
					return IMAGE_EXTENSIONS.includes(format) ? format : fail(at, `must be one of ${IMAGE_EXTENSIONS.join(", ")}`);
				});
	if (imageFormats?.length === 0) fail(`${where}.imageFormats`, "needs at least one format");
	const pricing = value.pricing;
	if (!isRecord(pricing)) fail(`${where}.pricing`, "must be an object");
	return {
		modelId,
		label: text(value.label, `${where}.label`),
		produces: produces as GenerationModality,
		accepts,
		inputs,
		...(imageFormats !== undefined && { imageFormats }),
		...(value.maxImageBytes !== undefined && { maxImageBytes: number(value.maxImageBytes, `${where}.maxImageBytes`, 1) }),
		pricing: { basis: text(pricing.basis, `${where}.pricing.basis`), source: httpsUrl(pricing.source, `${where}.pricing.source`) },
		licence: parseLicence(value.licence, `${where}.licence`),
		...(value.features !== undefined && { features: list(value.features, `${where}.features`, text) }),
	};
}

/** Parse and check the contents of `models.json`. */
export function parsePackData(raw: unknown): PackData {
	if (!isRecord(raw)) fail("the file", "must hold a JSON object");
	const uploads = isRecord(raw.uploads) ? raw.uploads : fail("uploads", "must be an object");
	const models = list(raw.models, "models", parseModel);
	const seen = new Set<string>();
	for (const model of models) {
		if (seen.has(model.modelId)) fail("models", `lists "${model.modelId}" twice`);
		seen.add(model.modelId);
	}
	return {
		uploadRetainSeconds: number(uploads.retainSeconds, "uploads.retainSeconds", 60),
		pricingProbeImage: httpsUrl(raw.pricingProbeImage, "pricingProbeImage"),
		models,
	};
}

/** Read `models.json`. `path` is the test seam. */
export async function loadPackData(path: string = MODELS_PATH): Promise<PackData> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new Error(`gen-wavespeed cannot read its model list at ${path}`);
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch (error) {
		throw new Error(`gen-wavespeed models.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parsePackData(parsedJson);
}
