// A WaveSpeed task's outputs, mapped to files.
//
// `outputs` is a list whose items are "usually URL strings, but may be text strings
// or structured result objects, depending on the model" (WaveSpeed's docs). A 3D
// model's recorded runs list one URL string per file. So a file is a URL string, or
// an object carrying a `url` string; any other text is not a file. Files are
// classified by what they are — their extension — because the list carries no names.

import { basename, extname } from "node:path";
import type { GenerationFile } from "@dimension/sdk/provider";
import { isRecord } from "./guards.ts";

export interface RemoteFile {
	readonly url: string;
	readonly role: GenerationFile["role"];
	/** Extension without the dot: glb, fbx, png, … */
	readonly format: string;
	/** Where the file sits in the task's outputs, e.g. `outputs[0]`. */
	readonly label: string;
	/** A safe, unique file name for the job's output directory. */
	readonly name: string;
}

const MODEL_FORMATS = ["glb", "gltf", "fbx", "obj", "usdz", "stl", "ply", "blend", "dae"];
const IMAGE_FORMATS = ["png", "jpg", "jpeg", "webp", "avif", "exr", "tga", "bmp"];

interface Found {
	readonly label: string;
	readonly url: string;
}

/** Every file reference in `node`, in document order. A text that is not an http(s) URL is skipped. */
function findFiles(node: unknown, label: string, into: Found[]): void {
	if (Array.isArray(node)) {
		node.forEach((item, index) => {
			findFiles(item, `${label}[${index}]`, into);
		});
	} else if (typeof node === "string") {
		if (/^https?:\/\//i.test(node)) into.push({ label, url: node });
	} else if (isRecord(node)) {
		if (typeof node.url === "string") into.push({ label, url: node.url });
		else for (const [key, value] of Object.entries(node)) findFiles(value, `${label}.${key}`, into);
	}
}

function formatOf(url: URL): string {
	const ext = extname(url.pathname).slice(1).toLowerCase();
	return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

function roleOf(format: string): RemoteFile["role"] {
	if (MODEL_FORMATS.includes(format)) return "model";
	if (IMAGE_FORMATS.includes(format)) return "image";
	return "other";
}

/** WaveSpeed's name for a file is advice, not a path: it never leaves the job's directory. */
function safeName(url: URL, format: string): string {
	let decoded = url.pathname;
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		// a malformed escape: the sanitiser below handles the raw path just as well
	}
	const raw = basename(decoded);
	const stem = basename(raw, extname(raw))
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^[._]+/, "")
		.slice(0, 80);
	return `${stem === "" ? "file" : stem}.${format}`;
}

/** Collect and classify the files of a task's outputs. The same URL listed twice is
 *  one file. Throws for a file listed over plain http or with an unusable URL: it is
 *  never downloaded. */
export function collectFiles(outputs: readonly unknown[]): RemoteFile[] {
	const found: Found[] = [];
	findFiles(outputs, "outputs", found);
	const seenUrls = new Set<string>();
	const takenNames = new Set<string>();
	const files: RemoteFile[] = [];
	for (const item of found) {
		let url: URL;
		try {
			url = new URL(item.url);
		} catch {
			throw new Error(`WaveSpeed's result lists "${item.label}" with an unusable URL`);
		}
		if (url.protocol !== "https:") throw new Error(`WaveSpeed's result lists "${item.label}" with a non-https URL`);
		if (seenUrls.has(item.url)) continue;
		seenUrls.add(item.url);
		const format = formatOf(url);
		const base = safeName(url, format);
		let name = base;
		for (let n = 2; takenNames.has(name); n++) name = base.replace(/(\.[^.]+)$/, `-${n}$1`);
		takenNames.add(name);
		files.push({ url: item.url, role: roleOf(format), format, label: item.label, name });
	}
	return files;
}
