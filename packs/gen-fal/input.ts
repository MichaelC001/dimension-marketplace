// A Dimension request, turned into the JSON body of a fal endpoint.
//
// Dimension's `GenerationInput` is the same for every provider: reference images
// by absolute path, a prompt, a 3D file or an earlier job to chain from. Each fal
// endpoint names those inputs differently (`image_url`, `image_urls`,
// `input_image_url` + `back_image_url` + …, `input_file_url`), and models.json
// says how. Files go to fal's CDN first — the only form every endpoint accepts —
// and the body carries their URLs. The request and its local files are validated
// before the first upload so a bad request costs nothing.

import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { GenerationRequest } from "@dimension/sdk/provider";
import type { ImageFields, ModelEntry } from "./models.ts";
import { chainedFile } from "./result.ts";
import { type OptionsSchema, validateOptions } from "./schema.ts";

/** Uploads a local file to fal and returns its URL. */
export type Upload = (path: string) => Promise<string>;

/** The image types fal's endpoints take: the ones its CDN names a content type for. */
const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"];

/** The pack's own ceilings, not fal's (fal publishes none). Everything uploaded is
 *  served by fal's CDN under a public URL, so a "reference image" or mesh this large
 *  is a wrong path, not an input. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_MODEL_BYTES = 500 * 1024 * 1024;

function imageCapacity(images: ImageFields): number {
	if ("field" in images) return 1;
	return "arrayField" in images ? images.max : images.fields.length;
}

function extensionOf(path: string): string {
	return extname(path).slice(1).toLowerCase();
}

/** The names of the endpoint fields a request fills from its inputs rather than its options. */
export function claimedFields(model: ModelEntry): string[] {
	const { images, prompt, negativePrompt, model: file, seed } = model.inputs;
	const claimed: string[] = [];
	if (images !== undefined) {
		if ("field" in images) claimed.push(images.field);
		else if ("arrayField" in images) claimed.push(images.arrayField);
		else claimed.push(...images.fields);
	}
	if (prompt !== undefined) claimed.push(prompt.field);
	if (negativePrompt !== undefined) claimed.push(negativePrompt);
	if (file !== undefined) claimed.push(file.field, ...(file.typeField === undefined ? [] : [file.typeField]));
	if (seed !== undefined) claimed.push(seed);
	return claimed;
}

/** Throw, naming every problem at once, when a request cannot be sent to this
 *  endpoint. Touches neither the network nor the disk. */
export function checkRequest(model: ModelEntry, schema: OptionsSchema, request: GenerationRequest): void {
	const { input, options, seed } = request;
	const { inputs } = model;
	const problems: string[] = [];

	const images = input.images ?? [];
	if (inputs.images === undefined) {
		if (images.length > 0) problems.push("takes no reference images");
	} else if (images.length === 0) {
		problems.push("needs at least one reference image in input.images");
	} else if (images.length > imageCapacity(inputs.images)) {
		problems.push(`takes at most ${imageCapacity(inputs.images)} reference image(s), got ${images.length}`);
	}
	for (const path of images) {
		if (!isAbsolute(path)) problems.push(`image "${path}" is not an absolute path`);
		else if (!IMAGE_EXTENSIONS.includes(extensionOf(path))) {
			problems.push(`image "${basename(path)}" is not a type fal takes (${IMAGE_EXTENSIONS.join(", ")})`);
		}
	}

	if (inputs.model === undefined) {
		if (input.model !== undefined || input.from !== undefined) problems.push("takes no 3D input");
	} else if (input.model !== undefined && input.from !== undefined) {
		problems.push("takes input.model or input.from, not both");
	} else if (input.from !== undefined) {
		try {
			chainedFile(input.from.handle, inputs.model.formats);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	} else if (input.model === undefined) {
		problems.push(`needs a 3D file (${inputs.model.formats.join(" or ")}) in input.model, or a chained job in input.from`);
	} else if (!isAbsolute(input.model)) {
		problems.push(`model "${input.model}" is not an absolute path`);
	} else if (!inputs.model.formats.includes(extensionOf(input.model))) {
		problems.push(`takes ${inputs.model.formats.join(" or ")} files, got "${extensionOf(input.model) || input.model}"`);
	}

	const prompt = input.prompt?.trim() ?? "";
	if (prompt !== "" && inputs.prompt === undefined) problems.push("takes no prompt");
	if (prompt === "" && inputs.prompt?.required === true) problems.push("needs input.prompt");
	if ((input.negativePrompt?.trim() ?? "") !== "" && inputs.negativePrompt === undefined) {
		problems.push("takes no negative prompt");
	}
	if (seed !== undefined && inputs.seed === undefined) problems.push("takes no seed");

	problems.push(...validateOptions(schema, options ?? {}));
	if (problems.length > 0) throw new Error(`${model.endpoint}: ${problems.join("; ")}`);
}

/** Throw, naming every problem at once, when a local file would be uploaded to fal's
 *  public CDN that is not a plain, non-empty file within the pack's ceiling. Reads
 *  metadata only; runs after `checkRequest` and before the first upload. */
export async function checkLocalFiles(model: ModelEntry, request: GenerationRequest): Promise<void> {
	const { input } = request;
	const files: { readonly path: string; readonly kind: string; readonly maxBytes: number }[] = [];
	if (model.inputs.images !== undefined) {
		for (const path of input.images ?? []) files.push({ path, kind: "image", maxBytes: MAX_IMAGE_BYTES });
	}
	if (model.inputs.model !== undefined && input.from === undefined && input.model !== undefined) {
		files.push({ path: input.model, kind: "3D file", maxBytes: MAX_MODEL_BYTES });
	}
	const infos = await Promise.all(files.map(file => stat(file.path).catch(() => undefined)));
	const problems: string[] = [];
	files.forEach(({ path, kind, maxBytes }, index) => {
		const info = infos[index];
		if (!info?.isFile()) problems.push(`${basename(path)} is not a readable file`);
		else if (info.size === 0) problems.push(`${basename(path)} is empty`);
		else if (info.size > maxBytes) problems.push(`${basename(path)} is ${info.size} bytes, over the pack's ${maxBytes} byte ceiling (${kind})`);
	});
	if (problems.length > 0) throw new Error(`${model.endpoint}: ${problems.join("; ")}`);
}

/** The JSON body to POST to the endpoint. Uploads the request's files. */
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

	if (inputs.model !== undefined) {
		const file =
			input.from !== undefined
				? chainedFile(input.from.handle, inputs.model.formats)
				: { url: await upload(input.model!), format: extensionOf(input.model!) };
		body[inputs.model.field] = file.url;
		if (inputs.model.typeField !== undefined) body[inputs.model.typeField] = file.format;
	}

	const prompt = input.prompt?.trim() ?? "";
	if (prompt !== "" && inputs.prompt !== undefined) body[inputs.prompt.field] = prompt;
	const negative = input.negativePrompt?.trim() ?? "";
	if (negative !== "" && inputs.negativePrompt !== undefined) body[inputs.negativePrompt] = negative;
	if (seed !== undefined && inputs.seed !== undefined) body[inputs.seed] = seed;
	return body;
}
