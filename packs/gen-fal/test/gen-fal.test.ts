// The fal.ai `generation` pack (doc 75 §3.3): what it offers from fal's published
// catalogue, what it quotes from fal's published prices, how it turns a Dimension
// request into a fal body and a fal result into files, and what it reports for a
// job fal failed. Every case runs against an in-memory fal built from fal's real
// responses (`fixtures/`, provenance in `fixtures/sources.json`): no network, no
// real key, nothing written outside a temp dir.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationRequest } from "@dimension/sdk/provider";
import {
	buildBody,
	buildOptionsSchema,
	checkRequest,
	claimedFields,
	collectFiles,
	createFalProvider,
	loadPackData,
	makeHandle,
	priceUnits,
	quoteRequest,
	readConnectKey,
	validateOptions,
} from "../index.ts";
import type { ModelEntry, ModelPricing } from "../models.ts";

/** The parts of fal's catalogue entry these tests read or edit. */
interface LiveSchema {
	properties?: Record<string, unknown>;
	required?: string[];
}
interface LiveModel {
	endpoint_id: string;
	metadata: { status?: string; license_type?: string };
	openapi: { components: { schemas: Record<string, LiveSchema> } };
}
interface PriceTable {
	prices: { endpoint_id: string; unit_price: number; unit: string; currency: string }[];
}

const fixture = async <T = unknown>(name: string): Promise<T> => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const KEY = "fal_SECRET_DO_NOT_LEAK";
const NOW = 1_790_000_000_000;
const signal = new AbortController().signal;

const PIXAL = "fal-ai/pixal3d";
const HUNYUAN_PRO = "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d";
const HUNYUAN_PART = "fal-ai/hunyuan-3d/v3.1/part";
const SMART_TOPOLOGY = "fal-ai/hunyuan-3d/v3.1/smart-topology";

const packData = await loadPackData();
const catalogueFixture = await fixture<{ models: LiveModel[] }>("catalogue.json");
const pricesFixture = await fixture<PriceTable>("pricing.json");
const queueSubmit = await fixture<Record<string, unknown>>("queue-submit.json");
const queueStatus = {
	IN_QUEUE: await fixture<Record<string, unknown>>("queue-status-in-queue.json"),
	IN_PROGRESS: await fixture<Record<string, unknown>>("queue-status-in-progress.json"),
	COMPLETED: await fixture<Record<string, unknown>>("queue-status-completed.json"),
};

const entryOf = (endpoint: string): ModelEntry => {
	const entry = packData.models.find(model => model.endpoint === endpoint);
	if (entry === undefined) throw new Error(`models.json has no ${endpoint}`);
	return entry;
};

const schemaOf = (endpoint: string) => {
	const live = catalogueFixture.models.find(model => model.endpoint_id === endpoint);
	if (live === undefined) throw new Error(`the fixture catalogue has no ${endpoint}`);
	return buildOptionsSchema(live.openapi, claimedFields(entryOf(endpoint))).options;
};

interface Call {
	readonly method: string;
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: Record<string, unknown> | undefined;
}

/** An in-memory fal: the catalogue and price APIs, the CDN, the queue and the
 *  billing events, each answering from fal's recorded shapes. Whatever a test
 *  does not touch behaves like a healthy fal. */
class FakeFal {
	readonly calls: Call[] = [];
	catalogue: { models: LiveModel[] } = structuredClone(catalogueFixture);
	prices: PriceTable = structuredClone(pricesFixture);
	pricingStatus = 200;
	queueState: keyof typeof queueStatus = "IN_QUEUE";
	completed: Record<string, unknown> = { ...queueStatus.COMPLETED };
	statusHttp = 200;
	result: { status: number; body: unknown } = { status: 200, body: {} };
	billing: { status: number; body: unknown }[] = [{ status: 200, body: { billing_events: [{ cost_total: 0.18, output_units: 3 }] } }];
	submitBody: unknown = queueSubmit;
	cancelReply: { status: number; body: unknown } = { status: 200, body: {} };
	slept = 0;
	#uploads = 0;

	callsTo(fragment: string): Call[] {
		return this.calls.filter(call => call.url.includes(fragment));
	}

	readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		const headers = Object.fromEntries(
			Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]),
		);
		const body: Record<string, unknown> | undefined = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		this.calls.push({ method, url, headers, body });
		const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status });
		const { hostname, pathname, searchParams } = new URL(url);

		if (hostname === "api.fal.ai") {
			if (pathname === "/v1/models/pricing") return this.pricingStatus === 200 ? json(200, this.prices) : json(this.pricingStatus, { detail: "nope" });
			if (pathname === "/v1/models/billing-events") {
				const next = this.billing.length > 1 ? (this.billing.shift() as (typeof this.billing)[number]) : (this.billing[0] as (typeof this.billing)[number]);
				return json(next.status, next.body);
			}
			if (pathname === "/v1/models") {
				const wanted = searchParams.getAll("endpoint_id");
				return json(200, { models: this.catalogue.models.filter(model => wanted.includes(model.endpoint_id)) });
			}
		}
		if (hostname === "rest.fal.ai" && pathname.startsWith("/storage/upload/initiate")) {
			const n = ++this.#uploads;
			const name = String(body?.file_name);
			return json(200, { upload_url: `https://cdn.fake.example/put/${n}`, file_url: `https://v3b.fal.media/files/up/${n}-${name}` });
		}
		if (hostname === "cdn.fake.example" && method === "PUT") return new Response("", { status: 200 });
		if (hostname === "queue.fal.run") {
			if (method === "POST") return json(200, this.submitBody);
			if (method === "PUT" && pathname.endsWith("/cancel")) return json(this.cancelReply.status, this.cancelReply.body);
			if (pathname.endsWith("/status")) {
				if (this.statusHttp !== 200) return json(this.statusHttp, { detail: "gone" });
				return json(200, this.queueState === "COMPLETED" ? this.completed : queueStatus[this.queueState]);
			}
			if (pathname.endsWith("/response")) return json(this.result.status, this.result.body);
		}
		if (hostname === "v3b.fal.media" || hostname === "storage.googleapis.com") return new Response(`bytes of ${url}`);
		return json(404, { detail: `the fake fal has no route for ${method} ${url}` });
	}) as typeof fetch;

	provider(extra: Parameters<typeof createFalProvider>[0] = {}) {
		return createFalProvider({
			apiKey: async () => KEY,
			fetch: this.fetch,
			now: () => NOW,
			sleep: async () => {
				this.slept += 1;
			},
			...extra,
		});
	}
}

let dir: string;
let imagePath: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "gen-fal-"));
	imagePath = join(dir, "ref.png");
	await writeFile(imagePath, "png bytes");
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const request = (model: string, extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
	model,
	input: { images: [imagePath] },
	...extra,
});

/** Take a field out of an endpoint's live input schema, as fal removing it would. */
function dropLiveInput(fake: FakeFal, endpoint: string, field: string): void {
	const live = fake.catalogue.models.find(model => model.endpoint_id === endpoint);
	if (live === undefined) throw new Error(`the fixture catalogue has no ${endpoint}`);
	for (const schema of Object.values(live.openapi.components.schemas)) {
		if (schema.properties?.[field] !== undefined && schema.required?.includes(field)) {
			delete schema.properties[field];
			schema.required = schema.required.filter(name => name !== field);
		}
	}
}

