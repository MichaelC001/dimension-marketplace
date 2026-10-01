// An endpoint's option schema, built from fal's own OpenAPI, and the validation
// of a request's options against it.
//
// fal publishes each endpoint's real input schema (`GET api.fal.ai/v1/models
// ?endpoint_id=…&expand=openapi-3.0`). An agent picks options from that schema,
// so it is forwarded as JSON Schema with fal's `$ref`s inlined and the keys fal
// adds for its own UI dropped. The fields Dimension fills itself — images,
// prompt, seed, the 3D input file — are removed: every field of the endpoint is
// reachable exactly once, either as an option or through the request's inputs.

import { isRecord } from "./guards.ts";

export type OptionsSchema = {
	readonly type: "object";
	readonly additionalProperties: false;
	readonly properties: Readonly<Record<string, unknown>>;
	readonly required?: readonly string[];
};

/** Keys fal puts in its schemas for its UI and tooling; they tell a caller nothing. */
const NOISE: Readonly<Record<string, true>> = {
	title: true,
	examples: true,
	example: true,
	"x-fal-order-properties": true,
	_fal_ui_field: true,
	ui: true,
	max_pixels: true,
	max_file_size: true,
};

/** A `$ref` chain deeper than this is a cycle: fal's schemas are shallow. */
const MAX_REF_DEPTH = 12;

function resolveRef(root: unknown, ref: string): unknown {
	if (!ref.startsWith("#/")) throw new Error(`unsupported schema reference "${ref}"`);
	let node: unknown = root;
	for (const part of ref.slice(2).split("/")) {
		node = isRecord(node) ? node[part] : undefined;
	}
	if (node === undefined) throw new Error(`schema reference "${ref}" does not resolve`);
	return node;
}

/** Copy `schema` with `$ref`s inlined and noise dropped. Walks schema positions
 *  only, so a property that happens to be called `title` survives. */
function cleanSchema(root: unknown, schema: unknown, depth = 0): unknown {
	if (!isRecord(schema)) return schema;
	if (depth > MAX_REF_DEPTH) throw new Error("schema references nest too deeply");
	const { $ref, ...own } = schema;
	const base = typeof $ref === "string" ? cleanSchema(root, resolveRef(root, $ref), depth + 1) : {};
	const out: Record<string, unknown> = isRecord(base) ? { ...base } : {};
	for (const [key, value] of Object.entries(own)) {
		if (Object.hasOwn(NOISE, key)) continue;
		if (key === "properties" && isRecord(value)) {
			out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, cleanSchema(root, child, depth)]));
		} else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
			out[key] = value.map(child => cleanSchema(root, child, depth));
		} else if (key === "items" || key === "additionalProperties") {
			out[key] = cleanSchema(root, value, depth);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** The input schema of an endpoint's queue submit operation. fal names paths
 *  after the app behind an endpoint, not the endpoint id, so the operation is
 *  found by shape: the one POST that is not a per-request path. */
function submitInputSchema(openapi: unknown): Record<string, unknown> {
	const paths = isRecord(openapi) ? openapi.paths : undefined;
	if (isRecord(paths)) {
		for (const [path, item] of Object.entries(paths)) {
			if (path.includes("{request_id}") || !isRecord(item) || !isRecord(item.post)) continue;
			const body = isRecord(item.post.requestBody) ? item.post.requestBody : undefined;
			const content = isRecord(body?.content) ? body.content["application/json"] : undefined;
			const schema = isRecord(content) ? cleanSchema(openapi, content.schema) : undefined;
			if (isRecord(schema) && isRecord(schema.properties)) return schema;
		}
	}
	throw new Error("fal's OpenAPI for the endpoint has no queue submit operation with an input schema");
}

/** What an endpoint's catalogue entry yields for one model. */
export interface EndpointSchema {
	readonly options: OptionsSchema;
	/** The names of fields of fal's input schema among `claimed` that it no longer has. */
	readonly missing: readonly string[];
}

/** Build the options schema of an endpoint: fal's input schema minus the
 *  `claimed` fields Dimension fills from the request's inputs. */
export function buildOptionsSchema(openapi: unknown, claimed: readonly string[]): EndpointSchema {
	const input = submitInputSchema(openapi);
	const all = input.properties as Record<string, unknown>;
	const properties = Object.fromEntries(Object.entries(all).filter(([name]) => !claimed.includes(name)));
	const required = Array.isArray(input.required)
		? input.required.filter((name): name is string => typeof name === "string" && !claimed.includes(name))
		: [];
	return {
		options: {
			type: "object",
			additionalProperties: false,
			properties,
			...(required.length > 0 && { required }),
		},
		missing: claimed.filter(name => !Object.hasOwn(all, name)),
	};
}

/** The default each option has when the caller omits it. */
export function schemaDefaults(schema: OptionsSchema): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};
	for (const [name, property] of Object.entries(schema.properties)) {
		if (isRecord(property) && property.default !== undefined) defaults[name] = property.default;
	}
	return defaults;
}

