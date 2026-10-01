// The Tripo `generation` pack (doc 75 §3.3): what a request costs from Tripo's
// credit table, how images become Tripo's views, how a later step chains from an
// earlier task, what a failed task costs, and how a finished task becomes files.
// Every case runs on an in-memory Tripo built from Tripo's documented responses
// (`fixtures/`, each says where it came from): no network, no real key, nothing
// written outside a temp dir.
//
// Prices are read from the pack's own `models.json` rows and added up here, so a
// price edit in the data does not break a test, but a pack that stops applying a
// row, applies it twice or forgets the dollar conversion does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { GenerationRequest } from "@dimension/sdk/provider";
import {
	buildTaskRequest,
	collectOutputs,
	createTripoProvider,
	loadCatalogue,
	readConnectKey,
	type TripoCatalogue,
	type TripoModel,
	type TripoTask,
	taskStatus,
} from "../index.ts";

const fixture = async (name: string): Promise<unknown> => {
	const wrapped: { response: unknown } = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
	return wrapped.response;
};

const KEY = "tsk_SECRET_DO_NOT_LEAK";
const signal = new AbortController().signal;
const catalogue: TripoCatalogue = await loadCatalogue();

const IMAGE_TO_MODEL = "h3.1/image_to_model";
const MULTIVIEW = "h3.1/multiview_to_model";

function modelOf(id: string): TripoModel {
	const model = catalogue.models.find(candidate => candidate.id === id);
	if (model === undefined) throw new Error(`models.json has no ${id}`);
	return model;
}

/** The credits of one row of a model's price table, by its label. */
function row(model: TripoModel, label: string): number {
	const found = model.pricing.rules.find(rule => rule.label === label);
	if (found === undefined) throw new Error(`${model.id} has no price row "${label}"`);
	return found.credits;
}

const abs = (name: string): string => join(tmpdir(), name);
const token = (file: { path: string }): string => `tok:${basename(file.path)}`;
const build = (id: string, request: Omit<GenerationRequest, "model">) => buildTaskRequest(catalogue, modelOf(id), { model: id, ...request }, token);
const image = (...names: string[]) => ({ images: names.map(abs) });

/** Every option a price row of the image models looks at, set so that no row applies. */
const BARE = {
	texture: false,
	pbr: false,
	texture_quality: "standard",
	geometry_quality: "standard",
	quad: false,
	smart_low_poly: false,
	generate_parts: false,
};