describe("what the pack offers from fal's catalogue", () => {
	test("every endpoint in models.json that fal lists is offered, with fal's own options minus the fields Dimension fills itself", async () => {
		const catalogue = await new FakeFal().provider().describe({ signal });
		expect(catalogue.ready).toBe(true);
		expect(catalogue.models.map(model => model.id).sort()).toEqual(packData.models.map(entry => entry.endpoint).sort());
		for (const model of catalogue.models) {
			const properties = Object.keys(model.options.properties ?? {});
			expect(model.options.additionalProperties).toBe(false);
			for (const owned of claimedFields(entryOf(model.id))) expect(properties).not.toContain(owned);
		}
		const pixal = catalogue.models.find(model => model.id === PIXAL);
		expect(Object.keys(pixal?.options.properties ?? {})).toContain("resolution");
	});

	test("without a key the pack is not ready and says how to connect it, and describe does not throw", async () => {
		const fake = new FakeFal();
		const catalogue = await fake.provider({
			apiKey: async () => {
				throw new Error("fal is not connected — add a fal API key on the pack's Connect page");
			},
		}).describe({ signal });
		expect(catalogue.ready).toBe(false);
		expect(catalogue.reason).toContain("Connect page");
		expect(catalogue.models).toEqual([]);
		expect(fake.calls).toEqual([]);
	});

	test("a key fal rejects makes the pack not ready with a reconnect reason that does not contain the key", async () => {
		const fake = new FakeFal();
		fake.pricingStatus = 401;
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.ready).toBe(false);
		expect(catalogue.reason).toContain("reconnect");
		expect(JSON.stringify(catalogue)).not.toContain(KEY);
	});

	test("an endpoint whose input schema lost a field Dimension fills is withdrawn with the field named; the others are still offered", async () => {
		const fake = new FakeFal();
		dropLiveInput(fake, PIXAL, "image_url");
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.ready).toBe(true);
		expect(catalogue.models.map(model => model.id)).not.toContain(PIXAL);
		expect(catalogue.models.length).toBe(packData.models.length - 1);
		expect(catalogue.reason).toContain(PIXAL);
		expect(catalogue.reason).toContain("image_url");
	});

	test("a deprecated endpoint is withdrawn, and one fal does not list at all is withdrawn with that said", async () => {
		const fake = new FakeFal();
		const trellis = fake.catalogue.models.find(model => model.endpoint_id === "fal-ai/trellis-2");
		trellis.metadata.status = "deprecated";
		fake.catalogue.models = fake.catalogue.models.filter(model => model.endpoint_id !== PIXAL);
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.models.map(model => model.id)).not.toContain("fal-ai/trellis-2");
		expect(catalogue.models.map(model => model.id)).not.toContain(PIXAL);
		expect(catalogue.reason).toContain("deprecated");
		expect(catalogue.reason).toContain("does not list");
	});

	test("a recorded commercial-use answer is withdrawn when fal's own catalogue stops calling the endpoint commercial", async () => {
		const recorded = entryOf("fal-ai/trellis-2");
		expect(recorded.licence.commercialUse).toBe("yes");
		const fake = new FakeFal();
		fake.catalogue.models.find(model => model.endpoint_id === "fal-ai/trellis-2").metadata.license_type = "research";
		const catalogue = await fake.provider().describe({ signal });
		const licence = catalogue.models.find(model => model.id === "fal-ai/trellis-2")?.licence;
		expect(licence?.commercialUse).toBe("unknown");
		expect(licence?.note).toContain("research");
	});

	test("when fal's price API is down the models are still offered and the reason says quotes use recorded prices", async () => {
		const fake = new FakeFal();
		fake.pricingStatus = 500;
		const catalogue = await fake.provider().describe({ signal });
		expect(catalogue.ready).toBe(true);
		expect(catalogue.models.length).toBe(packData.models.length);
		expect(catalogue.reason).toContain("recorded in models.json");
	});
});

describe("how billing units become dollars", () => {
	const pricing = (rules: ModelPricing["rules"], base = 10): ModelPricing => ({
		unit: "units",
		unitPrice: 0.01,
		base,
		rules,
		basis: "test basis",
		source: "test",
	});
	const units = (rules: ModelPricing["rules"], context: { provided?: Record<string, unknown>; defaults?: Record<string, unknown>; images?: number } = {}) =>
		priceUnits(pricing(rules), {
			provided: context.provided ?? {},
			effective: { ...context.defaults, ...context.provided },
			images: context.images ?? 0,
		});

	const CASES: readonly { name: string; rules: ModelPricing["rules"]; context: Parameters<typeof units>[1]; expected: number }[] = [
		{ name: "no rule applies: the base", rules: [{ when: { quality: "high" }, add: 5 }], context: { provided: { quality: "low" } }, expected: 10 },
		{ name: "a matching rule adds", rules: [{ when: { quality: "high" }, add: 5 }], context: { provided: { quality: "high" } }, expected: 15 },
		{ name: "a matching rule can replace the count", rules: [{ when: { quality: "high" }, set: 40 }], context: { provided: { quality: "high" } }, expected: 40 },
		{
			name: "rules apply in order: a later add lands on an earlier set",
			rules: [
				{ when: { quality: "high" }, set: 40 },
				{ when: { pbr: true }, add: 3 },
			],
			context: { provided: { quality: "high", pbr: true } },
			expected: 43,
		},
		{ name: "a default counts as the option's value", rules: [{ when: { quality: "high" }, add: 5 }], context: { defaults: { quality: "high" } }, expected: 15 },
		{ name: "`present` is about what the caller passed, not the default", rules: [{ when: { face_count: { present: true } }, add: 7 }], context: { defaults: { face_count: 1000 } }, expected: 10 },
		{ name: "`present` holds when the caller passed it", rules: [{ when: { face_count: { present: true } }, add: 7 }], context: { provided: { face_count: 1000 } }, expected: 17 },
		{ name: "`gte` on the image count", rules: [{ when: { $images: { gte: 2 } }, add: 10 }], context: { images: 2 }, expected: 20 },
		{ name: "`gte` just below the threshold does not hold", rules: [{ when: { $images: { gte: 2 } }, add: 10 }], context: { images: 1 }, expected: 10 },
		{ name: "`not` excludes a value", rules: [{ when: { mode: { not: "fast" } }, add: 4 }], context: { provided: { mode: "fast" } }, expected: 10 },
		{ name: "a list matches any member", rules: [{ when: { size: [512, 1024] }, add: 2 }], context: { provided: { size: 1024 } }, expected: 12 },
		{ name: "a dotted key reaches a nested option", rules: [{ when: { "addons.high_pack": true }, add: 2 }], context: { provided: { addons: { high_pack: true } } }, expected: 12 },
		{ name: "every key of `when` must hold", rules: [{ when: { texture: false, pbr: false }, set: 100 }], context: { provided: { texture: false, pbr: true } }, expected: 10 },
	];

	for (const { name, rules, context, expected } of CASES) {
		test(name, () => {
			expect(units(rules, context)).toBe(expected);
		});
	}

	test("the quote is units × fal's live unit price, rounded to a millionth of a dollar", () => {
		const quote = quoteRequest(pricing([]), { provided: {}, effective: {}, images: 0 }, { unitPrice: 0.0123457, unit: "units" });
		expect(quote.usd).toBe(0.123457);
		expect(quote.basis).toContain("live pricing");
	});

	test("a unit price fal now publishes in another billing unit is NOT applied: the recorded price is used and models.json is named as stale", () => {
		const quote = quoteRequest(pricing([]), { provided: {}, effective: {}, images: 0 }, { unitPrice: 5, unit: "credits" });
		expect(quote.usd).toBe(0.1);
		expect(quote.basis).toContain("models.json needs updating");
	});

	test("with no live price the recorded one is used and the basis says fal's pricing was unavailable", () => {
		const quote = quoteRequest(pricing([]), { provided: {}, effective: {}, images: 0 }, undefined);
		expect(quote.usd).toBe(0.1);
		expect(quote.basis).toContain("unavailable");
	});
});

