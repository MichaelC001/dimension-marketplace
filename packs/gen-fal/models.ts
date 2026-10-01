// The pack's data file, `models.json`: which fal endpoints Dimension offers and
// the facts fal's own APIs do not expose (see the `$comment` in models.json).
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
const ROLES = ["model", "texture", "image", "preview", "rig", "part", "other"] as const;
export type FileRole = (typeof ROLES)[number];

export type Scalar = string | number | boolean;

/** Operators a pricing condition may combine; all that are given must hold. */
export interface ConditionOperators {
	/** True when the caller passed the option, whatever its value. */
	readonly present?: boolean;
	readonly not?: Scalar | Scalar[];
	readonly gte?: number;
}

/** One condition of a pricing rule, against an option's effective value. A bare
 *  scalar must equal it; a list matches any member. */
export type Condition = Scalar | Scalar[] | ConditionOperators;

/** `when` is AND over its keys. A key is an option name (dotted for nested
 *  options) or `$images`, the number of reference images. */
export interface PricingRule {
	readonly when: Readonly<Record<string, Condition>>;
	/** Replace the running unit count. */
	readonly set?: number;
	/** Add to the running unit count. */
	readonly add?: number;
}

export interface ModelPricing {
	/** fal's billing unit for the endpoint, e.g. "units", "generations". */
	readonly unit: string;
	/** USD per unit when `base` and `rules` were derived. Live pricing replaces it. */
	readonly unitPrice: number;
	/** Units a request takes at default options. */
	readonly base: number;
	readonly rules: readonly PricingRule[];
	/** One sentence, in fal's own terms, of how the price is made up. */
	readonly basis: string;
	readonly source: string;
}

/** How a request's images reach the endpoint's fields. */
export type ImageFields =
	/** One image, one field. */
	| { readonly field: string }
	/** An array field of up to `max` image URLs. */
	| { readonly arrayField: string; readonly max: number }
	/** One named field per view, in the order the caller lists images. */
	| { readonly fields: readonly string[] };

export interface ModelInputs {
	readonly images?: ImageFields;
	readonly prompt?: { readonly field: string; readonly required?: boolean };
	readonly negativePrompt?: string;
	/** The 3D file an endpoint works on, uploaded from `input.model` or taken
	 *  from `input.from.handle`. */
	readonly model?: {
		readonly field: string;
		/** Extensions the endpoint accepts, lower case, no dot. */
		readonly formats: readonly string[];
		/** A field fal wants the file's extension in, besides its URL. */
		readonly typeField?: string;
	};
	/** The endpoint field the request's `seed` goes to. */
	readonly seed?: string;
}

export interface RoleRule {
	readonly path: string;
	readonly role: FileRole;
}

export interface ModelEntry {
	/** fal's endpoint id, e.g. `fal-ai/pixal3d`. Also this pack's model id. */
	readonly endpoint: string;
	readonly label: string;
	readonly produces: GenerationModality;
	readonly accepts: readonly GenerationInputKind[];
	readonly maxImages?: number;
	readonly inputs: ModelInputs;
	readonly pricing: ModelPricing;
	readonly licence: GenerationLicence;
	readonly features?: readonly string[];
	readonly outputRoles?: readonly RoleRule[];
}

export interface PackData {
	readonly uploadExpireSeconds: number;
	readonly outputRoles: readonly RoleRule[];
	readonly models: readonly ModelEntry[];
}

export const MODELS_PATH = join(dirname(fileURLToPath(import.meta.url)), "models.json");

