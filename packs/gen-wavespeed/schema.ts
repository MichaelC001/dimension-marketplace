// A model's option schema, taken from WaveSpeed's own catalogue, and the validation
// of a request's options against it.
//
// `GET /api/v3/models` publishes each model's real request schema as JSON Schema
// (`api_schema.api_schemas[].request_schema`). An agent picks options from that
// schema, so it is forwarded as published, minus the keys WaveSpeed adds for its own
// UI (`x-*`, `title`). The fields Dimension fills itself — images, prompt, seed —
// are removed: every field of the model is reachable exactly once, either as an
// option or through the request's inputs.

import { isRecord } from "./guards.ts";

export type OptionsSchema = {
	readonly type: "object";
	readonly additionalProperties: false;
	readonly properties: Readonly<Record<string, unknown>>;
	readonly required?: readonly string[];
};

/** Keys WaveSpeed puts in its schemas for its UI; `x-hidden` marks fields it merely
 *  keeps out of its form (Tripo's seeds), which are still valid to send. */
function isNoise(key: string): boolean {
	return key === "title" || key.startsWith("x-");
}

/** Copy of a schema node with the UI noise dropped. Walks schema positions only, so
 *  a property that happens to be called `title` survives. */
function cleanSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (isNoise(key)) continue;
		if (key === "properties" && isRecord(value)) {
			out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, cleanSchema(child)]));
		} else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
			out[key] = value.map(cleanSchema);
		} else if (key === "items" || key === "additionalProperties") {
			out[key] = cleanSchema(value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** What a catalogue entry yields for one model. */
export interface EndpointSchema {
	readonly options: OptionsSchema;
	/** The `claimed` fields the model's request schema no longer has. */
	readonly missing: readonly string[];
}

/** Build the options schema from a catalogue entry's `request_schema`: the model's
 *  properties minus the `claimed` fields Dimension fills from the request's inputs. */
export function buildOptionsSchema(requestSchema: unknown, claimed: readonly string[]): EndpointSchema {
	if (!isRecord(requestSchema) || !isRecord(requestSchema.properties)) {
		throw new Error("WaveSpeed's catalogue entry has no request schema");
	}
	const all = requestSchema.properties;
	const properties = Object.fromEntries(
		Object.entries(all)
			.filter(([name]) => !claimed.includes(name))
			.map(([name, property]) => [name, cleanSchema(property)]),
	);
	const required = Array.isArray(requestSchema.required)
		? requestSchema.required.filter((name): name is string => typeof name === "string" && !claimed.includes(name))
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
		errors.push(...(informative ?? attempts[0])?.found ?? []);
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

/** Everything wrong with `options` against the model's schema; empty when valid.
 *  WaveSpeed's pricing API accepts keys a model does not have and prices them as if
 *  they were absent, so this is the only place an unknown option is caught. */
export function validateOptions(schema: OptionsSchema, options: Readonly<Record<string, unknown>>): string[] {
	const errors: string[] = [];
	check(schema, options, "options", errors);
	return errors;
}