describe("what a request quotes", () => {
	test("follows fal's published unit price: when fal doubles it, the quote doubles", async () => {
		const base = await new FakeFal().provider().quote(request(PIXAL), { signal });
		expect(base.usd).toBeGreaterThan(0);

		const dearer = new FakeFal();
		for (const row of dearer.prices.prices) row.unit_price *= 2;
		const doubled = await dearer.provider().quote(request(PIXAL), { signal });
		expect(doubled.usd).toBeCloseTo(base.usd * 2, 9);
	});

	test("falls back to the recorded price when fal's pricing API is down, and when fal now bills in another unit", async () => {
		const base = await new FakeFal().provider().quote(request(PIXAL), { signal });

		const down = new FakeFal();
		down.pricingStatus = 500;
		expect((await down.provider().quote(request(PIXAL), { signal })).usd).toBeCloseTo(base.usd, 9);

		const reunited = new FakeFal();
		for (const row of reunited.prices.prices) {
			row.unit = "something-else";
			row.unit_price *= 10;
		}
		expect((await reunited.provider().quote(request(PIXAL), { signal })).usd).toBeCloseTo(base.usd, 9);
	});

	test("a request fal would refuse is refused before any price is given", async () => {
		const fake = new FakeFal();
		await expect(fake.provider().quote({ model: PIXAL, input: {} }, { signal })).rejects.toThrow("needs at least one reference image");
		await expect(fake.provider().quote(request("fal-ai/not-offered"), { signal })).rejects.toThrow("not one this pack offers");
	});
});

