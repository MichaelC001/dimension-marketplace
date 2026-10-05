// The WaveSpeed `generation` pack (doc 75 §3.3): what it offers from WaveSpeed's
// published catalogue, what it quotes from WaveSpeed's pricing API, how it turns a
// Dimension request into a WaveSpeed body and a WaveSpeed result into files, and what
// it reports for a task WaveSpeed failed. Every case runs against an in-memory
// WaveSpeed built from WaveSpeed's real responses (`fixtures/`, provenance in
// `fixtures/sources.json`): no network, no real key, nothing written outside a temp dir.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationProvider, GenerationRequest } from "@dimension/sdk/provider";
import {
	buildBody,
	buildOptionsSchema,
	checkRequest,
	claimedFields,
	collectFiles,
	createWaveSpeedProvider,
	loadPackData,
	parsePackData,
	readConnectKey,
	validateOptions,
} from "../index.ts";
import type { ModelEntry } from "../models.ts";

interface Reply {
	readonly status: number;
	readonly body: unknown;
}
interface LiveEntry {
	model_id: string;
	api_schema: { api_schemas: { request_schema: { properties: Record<string, unknown>; required?: string[] } }[] };
}
interface Recorded {
	request: { model_id: string; inputs: Record<string, unknown> };
	response: Reply;
}

const fixture = async <T = unknown>(name: string): Promise<T> => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const KEY = "wsk_SECRET_DO_NOT_LEAK";
const NOW = 1_790_000_000_000;
const signal = new AbortController().signal;
const PROBE = "https://example.invalid/pricing-probe.png";

const TRIPO_P2 = "tripo3d/p2/image-to-3d";
const TRIPO_MULTIVIEW = "tripo3d/h3.1/multiview-to-3d";
const MESHY_V6 = "meshy/v6/image-to-3d";
const RODIN = "hyper3d/rodin-v2.5/image-to-3d";
const HUNYUAN_V3 = "wavespeed-ai/hunyuan3d-v3/image-to-3d";
const HUNYUAN_RAPID = "wavespeed-ai/hunyuan-3d-v3.1/image-to-3d-rapid";

const packData = await loadPackData();
const catalogueFixture = await fixture<{ data: LiveEntry[] }>("catalogue.json");
const priceFixture = await fixture<{ prices: Recorded[] }>("prices.json");
const errorFixture = await fixture<Record<"badKey" | "unknownModel" | "badEnum" | "unknownTask", Reply>>("errors.json");
const submitFixture = await fixture("submit.json");
const tasks = await fixture<Record<"created" | "processing" | "failed" | "timeout" | "cancelled" | "deleted", unknown>>("tasks.json");
const completed = await fixture<Record<string, unknown>>("results-completed.json");
const ticketFixture = await fixture<{ data: { upload: { headers: Record<string, string> } } }>("upload-ticket.json");

const entryOf = (modelId: string): ModelEntry => {
	const entry = packData.models.find(model => model.modelId === modelId);
	if (entry === undefined) throw new Error(`models.json has no ${modelId}`);
	return entry;
};

const schemaOf = (modelId: string) => {
	const live = catalogueFixture.data.find(model => model.model_id === modelId);
	if (live === undefined) throw new Error(`the fixture catalogue has no ${modelId}`);
	return buildOptionsSchema(live.api_schema.api_schemas[0]?.request_schema, claimedFields(entryOf(modelId))).options;
};

/** JSON with object keys in sorted order, so two bodies compare by content, not by key order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** A request body with every uploaded-file URL replaced by the pricing stand-in. WaveSpeed's
 *  formulas read which image fields are present, not what they point at (checked live: an
 *  unreachable URL prices the same as a real one), so an upload is priced as the stand-in. */
function standInForUploads(value: unknown): unknown {
	if (typeof value === "string") return value.startsWith("https://example.invalid/media/") ? PROBE : value;
	if (Array.isArray(value)) return value.map(standInForUploads);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, standInForUploads(member)]));
	}
	return value;
}

interface Call {
	readonly method: string;
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: Record<string, unknown> | undefined;
	readonly bytes: Uint8Array | undefined;
}

/** An in-memory WaveSpeed: the catalogue, the pricing API, the upload tickets and
 *  storage, the task queue and the CDN, each answering from WaveSpeed's recorded
 *  shapes. The pricing API answers only requests it was recorded answering — a pack
 *  that sends different inputs than it should is refused, as WaveSpeed would price them
 *  differently. Whatever a test does not touch behaves like a healthy WaveSpeed. */
class FakeWaveSpeed {
	readonly calls: Call[] = [];
	catalogue: { code: number; message: string; data: LiveEntry[] } = structuredClone(catalogueFixture) as never;
	catalogueReply: Reply | undefined;
	priceReply: ((request: Recorded["request"]) => Reply | undefined) | undefined;
	submitReply: Reply = { status: 200, body: submitFixture };
	taskReply: Reply = { status: 200, body: tasks.processing };
	ticketReply: Reply | undefined;
	storageStatus = 200;
	downloadFailures = new Set<string>();
	redirectedDownloads = new Set<string>();
	#uploads = 0;
	readonly #prices = new Map(priceFixture.prices.map(({ request, response }) => [canonical(request), response]));

	callsTo(fragment: string): Call[] {
		return this.calls.filter(call => call.url.includes(fragment));
	}

	readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		const headers = Object.fromEntries(
			Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]),
		);
		const bytes = init?.body instanceof Uint8Array ? Uint8Array.from(init.body) : undefined;
		const body: Record<string, unknown> | undefined = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		this.calls.push({ method, url, headers, body, bytes });
		const reply = ({ status, body: payload }: Reply): Response => new Response(JSON.stringify(payload), { status });
		const { hostname, pathname } = new URL(url);

		if (hostname === "api.wavespeed.ai") {
			if (method === "GET" && pathname === "/api/v3/models") return reply(this.catalogueReply ?? { status: 200, body: this.catalogue });
			if (method === "POST" && pathname === "/api/v3/model/price") {
				const request = standInForUploads(body) as Recorded["request"];
				return reply(this.priceReply?.(request) ?? this.#prices.get(canonical(request)) ?? { status: 400, body: { code: 400, message: `the fake WaveSpeed has no recorded price for ${canonical(request)}` } });
			}
			if (method === "POST" && pathname === "/api/v3/media/uploads") {
				if (this.ticketReply !== undefined) return reply(this.ticketReply);
				const n = ++this.#uploads;
				return reply({
					status: 200,
					body: {
						code: 200,
						message: "success",
						data: {
							type: "image",
							download_url: `https://example.invalid/media/${n}/${String(body?.filename)}`,
							filename: body?.filename,
							size: body?.size,
							upload: { method: "PUT", url: `https://storage-provider.example/put/${n}`, headers: ticketFixture.data.upload.headers },
						},
					},
				});
			}
			if (method === "POST") return reply(this.submitReply);
			if (method === "GET" && /^\/api\/v3\/predictions\/[^/]+\/result$/.test(pathname)) return reply(this.taskReply);
		}
		if (hostname === "storage-provider.example" && method === "PUT") return new Response("", { status: this.storageStatus });
		if (hostname === "static.wavespeed.ai") {
			if (this.downloadFailures.has(url)) return new Response("nope", { status: 500 });
			const response = new Response(`bytes of ${url}`);
			if (this.redirectedDownloads.has(url)) Object.defineProperty(response, "url", { value: url.replace("https:", "http:") });
			return response;
		}
		return reply({ status: 404, body: { code: 404, message: `the fake WaveSpeed has no route for ${method} ${url}` } });
	}) as typeof fetch;

	provider(extra: Parameters<typeof createWaveSpeedProvider>[0] = {}) {
		return createWaveSpeedProvider({ apiKey: async () => KEY, fetch: this.fetch, now: () => NOW, ...extra });
	}
}

let dir: string;
let imagePath: string;
let image2Path: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "gen-wavespeed-"));
	imagePath = join(dir, "ref.png");
	image2Path = join(dir, "ref2.png");
	await writeFile(imagePath, "png bytes");
	await writeFile(image2Path, "png bytes");
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const request = (model: string, extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
	model,
	input: { images: [imagePath] },
	...extra,
});

/** Take a field out of a model's live request schema, as WaveSpeed removing it would. */
function dropLiveField(fake: FakeWaveSpeed, modelId: string, field: string): void {
	const live = fake.catalogue.data.find(model => model.model_id === modelId);
	if (live === undefined) throw new Error(`the fixture catalogue has no ${modelId}`);
	delete live.api_schema.api_schemas[0]?.request_schema.properties[field];
}

describe("what the pack offers from WaveSpeed's catalogue", () => {
	test("every model in models.json that WaveSpeed lists is offered, with WaveSpeed's own options minus the fields Dimension fills itself", async () => {
		const fake = new FakeWaveSpeed();
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.ready).toBe(true);
		expect(catalogue.reason).toBeUndefined();
		expect(catalogue.models.map(model => model.id).sort()).toEqual(packData.models.map(entry => entry.modelId).sort());
		for (const model of catalogue.models) {
			const properties = Object.keys(model.options.properties ?? {});
			expect(model.options.additionalProperties).toBe(false);
			for (const owned of claimedFields(entryOf(model.id))) expect(properties).not.toContain(owned);
		}
		const tripo = catalogue.models.find(model => model.id === TRIPO_P2);
		expect(Object.keys(tripo?.options.properties ?? {})).toContain("texture_quality");
		// Tripo's seeds are hidden in WaveSpeed's own form but are real fields: the request's
		// seed takes model_seed, so texture_seed is what is left to pass as an option.
		expect(Object.keys(tripo?.options.properties ?? {})).toContain("texture_seed");
		expect(fake.callsTo("/api/v3/models")[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
	});

	test("WaveSpeed's UI-only keys are not forwarded to the agent", async () => {
		const catalogue = await new FakeWaveSpeed().provider().describe({ signal });
		const options = JSON.stringify(catalogue.models.map(model => model.options));
		expect(options).not.toContain('"x-');
		expect(options).not.toContain('"title"');
	});

	test("without a key the pack is not ready and says how to connect it, and describe does not throw", async () => {
		const fake = new FakeWaveSpeed();
		const catalogue = await fake
			.provider({
				apiKey: async () => {
					throw new Error("WaveSpeed is not connected — add a WaveSpeed API key on the pack's Connect page");
				},
			})
			.describe({ signal });
		expect(catalogue.ready).toBe(false);
		expect(catalogue.reason).toContain("Connect page");
		expect(catalogue.models).toEqual([]);
		expect(fake.calls).toEqual([]);
	});

	test("a key WaveSpeed rejects makes the pack not ready with a reconnect reason that does not contain the key", async () => {
		const fake = new FakeWaveSpeed();
		fake.catalogueReply = errorFixture.badKey;
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.ready).toBe(false);
		expect(catalogue.reason).toContain("reconnect");
		expect(JSON.stringify(catalogue)).not.toContain(KEY);
	});

	test("a model whose request schema lost a field Dimension fills is withdrawn with the field named; the others are still offered", async () => {
		const fake = new FakeWaveSpeed();
		dropLiveField(fake, TRIPO_P2, "image");
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.ready).toBe(true);
		expect(catalogue.models.map(model => model.id)).not.toContain(TRIPO_P2);
		expect(catalogue.models.length).toBe(packData.models.length - 1);
		expect(catalogue.reason).toContain(TRIPO_P2);
		expect(catalogue.reason).toContain("image");
	});

	test("a model WaveSpeed no longer lists, or now submits elsewhere, is withdrawn with that said", async () => {
		const fake = new FakeWaveSpeed();
		fake.catalogue.data = fake.catalogue.data.filter(model => model.model_id !== TRIPO_P2);
		const moved = fake.catalogue.data.find(model => model.model_id === MESHY_V6);
		(moved?.api_schema.api_schemas[0] as { api_path?: string }).api_path = "/api/v3/wavespeed-ai/meshy6/image-to-3d";
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.models.map(model => model.id)).not.toContain(TRIPO_P2);
		expect(catalogue.models.map(model => model.id)).not.toContain(MESHY_V6);
		expect(catalogue.reason).toContain("does not list");
		expect(catalogue.reason).toContain("now submits it at /api/v3/wavespeed-ai/meshy6/image-to-3d");
		await expect(fake.provider().quote(request(MESHY_V6), { signal })).rejects.toThrow("unavailable");
	});

	test("when WaveSpeed lists none of the pack's models the pack is not ready", async () => {
		const fake = new FakeWaveSpeed();
		fake.catalogue.data = [];
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.ready).toBe(false);
		expect(catalogue.reason).toContain("offers none");
	});
});

