// A Dimension request, turned into the JSON body of a WaveSpeed model.
//
// Dimension's `GenerationInput` is the same for every provider: reference images
// by absolute path, a prompt. Each WaveSpeed model names those inputs differently
// (`image`, `images`, `image` + `back_image` + `left_image` + …), and models.json
// says how. Files go to WaveSpeed's storage first — the only form its models
// accept — and the body carries their URLs. The request and its local files are
// validated before the first upload so a bad request costs nothing.

import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { GenerationRequest } from "@dimension/sdk/provider";
import { IMAGE_EXTENSIONS, type ImageFields, type ModelEntry } from "./models.ts";
import { type OptionsSchema, validateOptions } from "./schema.ts";

/** Uploads a local file to WaveSpeed and returns the URL its models read it from. */
export type Upload = (path: string) => Promise<string>;

/** The pack's own ceiling, not WaveSpeed's (it allows 200 MB per upload). Everything
 *  uploaded is stored by WaveSpeed for a week, so a "reference image" this large is
 *  a wrong path, not an input. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** Most reference images one request may carry. */
export function imageCapacity(images: ImageFields): number {
	if ("field" in images) return 1;
	return "arrayField" in images ? images.max : images.fields.length;
}

function imageMinimum(images: ImageFields): number {
	return "arrayField" in images ? images.min : 1;
}

function extensionOf(path: string): string {
	return extname(path).slice(1).toLowerCase();
}

/** The names of the model fields a request fills from its inputs rather than its options. */
export function claimedFields(model: ModelEntry): string[] {
	const { images, prompt, negativePrompt, seed } = model.inputs;
	const claimed: string[] = [];
	if (images !== undefined) {
		if ("field" in images) claimed.push(images.field);
		else if ("arrayField" in images) claimed.push(images.arrayField);
		else claimed.push(...images.fields);
	}
	if (prompt !== undefined) claimed.push(prompt.field);
	if (negativePrompt !== undefined) claimed.push(negativePrompt);
	if (seed !== undefined) claimed.push(seed);
	return claimed;
}

/** Throw, naming every problem at once, when a request cannot be sent to this
 *  model. Touches neither the network nor the disk. */
export function checkRequest(model: ModelEntry, schema: OptionsSchema, request: GenerationRequest): void {
	const { input, options, seed } = request;
	const { inputs } = model;
	const problems: string[] = [];

	const images = input.images ?? [];
	if (inputs.images === undefined) {
		if (images.length > 0) problems.push("takes no reference images");
	} else if (images.length < imageMinimum(inputs.images)) {
		problems.push(`needs at least ${imageMinimum(inputs.images)} reference image(s) in input.images, got ${images.length}`);
	} else if (images.length > imageCapacity(inputs.images)) {
		problems.push(`takes at most ${imageCapacity(inputs.images)} reference image(s), got ${images.length}`);
	}
	const formats = model.imageFormats ?? IMAGE_EXTENSIONS;
	for (const path of images) {
		if (!isAbsolute(path)) problems.push(`image "${path}" is not an absolute path`);
		else if (!formats.includes(extensionOf(path))) {
			problems.push(`image "${basename(path)}" is not a type this model takes (${formats.join(", ")})`);
		}
	}

	if (input.model !== undefined || input.from !== undefined) problems.push("takes no 3D input");

	const prompt = input.prompt?.trim() ?? "";
	if (prompt !== "" && inputs.prompt === undefined) problems.push("takes no prompt");
	if (prompt === "" && inputs.prompt?.required === true) problems.push("needs input.prompt");
	if ((input.negativePrompt?.trim() ?? "") !== "" && inputs.negativePrompt === undefined) {
		problems.push("takes no negative prompt");
	}
	if (seed !== undefined && inputs.seed === undefined) problems.push("takes no seed");

	problems.push(...validateOptions(schema, options ?? {}));
	if (problems.length > 0) throw new Error(`${model.modelId}: ${problems.join("; ")}`);
}

/** Throw, naming every problem at once, when a local file would be uploaded to
 *  WaveSpeed's storage that is not a plain, non-empty file within the ceiling.
 *  Reads metadata only; runs after `checkRequest` and before the first upload. */
async function checkLocalFiles(model: ModelEntry, request: GenerationRequest): Promise<void> {
	if (model.inputs.images === undefined) return;
	const paths = request.input.images ?? [];
	const maxBytes = Math.min(MAX_IMAGE_BYTES, model.maxImageBytes ?? MAX_IMAGE_BYTES);
	const infos = await Promise.all(paths.map(path => stat(path).catch(() => undefined)));
	const problems: string[] = [];
	paths.forEach((path, index) => {
		const info = infos[index];
		if (!info?.isFile()) problems.push(`${basename(path)} is not a readable file`);
		else if (info.size === 0) problems.push(`${basename(path)} is empty`);
		else if (info.size > maxBytes) problems.push(`${basename(path)} is ${info.size} bytes, over the ${maxBytes} byte ceiling for this model`);
	});
	if (problems.length > 0) throw new Error(`${model.modelId}: ${problems.join("; ")}`);
}

/** The JSON body to POST to the model. Uploads the request's files. */
export async function buildBody(
	model: ModelEntry,
	schema: OptionsSchema,
	request: GenerationRequest,
	upload: Upload,
): Promise<Record<string, unknown>> {
	checkRequest(model, schema, request);
	await checkLocalFiles(model, request);
	const { input, options, seed } = request;
	const { inputs } = model;
	const body: Record<string, unknown> = { ...options };

	const imageFields = inputs.images;
	if (imageFields !== undefined && input.images !== undefined) {
		// Upload order is the caller's image order: Promise.all keeps it.
		const urls = await Promise.all(input.images.map(path => upload(path)));
		if ("field" in imageFields) body[imageFields.field] = urls[0];
		else if ("arrayField" in imageFields) body[imageFields.arrayField] = urls;
		else {
			urls.forEach((url, index) => {
				body[imageFields.fields[index]!] = url;
			});
		}
	}

	const prompt = input.prompt?.trim() ?? "";
	if (prompt !== "" && inputs.prompt !== undefined) body[inputs.prompt.field] = prompt;
	const negative = input.negativePrompt?.trim() ?? "";
	if (negative !== "" && inputs.negativePrompt !== undefined) body[inputs.negativePrompt] = negative;
	if (seed !== undefined && inputs.seed !== undefined) body[inputs.seed] = seed;
	return body;
}