describe("building fal's request body", () => {
	const uploader = () => {
		const uploaded: string[] = [];
		return {
			uploaded,
			upload: async (path: string) => {
				uploaded.push(path);
				return `https://v3b.fal.media/files/up/${path.split(/[\\/]/).pop()}`;
			},
		};
	};

	test("a reference image is uploaded and its URL lands in the endpoint's own field beside the options and seed, nothing else", async () => {
		const { upload } = uploader();
		const body = await buildBody(entryOf(PIXAL), schemaOf(PIXAL), request(PIXAL, { options: { resolution: 1536 }, seed: 7 }), upload);
		expect(body).toEqual({ resolution: 1536, image_url: "https://v3b.fal.media/files/up/ref.png", seed: 7 });
	});

	test("the fields Dimension fills cannot also be sent as options: they are not options of the model", async () => {
		const { upload, uploaded } = uploader();
		await expect(
			buildBody(entryOf(PIXAL), schemaOf(PIXAL), request(PIXAL, { options: { image_url: "https://evil.example/x.png", seed: 1 } }), upload),
		).rejects.toThrow(/options\.image_url is not an option.*options\.seed is not an option/);
		expect(uploaded).toEqual([]);
	});

	test("a bad request is refused in one error naming every problem, before the first upload", async () => {
		const { upload, uploaded } = uploader();
		const bad = { model: PIXAL, input: { prompt: "a hero", images: ["relative.png"] }, options: { resolution: 999 }, seed: 1 };
		const failure = await buildBody(entryOf(PIXAL), schemaOf(PIXAL), bad, upload).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain("takes no prompt");
		expect(message).toContain('image "relative.png" is not an absolute path');
		expect(message).toContain("options.resolution must be one of");
		expect(uploaded).toEqual([]);
	});

	test("more images than the endpoint takes are refused naming how many it takes", () => {
		const images = Array.from({ length: 9 }, (_, index) => join(dir, `view-${index}.png`));
		expect(() => checkRequest(entryOf(HUNYUAN_PRO), schemaOf(HUNYUAN_PRO), { model: HUNYUAN_PRO, input: { images } })).toThrow("at most 8 reference image(s), got 9");
	});

	test("views map onto the endpoint's per-view fields in the order the caller listed them, whichever upload finishes first", async () => {
		const front = join(dir, "front.png");
		const back = join(dir, "back.png");
		const left = join(dir, "left.png");
		const release = new Map<string, () => void>();
		const gated = (path: string): Promise<string> => {
			const { promise, resolve } = Promise.withResolvers<string>();
			release.set(path, () => resolve(`https://v3b.fal.media/files/up/${path.split(/[\\/]/).pop()}`));
			return promise;
		};
		const building = buildBody(entryOf(HUNYUAN_PRO), schemaOf(HUNYUAN_PRO), { model: HUNYUAN_PRO, input: { images: [front, back, left] } }, gated);
		for (let turn = 0; turn < 20; turn++) await Promise.resolve();
		// Finish in the opposite order to the caller's.
		release.get(left)?.();
		release.get(back)?.();
		release.get(front)?.();
		expect(await building).toEqual({
			input_image_url: "https://v3b.fal.media/files/up/front.png",
			back_image_url: "https://v3b.fal.media/files/up/back.png",
			left_image_url: "https://v3b.fal.media/files/up/left.png",
		});
	});

	describe("chaining a 3D endpoint from an earlier job", () => {
		const makeHandleOf = async (resultName: string): Promise<string> => {
			const files = collectFiles(await fixture(resultName), packData.outputRoles);
			const handle = makeHandle(files);
			if (handle === undefined) throw new Error(`${resultName} yields no handle`);
			return handle;
		};

		test("takes the format the endpoint accepts out of the earlier job's files, in the endpoint's order of preference, and uploads nothing", async () => {
			const meshy = await makeHandleOf("result-meshy-v6.json");
			const { upload, uploaded } = uploader();

			const part = await buildBody(entryOf(HUNYUAN_PART), schemaOf(HUNYUAN_PART), { model: HUNYUAN_PART, input: { from: { handle: meshy } } }, upload);
			expect(part.input_file_url).toBe("https://v3b.fal.media/files/b/kangaroo/4Q2qdpTvfLVdzAKH1-72v_model.fbx");

			const topology = await buildBody(entryOf(SMART_TOPOLOGY), schemaOf(SMART_TOPOLOGY), { model: SMART_TOPOLOGY, input: { from: { handle: meshy } } }, upload);
			expect(topology.input_file_url).toBe("https://v3b.fal.media/files/b/zebra/OXF1e1bO3JddPTaugv0eL_model.glb");
			expect(topology.input_file_type).toBe("glb");
			expect(uploaded).toEqual([]);
		});

		test("an earlier job that produced none of the formats the endpoint takes is refused, naming both", async () => {
			const glbOnly = await makeHandleOf("result-pixal3d.json");
			expect(() => checkRequest(entryOf(HUNYUAN_PART), schemaOf(HUNYUAN_PART), { model: HUNYUAN_PART, input: { from: { handle: glbOnly } } })).toThrow(
				"produced glb, but this model needs fbx",
			);
		});

		test("a handle this provider never issued is refused, and so is giving both a file and a chain", () => {
			expect(() => checkRequest(entryOf(HUNYUAN_PART), schemaOf(HUNYUAN_PART), { model: HUNYUAN_PART, input: { from: { handle: "task_123" } } })).toThrow(
				"not one this provider issued",
			);
			expect(() =>
				checkRequest(entryOf(HUNYUAN_PART), schemaOf(HUNYUAN_PART), {
					model: HUNYUAN_PART,
					input: { model: join(dir, "m.fbx"), from: { handle: "{}" } },
				}),
			).toThrow("input.model or input.from, not both");
		});

		test("a 3D file must be absolute and in a format the endpoint takes", () => {
			const check = (model: string): void => checkRequest(entryOf(HUNYUAN_PART), schemaOf(HUNYUAN_PART), { model: HUNYUAN_PART, input: { model } });
			expect(() => check("relative.fbx")).toThrow("not an absolute path");
			expect(() => check(join(dir, "mesh.glb"))).toThrow("takes fbx files, got \"glb\"");
			expect(() => check(join(dir, "mesh.FBX"))).not.toThrow();
		});
	});
});

