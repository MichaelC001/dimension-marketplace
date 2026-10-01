// A fal result, mapped to files.
//
// fal's result schema differs per endpoint — `model_glb`, `model_mesh`,
// `model_urls.fbx`, `texture_urls[0].base_color`, `result_files[]` — but every file
// in it has one shape: an object with a `url` (plus `file_name`, `content_type`,
// `file_size`). So files are found by shape, not by a per-endpoint field list, and
// classified by rules over the file's dotted path in models.json. A new endpoint
// that follows fal's conventions needs no code.

import { basename, extname } from "node:path";
import { isRecord } from "./guards.ts";
import type { FileRole, RoleRule } from "./models.ts";

export interface RemoteFile {
	readonly url: string;
	readonly role: FileRole;
	/** Extension without the dot: glb, fbx, png, … */
	readonly format: string;
	/** Where the file sits in fal's result, e.g. `model_urls.fbx`. */
	readonly label: string;
	/** A safe, unique file name for the job's output directory. */
	readonly name: string;
}

const MODEL_FORMATS = ["glb", "gltf", "fbx", "obj", "usdz", "stl", "ply", "blend", "dae"];
const IMAGE_FORMATS = ["png", "jpg", "jpeg", "webp", "avif", "exr", "tga", "bmp"];

/** Used only when a file carries neither a name nor an extension in its URL. */
const FORMAT_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
	"model/gltf-binary": "glb",
	"model/gltf+json": "gltf",
	"model/obj": "obj",
	"model/stl": "stl",
	"model/vnd.usdz+zip": "usdz",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};

interface Found {
	readonly label: string;
	readonly file: Record<string, unknown> & { readonly url: string };
}

/** Every file-shaped object in `node`, in document order. A file is not descended into. */
function findFiles(node: unknown, label: string, into: Found[]): void {
	if (Array.isArray(node)) {
		node.forEach((item, index) => {
			findFiles(item, `${label}[${index}]`, into);
		});
	} else if (isRecord(node)) {
		if (typeof node.url === "string") {
			into.push({ label, file: node as Found["file"] });
			return;
		}
		for (const [key, value] of Object.entries(node)) findFiles(value, label === "" ? key : `${label}.${key}`, into);
	}
}

function formatOf(found: Found): string {
	const named = typeof found.file.file_name === "string" ? extname(found.file.file_name) : "";
	const fromUrl = extname(new URL(found.file.url).pathname);
	const ext = (named || fromUrl).slice(1).toLowerCase();
	if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
	const contentType = typeof found.file.content_type === "string" ? found.file.content_type.toLowerCase() : "";
	return FORMAT_BY_CONTENT_TYPE[contentType] ?? "bin";
}

function roleOf(label: string, format: string, rules: readonly RoleRule[]): FileRole {
	for (const rule of rules) {
		if (new RegExp(rule.path, "i").test(label)) return rule.role;
	}
	if (MODEL_FORMATS.includes(format)) return "model";
	if (IMAGE_FORMATS.includes(format)) return "image";
	return "other";
}

/** fal's name for a file is advice, not a path: it never leaves the job's directory. */
function safeName(found: Found, format: string): string {
	const raw = typeof found.file.file_name === "string" ? found.file.file_name : basename(new URL(found.file.url).pathname);
	const stem = basename(raw, extname(raw))
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^[._]+/, "")
		.slice(0, 80);
	return `${stem === "" ? "file" : stem}.${format}`;
}

/** Collect and classify the files of a fal result. The same URL listed twice
 *  (Meshy lists its GLB as `model_glb` and `model_urls.glb`) is one file. */
export function collectFiles(result: unknown, rules: readonly RoleRule[]): RemoteFile[] {
	const found: Found[] = [];
	findFiles(result, "", found);
	const seenUrls = new Set<string>();
	const takenNames = new Set<string>();
	const files: RemoteFile[] = [];
	for (const item of found) {
		let url: URL;
		try {
			url = new URL(item.file.url);
		} catch {
			throw new Error(`fal's result lists "${item.label}" with an unusable URL`);
		}
		if (url.protocol !== "https:") throw new Error(`fal's result lists "${item.label}" with a non-https URL`);
		if (seenUrls.has(item.file.url)) continue;
		seenUrls.add(item.file.url);
		const format = formatOf(item);
		const base = safeName(item, format);
		let name = base;
		for (let n = 2; takenNames.has(name); n++) name = base.replace(/(\.[^.]+)$/, `-${n}$1`);
		takenNames.add(name);
		files.push({
			url: item.file.url,
			role: roleOf(item.label, format, rules),
			format,
			label: item.label,
			name,
		});
	}
	return files;
}

/** The handle a later job of this provider chains from: the model files of this
 *  one, by format, as fal CDN URLs. A 3D-to-3D endpoint wants one specific format
 *  (Part wants FBX, Smart Topology GLB or OBJ), so the handle carries every format
 *  the job produced. The URLs live as long as fal keeps the job's media. */
export function makeHandle(files: readonly RemoteFile[]): string | undefined {
	const formats: Record<string, string> = {};
	for (const file of files) {
		if (file.role === "model" && !Object.hasOwn(formats, file.format)) formats[file.format] = file.url;
	}
	return Object.keys(formats).length > 0 ? JSON.stringify({ formats }) : undefined;
}

/** The file of a chained job's handle an endpoint can take, in the endpoint's order of preference. */
export function chainedFile(handle: string, accepted: readonly string[]): { url: string; format: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(handle);
	} catch {
		throw new Error("the chained job's handle is not one this provider issued");
	}
	const formats = isRecord(parsed) && isRecord(parsed.formats) ? parsed.formats : undefined;
	if (formats === undefined) throw new Error("the chained job's handle is not one this provider issued");
	for (const format of accepted) {
		const url = Object.hasOwn(formats, format) ? formats[format] : undefined;
		if (typeof url === "string") return { url, format };
	}
	const have = Object.keys(formats).join(", ");
	throw new Error(`the chained job produced ${have === "" ? "no model file" : have}, but this model needs ${accepted.join(" or ")}`);
}