describe("what a request quotes, from Tripo's credit table", () => {
	const model = modelOf(IMAGE_TO_MODEL);
	const quoted = (options: Record<string, unknown>) => build(IMAGE_TO_MODEL, { input: image("hero.png"), options: { ...BARE, ...options } });

	test("bare geometry costs the model's base, and dollars are credits × the credit's price", () => {
		const bare = quoted({});
		expect(bare.credits).toBe(model.pricing.base);
		expect(bare.usd).toBeCloseTo(bare.credits * catalogue.credit.usd, 9);
	});

	test("each surcharge the options trigger adds its own row, once", () => {
		const request = quoted({ texture: true, texture_quality: "detailed", quad: true });
		expect(request.credits).toBe(model.pricing.base + row(model, "textured") + row(model, "HD texture") + row(model, "quad"));
	});

	test("8K texture replaces HD texture; the two are never charged together", () => {
		expect(quoted({ texture: true, texture_quality: "extreme" }).credits).toBe(model.pricing.base + row(model, "textured") + row(model, "8K texture"));
	});

	test("texture and pbr each ask for texture, and asking twice is charged once", () => {
		const once = model.pricing.base + row(model, "textured");
		expect(quoted({ texture: true }).credits).toBe(once);
		expect(quoted({ pbr: true }).credits).toBe(once);
		expect(quoted({ texture: true, pbr: true }).credits).toBe(once);
	});

	test("the dollar figure carries no binary-float noise", () => {
		const request = quoted({ texture: true, geometry_quality: "detailed", texture_quality: "detailed", smart_low_poly: true });
		expect(request.usd).toBe(Math.round(request.credits * catalogue.credit.usd * 1e6) / 1e6);
		expect(String(request.usd).length).toBeLessThan(10);
	});

	test("the basis names the total and every row it is made of", () => {
		const { basis } = quoted({ texture: true, quad: true });
		expect(basis).toContain(`${model.pricing.base + row(model, "textured") + row(model, "quad")} credits`);
		expect(basis).toContain("textured");
		expect(basis).toContain("quad");
	});

	test("a list option charges its row per element: three animations cost three rows, one costs one", () => {
		const retarget = modelOf("retarget");
		const clips = ["preset:idle", "preset:walk", "preset:run"];
		const many = build("retarget", { input: { from: { handle: "task_abc123" } }, options: { animations: clips } });
		expect(many.credits).toBe(retarget.pricing.base + 3 * row(retarget, "animation"));
		const one = build("retarget", { input: { from: { handle: "task_abc123" } }, options: { animation: "preset:idle" } });
		expect(one.credits).toBe(retarget.pricing.base + row(retarget, "animation"));
	});

	test("a reference image on the segmentation model adds its row", () => {
		const segment = modelOf("segmentation/v2.0");
		const plain = build("segmentation/v2.0", { input: { model: abs("mesh.glb") } });
		const referenced = build("segmentation/v2.0", { input: { model: abs("mesh.glb"), images: [abs("ref.png")] } });
		expect(plain.credits).toBe(segment.pricing.base);
		expect(referenced.credits).toBe(segment.pricing.base + row(segment, "reference image"));
	});

	test("an option the model does not have is refused, naming the ones it does", () => {
		expect(() => build(IMAGE_TO_MODEL, { input: image("hero.png"), options: { warp_drive: true } })).toThrow(/unknown option "warp_drive".*this model takes:.*texture/);
	});

	test("an option value outside the model's schema is refused", () => {
		expect(() => build(IMAGE_TO_MODEL, { input: image("hero.png"), options: { texture_quality: "ludicrous" } })).toThrow("texture_quality");
	});

	test("a combination the model's own constraints forbid is refused with the constraint's reason", () => {
		expect(() => build(IMAGE_TO_MODEL, { input: image("hero.png"), options: { generate_parts: true, texture: true } })).toThrow("generate_parts needs texture:false");
		expect(() =>
			build("retarget", { input: { from: { handle: "t" } }, options: { animation: "preset:idle", animations: ["preset:walk"] } }),
		).toThrow("exactly one of animation");
	});
});

describe("mapping images onto Tripo's views", () => {
	const viewsOf = (request: Omit<GenerationRequest, "model">) => build(MULTIVIEW, request).body.inputs;

	test("without `views`, the images are the first N of front, left, back, right", () => {
		expect(viewsOf({ input: image("a.png", "b.png", "c.png") })).toEqual([{ front: "tok:a.png" }, { left: "tok:b.png" }, { back: "tok:c.png" }]);
	});

	test("named views pick each image's view, and the body lists them in Tripo's canonical order whatever order they were named in", () => {
		expect(viewsOf({ input: image("i0.png", "i1.png", "i2.png"), options: { views: ["right", "front", "back"] } })).toEqual([
			{ front: "tok:i1.png" },
			{ back: "tok:i2.png" },
			{ right: "tok:i0.png" },
		]);
	});

	test("`views` is guidance for the pack and is not sent to Tripo", () => {
		expect(build(MULTIVIEW, { input: image("a.png", "b.png"), options: { views: ["front", "left"] } }).body).not.toHaveProperty("views");
	});

	const REFUSED: readonly { name: string; request: Omit<GenerationRequest, "model">; reason: string }[] = [
		{ name: "views without the front", request: { input: image("a.png", "b.png"), options: { views: ["left", "back"] } }, reason: "front view is mandatory" },
		{ name: "a view list the wrong length for the images", request: { input: image("a.png", "b.png", "c.png"), options: { views: ["front", "left"] } }, reason: "names 2 views for 3 images" },
		{ name: "one image", request: { input: image("a.png") }, reason: "at least 2 images" },
		{ name: "five images", request: { input: image("a.png", "b.png", "c.png", "d.png", "e.png") }, reason: "at most 4 images" },
		{ name: "a prompt", request: { input: { ...image("a.png", "b.png"), prompt: "a knight" } }, reason: "takes no text prompt" },
		{ name: "a negative prompt", request: { input: { ...image("a.png", "b.png"), negativePrompt: "blurry" } }, reason: "no negative prompt" },
		{ name: "a relative path", request: { input: { images: ["a.png", "b.png"] } }, reason: "must be absolute paths" },
		{ name: "a chain handle", request: { input: { ...image("a.png", "b.png"), from: { handle: "task_1" } } }, reason: "builds from images" },
	];
	for (const { name, request, reason } of REFUSED) {
		test(`refuses ${name}`, () => {
			expect(() => build(MULTIVIEW, request)).toThrow(reason);
		});
	}

	test("one seed fills both of the model's seed fields, without overriding a seed the caller set explicitly", () => {
		const body = build(MULTIVIEW, { input: image("a.png", "b.png"), seed: 7, options: { texture_seed: 3 } }).body;
		expect(body.model_seed).toBe(7);
		expect(body.texture_seed).toBe(3);
	});
});