describe("mapping fal's result to files", () => {
	const files = async (name: string, endpoint: string) => collectFiles(await fixture(name), [...(entryOf(endpoint).outputRoles ?? []), ...packData.outputRoles]);

	test("Meshy's result: a file listed under two keys is one file, models/textures/previews are told apart, and every name is unique and plain", async () => {
		const found = await files("result-meshy-v6.json", "fal-ai/meshy/v6/image-to-3d");
		const byLabel = new Map(found.map(file => [file.label, file]));
		expect(found.filter(file => file.format === "glb")).toHaveLength(1);
		expect(byLabel.get("texture_urls[0].base_color")).toMatchObject({ role: "texture", format: "png" });
		expect(byLabel.get("thumbnail")).toMatchObject({ role: "preview", format: "png" });
		expect(found.filter(file => file.role === "model").map(file => file.format).sort()).toEqual(["fbx", "glb", "obj", "usdz"]);
		expect(new Set(found.map(file => file.name)).size).toBe(found.length);
		for (const file of found) expect(file.name).toMatch(/^[A-Za-z0-9._-]+$/);
	});

	test("Hunyuan Part's pieces are parts, not models", async () => {
		const [piece, ...rest] = await files("result-hunyuan-part.json", HUNYUAN_PART);
		expect(rest).toEqual([]);
		expect(piece).toMatchObject({ role: "part", format: "fbx" });
	});

	test("a file is classified by what it is, not by the key fal filed it under: an .obj under `model_glb` is an obj", async () => {
		const found = await files("result-hunyuan-smart-topology.json", SMART_TOPOLOGY);
		expect(found.map(file => file.format).sort()).toEqual(["glb", "obj"]);
		expect(found.every(file => file.role === "model")).toBe(true);
	});

	test("a hostile file name cannot leave the job's directory, and two files with one name both survive", () => {
		const found = collectFiles(
			{
				model_a: { url: "https://v3b.fal.media/files/a/x.glb", file_name: "..\\..\\evil/../../model.glb" },
				model_b: { url: "https://v3b.fal.media/files/b/y.glb", file_name: "model.glb" },
				model_c: { url: "https://v3b.fal.media/files/c/z.glb", file_name: "model.glb" },
			},
			packData.outputRoles,
		);
		expect(found).toHaveLength(3);
		expect(new Set(found.map(file => file.name)).size).toBe(3);
		for (const file of found) {
			expect(file.name).not.toMatch(/[\\/]/);
			expect(file.name.startsWith(".")).toBe(false);
		}
	});

	test("a result that points at anything but https is refused", () => {
		expect(() => collectFiles({ model_glb: { url: "http://v3b.fal.media/a.glb" } }, [])).toThrow("non-https");
		expect(() => collectFiles({ model_glb: { url: "file:///etc/passwd" } }, [])).toThrow("non-https");
		expect(() => collectFiles({ model_glb: { url: "not a url" } }, [])).toThrow("unusable URL");
	});

	test("the handle carries only model files, by format, and nothing when the job made none", async () => {
		const meshy = await files("result-meshy-v6.json", "fal-ai/meshy/v6/image-to-3d");
		const handle: { formats: Record<string, string> } = JSON.parse(makeHandle(meshy) ?? "{}");
		expect(Object.keys(handle.formats).sort()).toEqual(["fbx", "glb", "obj", "usdz"]);
		expect(makeHandle(meshy.filter(file => file.role !== "model"))).toBeUndefined();
	});
});