describe("what a request quotes", () => {
	// Each amount is what WaveSpeed's pricing API answered for exactly the inputs the pack
	// sends (fixtures/prices.json), and equals the model's documented price table. The fake
	// answers only recorded requests, so a body the pack builds differently is not priced.
	const CASES: readonly { name: string; request: () => GenerationRequest; usd: number }[] = [
		{ name: "Tripo P2 at its defaults (standard textures)", request: () => request(TRIPO_P2), usd: 1.32 },
		{ name: "Tripo P2 untextured", request: () => request(TRIPO_P2, { options: { texture: false, pbr: false } }), usd: 1.2 },
		{ name: "Tripo P2 with extreme textures and a seed", request: () => request(TRIPO_P2, { options: { texture_quality: "extreme" }, seed: 7 }), usd: 1.56 },
		{ name: "Hunyuan3D 3 from one view", request: () => request(HUNYUAN_V3), usd: 0.63 },
		{ name: "Hunyuan3D 3 from two views costs the extra-view fee", request: () => ({ model: HUNYUAN_V3, input: { images: [imagePath, image2Path] } }), usd: 0.81 },
		{
			name: "Hunyuan3D 3 low-poly with PBR and the extra-view fee charged once for three views",
			request: () => ({ model: HUNYUAN_V3, input: { images: [imagePath, image2Path, imagePath] }, options: { generate_type: "LowPoly", enable_pbr: true } }),
			usd: 1.08,
		},
		{
			name: "Tripo H3.1 multiview, quad, detailed geometry and textures",
			request: () => ({ model: TRIPO_MULTIVIEW, input: { images: [imagePath, image2Path] }, options: { quad: true, geometry_quality: "detailed", texture_quality: "detailed" } }),
			usd: 0.78,
		},
		{
			name: "Rodin 2.5 at the top tier with HighPack (the two stack)",
			request: () => request(RODIN, { input: { images: [imagePath], prompt: "a knight" }, options: { tier: "Gen-2.5-Extreme-High", addons: "HighPack" } }),
			usd: 1.92,
		},
		{ name: "Meshy 7.1 with 4K geometry, rigging and an animation", request: () => request("meshy/v7.1/image-to-3d", { options: { enable_rigging: true, enable_animation: true, geometry_resolution: "4k" } }), usd: 2.304 },
		{ name: "Meshy 6 untextured", request: () => request(MESHY_V6, { options: { should_texture: false } }), usd: 0.96 },
		{ name: "TRELLIS.2 at 1536 with 4096 textures", request: () => request("wavespeed-ai/trellis-2/image-to-3d", { options: { resolution: "1536", texture_size: 4096 }, seed: 3 }), usd: 0.45 },
		{ name: "Hunyuan3D 3.1 Rapid, flat", request: () => request(HUNYUAN_RAPID), usd: 0.27 },
	];

	for (const { name, request: build, usd } of CASES) {
		test(`${name} quotes WaveSpeed's own price, $${usd}`, async () => {
			const fake = new FakeWaveSpeed();
			const quote = await fake.provider().quote(build(), { signal });
			expect(quote.usd).toBe(usd);
			expect(quote.basis).toContain("WaveSpeed's pricing API");
			// Asking a price costs nothing: no file is uploaded and no task is submitted.
			expect(fake.callsTo("/media/uploads")).toEqual([]);
			expect(fake.calls.filter(call => call.method === "POST" && !call.url.endsWith("/model/price"))).toEqual([]);
		});
	}

	test("the quote is what the account pays: a discount lowers it, and the basis keeps the list price", async () => {
		const fake = new FakeWaveSpeed();
		fake.priceReply = () => ({ status: 200, body: { code: 200, message: "success", data: { model_id: TRIPO_P2, price: 1.32, discounted_price: 0.66, discount_rate: 50, currency: "USD" } } });
		const quote = await fake.provider().quote(request(TRIPO_P2), { signal });
		expect(quote.usd).toBe(0.66);
		expect(quote.basis).toContain("list price $1.32");
	});

	test("a price WaveSpeed cannot give is not invented: the quote is refused with WaveSpeed's reason", async () => {
		const fake = new FakeWaveSpeed();
		fake.priceReply = () => errorFixture.badEnum;
		await expect(fake.provider().quote(request(TRIPO_P2), { signal })).rejects.toThrow('field "texture_quality" must be one of');
		fake.priceReply = () => ({ status: 500, body: { code: 500, message: "later" } });
		await expect(fake.provider().quote(request(TRIPO_P2), { signal })).rejects.toThrow("HTTP 500");
	});

	test("a price in another currency is refused, not read as dollars", async () => {
		const fake = new FakeWaveSpeed();
		fake.priceReply = () => ({ status: 200, body: { code: 200, message: "success", data: { model_id: TRIPO_P2, price: 1, discounted_price: 1, currency: "EUR" } } });
		await expect(fake.provider().quote(request(TRIPO_P2), { signal })).rejects.toThrow("EUR");
	});

	test("a request WaveSpeed would refuse is refused before any price is asked", async () => {
		const fake = new FakeWaveSpeed();
		await expect(fake.provider().quote({ model: TRIPO_P2, input: {} }, { signal })).rejects.toThrow("needs at least 1 reference image");
		await expect(fake.provider().quote(request("tripo3d/not-offered/image-to-3d"), { signal })).rejects.toThrow("not one this pack offers");
		expect(fake.callsTo("/model/price")).toEqual([]);
	});
});

