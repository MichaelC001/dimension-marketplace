// What a request costs, in fal's own terms.
//
// fal bills `output units × the endpoint's unit price`. The unit price is live
// (`GET api.fal.ai/v1/models/pricing`); how many units a request takes is not
// exposed by any API, only described in the price text on the endpoint's page
// ("$0.30 at 1024p, $0.42 at 1536p" is 5 units and 7 at $0.06). models.json
// holds that unit count as a base plus rules over the request's options, so
// a price change at fal reprices every quote without a release, and a change in
// how fal counts units shows up as a billing unit that no longer matches.

import type { GenerationQuote } from "@dimension/sdk/provider";
import { isRecord } from "./guards.ts";
import type { Condition, ModelPricing, Scalar } from "./models.ts";

/** What fal's pricing API says an endpoint costs per billing unit. */
export interface LivePrice {
	readonly unitPrice: number;
	readonly unit: string;
}

export interface PriceContext {
	/** The options the caller passed. */
	readonly provided: Readonly<Record<string, unknown>>;
	/** `provided` over the schema's defaults: what fal will run with. */
	readonly effective: Readonly<Record<string, unknown>>;
	/** How many reference images the request carries. */
	readonly images: number;
}

function lookup(source: Readonly<Record<string, unknown>>, path: string): unknown {
	let node: unknown = source;
	for (const part of path.split(".")) {
		node = isRecord(node) && Object.hasOwn(node, part) ? node[part] : undefined;
	}
	return node;
}

function members(condition: Scalar | Scalar[]): readonly Scalar[] {
	return Array.isArray(condition) ? condition : [condition];
}

/** `given` is whether the caller passed the value at all, as opposed to a default. */
function holds(condition: Condition, value: unknown, given: boolean): boolean {
	if (typeof condition !== "object" || Array.isArray(condition)) return members(condition).includes(value as Scalar);
	if (condition.present !== undefined && condition.present !== given) return false;
	if (condition.gte !== undefined && !(typeof value === "number" && value >= condition.gte)) return false;
	if (condition.not !== undefined && members(condition.not).includes(value as Scalar)) return false;
	return true;
}

/** The billing units a request takes. Rules apply in order; a `set` replaces the
 *  running count, an `add` adds to it. */
export function priceUnits(pricing: ModelPricing, context: PriceContext): number {
	let units = pricing.base;
	for (const rule of pricing.rules) {
		const applies = Object.entries(rule.when).every(([key, condition]) =>
			key === "$images"
				? holds(condition, context.images, true)
				: holds(condition, lookup(context.effective, key), lookup(context.provided, key) !== undefined),
		);
		if (applies) units = rule.set ?? units + (rule.add ?? 0);
	}
	return units;
}

/** The USD a request will be billed. Uses fal's live unit price when it is in the
 *  unit the rules were written for; otherwise the recorded price, and says so. */
export function quoteRequest(pricing: ModelPricing, context: PriceContext, live: LivePrice | undefined): GenerationQuote {
	const units = priceUnits(pricing, context);
	const liveUsable = live !== undefined && live.unit === pricing.unit;
	const unitPrice = liveUsable ? live.unitPrice : pricing.unitPrice;
	let source = "fal's live pricing";
	if (!liveUsable) {
		source =
			live === undefined
				? "recorded price: fal's pricing API was unavailable"
				: `recorded price: fal now bills in "${live.unit}", not "${pricing.unit}" — models.json needs updating`;
	}
	return {
		usd: Math.round(units * unitPrice * 1e6) / 1e6,
		basis: `${units} ${pricing.unit} × $${unitPrice} (${source}); ${pricing.basis}`,
	};
}