function fail(where: string, problem: string): never {
	throw new Error(`gen-fal models.json: ${where} ${problem}`);
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

function isScalar(value: unknown): value is Scalar {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function parseCondition(value: unknown, where: string): Condition {
	if (isScalar(value)) return value;
	if (Array.isArray(value)) {
		return list(value, where, (item, at) => (isScalar(item) ? item : fail(at, "must be a string, number or boolean")));
	}
	if (!isRecord(value)) fail(where, "must be a scalar, a list of scalars or an operator object");
	for (const key of Object.keys(value)) {
		if (key !== "present" && key !== "not" && key !== "gte") fail(where, `has unknown operator "${key}"`);
	}
	if (value.present !== undefined && typeof value.present !== "boolean") fail(`${where}.present`, "must be a boolean");
	if (value.gte !== undefined) number(value.gte, `${where}.gte`, Number.NEGATIVE_INFINITY);
	const not = value.not;
	if (not !== undefined && !isScalar(not) && !(Array.isArray(not) && not.every(isScalar))) {
		fail(`${where}.not`, "must be a scalar or a list of scalars");
	}
	return value as Condition;
}

function parseRule(value: unknown, where: string): PricingRule {
	if (!isRecord(value) || !isRecord(value.when)) fail(where, "needs a `when` object");
	const when: Record<string, Condition> = {};
	for (const [key, condition] of Object.entries(value.when)) when[key] = parseCondition(condition, `${where}.when.${key}`);
	if ((value.set === undefined) === (value.add === undefined)) fail(where, "needs exactly one of `set` and `add`");
	return {
		when,
		...(value.set !== undefined && { set: number(value.set, `${where}.set`, 0) }),
		...(value.add !== undefined && { add: number(value.add, `${where}.add`, 0) }),
	};
}

function parsePricing(value: unknown, where: string): ModelPricing {
	if (!isRecord(value)) fail(where, "must be an object");
	return {
		unit: text(value.unit, `${where}.unit`),
		unitPrice: number(value.unitPrice, `${where}.unitPrice`, Number.MIN_VALUE),
		base: number(value.base, `${where}.base`, 0),
		rules: list(value.rules, `${where}.rules`, parseRule),
		basis: text(value.basis, `${where}.basis`),
		source: text(value.source, `${where}.source`),
	};
}

function parseImages(value: unknown, where: string): ImageFields {
	if (!isRecord(value)) fail(where, "must be an object");
	if (typeof value.field === "string") return { field: value.field };
	if (typeof value.arrayField === "string") {
		return { arrayField: value.arrayField, max: number(value.max, `${where}.max`, 1) };
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
	if (value.model !== undefined) {
		if (!isRecord(value.model)) fail(`${where}.model`, "must be an object");
		inputs.model = {
			field: text(value.model.field, `${where}.model.field`),
			formats: list(value.model.formats, `${where}.model.formats`, text).map(format => format.toLowerCase()),
			...(value.model.typeField !== undefined && { typeField: text(value.model.typeField, `${where}.model.typeField`) }),
		};
		if (inputs.model.formats.length === 0) fail(`${where}.model.formats`, "needs at least one format");
	}
	return inputs;
}

function parseRoleRule(value: unknown, where: string): RoleRule {
	if (!isRecord(value)) fail(where, "must be an object");
	const path = text(value.path, `${where}.path`);
	try {
		new RegExp(path, "i");
	} catch {
		fail(`${where}.path`, "is not a valid regular expression");
	}
	const role = value.role;
	if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
		return fail(`${where}.role`, `must be one of ${ROLES.join(", ")}`);
	}
	return { path, role: role as FileRole };
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
	return {
		endpoint: text(value.endpoint, `${where}.endpoint`),
		label: text(value.label, `${where}.label`),
		produces: produces as GenerationModality,
		accepts: list(value.accepts, `${where}.accepts`, (item, at) =>
			typeof item === "string" && (INPUT_KINDS as readonly string[]).includes(item)
				? (item as GenerationInputKind)
				: fail(at, `must be one of ${INPUT_KINDS.join(", ")}`),
		),
		...(value.maxImages !== undefined && { maxImages: number(value.maxImages, `${where}.maxImages`, 1) }),
		inputs: parseInputs(value.inputs, `${where}.inputs`),
		pricing: parsePricing(value.pricing, `${where}.pricing`),
		licence: parseLicence(value.licence, `${where}.licence`),
		...(value.features !== undefined && { features: list(value.features, `${where}.features`, text) }),
		...(value.outputRoles !== undefined && { outputRoles: list(value.outputRoles, `${where}.outputRoles`, parseRoleRule) }),
	};
}

/** Parse and check the contents of `models.json`. */
export function parsePackData(raw: unknown): PackData {
	if (!isRecord(raw)) fail("the file", "must hold a JSON object");
	const uploads = isRecord(raw.uploads) ? raw.uploads : fail("uploads", "must be an object");
	const models = list(raw.models, "models", parseModel);
	const seen = new Set<string>();
	for (const model of models) {
		if (seen.has(model.endpoint)) fail("models", `lists "${model.endpoint}" twice`);
		seen.add(model.endpoint);
	}
	return {
		uploadExpireSeconds: number(uploads.expireSeconds, "uploads.expireSeconds", 60),
		outputRoles: list(raw.outputRoles, "outputRoles", parseRoleRule),
		models,
	};
}

/** Read `models.json`. `path` is the test seam. */
export async function loadPackData(path: string = MODELS_PATH): Promise<PackData> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new Error(`gen-fal cannot read its model list at ${path}`);
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch (error) {
		throw new Error(`gen-fal models.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parsePackData(parsedJson);
}