describe("building WaveSpeed's request body", () => {
	const uploader = () => {
		const uploaded: string[] = [];
		return {
			uploaded,
			upload: async (path: string) => {
				uploaded.push(path);
				return `https://example.invalid/media/${path.split(/[\\/]/).pop()}`;
			},
		};
	};

	test("a reference image is uploaded and its URL lands in the model's own field beside the options and the seed, nothing else", async () => {
		const { upload } = uploader();
		const body = await buildBody(entryOf(TRIPO_P2), schemaOf(TRIPO_P2), request(TRIPO_P2, { options: { texture_quality: "detailed", texture_seed: 4 }, seed: 7 }), upload);
		expect(body).toEqual({ texture_quality: "detailed", texture_seed: 4, image: "https://example.invalid/media/ref.png", model_seed: 7 });
	});

	test("the fields Dimension fills cannot also be sent as options: they are not options of the model", async () => {
		const { upload, uploaded } = uploader();
		await expect(
			buildBody(entryOf(TRIPO_P2), schemaOf(TRIPO_P2), request(TRIPO_P2, { options: { image: "https://evil.example/x.png", model_seed: 1 } }), upload),
		).rejects.toThrow(/options\.image is not an option.*options\.model_seed is not an option/);
		expect(uploaded).toEqual([]);
	});

	test("a bad request is refused in one error naming every problem, before the first upload", async () => {
		const { upload, uploaded } = uploader();
		const bad = { model: TRIPO_P2, input: { prompt: "a hero", images: ["relative.png"] }, options: { texture_quality: "ultra" } };
		const failure = await buildBody(entryOf(TRIPO_P2), schemaOf(TRIPO_P2), bad, upload).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain("takes no prompt");
		expect(message).toContain('image "relative.png" is not an absolute path');
		expect(message).toContain("options.texture_quality must be one of");
		expect(uploaded).toEqual([]);
		expect(() => checkRequest(entryOf(MESHY_V6), schemaOf(MESHY_V6), request(MESHY_V6, { seed: 1 }))).toThrow("takes no seed");
	});

	test("an option WaveSpeed's pricing API would silently ignore is still caught here", async () => {
		expect(() => checkRequest(entryOf(TRIPO_P2), schemaOf(TRIPO_P2), request(TRIPO_P2, { options: { surprise: true } }))).toThrow(
			"options.surprise is not an option of this model",
		);
	});

	test("a 3D file or an earlier job to chain from is refused: no model this pack offers takes one", () => {
		expect(() => checkRequest(entryOf(TRIPO_P2), schemaOf(TRIPO_P2), { model: TRIPO_P2, input: { images: [imagePath], model: join(dir, "m.glb") } })).toThrow("takes no 3D input");
		expect(() => checkRequest(entryOf(TRIPO_P2), schemaOf(TRIPO_P2), { model: TRIPO_P2, input: { images: [imagePath], from: { handle: "x" } } })).toThrow("takes no 3D input");
	});

	test("views map onto the model's per-view fields in the order the caller listed them, whichever upload finishes first", async () => {
		const front = join(dir, "front.png");
		const back = join(dir, "back.png");
		const left = join(dir, "left.png");
		await Promise.all([front, back, left].map(path => writeFile(path, "png bytes")));
		const release = new Map<string, () => void>();
		const allStarted = Promise.withResolvers<void>();
		const gated = (path: string): Promise<string> => {
			const { promise, resolve } = Promise.withResolvers<string>();
			release.set(path, () => resolve(`https://example.invalid/media/${path.split(/[\\/]/).pop()}`));
			if (release.size === 3) allStarted.resolve();
			return promise;
		};
		const building = buildBody(entryOf(HUNYUAN_V3), schemaOf(HUNYUAN_V3), { model: HUNYUAN_V3, input: { images: [front, back, left] } }, gated);
		await allStarted.promise;
		// Finish in the opposite order to the caller's.
		release.get(left)?.();
		release.get(back)?.();
		release.get(front)?.();
		expect(await building).toEqual({
			image: "https://example.invalid/media/front.png",
			back_image: "https://example.invalid/media/back.png",
			left_image: "https://example.invalid/media/left.png",
		});
	});

	test("an array field gets every image in the caller's order, within the model's published minimum and maximum", async () => {
		const { upload } = uploader();
		const body = await buildBody(entryOf(TRIPO_MULTIVIEW), schemaOf(TRIPO_MULTIVIEW), { model: TRIPO_MULTIVIEW, input: { images: [imagePath, image2Path] } }, upload);
		expect(body.images).toEqual(["https://example.invalid/media/ref.png", "https://example.invalid/media/ref2.png"]);
		const five = Array.from({ length: 5 }, () => imagePath);
		expect(() => checkRequest(entryOf(TRIPO_MULTIVIEW), schemaOf(TRIPO_MULTIVIEW), { model: TRIPO_MULTIVIEW, input: { images: five } })).toThrow("at most 4 reference image(s), got 5");
		expect(() => checkRequest(entryOf(RODIN), schemaOf(RODIN), { model: RODIN, input: { images: [...five, imagePath] } })).toThrow("at most 5 reference image(s), got 6");
	});

	test("a prompt goes to the field of the model that takes one and is refused by the models that do not", async () => {
		const { upload } = uploader();
		const body = await buildBody(entryOf(RODIN), schemaOf(RODIN), request(RODIN, { input: { images: [imagePath], prompt: "  a knight  " } }), upload);
		expect(body.prompt).toBe("a knight");
		expect(() => checkRequest(entryOf(HUNYUAN_RAPID), schemaOf(HUNYUAN_RAPID), request(HUNYUAN_RAPID, { input: { images: [imagePath], prompt: "x" } }))).toThrow("takes no prompt");
	});

	describe("what may leave the machine as a reference image", () => {
		const check = async (model: string, images: string[]): Promise<Error | undefined> => {
			const { upload, uploaded } = uploader();
			const failure = await buildBody(entryOf(model), schemaOf(model), { model, input: { images } }, upload).then(
				() => undefined,
				(error: Error) => error,
			);
			// Whatever is refused, nothing was uploaded first.
			if (failure !== undefined) expect(uploaded).toEqual([]);
			return failure;
		};

		test("only image types are sent: a text, 3D or script file named in input.images is refused", async () => {
			for (const name of ["notes.txt", "mesh.glb", "run.exe", "id_rsa", "dump.png.sh"]) {
				const path = join(dir, name);
				await writeFile(path, "content");
				expect((await check(TRIPO_P2, [path]))?.message).toContain("is not a type this model takes");
			}
			expect(await check(TRIPO_P2, [join(dir, "photo.JPG")])).toBeInstanceOf(Error); // allowed type, but the file does not exist
			await writeFile(join(dir, "photo.JPG"), "jpeg bytes");
			expect(await check(TRIPO_P2, [join(dir, "photo.JPG")])).toBeUndefined();
		});

		test("a model whose docs name fewer image types is held to them: WebP goes to Tripo but not to Meshy 6", async () => {
			const webp = join(dir, "ref.webp");
			await writeFile(webp, "webp bytes");
			expect(await check(TRIPO_P2, [webp])).toBeUndefined();
			expect((await check(MESHY_V6, [webp]))?.message).toContain("is not a type this model takes (png, jpg, jpeg)");
		});

		test("a directory named like an image, a missing file and an empty file are not readable images", async () => {
			const directory = join(dir, "looks-like.png");
			await mkdir(directory, { recursive: true });
			const empty = join(dir, "empty.png");
			await writeFile(empty, "");
			const failure = await check(HUNYUAN_V3, [directory, join(dir, "absent.png"), empty]);
			expect(failure?.message).toContain("looks-like.png is not a readable file");
			expect(failure?.message).toContain("absent.png is not a readable file");
			expect(failure?.message).toContain("empty.png is empty");
		});

		test("a file over the ceiling WaveSpeed documents for the model is refused, and one at it is not", async () => {
			const ceiling = entryOf(HUNYUAN_RAPID).maxImageBytes ?? 0;
			expect(ceiling).toBe(8 * 1024 * 1024);
			const atLimit = join(dir, "at-limit.png");
			const over = join(dir, "over-limit.png");
			await writeFile(atLimit, "");
			await truncate(atLimit, ceiling);
			await writeFile(over, "");
			await truncate(over, ceiling + 1);
			expect(await check(HUNYUAN_RAPID, [atLimit])).toBeUndefined();
			expect((await check(HUNYUAN_RAPID, [over]))?.message).toContain(`over the ${ceiling} byte ceiling`);
			// The same file is fine for a model with no documented ceiling of its own.
			expect(await check(TRIPO_P2, [over])).toBeUndefined();
		});
	});
});