describe("a job on fal's queue", () => {
	async function submitted(fake: FakeFal, model = PIXAL, extra: Partial<GenerationRequest> = {}) {
		const provider = fake.provider();
		const { ref } = await provider.submit(request(model, extra), { signal, jobId: "gen_1" });
		return { provider, ref };
	}

	test("submit posts the built body to the endpoint with the key, and the ref it returns is enough for a fresh provider to carry the job on after a restart", async () => {
		const fake = new FakeFal();
		const { ref } = await submitted(fake, PIXAL, { options: { resolution: 1536 }, seed: 9 });
		const post = fake.calls.find(call => call.method === "POST" && call.url === `https://queue.fal.run/${PIXAL}`);
		expect(post?.headers.authorization).toBe(`Key ${KEY}`);
		expect(post?.body).toMatchObject({ resolution: 1536, seed: 9, image_url: expect.stringMatching(/^https:\/\/v3b\.fal\.media\/files\/up\//) });
		expect(() => JSON.parse(ref)).not.toThrow();

		const restarted = fake.provider();
		fake.queueState = "IN_PROGRESS";
		expect(await restarted.status(ref, { signal, jobId: "gen_1" })).toMatchObject({ state: "running", message: "Generating image..." });
	});

	test("fal handing back a queue URL on another host is refused, and nothing is sent to that host", async () => {
		const fake = new FakeFal();
		fake.submitBody = { ...queueSubmit, status_url: "https://evil.example/status" };
		await expect(submitted(fake)).rejects.toThrow("no usable status_url");
		expect(fake.callsTo("evil.example")).toEqual([]);
	});

	test("the queue's states read as queued (with the place in line), running (with the last log line), and an unknown state is never read as done", async () => {
		const fake = new FakeFal();
		const { provider, ref } = await submitted(fake);
		expect(await provider.status(ref, { signal, jobId: "g" })).toEqual({ state: "queued", message: "position 2 in fal's queue" });
		fake.queueState = "IN_PROGRESS";
		expect(await provider.status(ref, { signal, jobId: "g" })).toEqual({ state: "running", message: "Generating image..." });
		fake.queueState = "COMPLETED";
		fake.completed = { status: "SOMETHING_NEW", request_id: "x" };
		await expect(provider.status(ref, { signal, jobId: "g" })).rejects.toThrow("SOMETHING_NEW");
	});

	test("a request fal's app rejects completes in the queue but is reported failed and NOT billed, with fal's reason", async () => {
		const fake = new FakeFal();
		const { provider, ref } = await submitted(fake);
		fake.queueState = "COMPLETED";
		fake.result = { status: 422, body: { detail: [{ loc: ["body", "image_url"], msg: "could not decode the image", type: "value_error" }] } };
		const status = await provider.status(ref, { signal, jobId: "g" });
		expect(status).toEqual({ state: "failed", billed: false, error: "image_url: could not decode the image (value_error)" });
	});

	test("a job fal reports completed WITH an error, and one fal no longer knows, are failed and not billed", async () => {
		const fake = new FakeFal();
		const { provider, ref } = await submitted(fake);
		fake.queueState = "COMPLETED";
		fake.completed = { ...queueStatus.COMPLETED, error: "out of memory", error_type: "runtime_error" };
		expect(await provider.status(ref, { signal, jobId: "g" })).toEqual({ state: "failed", billed: false, error: "runtime_error: out of memory" });
		fake.statusHttp = 404;
		expect(await provider.status(ref, { signal, jobId: "g" })).toMatchObject({ state: "failed", billed: false });
	});

	test("an auth, rate-limit or server error while reading the result is not the request's failure: the status call throws so the engine retries", async () => {
		const fake = new FakeFal();
		const { provider, ref } = await submitted(fake);
		fake.queueState = "COMPLETED";
		for (const status of [401, 429, 500, 503]) {
			fake.result = { status, body: { detail: "later" } };
			await expect(provider.status(ref, { signal, jobId: "g" })).rejects.toThrow();
		}
	});

	describe("fetching the finished job", () => {
		async function finished(fake: FakeFal, sample = "result-pixal3d.json") {
			fake.result = { status: 200, body: await fixture(sample) };
			const { provider, ref } = await submitted(fake);
			fake.queueState = "COMPLETED";
			expect(await provider.status(ref, { signal, jobId: "gen_1" })).toEqual({ state: "succeeded" });
			const outDir = await mkdtemp(join(dir, "out-"));
			return { provider, ref, outDir };
		}

		test("downloads every file into the outDir under plain names, sending the key to no download host", async () => {
			const fake = new FakeFal();
			const { provider, ref, outDir } = await finished(fake, "result-meshy-v6.json");
			const result = await provider.fetch(ref, { signal, jobId: "gen_1", outDir });

			expect((await readdir(outDir)).sort()).toEqual(result.files.map(file => file.path.slice(outDir.length + 1)).sort());
			for (const file of result.files) {
				expect(file.path.startsWith(outDir)).toBe(true);
				expect(await readFile(file.path, "utf8")).toStartWith("bytes of https://");
			}
			expect(result.files.find(file => file.role === "texture")?.format).toBe("png");
			expect(result.handle).toBeDefined();
			expect(result.licence.id).toBeDefined();
			const downloads = fake.calls.filter(call => call.url.includes("v3b.fal.media/files/b/"));
			expect(downloads.length).toBe(result.files.length);
			for (const call of downloads) expect(call.headers.authorization).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain(KEY);
		});

		test("the cost is what fal's billing events say it charged, summed over the request's events", async () => {
			const fake = new FakeFal();
			fake.billing = [{ status: 200, body: { billing_events: [{ cost_total: 0.1, output_units: 2 }, { cost_total: 0.11, output_units: 1 }] } }];
			const { provider, ref, outDir } = await finished(fake);
			const result = await provider.fetch(ref, { signal, jobId: "gen_1", outDir });
			expect(result.costUsd).toBe(0.21);
			expect(result.meta.cost).toEqual({ source: "fal-billing-events", usd: 0.21, units: 3 });
		});

		test("a key that cannot read billing events records the job at its quote and says why", async () => {
			const fake = new FakeFal();
			fake.billing = [{ status: 403, body: { detail: "forbidden" } }];
			const { provider, ref, outDir } = await finished(fake);
			const quote = await new FakeFal().provider().quote(request(PIXAL), { signal });
			const result = await provider.fetch(ref, { signal, jobId: "gen_1", outDir });
			expect(result.costUsd).toBeCloseTo(quote.usd, 9);
			expect(result.meta.cost).toMatchObject({ source: "quote", reason: expect.stringContaining("admin-scope") });
		});

		test("a request fal has not booked yet is asked about once more, patiently, and the second answer is used", async () => {
			const fake = new FakeFal();
			fake.billing = [
				{ status: 200, body: { billing_events: [] } },
				{ status: 200, body: { billing_events: [{ cost_total: 0.3 }] } },
			];
			const { provider, ref, outDir } = await finished(fake);
			const result = await provider.fetch(ref, { signal, jobId: "gen_1", outDir });
			expect(result.costUsd).toBe(0.3);
			expect(fake.slept).toBe(1);
			expect(fake.callsTo("billing-events")).toHaveLength(2);
		});

		test("a result with no files is an error, not an empty success", async () => {
			const fake = new FakeFal();
			const { provider, ref, outDir } = await finished(fake);
			fake.result = { status: 200, body: { seed: 5 } };
			const fresh = fake.provider();
			await expect(fresh.fetch(ref, { signal, jobId: "gen_1", outDir })).rejects.toThrow("contains no files");
			expect(provider).toBeDefined();
		});

		test("after a restart, fetch reads the result again itself", async () => {
			const fake = new FakeFal();
			const { ref, outDir } = await finished(fake);
			const result = await fake.provider().fetch(ref, { signal, jobId: "gen_1", outDir });
			expect(result.files).toHaveLength(1);
			expect(result.files[0]).toMatchObject({ role: "model", format: "glb" });
		});
	});

	describe("cancelling", () => {
		test("asks fal on the cancel URL it issued; a job already completed or gone has nothing left to cancel; anything else is an error", async () => {
			const fake = new FakeFal();
			const { provider, ref } = await submitted(fake);
			await provider.cancel?.(ref, { signal, jobId: "g" });
			expect(fake.calls.at(-1)).toMatchObject({ method: "PUT", url: expect.stringContaining("/cancel") });

			fake.cancelReply = { status: 400, body: { status: "ALREADY_COMPLETED" } };
			await provider.cancel?.(ref, { signal, jobId: "g" });
			fake.cancelReply = { status: 404, body: {} };
			await provider.cancel?.(ref, { signal, jobId: "g" });

			fake.cancelReply = { status: 500, body: { detail: "boom" } };
			await expect(provider.cancel?.(ref, { signal, jobId: "g" })).rejects.toThrow("cancelling the job");
		});
	});
});

describe("readConnectKey", () => {
	const SECRET = "fal_SECRET_DO_NOT_LEAK";
	let keyDir: string;
	beforeAll(async () => {
		keyDir = await mkdtemp(join(tmpdir(), "gen-fal-key-"));
	});
	afterAll(async () => {
		await rm(keyDir, { recursive: true, force: true });
	});
	const write = async (name: string, content: string): Promise<string> => {
		await mkdir(keyDir, { recursive: true });
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

describe("validateOptions", () => {
	test("accepts a value inside the endpoint's own schema and names each violation otherwise", () => {
		const schema = schemaOf(PIXAL);
		expect(validateOptions(schema, { resolution: 1024 })).toEqual([]);
		const errors = validateOptions(schema, { resolution: "big", surprise: true });
		expect(errors.some(error => error.startsWith("options.resolution"))).toBe(true);
		expect(errors).toContain("options.surprise is not an option of this model");
	});
});