describe("chaining from an earlier task", () => {
	test("the handle IS the earlier task's id, and lands in the model's input field", () => {
		const rig = modelOf("rig/v2.5");
		expect(build("rig/v2.5", { input: { from: { handle: "task_abc123" } } }).body[rig.task.input.field]).toBe("task_abc123");
	});

	test("a model that works on a mesh file uploads it by token instead", () => {
		const rig = modelOf("rig/v2.5");
		expect(build("rig/v2.5", { input: { model: abs("hero.glb") } }).body[rig.task.input.field]).toBe("tok:hero.glb");
	});

	test("a model that can only continue a Tripo job refuses a local file, and says what it needs when given neither", () => {
		expect(() => build("completion/v1.0", { input: { model: abs("hero.glb") } })).toThrow("input.model (a local file) is not accepted");
		expect(() => build("completion/v1.0", { input: {} })).toThrow("needs input.from.handle");
		expect(() => build("rig/v2.5", { input: { model: abs("m.glb"), from: { handle: "t" } } })).toThrow("not both");
		expect(() => build("rig/v2.5", { input: {} })).toThrow("input.from.handle or input.model");
	});
});

describe("what a failed task costs", () => {
	const task = (patch: Partial<TripoTask>): TripoTask => ({ status: "failed", ...patch });

	test("a task Tripo reports no credits spent on is not billed, whichever way it says so", () => {
		for (const credits of [0, "0", undefined]) {
			expect(taskStatus(task({ credits_consumed: credits }))).toMatchObject({ state: "failed", billed: false });
		}
	});

	test("a task that consumed credits is billed, whether Tripo sends the number as a number or a string", () => {
		for (const credits of [20, "20"]) {
			expect(taskStatus(task({ credits_consumed: credits }))).toMatchObject({ state: "failed", billed: true });
		}
	});

	test("the failure names Tripo's error code and message", async () => {
		const failed = (await fixture("task-failed.json")) as { data: TripoTask };
		const status = taskStatus(failed.data);
		expect(status).toMatchObject({ state: "failed", billed: false });
		expect(status.state === "failed" ? status.error : "").toContain("error 2018");
		expect(status.state === "failed" ? status.error : "").toContain("Model too complex");
	});

	test("cancelled, banned, expired and unknown tasks are failures with their own reason", () => {
		const reasons = ["cancelled", "banned", "expired", "unknown"].map(state => {
			const status = taskStatus({ status: state });
			expect(status).toMatchObject({ state: "failed", billed: false });
			return status.state === "failed" ? status.error : "";
		});
		expect(new Set(reasons).size).toBe(4);
		expect(reasons[1]).toContain("content policy");
	});

	test("a status this pack does not know throws instead of being read as done or failed", () => {
		expect(() => taskStatus({ status: "teleporting" })).toThrow("unrecognised task status");
	});

	test("a live task reads as queued or running, with progress as a clamped fraction", () => {
		expect(taskStatus({ status: "queued" })).toEqual({ state: "queued" });
		expect(taskStatus({ status: "running" })).toEqual({ state: "running" });
		expect(taskStatus({ status: "running", progress: 42 })).toEqual({ state: "running", progress: 0.42 });
		expect(taskStatus({ status: "running", progress: 150 })).toEqual({ state: "running", progress: 1 });
		expect(taskStatus({ status: "running", progress: -5 })).toEqual({ state: "running", progress: 0 });
		expect(taskStatus({ status: "success" })).toEqual({ state: "succeeded" });
	});
});