describe("uploading a reference image", () => {
	async function submitWith(fake: FakeWaveSpeed, extra: Partial<GenerationRequest> = {}) {
		return fake.provider().submit(request(TRIPO_P2, extra), { signal, jobId: "gen_1" });
	}

	test("the file goes to the target WaveSpeed's ticket names, with the ticket's headers and not the API key, under a generated name", async () => {
		const fake = new FakeWaveSpeed();
		await submitWith(fake);
		const ticket = fake.callsTo("/media/uploads")[0];
		expect(ticket?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(ticket?.body).toMatchObject({ size: 9, content_type: "image/png" });
		expect(String(ticket?.body?.filename)).toMatch(/^ref-[0-9a-f]{8}\.png$/);
		const put = fake.calls.find(call => call.method === "PUT");
		expect(put?.url).toBe("https://storage-provider.example/put/1");
		expect(put?.headers.authorization).toBeUndefined();
		expect(put?.headers["content-type"]).toBe("image/png");
		expect(put?.headers["if-none-match"]).toBe("*");
		expect(new TextDecoder().decode(put?.bytes)).toBe("png bytes");
		// The local file's name stays on this machine.
		expect(JSON.stringify(fake.calls.map(call => call.body))).not.toContain("ref.png");
		expect(fake.callsTo(TRIPO_P2)[0]?.body?.image).toMatch(/^https:\/\/example\.invalid\/media\/1\/ref-/);
	});

	test("one image sent to many models is uploaded once", async () => {
		const fake = new FakeWaveSpeed();
		const provider = fake.provider();
		await provider.submit(request(TRIPO_P2), { signal, jobId: "a" });
		await provider.submit(request(HUNYUAN_V3), { signal, jobId: "b" });
		expect(fake.callsTo("/media/uploads")).toHaveLength(1);
		expect(fake.calls.filter(call => call.method === "PUT")).toHaveLength(1);
	});

	test("a ticket that does not name an https PUT target is refused, and nothing is uploaded", async () => {
		const fake = new FakeWaveSpeed();
		fake.ticketReply = { status: 200, body: { code: 200, message: "success", data: { download_url: "https://example.invalid/m/x.png", upload: { method: "PUT", url: "http://storage-provider.example/put", headers: {} } } } };
		await expect(submitWith(fake)).rejects.toThrow("not an https PUT target");
		fake.ticketReply = { status: 200, body: { code: 200, message: "success", data: { download_url: "https://example.invalid/m/x.png", upload: { method: "POST", url: "https://storage-provider.example/put", headers: {} } } } };
		await expect(submitWith(fake)).rejects.toThrow("not an https PUT target");
		expect(fake.calls.filter(call => call.method === "PUT")).toEqual([]);
		expect(fake.callsTo(TRIPO_P2)).toEqual([]);
	});

	test("storage refusing the file, and WaveSpeed refusing a ticket for quota, fail the submit with the reason and no task is created", async () => {
		const refused = new FakeWaveSpeed();
		refused.storageStatus = 403;
		await expect(submitWith(refused)).rejects.toThrow("storage refused ref.png (HTTP 403)");

		const quota = new FakeWaveSpeed();
		quota.ticketReply = { status: 429, body: { code: 429, message: "Upload quota exceeded" } };
		await expect(submitWith(quota)).rejects.toThrow("HTTP 429): Upload quota exceeded");
		for (const fake of [refused, quota]) expect(fake.callsTo(TRIPO_P2)).toEqual([]);
	});
});

describe("mapping a result to files", () => {
	test("each recorded run of a 3D model yields its one model file, named plainly", () => {
		for (const [modelId, run] of Object.entries(completed)) {
			const outputs = (run as { data: { outputs: unknown[] } }).data.outputs;
			const files = collectFiles(outputs);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatchObject({ role: "model", format: "glb", label: "outputs[0]" });
			expect(files[0]?.name).toMatch(/^[A-Za-z0-9._-]+\.glb$/);
			expect(modelId.length).toBeGreaterThan(0);
		}
		expect(Object.keys(completed).sort()).toEqual(packData.models.map(entry => entry.modelId).sort());
	});

	test("outputs are URLs, objects carrying a url, or text: only the first two are files, and one URL listed twice is one file", () => {
		const files = collectFiles([
			"https://static.wavespeed.ai/o/1/model.fbx",
			{ url: "https://static.wavespeed.ai/o/1/preview.png", extra: 1 },
			"A text answer the model also returned",
			"https://static.wavespeed.ai/o/1/model.fbx",
			["https://static.wavespeed.ai/o/2/pack.zip"],
		]);
		expect(files.map(file => [file.name, file.role, file.format])).toEqual([
			["model.fbx", "model", "fbx"],
			["preview.png", "image", "png"],
			["pack.zip", "other", "zip"],
		]);
	});

	test("a file over plain http is refused: nothing is downloaded off https", () => {
		expect(() => collectFiles(["http://static.wavespeed.ai/o/1/model.glb"])).toThrow("non-https URL");
	});

	test("a hostile file name cannot leave the job's directory, and two files with one name both survive", () => {
		const files = collectFiles([
			"https://static.wavespeed.ai/a/..%5C..%5Cevil%2F..%2F..%2Fmodel.glb",
			"https://static.wavespeed.ai/b/model.glb",
			"https://static.wavespeed.ai/c/model.glb?sig=1",
			"https://static.wavespeed.ai/d/%E0%A4%A.glb",
		]);
		expect(files).toHaveLength(4);
		expect(new Set(files.map(file => file.name)).size).toBe(4);
		for (const file of files) expect(file.name).toMatch(/^[A-Za-z0-9._-]+$/);
	});

	test("an empty result has no files", () => {
		expect(collectFiles([])).toEqual([]);
		expect(collectFiles(["only text"])).toEqual([]);
	});
});

describe("a task on WaveSpeed", () => {
	async function submitted(fake: FakeWaveSpeed, model = TRIPO_P2, extra: Partial<GenerationRequest> = {}) {
		const provider = fake.provider();
		const { ref } = await provider.submit(request(model, extra), { signal, jobId: "gen_1" });
		return { provider, ref };
	}
	const statusOf = (provider: GenerationProvider, ref: string) => provider.status(ref, { signal, jobId: "g" });

	test("submit posts the built body to the model's path with the key, and the ref it returns is enough for a fresh provider to carry the job on after a restart", async () => {
		const fake = new FakeWaveSpeed();
		const { ref } = await submitted(fake, TRIPO_P2, { options: { texture_quality: "extreme" }, seed: 7 });
		const post = fake.calls.find(call => call.method === "POST" && call.url === `https://api.wavespeed.ai/api/v3/${TRIPO_P2}`);
		expect(post?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(post?.body).toMatchObject({ texture_quality: "extreme", model_seed: 7, image: expect.stringMatching(/^https:\/\/example\.invalid\/media\//) });
		const job = JSON.parse(ref);
		expect(job).toMatchObject({ model: TRIPO_P2, taskId: "pred_abc123", quoteUsd: 1.56 });
		expect(ref).not.toContain(KEY);

		fake.taskReply = { status: 200, body: tasks.processing };
		expect(await statusOf(fake.provider(), ref)).toEqual({ state: "running" });
		expect(fake.callsTo("/predictions/pred_abc123/result")[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
	});

	test("a submit is sent once and never retried: a refused one fails with WaveSpeed's reason and a lost id fails loudly", async () => {
		const poor = new FakeWaveSpeed();
		poor.submitReply = { status: 400, body: { code: 1407, message: "insufficient credits" } };
		await expect(submitted(poor)).rejects.toThrow("insufficient credits");
		expect(poor.callsTo(`/api/v3/${TRIPO_P2}`)).toHaveLength(1);

		const lost = new FakeWaveSpeed();
		lost.submitReply = { status: 200, body: { code: 200, message: "success", data: { status: "created" } } };
		await expect(submitted(lost)).rejects.toThrow("no usable task id");

		const odd = new FakeWaveSpeed();
		odd.submitReply = { status: 200, body: { code: 200, message: "success", data: { id: "../../etc/passwd" } } };
		await expect(submitted(odd)).rejects.toThrow("no usable task id");
	});

	test("the queue's states read as queued and running, and a state this pack does not know is polled again, never read as done", async () => {
		const fake = new FakeWaveSpeed();
		const { provider, ref } = await submitted(fake);
		fake.taskReply = { status: 200, body: tasks.created };
		expect(await statusOf(provider, ref)).toEqual({ state: "queued", message: "waiting in WaveSpeed's queue" });
		fake.taskReply = { status: 200, body: tasks.processing };
		expect(await statusOf(provider, ref)).toEqual({ state: "running" });
		fake.taskReply = { status: 200, body: { code: 200, message: "success", data: { id: "pred_abc123", status: "something-new", outputs: [] } } };
		expect(await statusOf(provider, ref)).toEqual({ state: "running", message: 'WaveSpeed status "something-new"' });
	});

	test("a failed or timed-out task is reported failed and NOT billed, with WaveSpeed's code and reason; a cancelled or deleted one is held at its quote", async () => {
		const fake = new FakeWaveSpeed();
		const { provider, ref } = await submitted(fake);
		fake.taskReply = { status: 200, body: tasks.failed };
		expect(await statusOf(provider, ref)).toEqual({ state: "failed", billed: false, error: "WaveSpeed task failed: 1402: Failed to download image from the provided URL." });
		fake.taskReply = { status: 200, body: tasks.timeout };
		expect(await statusOf(provider, ref)).toMatchObject({ state: "failed", billed: false, error: expect.stringContaining("timeout") });
		for (const ended of ["cancelled", "deleted"] as const) {
			fake.taskReply = { status: 200, body: tasks[ended] };
			expect(await statusOf(provider, ref)).toMatchObject({ state: "failed", billed: true, error: expect.stringContaining(ended) });
		}
	});

	test("a task WaveSpeed completed but whose result has no usable file is a billed failure, not an endless poll", async () => {
		const fake = new FakeWaveSpeed();
		const { provider, ref } = await submitted(fake);
		const completedWith = (outputs: unknown[]) => ({ status: 200, body: { code: 200, message: "success", data: { id: "pred_abc123", status: "completed", outputs } } });
		fake.taskReply = completedWith([]);
		expect(await statusOf(provider, ref)).toMatchObject({ state: "failed", billed: true, error: expect.stringContaining("no files") });
		fake.taskReply = completedWith(["http://static.wavespeed.ai/o/model.glb"]);
		expect(await statusOf(provider, ref)).toMatchObject({ state: "failed", billed: true, error: expect.stringContaining("non-https") });
	});

	test("an auth, rate-limit, server or unknown-task error while reading the task is not the task's failure: the status call throws so the engine retries", async () => {
		const fake = new FakeWaveSpeed();
		const { provider, ref } = await submitted(fake);
		for (const status of [401, 429, 500, 503]) {
			fake.taskReply = { status, body: { code: status, message: "later" } };
			await expect(statusOf(provider, ref)).rejects.toThrow();
		}
		fake.taskReply = errorFixture.unknownTask;
		await expect(statusOf(provider, ref)).rejects.toThrow("Prediction not found");
		fake.taskReply = { status: 200, body: { code: 5003, message: "Service unavailable", data: null } };
		await expect(statusOf(provider, ref)).rejects.toThrow("code 5003");
	});

	test("WaveSpeed has no way to stop a task, so the provider offers no cancel: the engine then refuses to book a running, billing task as cancelled", async () => {
		expect(new FakeWaveSpeed().provider().cancel).toBeUndefined();
	});

	describe("fetching the finished job", () => {
		async function finished(fake: FakeWaveSpeed, model = TRIPO_P2) {
			fake.taskReply = { status: 200, body: completed[model] };
			const { provider, ref } = await submitted(fake, model);
			expect(await statusOf(provider, ref)).toEqual({ state: "succeeded" });
			return { provider, ref, outDir: await mkdtemp(join(dir, "out-")) };
		}

		test("downloads every file into the outDir under plain names, sending the key to no download host, and stamps the licence and the quoted cost", async () => {
			const fake = new FakeWaveSpeed();
			const { provider, ref, outDir } = await finished(fake);
			const result = await provider.fetch(ref, { signal, jobId: "gen_1", outDir });

			expect((await readdir(outDir)).sort()).toEqual(result.files.map(file => file.path.slice(outDir.length + 1)).sort());
			for (const file of result.files) {
				expect(file.path.startsWith(outDir)).toBe(true);
				expect(await readFile(file.path, "utf8")).toStartWith("bytes of https://");
			}
			expect(result.files).toMatchObject([{ role: "model", format: "glb" }]);
			expect(result.costUsd).toBe(1.32);
			expect(result.meta.cost).toEqual({ source: "wavespeed-pricing-api", usd: 1.32 });
			expect(result.licence).toEqual(entryOf(TRIPO_P2).licence);
			expect(result.handle).toBeUndefined();
			const downloads = fake.callsTo("static.wavespeed.ai");
			expect(downloads).toHaveLength(result.files.length);
			for (const call of downloads) expect(call.headers.authorization).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain(KEY);
		});

		test("after a restart, fetch reads the task again itself, and refuses one that is not completed", async () => {
			const fake = new FakeWaveSpeed();
			const { ref, outDir } = await finished(fake);
			const result = await fake.provider().fetch(ref, { signal, jobId: "gen_1", outDir });
			expect(result.files).toHaveLength(1);

			fake.taskReply = { status: 200, body: tasks.processing };
			await expect(fake.provider().fetch(ref, { signal, jobId: "gen_1", outDir })).rejects.toThrow("is processing, not completed");
			fake.taskReply = { status: 200, body: { code: 200, message: "success", data: { id: "pred_abc123", status: "completed", outputs: [] } } };
			await expect(fake.provider().fetch(ref, { signal, jobId: "gen_1", outDir })).rejects.toThrow("contains no files");
		});

		test("a download that fails leaves no half-written file behind and fails the fetch", async () => {
			const fake = new FakeWaveSpeed();
			const { provider, ref, outDir } = await finished(fake);
			const url = (completed[TRIPO_P2] as { data: { outputs: string[] } }).data.outputs[0] as string;
			fake.downloadFailures.add(url);
			await expect(provider.fetch(ref, { signal, jobId: "gen_1", outDir })).rejects.toThrow("failed (HTTP 500)");
			expect(await readdir(outDir)).toEqual([]);
		});

		test("a download redirected off https is refused and leaves nothing behind", async () => {
			const fake = new FakeWaveSpeed();
			const { provider, ref, outDir } = await finished(fake);
			fake.redirectedDownloads.add((completed[TRIPO_P2] as { data: { outputs: string[] } }).data.outputs[0] as string);
			await expect(provider.fetch(ref, { signal, jobId: "gen_1", outDir })).rejects.toThrow("redirected off https");
			expect(await readdir(outDir)).toEqual([]);
		});
	});
});

describe("readConnectKey", () => {
	const SECRET = "wsk_SECRET_DO_NOT_LEAK";
	let keyDir: string;
	beforeAll(async () => {
		keyDir = await mkdtemp(join(tmpdir(), "gen-wavespeed-key-"));
	});
	afterAll(async () => {
		await rm(keyDir, { recursive: true, force: true });
	});
	const write = async (name: string, content: string): Promise<string> => {
		const path = join(keyDir, name);
		await writeFile(path, content);
		return path;
	};

	test("reads the key the connect form wrote, trimmed", async () => {
		expect(await readConnectKey(await write("ok.json", JSON.stringify({ access: `  ${SECRET}\n` })))).toBe(SECRET);
	});

	test("a missing file tells the owner how to connect", async () => {
		await expect(readConnectKey(join(keyDir, "absent.json"))).rejects.toThrow("Connect page");
	});

	test("a corrupt file and an empty key are refused without echoing the file's content", async () => {
		for (const [name, content] of [
			["corrupt.json", `{ "access": "${SECRET}" `],
			["empty.json", JSON.stringify({ access: "   " })],
			["wrong.json", JSON.stringify({ token: SECRET })],
		] as const) {
			const failure = await readConnectKey(await write(name, content)).catch((error: Error) => error);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain("reconnect");
			expect((failure as Error).message).not.toContain(SECRET);
		}
	});
});

describe("models.json", () => {
	test("every field it names and every image count it states agrees with WaveSpeed's published request schemas", () => {
		expect(packData.models.length).toBeGreaterThan(0);
		for (const entry of packData.models) {
			const live = catalogueFixture.data.find(model => model.model_id === entry.modelId);
			const schema = live?.api_schema.api_schemas[0]?.request_schema;
			expect(schema, `${entry.modelId} is in the catalogue fixture`).toBeDefined();
			for (const field of claimedFields(entry)) expect(Object.keys(schema?.properties ?? {}), `${entry.modelId}.${field}`).toContain(field);
			const images = entry.inputs.images;
			if (images !== undefined && "arrayField" in images) {
				const published = (schema?.properties[images.arrayField] ?? {}) as { minItems?: number; maxItems?: number };
				expect(images.max, `${entry.modelId} max images`).toBe(published.maxItems ?? images.max);
				expect(images.min, `${entry.modelId} min images`).toBe(published.minItems ?? images.min);
			}
		}
	});

	test("an entry that contradicts itself is refused by name: a 3D input, an image input with no image field, a widened image type, a path-like id", async () => {
		const base = JSON.parse(await readFile(new URL("../models.json", import.meta.url), "utf8"));
		const edit = (change: (model: Record<string, unknown>) => void) => {
			const copy = structuredClone(base) as { models: Record<string, unknown>[] };
			change(copy.models[0] as Record<string, unknown>);
			return () => parsePackData(copy);
		};
		expect(edit(model => (model.accepts = ["image", "model3d"]))).toThrow("cannot list model3d");
		expect(edit(model => (model.inputs = { seed: "model_seed" }))).toThrow('lists "image" exactly when');
		expect(edit(model => (model.imageFormats = ["png", "svg"]))).toThrow("must be one of png, jpg, jpeg, webp");
		expect(edit(model => (model.modelId = "tripo3d/../admin"))).toThrow("must look like owner/model/task");
		expect(() => parsePackData({ ...base, models: [base.models[0], base.models[0]] })).toThrow("lists");
	});
});

describe("validateOptions", () => {
	test("accepts a value inside the model's own schema and names each violation otherwise", () => {
		const schema = schemaOf("wavespeed-ai/trellis-2/image-to-3d");
		expect(validateOptions(schema, { resolution: "1024", texture_size: 2048, target_face_count: 20000 })).toEqual([]);
		const errors = validateOptions(schema, { resolution: 1024, texture_size: 3000, target_face_count: 5, surprise: true });
		expect(errors.some(error => error.startsWith("options.resolution"))).toBe(true);
		expect(errors.some(error => error.startsWith("options.texture_size must be one of"))).toBe(true);
		expect(errors).toContain("options.target_face_count must be >= 10000");
		expect(errors).toContain("options.surprise is not an option of this model");
	});
});