function matchesType(type: unknown, value: unknown): boolean {
	if (Array.isArray(type)) return type.some(each => matchesType(each, value));
	switch (type) {
		case "string":
			return typeof value === "string";
		case "integer":
			return Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		default:
			return true;
	}
}

function checkNumber(schema: Record<string, unknown>, value: number, at: string, errors: string[]): void {
	if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
	if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
	if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
		errors.push(`${at} must be > ${schema.exclusiveMinimum}`);
	}
	if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
		errors.push(`${at} must be < ${schema.exclusiveMaximum}`);
	}
}

function check(schema: unknown, value: unknown, at: string, errors: string[]): void {
	if (!isRecord(schema)) return;
	if (Array.isArray(schema.anyOf)) {
		const attempts = schema.anyOf.map(branch => {
			const found: string[] = [];
			check(branch, value, at, found);
			return { branch, found };
		});
		if (attempts.some(attempt => attempt.found.length === 0)) return;
		// The branch worth reporting is the first that is not just `null`.
		const informative = attempts.find(attempt => !(isRecord(attempt.branch) && attempt.branch.type === "null"));
		errors.push(...(informative ?? attempts[0]).found);
		return;
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		errors.push(`${at} must be one of ${schema.enum.map(member => JSON.stringify(member)).join(", ")}`);
		return;
	}
	if (schema.type !== undefined && !matchesType(schema.type, value)) {
		errors.push(`${at} must be of type ${[schema.type].flat().join(" or ")}`);
		return;
	}
	if (typeof value === "number") checkNumber(schema, value, at, errors);
	if (typeof value === "string") {
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
			errors.push(`${at} must be at most ${schema.maxLength} characters`);
		}
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			errors.push(`${at} must be at least ${schema.minLength} characters`);
		}
	}
	if (Array.isArray(value)) {
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			errors.push(`${at} must have at most ${schema.maxItems} items`);
		}
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			errors.push(`${at} must have at least ${schema.minItems} items`);
		}
		value.forEach((item, index) => {
			check(schema.items, item, `${at}[${index}]`, errors);
		});
	}
	if (isRecord(value)) {
		const properties = isRecord(schema.properties) ? schema.properties : {};
		for (const [name, member] of Object.entries(value)) {
			if (Object.hasOwn(properties, name)) check(properties[name], member, `${at}.${name}`, errors);
			else if (schema.additionalProperties === false) errors.push(`${at}.${name} is not an option of this model`);
		}
		for (const name of Array.isArray(schema.required) ? schema.required : []) {
			if (!Object.hasOwn(value, name)) errors.push(`${at}.${name} is required`);
		}
	}
}

/** Everything wrong with `options` against the model's schema; empty when valid. */
export function validateOptions(schema: OptionsSchema, options: Readonly<Record<string, unknown>>): string[] {
	const errors: string[] = [];
	check(schema, options, "options", errors);
	return errors;
}