describe("a finished task's outputs", () => {
	const outputs = (id: string, output: Record<string, unknown>) => collectOutputs(catalogue, modelOf(id), output);

	test("a batch listing several models expands to numbered files under the one name", async () => {
		const batch = (await fixture("task-retarget-batch-success.json")) as { data: TripoTask };
		const found = outputs("retarget", batch.data.output ?? {});
		expect(found.map(file => file.name)).toEqual(["model-1", "model-2", "model-3"]);
		expect(found.map(file => file.format)).toEqual(["glb", "glb", "glb"]);
	});

	test("aliases of one output are one file: the first key present wins", () => {
		const found = outputs(IMAGE_TO_MODEL, { model_url: "https://cdn.tripo3d.ai/a/first.glb", model: "https://cdn.tripo3d.ai/a/second.glb" });
		expect(found.map(file => file.url)).toEqual(["https://cdn.tripo3d.ai/a/first.glb"]);
	});

	test("the model's own file role applies to its model files; previews stay previews", async () => {
		const done = (await fixture("task-image-to-model-success.json")) as { data: TripoTask };
		const rigged = outputs("rig/v2.5", done.data.output ?? {});
		expect(rigged.find(file => file.name === "model")?.role).toBe(modelOf("rig/v2.5").fileRole);
		expect(rigged.find(file => file.name === "rendered_image")?.role).toBe("preview");
	});

	test("a URL that is not https, or not a URL, is refused", () => {
		expect(() => outputs(IMAGE_TO_MODEL, { model_url: "http://cdn.tripo3d.ai/a.glb" })).toThrow("not an https URL");
		expect(() => outputs(IMAGE_TO_MODEL, { model_url: "nope" })).toThrow("not a URL");
	});

	test("a URL without an extension falls back to the pack's default for that kind of file", () => {
		const [file] = outputs(IMAGE_TO_MODEL, { model_url: "https://cdn.tripo3d.ai/a/model" });
		expect(file?.format).toBe(catalogue.defaultExtension.model ?? "bin");
	});
});

interface Reply {
	readonly status: number;
	readonly body: unknown;
	readonly headers?: Record<string, string>;
}

interface Call {
	readonly method: string;
	readonly url: string;
	readonly path: string;
	readonly headers: Record<string, string>;
	readonly json: Record<string, unknown> | undefined;
	readonly upload: string | undefined;
}

/** An in-memory Tripo: upload, balance, task creation, task query and the CDN. */
class FakeTripo {
	readonly calls: Call[] = [];
	balance: Reply = { status: 200, body: { code: 0, data: { balance: 10_000, frozen: 0 } } };
	/** Replies to task-creating POSTs, in order; the last one repeats. */
	create: Reply[] = [];
	/** What `GET /tasks/<id>` answers per task id. */
	tasks = new Map<string, Reply>();
	networkDown = false;
	readonly sleeps: number[] = [];
	#uploads = 0;

	async init(): Promise<void> {
		this.create = [{ status: 200, body: await fixture("create-task.json") }];
	}

	readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		const headers = Object.fromEntries(
			Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]),
		);
		const json: Record<string, unknown> | undefined = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const form = init?.body instanceof FormData ? init.body.get("file") : null;
		const upload = form instanceof File ? form.name : undefined;
		const path = url.startsWith(catalogue.api.baseUrl) ? url.slice(catalogue.api.baseUrl.length) : url;
		this.calls.push({ method, url, path, headers, json, upload });
		const reply = (made: Reply): Response => new Response(JSON.stringify(made.body), { status: made.status, ...(made.headers && { headers: made.headers }) });

		if (url.startsWith("https://cdn.tripo3d.ai/")) return new Response(`bytes of ${url}`);
		if (path === catalogue.upload.endpoint) {
			this.#uploads += 1;
			const base: { data: Record<string, unknown> } = (await fixture("upload.json")) as { data: Record<string, unknown> };
			return reply({ status: 200, body: { code: 0, data: { file_token: `${base.data.file_token}-${this.#uploads}` } } });
		}
		if (this.networkDown && method === "POST") throw new TypeError("fetch failed");
		if (path === "/account/balance") return reply(this.balance);
		if (path.startsWith("/tasks/")) {
			const task = this.tasks.get(decodeURIComponent(path.slice("/tasks/".length)));
			return reply(task ?? { status: 404, body: { code: 2001, message: "task not found" } });
		}
		if (method === "POST") {
			const next = this.create.length > 1 ? (this.create.shift() as Reply) : (this.create[0] as Reply);
			return reply(next);
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;

	provider() {
		return createTripoProvider({
			apiKey: async () => KEY,
			fetch: this.fetch,
			catalogue,
			sleep: async ms => {
				this.sleeps.push(ms);
			},
		});
	}

	taskCalls(): Call[] {
		return this.calls.filter(call => call.method === "POST" && call.path !== catalogue.upload.endpoint);
	}
}

let dir: string;
let heroPath: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "gen-tripo-"));
	heroPath = join(dir, "hero.png");
	await writeFile(heroPath, "png bytes");
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const fresh = async (): Promise<FakeTripo> => {
	const fake = new FakeTripo();
	await fake.init();
	return fake;
};

const imageRequest = (): GenerationRequest => ({ model: IMAGE_TO_MODEL, input: { images: [heroPath] }, options: BARE });

describe("a job from submit to its files", () => {
	test("uploads the image, creates the task with the upload's token and the model's version, and quotes what the table says", async () => {
		const fake = await fresh();
		const provider = fake.provider();
		const quote = await provider.quote(imageRequest(), { signal });
		expect(quote.usd).toBe(build(IMAGE_TO_MODEL, { input: { images: [heroPath] }, options: BARE }).usd);

		const { ref } = await provider.submit(imageRequest(), { signal, jobId: "gen_1" });
		const model = modelOf(IMAGE_TO_MODEL);
		const [create] = fake.taskCalls();
		expect(create?.path).toBe(model.task.endpoint);
		expect(create?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(create?.json?.model).toBe(model.task.version);
		expect(String(create?.json?.[model.task.input.field])).toStartWith("file_abc123");
		expect(basename(String(fake.calls.find(call => call.upload !== undefined)?.upload))).toBe("hero.png");
		expect(JSON.parse(ref)).toMatchObject({ task: "task_abc123", model: IMAGE_TO_MODEL });
	});

	test("the task is polled by the id the ref carries, and a fresh provider can carry a job on after a restart", async () => {
		const fake = await fresh();
		const { ref } = await fake.provider().submit(imageRequest(), { signal, jobId: "gen_1" });
		fake.tasks.set("task_abc123", { status: 200, body: await fixture("task-running.json") });
		expect(await fake.provider().status(ref, { signal, jobId: "gen_1" })).toEqual({ state: "running", progress: 0.42 });
	});

	test("a finished task is downloaded into the outDir with no key on the download, the task id becomes the handle, and the cost is the credits Tripo consumed", async () => {
		const fake = await fresh();
		const provider = fake.provider();
		const { ref } = await provider.submit(imageRequest(), { signal, jobId: "gen_1" });
		fake.tasks.set("task_abc123", { status: 200, body: await fixture("task-image-to-model-success.json") });
		expect(await provider.status(ref, { signal, jobId: "gen_1" })).toEqual({ state: "succeeded" });

		const outDir = join(dir, "out-1");
		const result = await provider.fetch(ref, { signal, jobId: "gen_1", outDir });
		expect(result.handle).toBe("task_abc123");
		expect((await readdir(outDir)).sort()).toEqual(["model.glb", "rendered_image.png"]);
		expect(result.files.every(file => file.path.startsWith(outDir))).toBe(true);
		expect(await readFile(join(outDir, "model.glb"), "utf8")).toBe("bytes of https://cdn.tripo3d.ai/output/model_pbr.glb");
		for (const call of fake.calls.filter(call => call.url.startsWith("https://cdn.tripo3d.ai/"))) expect(call.headers.authorization).toBeUndefined();
		expect(result.costUsd).toBe(100 * catalogue.credit.usd);
		expect(result.meta).toMatchObject({ taskId: "task_abc123", costSource: "task", credits: 100 });
		expect(JSON.stringify(result)).not.toContain(KEY);
	});

	test("Tripo charging fewer credits than were quoted is what the job costs", async () => {
		const fake = await fresh();
		const provider = fake.provider();
		const { ref } = await provider.submit(imageRequest(), { signal, jobId: "gen_1" });
		const done = (await fixture("task-image-to-model-success.json")) as { data: TripoTask };
		fake.tasks.set("task_abc123", { status: 200, body: { code: 0, data: { ...done.data, credits_consumed: 1 } } });
		const result = await provider.fetch(ref, { signal, jobId: "gen_1", outDir: join(dir, "out-2") });
		expect(result.costUsd).toBe(1 * catalogue.credit.usd);
		expect(result.costUsd).toBeLessThan(JSON.parse(ref).usd);
	});

	test("a finished task that reports no credits is recorded at the quote, and says so", async () => {
		const fake = await fresh();
		const provider = fake.provider();
		const { ref } = await provider.submit(imageRequest(), { signal, jobId: "gen_1" });
		const done = (await fixture("task-image-to-model-success.json")) as { data: TripoTask };
		const { credits_consumed: _unreported, ...withoutCredits } = done.data;
		fake.tasks.set("task_abc123", { status: 200, body: { code: 0, data: withoutCredits } });
		const result = await provider.fetch(ref, { signal, jobId: "gen_1", outDir: join(dir, "out-3") });
		expect(result.costUsd).toBe(JSON.parse(ref).usd);
		expect(result.meta).toMatchObject({ costSource: "quote", credits: null });
	});

	test("a later step chains by the handle a finished job returned, with no download or re-upload in between", async () => {
		const fake = await fresh();
		const provider = fake.provider();
		const first = await provider.submit(imageRequest(), { signal, jobId: "gen_1" });
		fake.tasks.set("task_abc123", { status: 200, body: await fixture("task-image-to-model-success.json") });
		const { handle } = await provider.fetch(first.ref, { signal, jobId: "gen_1", outDir: join(dir, "out-4") });
		expect(handle).toBeDefined();

		fake.calls.length = 0;
		await provider.submit({ model: "completion/v1.0", input: { from: { handle: handle ?? "" } } }, { signal, jobId: "gen_2" });
		const [create] = fake.taskCalls();
		expect(create?.json?.[modelOf("completion/v1.0").task.input.field]).toBe("task_abc123");
		expect(fake.calls.filter(call => call.upload !== undefined)).toEqual([]);
	});

	test("fetch refuses a task that has not finished, and one that finished with nothing to download", async () => {
		const fake = await fresh();
		const provider = fake.provider();
		const { ref } = await provider.submit(imageRequest(), { signal, jobId: "gen_1" });
		fake.tasks.set("task_abc123", { status: 200, body: await fixture("task-running.json") });
		await expect(provider.fetch(ref, { signal, jobId: "gen_1", outDir: join(dir, "out-5") })).rejects.toThrow("is running, not finished");
		fake.tasks.set("task_abc123", { status: 200, body: { code: 0, data: { task_id: "task_abc123", status: "success", output: {} } } });
		await expect(provider.fetch(ref, { signal, jobId: "gen_1", outDir: join(dir, "out-5") })).rejects.toThrow("listed no downloadable output");
	});

	test("a request Tripo's schema would refuse never reaches the network: nothing is uploaded and no task is created", async () => {
		const fake = await fresh();
		const provider = fake.provider();
		await expect(provider.submit({ model: IMAGE_TO_MODEL, input: { images: [heroPath] }, options: { texture_quality: "ludicrous" } }, { signal, jobId: "g" })).rejects.toThrow("texture_quality");
		await expect(provider.submit({ model: IMAGE_TO_MODEL, input: { images: [join(dir, "missing.png")] } }, { signal, jobId: "g" })).rejects.toThrow("not a readable file");
		await expect(provider.submit({ model: IMAGE_TO_MODEL, input: { images: [join(dir, "hero.bmp")] } }, { signal, jobId: "g" })).rejects.toThrow("Tripo accepts image files as");
		expect(fake.calls).toEqual([]);
	});
});

describe("the quote's balance note", () => {
	test("says how many credits the account holds, and flags an account that cannot cover the job", async () => {
		const fake = await fresh();
		const need = build(IMAGE_TO_MODEL, { input: { images: [heroPath] }, options: BARE }).credits;
		fake.balance = { status: 200, body: { code: 0, data: { balance: need + 1 } } };
		const enough = await fake.provider().quote(imageRequest(), { signal });
		expect(enough.basis).toContain(`account balance ${need + 1} credits`);
		expect(enough.basis).not.toContain("NOT ENOUGH");

		fake.balance = { status: 200, body: { code: 0, data: { balance: need - 1 } } };
		expect((await fake.provider().quote(imageRequest(), { signal })).basis).toContain("NOT ENOUGH");
	});

	test("a balance that cannot be read does not stop the quote, and the basis says so", async () => {
		const fake = await fresh();
		fake.balance = { status: 500, body: "boom" };
		const quote = await fake.provider().quote(imageRequest(), { signal });
		expect(quote.usd).toBeGreaterThan(0);
		expect(quote.basis).toContain("account balance unavailable");
	});
});

describe("never paying twice", () => {
	test("a task-creating POST that fails in transit is not retried, and the error warns that Tripo may have it", async () => {
		const fake = await fresh();
		fake.networkDown = true;
		await expect(fake.provider().submit(imageRequest(), { signal, jobId: "g" })).rejects.toThrow("may have reached Tripo");
		expect(fake.taskCalls()).toHaveLength(1);
	});

	test("a 429 or 503 - Tripo declined the request unprocessed - is retried after the wait Tripo asked for, then succeeds", async () => {
		const fake = await fresh();
		const limited = await fixture("error-concurrency.json");
		fake.create = [
			{ status: 429, body: limited, headers: { "retry-after": "3" } },
			{ status: 503, body: limited },
			{ status: 200, body: await fixture("create-task.json") },
		];
		const { ref } = await fake.provider().submit(imageRequest(), { signal, jobId: "g" });
		expect(JSON.parse(ref).task).toBe("task_abc123");
		expect(fake.taskCalls()).toHaveLength(3);
		expect(fake.sleeps[0]).toBe(3000);
		expect(fake.sleeps[1]).toBeGreaterThan(0);
	});

	test("a 429 that never lifts stops retrying and surfaces Tripo's own message", async () => {
		const fake = await fresh();
		fake.create = [{ status: 429, body: await fixture("error-concurrency.json") }];
		await expect(fake.provider().submit(imageRequest(), { signal, jobId: "g" })).rejects.toThrow("exceeded the limit of generation");
		expect(fake.taskCalls().length).toBe(fake.sleeps.length + 1);
	});

	test("insufficient credits comes back with Tripo's message and how to top up, and never the key", async () => {
		const fake = await fresh();
		fake.create = [{ status: 403, body: await fixture("error-insufficient-credits.json") }];
		const failure = await fake.provider().submit(imageRequest(), { signal, jobId: "g" }).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("Insufficient credits");
		expect((failure as Error).message).toContain("platform.tripo3d.ai");
		expect((failure as Error).message).not.toContain(KEY);
		expect(fake.taskCalls()).toHaveLength(1);
	});
});

describe("connecting", () => {
	test("without a key the pack is not ready and says how to connect it; with one it is ready", async () => {
		const fake = await fresh();
		const unconnected = createTripoProvider({
			apiKey: () => readConnectKey(join(dir, "never-written.json")),
			fetch: fake.fetch,
			catalogue,
		});
		const notReady = await unconnected.describe({ signal });
		expect(notReady.ready).toBe(false);
		expect(notReady.reason).toContain("Connect page");
		expect((await fake.provider().describe({ signal })).ready).toBe(true);
		expect(fake.calls).toEqual([]);
	});

	describe("readConnectKey", () => {
		const SECRET = "tsk_SECRET_DO_NOT_LEAK";
		const write = async (name: string, content: string): Promise<string> => {
			await mkdir(dir, { recursive: true });
			const path = join(dir, name);
			await writeFile(path, content);
			return path;
		};

		test("reads the key the connect form wrote, trimmed", async () => {
			expect(await readConnectKey(await write("key-ok.json", JSON.stringify({ access: `  ${SECRET}\n` })))).toBe(SECRET);
		});

		test("a corrupt file, an empty key and a wrong shape are refused without echoing the file's content", async () => {
			for (const [name, content] of [
				["corrupt.json", `{ "access": "${SECRET}" `],
				["empty.json", JSON.stringify({ access: " " })],
				["wrong.json", JSON.stringify({ token: SECRET })],
			] as const) {
				const failure = await readConnectKey(await write(name, content)).catch((error: Error) => error);
				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toContain("reconnect");
				expect((failure as Error).message).not.toContain(SECRET);
			}
		});
	});
});
